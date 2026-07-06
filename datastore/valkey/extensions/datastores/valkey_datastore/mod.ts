/**
 * Valkey/Redis datastore extension for swamp.
 *
 * Stores runtime data in Valkey (or Redis-compatible) backends using
 * a sorted-set path index for O(log n + k) prefix lookups. Provides
 * distributed locking via SET NX EX with Lua-guarded release, and
 * two-phase sync to minimize time under the global lock.
 *
 * Compatible with local Valkey, AWS ElastiCache Serverless, and
 * AWS MemoryDB.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { z } from "npm:zod@4";
import { Redis } from "npm:ioredis@5.6.1";
import { Sidecar } from "./sidecar.ts";
import type { SidecarState } from "./sidecar.ts";

interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

interface DatastoreSyncOptions {
  signal?: AbortSignal;
  relPath?: string;
  context?: SyncContext;
  metadataOnly?: boolean;
}

interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  twoPhaseSync?: boolean;
}

interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  capabilities?(): SyncCapabilities;
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
}

declare const PushManifestBrand: unique symbol;
type PushManifest = { readonly [PushManifestBrand]: true };

interface InternalPushManifest {
  toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
  toDelete: string[];
  snapshot: {
    dirtyPaths: string[];
    bulkInvalidated: boolean;
    lastPulledSeq: number;
    lazyPullActive: boolean;
  };
}

interface TwoPhaseSyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<PushManifest>;
  commitPush(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(
    repoDir: string,
    cachePath: string,
  ): TwoPhaseSyncService;
  resolveDatastorePath(repoDir: string): string;
  resolveCachePath?(repoDir: string): string | undefined;
}

// -- Key schema helpers --

function blobKey(prefix: string, relPath: string): string {
  return `${prefix}:blob:${relPath}`;
}

function metaKey(prefix: string, relPath: string): string {
  return `${prefix}:meta:${relPath}`;
}

function pathIndexKey(prefix: string): string {
  return `${prefix}:_paths`;
}

function seqKey(prefix: string): string {
  return `${prefix}:_seq`;
}

function lockKey(prefix: string, key: string): string {
  return `${prefix}:_lock:${key}`;
}

// -- Utilities --

const DATASTORE_SUBDIRS = [
  "definitions-evaluated",
  "workflows-evaluated",
  "data",
  "outputs",
  "workflow-runs",
  "secrets",
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "report-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

function isTraversal(p: string): boolean {
  return !p || p.split("/").some((s) => s === "..");
}

function modelPrefixes(
  models: ReadonlyArray<{ modelType: string; modelId: string }> | undefined,
): string[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => `data/${m.modelType}/${m.modelId}/`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new Uint8Array(bytes).buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function writeFileAtomic(
  absPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const slash = absPath.lastIndexOf("/");
  const dir = slash > 0 ? absPath.slice(0, slash) : ".";
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, absPath);
}

async function walkCache(
  root: string,
  relRoot: string,
  onFile: (relPath: string, bytes: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      signal?.throwIfAborted();
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walkCache(childAbs, childRel, onFile, signal);
      } else if (entry.isFile) {
        let bytes: Uint8Array;
        try {
          bytes = await Deno.readFile(childAbs);
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) continue;
          throw err;
        }
        await onFile(childRel, bytes);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

// Lua script for safe lock release: parse stored JSON, only DEL if nonce matches.
const RELEASE_LOCK_LUA = `
local data = redis.call("get", KEYS[1])
if data then
  local info = cjson.decode(data)
  if info.nonce == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
end
return 0
`;

// -- Lock implementation --

function createValkeyLock(
  redis: Redis,
  prefix: string,
  datastorePath: string,
  options?: LockOptions,
): DistributedLock {
  const key = lockKey(prefix, options?.lockKey ?? datastorePath);
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  let nonce: string | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;

  const acquire = async () => {
    if (nonce !== undefined) {
      throw new Error("Lock already acquired; call release() first");
    }
    const start = Date.now();
    const candidate = crypto.randomUUID();

    let hostname = "unknown";
    try {
      hostname = Deno.hostname();
    } catch {
      // --allow-sys not granted; fall back gracefully
    }

    while (Date.now() - start < maxWaitMs) {
      const result = await redis.set(
        key,
        JSON.stringify({
          holder: `${Deno.env.get("USER") ?? "unknown"}@${hostname}`,
          hostname,
          pid: Deno.pid,
          acquiredAt: new Date().toISOString(),
          ttlMs,
          nonce: candidate,
        }),
        "PX",
        ttlMs,
        "NX",
      );

      if (result === "OK") {
        nonce = candidate;
        heartbeatId = setInterval(async () => {
          try {
            const current = await redis.get(key);
            if (current) {
              const parsed = JSON.parse(current);
              if (parsed.nonce === candidate) {
                await redis.pexpire(key, ttlMs);
              }
            }
          } catch {
            // Connection lost — lock will expire via TTL
          }
        }, ttlMs / 3);
        return;
      }

      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }

    throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
  };

  const release = async () => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
    if (nonce) {
      try {
        await redis.call("EVAL", RELEASE_LOCK_LUA, 1, key, nonce);
      } catch {
        // Connection may be dead — lock will expire via TTL
      }
      nonce = undefined;
    }
  };

  return {
    acquire,
    release,

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await fn();
      } finally {
        await release();
      }
    },

    inspect: async () => {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return {
          holder: parsed.holder,
          hostname: parsed.hostname,
          pid: parsed.pid,
          acquiredAt: parsed.acquiredAt,
          ttlMs: parsed.ttlMs,
          nonce: parsed.nonce,
        };
      } catch {
        return null;
      }
    },

    forceRelease: async (expectedNonce: string) => {
      const result = await redis.call(
        "EVAL",
        RELEASE_LOCK_LUA,
        1,
        key,
        expectedNonce,
      );
      return result === 1;
    },
  };
}

// -- Sync service --

function createSyncService(
  redis: Redis,
  prefix: string,
  cachePath: string,
): TwoPhaseSyncService {
  const sidecar = new Sidecar(cachePath);
  const pathIdx = pathIndexKey(prefix);
  const seq = seqKey(prefix);

  async function getRemoteSeq(): Promise<number> {
    const val = await redis.get(seq);
    return val ? parseInt(val, 10) : 0;
  }

  const PATH_LIMIT = 50_000;

  async function pathsForPrefixes(
    prefixes: string[],
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const results: string[] = [];
    let truncated = false;
    for (const p of prefixes) {
      const end = p + String.fromCharCode(0xff);
      const remaining = PATH_LIMIT - results.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const members = await redis.zrangebylex(
        pathIdx,
        `[${p}`,
        `(${end}`,
        "LIMIT",
        0,
        remaining,
      );
      results.push(...members);
      if (results.length >= PATH_LIMIT) truncated = true;
    }
    return { paths: results, truncated };
  }

  async function allPaths(): Promise<{ paths: string[]; truncated: boolean }> {
    const paths = await redis.zrangebylex(
      pathIdx,
      "-",
      "+",
      "LIMIT",
      0,
      PATH_LIMIT,
    );
    const total = await redis.zcard(pathIdx);
    return { paths, truncated: total > PATH_LIMIT };
  }

  async function pullFiles(
    paths: string[],
    metadataOnly: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    let changes = 0;
    const BATCH = 100;

    for (let i = 0; i < paths.length; i += BATCH) {
      signal?.throwIfAborted();
      const batch = paths.slice(i, i + BATCH);

      // Fetch metadata for all paths in batch
      const pipeline = redis.pipeline();
      for (const relPath of batch) {
        pipeline.hgetall(metaKey(prefix, relPath));
      }
      const metaResults = await pipeline.exec();
      if (!metaResults) continue;

      for (let j = 0; j < batch.length; j++) {
        signal?.throwIfAborted();
        const relPath = batch[j];
        const [err, meta] = metaResults[j];
        if (err || !meta || typeof meta !== "object") continue;

        const remoteMeta = meta as Record<string, string>;
        if (remoteMeta.deleted === "true") {
          try {
            await Deno.remove(`${cachePath}/${relPath}`);
            changes++;
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
          continue;
        }

        if (
          metadataOnly && relPath.startsWith("data/") &&
          relPath.endsWith("/raw")
        ) {
          const localPath = `${cachePath}/${relPath}`;
          const dir = localPath.substring(0, localPath.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          continue;
        }

        // Check local hash to skip unchanged files
        const localPath = `${cachePath}/${relPath}`;
        try {
          const local = await Deno.readFile(localPath);
          if (await sha256Hex(local) === remoteMeta.sha256) continue;
        } catch { /* file missing — fetch content */ }

        // Fetch blob
        const blobData = await redis.getBuffer(blobKey(prefix, relPath));
        if (!blobData) continue;

        await writeFileAtomic(localPath, new Uint8Array(blobData));
        changes++;
      }
    }

    return changes;
  }

  async function collectFullWalkDiff(
    signal?: AbortSignal,
  ): Promise<{
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
    toDelete: string[];
  }> {
    const { paths: allRemote } = await allPaths();
    const remotePaths = new Set(allRemote);
    const remoteHashes = new Map<string, string>();

    if (remotePaths.size > 0) {
      const pathArray = [...remotePaths];
      const BATCH = 100;
      for (let i = 0; i < pathArray.length; i += BATCH) {
        const batch = pathArray.slice(i, i + BATCH);
        const pipeline = redis.pipeline();
        for (const p of batch) {
          pipeline.hget(metaKey(prefix, p), "sha256");
        }
        const results = await pipeline.exec();
        if (results) {
          for (let j = 0; j < batch.length; j++) {
            const [err, hash] = results[j];
            if (!err && hash) remoteHashes.set(batch[j], hash as string);
          }
        }
      }
    }

    // Walk local cache and diff
    const localPaths = new Set<string>();
    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];

    for (const sub of DATASTORE_SUBDIRS) {
      signal?.throwIfAborted();
      await walkCache(
        `${cachePath}/${sub}`,
        sub,
        async (relPath, bytes) => {
          signal?.throwIfAborted();
          localPaths.add(relPath);
          const hash = await sha256Hex(bytes);
          if (remoteHashes.get(relPath) === hash) return;
          toPush.push({ relPath, hash, bytes });
        },
        signal,
      );
    }

    // Files in remote but not local = tombstones
    const toDelete: string[] = [];
    for (const remotePath of remotePaths) {
      if (!localPaths.has(remotePath)) {
        toDelete.push(remotePath);
      }
    }

    return { toPush, toDelete };
  }

  async function collectOneRelDiff(
    relPath: string,
    signal?: AbortSignal,
  ): Promise<{
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
    toDelete: string[];
  }> {
    if (isTraversal(relPath)) return { toPush: [], toDelete: [] };
    signal?.throwIfAborted();

    const absPath = `${cachePath}/${relPath}`;
    let stat: Deno.FileInfo | null = null;
    try {
      stat = await Deno.stat(absPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const localFiles: Array<
      { relPath: string; hash: string; bytes: Uint8Array }
    > = [];
    if (stat?.isFile) {
      const bytes = await Deno.readFile(absPath);
      localFiles.push({ relPath, hash: await sha256Hex(bytes), bytes });
    } else if (stat?.isDirectory) {
      await walkCache(absPath, relPath, async (childRel, bytes) => {
        localFiles.push({
          relPath: childRel,
          hash: await sha256Hex(bytes),
          bytes,
        });
      }, signal);
    }

    // Fetch remote state: point lookup for files, prefix range for directories
    let remotePaths: string[];
    if (stat?.isFile) {
      const score = await redis.zscore(pathIdx, relPath);
      remotePaths = score !== null ? [relPath] : [];
    } else {
      const end = relPath + String.fromCharCode(0xff);
      remotePaths = await redis.zrangebylex(
        pathIdx,
        `[${relPath}`,
        `[${end}`,
      );
    }

    const remoteHashes = new Map<string, string>();
    if (remotePaths.length > 0) {
      const pipeline = redis.pipeline();
      for (const p of remotePaths) {
        pipeline.hget(metaKey(prefix, p), "sha256");
      }
      const results = await pipeline.exec();
      if (results) {
        for (let i = 0; i < remotePaths.length; i++) {
          const [err, hash] = results[i];
          if (!err && hash) remoteHashes.set(remotePaths[i], hash as string);
        }
      }
    }

    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];
    for (const f of localFiles) {
      if (remoteHashes.get(f.relPath) === f.hash) continue;
      toPush.push(f);
    }

    const localPathSet = new Set(localFiles.map((f) => f.relPath));
    const toDelete = remotePaths.filter((p: string) => !localPathSet.has(p));

    return { toPush, toDelete };
  }

  async function applyChanges(
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>,
    toDelete: string[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (toPush.length === 0 && toDelete.length === 0) return 0;

    // Pipeline all writes for one round trip per batch
    const BATCH = 50;
    let changes = 0;

    for (let i = 0; i < toPush.length; i += BATCH) {
      signal?.throwIfAborted();
      const batch = toPush.slice(i, i + BATCH);
      const pipeline = redis.pipeline();

      for (const f of batch) {
        pipeline.set(blobKey(prefix, f.relPath), Buffer.from(f.bytes));
        pipeline.hset(metaKey(prefix, f.relPath), {
          sha256: f.hash,
          size: String(f.bytes.byteLength),
          deleted: "false",
        });
        pipeline.zadd(pathIdx, 0, f.relPath);
      }

      await pipeline.exec();
      changes += batch.length;
    }

    // Delete tombstones
    if (toDelete.length > 0) {
      const pipeline = redis.pipeline();
      for (const relPath of toDelete) {
        signal?.throwIfAborted();
        pipeline.del(blobKey(prefix, relPath));
        pipeline.del(metaKey(prefix, relPath));
        pipeline.zrem(pathIdx, relPath);
      }
      await pipeline.exec();
      changes += toDelete.length;
    }

    // Increment sequence counter
    await redis.incr(seq);

    return changes;
  }

  return {
    capabilities(): SyncCapabilities {
      return { scopedSync: true, lazyHydration: true, twoPhaseSync: true };
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      return sidecar.recordDirty(options?.relPath).then(() => undefined);
    },

    async pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const signal = options?.signal;
      const metadataOnly = options?.metadataOnly === true;

      if (metadataOnly) await sidecar.setLazyPullActive(true);
      const state = await sidecar.read();

      // Fast path: if local seq matches remote, nothing changed
      const remoteSeq = await getRemoteSeq();
      if (state.lastPulledSeq > 0 && remoteSeq <= state.lastPulledSeq) {
        return 0;
      }

      // Determine which paths to pull
      const scopePrefixes = modelPrefixes(options?.context?.models);
      const result = scopePrefixes.length > 0
        ? await pathsForPrefixes(scopePrefixes)
        : await allPaths();

      const changes = await pullFiles(result.paths, metadataOnly, signal);

      // Only advance seq on unscoped full pulls. Advancing on scoped pulls
      // would cause a subsequent full pull to skip changes outside the scope.
      if (scopePrefixes.length === 0 && !metadataOnly) {
        await sidecar.setLastPulledSeq(remoteSeq);
        await sidecar.setLazyPullActive(false);
      }

      return changes;
    },

    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      const signal = options?.signal;

      let snapshot!: {
        dirtyPaths: string[];
        bulkInvalidated: boolean;
        lastPulledSeq: number;
        lazyPullActive: boolean;
      };
      await sidecar.update((state: SidecarState) => {
        snapshot = {
          dirtyPaths: [...state.dirtyPaths],
          bulkInvalidated: state.bulkInvalidated,
          lastPulledSeq: state.lastPulledSeq,
          lazyPullActive: state.lazyPullActive,
        };
      });

      let changes: number;
      if (snapshot.bulkInvalidated) {
        const diff = await collectFullWalkDiff(signal);
        changes = await applyChanges(diff.toPush, diff.toDelete, signal);
      } else if (snapshot.dirtyPaths.length === 0) {
        return 0;
      } else {
        changes = 0;
        for (const relPath of snapshot.dirtyPaths) {
          signal?.throwIfAborted();
          const diff = await collectOneRelDiff(relPath, signal);
          changes += await applyChanges(diff.toPush, diff.toDelete, signal);
        }
      }

      await sidecar.clearPushed(snapshot);
      return changes;
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      if (isTraversal(relPath)) return false;
      const blobData = await redis.getBuffer(blobKey(prefix, relPath));
      if (!blobData) return false;

      await writeFileAtomic(
        `${cachePath}/${relPath}`,
        new Uint8Array(blobData),
      );
      return true;
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      const signal = options?.signal;

      let snapshot!: {
        dirtyPaths: string[];
        bulkInvalidated: boolean;
        lastPulledSeq: number;
        lazyPullActive: boolean;
      };
      await sidecar.update((state: SidecarState) => {
        snapshot = {
          dirtyPaths: [...state.dirtyPaths],
          bulkInvalidated: state.bulkInvalidated,
          lastPulledSeq: state.lastPulledSeq,
          lazyPullActive: state.lazyPullActive,
        };
      });

      let toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
        [];
      let toDelete: string[] = [];

      if (snapshot.bulkInvalidated) {
        const diff = await collectFullWalkDiff(signal);
        toPush = diff.toPush;
        toDelete = diff.toDelete;
      } else if (snapshot.dirtyPaths.length > 0) {
        for (const relPath of snapshot.dirtyPaths) {
          signal?.throwIfAborted();
          const diff = await collectOneRelDiff(relPath, signal);
          toPush.push(...diff.toPush);
          toDelete.push(...diff.toDelete);
        }
      }

      const internal: InternalPushManifest = { toPush, toDelete, snapshot };
      return internal as unknown as PushManifest;
    },

    async commitPush(
      manifest: PushManifest,
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      const internal = manifest as unknown as InternalPushManifest;
      const signal = options?.signal;

      if (internal.toPush.length === 0 && internal.toDelete.length === 0) {
        await sidecar.clearPushed(internal.snapshot);
        return 0;
      }

      const changes = await applyChanges(
        internal.toPush,
        internal.toDelete,
        signal,
      );

      await sidecar.clearPushed(internal.snapshot);
      return changes;
    },
  };
}

// -- Config --

const TlsConfigSchema = z.union([
  z.literal(false),
  z.literal(true),
  z.object({
    ca: z.string().optional().describe("Path to CA certificate file"),
    rejectUnauthorized: z.boolean().default(true),
  }),
]);

const ConfigSchema = z.object({
  url: z.string().min(1).describe(
    "Valkey/Redis connection URL (redis:// or rediss:// for TLS)",
  ),
  prefix: z.string().default("swamp").describe(
    "Key namespace prefix for all swamp data",
  ),
  db: z.number().int().min(0).max(15).default(0).describe(
    "Redis database number",
  ),
  tls: TlsConfigSchema.default(false).describe(
    "TLS configuration: false (no TLS), true (TLS without CA verify), or object with CA path",
  ),
  password: z.string().optional().describe(
    "Auth password (prefer vault expression for production use)",
  ),
  connectTimeoutMs: z.number().int().positive().default(10_000).describe(
    "Connection timeout in milliseconds",
  ),
  maxRetriesPerRequest: z.number().int().min(0).default(3).describe(
    "Max retries per command before failing",
  ),
});

type ValkeyConfig = z.output<typeof ConfigSchema>;

function createRedisClient(parsed: ValkeyConfig): Redis {
  const opts: Record<string, unknown> = {
    db: parsed.db,
    connectTimeout: parsed.connectTimeoutMs,
    maxRetriesPerRequest: parsed.maxRetriesPerRequest,
    lazyConnect: true,
    enableReadyCheck: true,
  };

  if (parsed.password) {
    opts.password = parsed.password;
  }

  if (parsed.tls === true) {
    opts.tls = {};
  } else if (typeof parsed.tls === "object" && parsed.tls !== null) {
    const tlsOpts: Record<string, unknown> = {
      rejectUnauthorized: parsed.tls.rejectUnauthorized,
    };
    if (parsed.tls.ca) {
      tlsOpts.ca = Deno.readTextFileSync(parsed.tls.ca);
    }
    opts.tls = tlsOpts;
  }

  return new Redis(parsed.url, opts);
}

// -- Exported provider --

/**
 * Valkey/Redis datastore provider for swamp.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * datastore:
 *   type: "@webframp/valkey-datastore"
 *   config:
 *     url: "redis://localhost:6379"
 *     prefix: "swamp"
 * ```
 */
export const datastore = {
  type: "@webframp/valkey-datastore",
  name: "Valkey Datastore",
  description:
    "Stores swamp runtime data in Valkey/Redis with sorted-set path indexing " +
    "and SET NX distributed locking. Compatible with local Valkey, AWS " +
    "ElastiCache Serverless, and AWS MemoryDB.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>): DatastoreProvider => {
    const parsed = ConfigSchema.parse(config);
    const redis = createRedisClient(parsed);

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createValkeyLock(redis, parsed.prefix, datastorePath, options);
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            const pong = await redis.ping();
            if (pong !== "PONG") {
              return {
                healthy: false,
                message: `Unexpected PING response: ${pong}`,
                latencyMs: Math.round(performance.now() - start),
                datastoreType: "@webframp/valkey-datastore",
              };
            }
            const info = await redis.info("server");
            const versionMatch = info.match(/(?:redis|valkey)_version:(.+)/);
            const version = versionMatch ? versionMatch[1].trim() : "unknown";
            return {
              healthy: true,
              message: "OK",
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/valkey-datastore",
              details: {
                version,
                prefix: parsed.prefix,
                db: String(parsed.db),
              },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/valkey-datastore",
            };
          }
        },
      }),

      createSyncService: (
        _repoDir: string,
        cachePath: string,
      ): TwoPhaseSyncService => {
        return createSyncService(redis, parsed.prefix, cachePath);
      },

      resolveDatastorePath: (_repoDir: string): string =>
        `valkey://${parsed.prefix}`,

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },
    };
  },
};
