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

import { z } from "npm:zod@4.4.3";
import { Redis } from "npm:ioredis@5.11.1";
import { Buffer } from "node:buffer";
import { Sidecar } from "./sidecar.ts";
import type { SidecarState } from "./sidecar.ts";
import {
  Attr,
  commandSpan,
  pipelineSpan,
  recordPipelineResults,
  recordRetry,
  withSpan,
} from "./_lib/tracing.ts";

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

/**
 * Outcome of a push. `changes` counts every successful command group (writes
 * plus deletes) and is what the public API returns; `pushed` and `deleted` are
 * tracked separately so span attributes report each honestly.
 */
interface PushCounts {
  changes: number;
  pushed: number;
  deleted: number;
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

/**
 * Escape glob metacharacters for use in Redis MATCH patterns.
 * Characters `*`, `?`, `[`, `]`, and `\` are prefixed with a backslash.
 */
function escapeMatchPattern(pattern: string): string {
  return pattern.replace(/([*?[\]\\])/g, "\\$1");
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
    return await withSpan("valkey-datastore lock acquire", {
      [Attr.LOCK_KEY]: key,
      [Attr.LOCK_TIMEOUT_MS]: maxWaitMs,
      [Attr.LOCK_TTL_MS]: ttlMs,
    }, async (span) => {
      if (nonce !== undefined) {
        throw new Error("Lock already acquired; call release() first");
      }
      const start = Date.now();
      const candidate = crypto.randomUUID();
      let contended = false;
      let attempt = 0;

      let hostname = "unknown";
      try {
        hostname = Deno.hostname();
      } catch {
        // --allow-sys not granted; fall back gracefully
      }

      while (Date.now() - start < maxWaitMs) {
        const result = await commandSpan(
          "SET",
          key,
          () =>
            redis.set(
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
            ),
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
          // Unref so a held lock doesn't keep the process alive if release is
          // never called — the same convention the other datastore locks
          // follow.
          Deno.unrefTimer(heartbeatId);
          span.setAttributes({
            [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
            [Attr.LOCK_CONTENDED]: contended,
          });
          return;
        }

        contended = true;
        attempt++;
        recordRetry(attempt, retryIntervalMs, {
          "retry.reason": "lock_contended",
        });
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }

      span.setAttributes({
        [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
        [Attr.LOCK_CONTENDED]: contended,
      });
      throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
    });
  };

  const release = async () => {
    return await withSpan("valkey-datastore lock release", {
      [Attr.LOCK_KEY]: key,
    }, async () => {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId);
        heartbeatId = undefined;
      }
      if (nonce) {
        const releaseNonce = nonce;
        try {
          await commandSpan(
            "EVAL",
            key,
            () => redis.call("EVAL", RELEASE_LOCK_LUA, 1, key, releaseNonce),
          );
        } catch {
          // Connection may be dead — lock will expire via TTL
        }
        nonce = undefined;
      }
    });
  };

  return {
    acquire,
    release,

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      return await withSpan("valkey-datastore lock withLock", {
        [Attr.LOCK_KEY]: key,
      }, async () => {
        await acquire();
        try {
          return await fn();
        } finally {
          await release();
        }
      });
    },

    inspect: async () => {
      return await withSpan("valkey-datastore lock inspect", {
        [Attr.LOCK_KEY]: key,
      }, async (span) => {
        const raw = await commandSpan("GET", key, () => redis.get(key));
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.holder) {
            span.setAttribute(
              Attr.LOCK_HOLDER,
              `${parsed.holder} (pid ${parsed.pid})`,
            );
          }
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
      });
    },

    forceRelease: async (expectedNonce: string) => {
      return await withSpan("valkey-datastore lock forceRelease", {
        [Attr.LOCK_KEY]: key,
      }, async () => {
        const result = await commandSpan(
          "EVAL",
          key,
          () =>
            redis.call(
              "EVAL",
              RELEASE_LOCK_LUA,
              1,
              key,
              expectedNonce,
            ),
        );
        const released = result === 1;
        // If this instance itself held that lock, drop its local state too.
        // Leaving the heartbeat running would keep extending the TTL of a key
        // this object no longer owns, and keeps the interval alive for the
        // lifetime of the process.
        if (released && nonce === expectedNonce) {
          if (heartbeatId !== undefined) {
            clearInterval(heartbeatId);
            heartbeatId = undefined;
          }
          nonce = undefined;
        }
        return released;
      });
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
    const val = await commandSpan("GET", seq, () => redis.get(seq));
    return val ? parseInt(val, 10) : 0;
  }

  const PATH_LIMIT = 50_000;

  async function pathsForPrefixes(
    prefixes: string[],
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const seen = new Set<string>();
    const results: string[] = [];
    let truncated = false;
    for (const p of prefixes) {
      const remaining = PATH_LIMIT - results.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // With varying scores, ZRANGEBYLEX is unreliable. Use ZSCAN with a
      // glob pattern to find members matching the prefix.
      const escaped = escapeMatchPattern(p);
      let cursor = "0";
      do {
        const [nextCursor, members] = await commandSpan(
          "ZSCAN",
          pathIdx,
          () =>
            redis.zscan(
              pathIdx,
              cursor,
              "MATCH",
              `${escaped}*`,
              "COUNT",
              500,
            ),
        );
        cursor = nextCursor;
        // zscan returns [member, score, member, score, ...]
        for (let i = 0; i < members.length; i += 2) {
          const path = members[i];
          if (!seen.has(path)) {
            seen.add(path);
            results.push(path);
            if (results.length >= PATH_LIMIT) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
      } while (cursor !== "0");
      if (truncated) break;
    }
    // Filter out soft-deleted entries
    const alive = await filterDeleted(results);
    // Only report truncated if live count still hits the limit after filtering.
    const actuallyTruncated = truncated && alive.length >= PATH_LIMIT;
    return { paths: alive, truncated: actuallyTruncated };
  }

  /**
   * Filters out paths whose metadata has `deleted: "true"`. Used by allPaths
   * and pathsForPrefixes to exclude soft-deleted entries from listing.
   */
  async function filterDeleted(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const BATCH = 200;
    const alive: string[] = [];
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);
      const pipeline = redis.pipeline();
      for (const p of batch) {
        pipeline.hget(metaKey(prefix, p), "deleted");
      }
      const results = await pipelineSpan(
        "filterDeleted",
        batch.length,
        async (span) => {
          const r = await pipeline.exec();
          recordPipelineResults(span, r);
          return r;
        },
      );
      if (results) {
        for (let j = 0; j < batch.length; j++) {
          const [err, val] = results[j];
          if (err || val === "true") continue;
          alive.push(batch[j]);
        }
      } else {
        // Pipeline failed entirely — exclude all paths as a safe fallback.
        // Including tombstoned paths would resurface deleted files.
      }
    }
    return alive;
  }

  async function allPaths(): Promise<{ paths: string[]; truncated: boolean }> {
    // With varying scores, ZRANGEBYLEX is unreliable. Use ZRANGEBYSCORE
    // over the full range to enumerate all members.
    const raw = await commandSpan(
      "ZRANGEBYSCORE",
      pathIdx,
      () =>
        redis.zrangebyscore(
          pathIdx,
          "-inf",
          "+inf",
          "LIMIT",
          0,
          PATH_LIMIT + 1,
        ),
    );
    const rawTruncated = raw.length > PATH_LIMIT;
    if (rawTruncated) raw.length = PATH_LIMIT;

    // Filter out soft-deleted entries by checking metadata
    const paths = await filterDeleted(raw);
    // Only report truncated if the live count still exceeds the limit.
    // A repo with many tombstones should not trigger truncation for live paths.
    const truncated = rawTruncated && paths.length >= PATH_LIMIT;
    return { paths, truncated };
  }

  /**
   * Returns paths whose score (write-seq) is strictly greater than `sinceSeq`.
   * Used by pullChanged to fetch only paths that changed since the last pull.
   */
  async function changedPathsSince(
    sinceSeq: number,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const paths = await commandSpan(
      "ZRANGEBYSCORE",
      pathIdx,
      () =>
        redis.zrangebyscore(
          pathIdx,
          `(${sinceSeq}`,
          "+inf",
          "LIMIT",
          0,
          PATH_LIMIT + 1,
        ),
    );
    const truncated = paths.length > PATH_LIMIT;
    if (truncated) paths.length = PATH_LIMIT;
    return { paths, truncated };
  }

  async function pullFiles(
    paths: string[],
    metadataOnly: boolean,
    signal?: AbortSignal,
  ): Promise<{ changes: number; skipped: number }> {
    let changes = 0;
    let skipped = 0;
    const BATCH = 100;

    for (let i = 0; i < paths.length; i += BATCH) {
      signal?.throwIfAborted();
      const batch = paths.slice(i, i + BATCH);

      // Fetch metadata for all paths in batch
      const pipeline = redis.pipeline();
      for (const relPath of batch) {
        pipeline.hgetall(metaKey(prefix, relPath));
      }
      const metaResults = await pipelineSpan(
        "fetchMetadata",
        batch.length,
        async (span) => {
          const r = await pipeline.exec();
          recordPipelineResults(span, r);
          return r;
        },
      );
      if (!metaResults) {
        skipped += batch.length;
        continue;
      }

      for (let j = 0; j < batch.length; j++) {
        signal?.throwIfAborted();
        const relPath = batch[j];
        const [err, meta] = metaResults[j];
        if (err || !meta || typeof meta !== "object") {
          // A metadata read that failed is not a file that was up to date —
          // count it so pullChanged can report an incomplete pull.
          skipped++;
          continue;
        }

        const remoteMeta = meta as Record<string, string>;

        // Handle soft-deleted paths: remove local file if it exists
        if (remoteMeta.deleted === "true") {
          const localPath = `${cachePath}/${relPath}`;
          try {
            await Deno.remove(localPath);
            changes++;
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
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
        const blobData = await commandSpan(
          "GET",
          blobKey(prefix, relPath),
          () => redis.getBuffer(blobKey(prefix, relPath)),
        );
        if (!blobData) continue;

        await writeFileAtomic(localPath, new Uint8Array(blobData));
        changes++;
      }
    }

    return { changes, skipped };
  }

  async function collectFullWalkDiff(
    signal?: AbortSignal,
  ): Promise<{
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
    toDelete: string[];
  }> {
    const { paths: allRemote, truncated } = await allPaths();
    if (truncated) {
      throw new Error(
        `Remote path index exceeds ${PATH_LIMIT} entries; full diff is unsafe`,
      );
    }
    const remotePaths = new Set(allRemote);

    // Walk local cache first to determine which files exist locally.
    const localFiles = new Map<
      string,
      { hash: string; bytes: Uint8Array }
    >();

    for (const sub of DATASTORE_SUBDIRS) {
      signal?.throwIfAborted();
      await walkCache(
        `${cachePath}/${sub}`,
        sub,
        async (relPath, bytes) => {
          signal?.throwIfAborted();
          const hash = await sha256Hex(bytes);
          localFiles.set(relPath, { hash, bytes });
        },
        signal,
      );
    }

    // Only fetch remote hashes for paths that exist BOTH locally and remotely.
    // New local files (not in remote) need no comparison — they always push.
    // Remote-only files (not local) are deletions — no hash needed.
    const intersection = [...localFiles.keys()].filter((p) =>
      remotePaths.has(p)
    );
    const remoteHashes = new Map<string, string>();

    if (intersection.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < intersection.length; i += BATCH) {
        signal?.throwIfAborted();
        const batch = intersection.slice(i, i + BATCH);
        const pipeline = redis.pipeline();
        for (const p of batch) {
          pipeline.hget(metaKey(prefix, p), "sha256");
        }
        const results = await pipelineSpan(
          "fetchHashes",
          batch.length,
          async (span) => {
            const r = await pipeline.exec();
            recordPipelineResults(span, r);
            return r;
          },
        );
        if (results) {
          for (let j = 0; j < batch.length; j++) {
            const [err, hash] = results[j];
            if (!err && hash) remoteHashes.set(batch[j], hash as string);
          }
        }
      }
    }

    // Diff: local files whose hash differs from remote (or are new)
    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];
    for (const [relPath, { hash, bytes }] of localFiles) {
      if (remoteHashes.get(relPath) === hash) continue;
      toPush.push({ relPath, hash, bytes });
    }

    // Files in remote but not local = tombstones
    const localPathSet = new Set(localFiles.keys());
    const toDelete: string[] = [];
    for (const remotePath of remotePaths) {
      if (!localPathSet.has(remotePath)) {
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

    // Fetch remote state: ZSCAN with pattern for directories, point lookup otherwise
    let remotePaths: string[];
    if (stat?.isDirectory) {
      remotePaths = [];
      const escaped = escapeMatchPattern(relPath);
      let cursor = "0";
      do {
        const [nextCursor, members] = await commandSpan(
          "ZSCAN",
          pathIdx,
          () =>
            redis.zscan(
              pathIdx,
              cursor,
              "MATCH",
              `${escaped}/*`,
              "COUNT",
              500,
            ),
        );
        cursor = nextCursor;
        for (let i = 0; i < members.length; i += 2) {
          remotePaths.push(members[i]);
          if (remotePaths.length >= PATH_LIMIT) break;
        }
        if (remotePaths.length >= PATH_LIMIT) break;
      } while (cursor !== "0");
      // Also include the exact relPath itself if it exists as a file
      const exactScore = await commandSpan(
        "ZSCORE",
        pathIdx,
        () => redis.zscore(pathIdx, relPath),
      );
      if (exactScore !== null && !remotePaths.includes(relPath)) {
        remotePaths.push(relPath);
      }
      // Filter out tombstoned paths — they should not appear in toDelete
      // or trigger re-scoring (which would refresh their seq indefinitely).
      remotePaths = await filterDeleted(remotePaths);
    } else {
      const score = await commandSpan(
        "ZSCORE",
        pathIdx,
        () => redis.zscore(pathIdx, relPath),
      );
      if (score !== null) {
        // Check if it's a tombstone
        const alive = await filterDeleted([relPath]);
        remotePaths = alive.length > 0 ? [relPath] : [];
      } else {
        remotePaths = [];
      }
    }

    const remoteHashes = new Map<string, string>();
    if (remotePaths.length > 0) {
      const pipeline = redis.pipeline();
      for (const p of remotePaths) {
        pipeline.hget(metaKey(prefix, p), "sha256");
      }
      const results = await pipelineSpan(
        "fetchHashes",
        remotePaths.length,
        async (span) => {
          const r = await pipeline.exec();
          recordPipelineResults(span, r);
          return r;
        },
      );
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
  ): Promise<PushCounts> {
    if (toPush.length === 0 && toDelete.length === 0) {
      return { changes: 0, pushed: 0, deleted: 0 };
    }

    // Read current seq to compute the intended score for this write batch.
    // INCR first so each concurrent writer gets a unique seq. A wasted seq on
    // crash is acceptable — seq gaps don't affect correctness (ZRANGEBYSCORE
    // with exclusive lower bound handles them transparently).
    const writeSeq = await commandSpan("INCR", seq, () => redis.incr(seq));

    // Pipeline all writes for one round trip per batch
    const BATCH = 50;
    let changes = 0;
    let pushed = 0;
    let deleted = 0;

    const failedPaths: string[] = [];
    const CMDS_PER_FILE = 3;

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
        // Score = writeSeq so pull can ZRANGEBYSCORE to find recent changes
        pipeline.zadd(pathIdx, writeSeq, f.relPath);
      }

      const results = await pipelineSpan(
        "writeFiles",
        batch.length * CMDS_PER_FILE,
        async (span) => {
          const r = await pipeline.exec();
          recordPipelineResults(span, r);
          return r;
        },
      );
      if (results) {
        for (let j = 0; j < batch.length; j++) {
          const base = j * CMDS_PER_FILE;
          const hasError = results.slice(base, base + CMDS_PER_FILE).some(
            ([err]) => err !== null,
          );
          if (hasError) failedPaths.push(batch[j].relPath);
          else {
            changes++;
            pushed++;
          }
        }
      }
    }

    // Delete tombstones — keep path in sorted set scored at writeSeq with
    // deleted: "true" metadata so incremental pull (ZRANGEBYSCORE) discovers
    // the deletion and removes local files.
    if (toDelete.length > 0) {
      const pipeline = redis.pipeline();
      for (const relPath of toDelete) {
        signal?.throwIfAborted();
        pipeline.del(blobKey(prefix, relPath));
        pipeline.hset(metaKey(prefix, relPath), {
          deleted: "true",
        });
        pipeline.zadd(pathIdx, writeSeq, relPath);
      }
      const delResults = await pipelineSpan(
        "deleteFiles",
        toDelete.length * CMDS_PER_FILE,
        async (span) => {
          const r = await pipeline.exec();
          recordPipelineResults(span, r);
          return r;
        },
      );
      if (delResults) {
        for (let j = 0; j < toDelete.length; j++) {
          const base = j * CMDS_PER_FILE;
          const hasError = delResults.slice(base, base + CMDS_PER_FILE).some(
            ([err]) => err !== null,
          );
          if (hasError) failedPaths.push(toDelete[j]);
          else {
            changes++;
            deleted++;
          }
        }
      }
    }

    if (failedPaths.length > 0) {
      throw new Error(
        `Pipeline errors on ${failedPaths.length} path(s): ${
          failedPaths.slice(0, 5).join(", ")
        }`,
      );
    }

    // Tombstone GC: evict tombstones whose score is older than
    // TOMBSTONE_RETENTION_SEQS behind the current seq. Clients that haven't
    // pulled in that many pushes fall back to a full sync via the watermark.
    const TOMBSTONE_RETENTION_SEQS = 1000;
    const gcThreshold = writeSeq - TOMBSTONE_RETENTION_SEQS;
    if (gcThreshold > 0) {
      // Find old tombstones by score range, then verify they're actually deleted
      const oldPaths = await commandSpan(
        "ZRANGEBYSCORE",
        pathIdx,
        () => redis.zrangebyscore(pathIdx, "-inf", String(gcThreshold)),
      );
      if (oldPaths.length > 0) {
        // Check which are tombstones (deleted: "true")
        const pipeline = redis.pipeline();
        for (const p of oldPaths) {
          pipeline.hget(metaKey(prefix, p), "deleted");
        }
        const gcResults = await pipeline.exec();
        if (gcResults) {
          const toEvict: string[] = [];
          for (let i = 0; i < oldPaths.length; i++) {
            const [err, val] = gcResults[i];
            if (!err && val === "true") toEvict.push(oldPaths[i]);
          }
          if (toEvict.length > 0) {
            const gcPipeline = redis.pipeline();
            for (const p of toEvict) {
              gcPipeline.zrem(pathIdx, p);
              gcPipeline.del(metaKey(prefix, p));
            }
            await gcPipeline.exec();
          }
        }
      }
    }

    return { changes, pushed, deleted };
  }

  return {
    capabilities(): SyncCapabilities {
      return { scopedSync: true, lazyHydration: true, twoPhaseSync: true };
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      return sidecar.recordDirty(options?.relPath).then(() => undefined);
    },

    async pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const scopePrefixes = modelPrefixes(options?.context?.models);
      const scoped = scopePrefixes.length > 0;
      return await withSpan("valkey-datastore pullChanged", {
        [Attr.DATASTORE_SCOPED]: scoped,
        [Attr.DATASTORE_METADATA_ONLY]: options?.metadataOnly === true,
      }, async (span) => {
        const signal = options?.signal;
        const metadataOnly = options?.metadataOnly === true;

        if (metadataOnly) await sidecar.setLazyPullActive(true);
        const state = await sidecar.read();

        // Fast path: if local seq matches remote, nothing changed
        const remoteSeq = await getRemoteSeq();
        span.setAttribute(Attr.DATASTORE_SEQ, remoteSeq);
        if (state.lastPulledSeq > 0 && remoteSeq <= state.lastPulledSeq) {
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: true,
            [Attr.DATASTORE_FILES_PULLED]: 0,
          });
          return 0;
        }

        // Determine which paths to pull.
        // When we have a prior seq, use score-based range to fetch only
        // paths changed since last pull (O(changed) instead of O(total)).
        let result: { paths: string[]; truncated: boolean };
        if (scoped) {
          result = await pathsForPrefixes(scopePrefixes);
        } else if (state.lastPulledSeq > 0) {
          result = await changedPathsSince(state.lastPulledSeq);
        } else {
          result = await allPaths();
        }

        if (result.truncated) {
          throw new Error(
            `Pull path set exceeds ${PATH_LIMIT} entries; ` +
              "use scoped sync or reduce change volume between pulls",
          );
        }

        span.setAttributes({
          [Attr.DATASTORE_PATHS]: result.paths.length,
          [Attr.DATASTORE_TRUNCATED]: result.truncated,
        });

        const { changes, skipped } = await pullFiles(
          result.paths,
          metadataOnly,
          signal,
        );

        // Only advance seq on unscoped full pulls. Advancing on scoped pulls
        // would cause a subsequent full pull to skip changes outside the scope.
        if (!scoped && !metadataOnly) {
          await sidecar.setLastPulledSeq(remoteSeq);
          await sidecar.setLazyPullActive(false);
        }

        span.setAttributes({
          [Attr.DATASTORE_FAST_PATH_HIT]: false,
          [Attr.DATASTORE_FILES_PULLED]: changes,
          [Attr.DATASTORE_FILES_SKIPPED]: skipped,
        });
        return changes;
      });
    },

    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      return await withSpan(
        "valkey-datastore pushChanged",
        {},
        async (span) => {
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
          let pushed = 0;
          let deleted = 0;
          if (snapshot.bulkInvalidated) {
            const diff = await collectFullWalkDiff(signal);
            const counts = await applyChanges(
              diff.toPush,
              diff.toDelete,
              signal,
            );
            changes = counts.changes;
            pushed = counts.pushed;
            deleted = counts.deleted;
          } else if (snapshot.dirtyPaths.length === 0) {
            span.setAttributes({
              [Attr.DATASTORE_FAST_PATH_HIT]: true,
              [Attr.DATASTORE_FILES_PUSHED]: 0,
              [Attr.DATASTORE_FILES_DELETED]: 0,
            });
            return 0;
          } else {
            // Batch: collect all diffs first, then apply in one pass to
            // reduce from N pipeline flushes to 1-3.
            const allToPush: Array<
              { relPath: string; hash: string; bytes: Uint8Array }
            > = [];
            const allToDelete: string[] = [];
            await Promise.all(
              snapshot.dirtyPaths.map(async (relPath) => {
                signal?.throwIfAborted();
                const diff = await collectOneRelDiff(relPath, signal);
                // Push results into shared arrays after each resolves.
                // No mutex needed — array push is safe here because we only
                // append and never read until all promises settle.
                allToPush.push(...diff.toPush);
                allToDelete.push(...diff.toDelete);
              }),
            );
            const counts = await applyChanges(
              allToPush,
              allToDelete,
              signal,
            );
            changes = counts.changes;
            pushed = counts.pushed;
            deleted = counts.deleted;
          }

          await sidecar.clearPushed(snapshot);
          // `changes` counts writes and deletes together, so the file counts
          // are tracked separately to keep each attribute honest.
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: false,
            [Attr.DATASTORE_FILES_PUSHED]: pushed,
            [Attr.DATASTORE_FILES_DELETED]: deleted,
          });
          return changes;
        },
      );
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      return await withSpan("valkey-datastore hydrateFile", {
        [Attr.DATASTORE_FILE]: relPath,
      }, async (span) => {
        if (isTraversal(relPath)) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }
        const blobData = await commandSpan(
          "GET",
          blobKey(prefix, relPath),
          () => redis.getBuffer(blobKey(prefix, relPath)),
        );
        if (!blobData) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }

        await writeFileAtomic(
          `${cachePath}/${relPath}`,
          new Uint8Array(blobData),
        );
        span.setAttribute(Attr.DATASTORE_HYDRATED, true);
        return true;
      });
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      return await withSpan(
        "valkey-datastore preparePush",
        {},
        async (span) => {
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

          let toPush: Array<
            { relPath: string; hash: string; bytes: Uint8Array }
          > = [];
          let toDelete: string[] = [];

          if (snapshot.bulkInvalidated) {
            const diff = await collectFullWalkDiff(signal);
            toPush = diff.toPush;
            toDelete = diff.toDelete;
          } else if (snapshot.dirtyPaths.length > 0) {
            await Promise.all(
              snapshot.dirtyPaths.map(async (relPath) => {
                signal?.throwIfAborted();
                const diff = await collectOneRelDiff(relPath, signal);
                toPush.push(...diff.toPush);
                toDelete.push(...diff.toDelete);
              }),
            );
          }

          span.setAttributes({
            [Attr.DATASTORE_FILES_PLANNED_PUSH]: toPush.length,
            [Attr.DATASTORE_FILES_PLANNED_DELETE]: toDelete.length,
          });

          const internal: InternalPushManifest = {
            toPush,
            toDelete,
            snapshot,
          };
          return internal as unknown as PushManifest;
        },
      );
    },

    async commitPush(
      manifest: PushManifest,
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      const internal = manifest as unknown as InternalPushManifest;
      return await withSpan("valkey-datastore commitPush", {
        [Attr.DATASTORE_FILES_PLANNED_PUSH]: internal.toPush.length,
        [Attr.DATASTORE_FILES_PLANNED_DELETE]: internal.toDelete.length,
      }, async (span) => {
        const signal = options?.signal;

        if (internal.toPush.length === 0 && internal.toDelete.length === 0) {
          await sidecar.clearPushed(internal.snapshot);
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: true,
            [Attr.DATASTORE_FILES_PUSHED]: 0,
            [Attr.DATASTORE_FILES_DELETED]: 0,
          });
          return 0;
        }

        const counts = await applyChanges(
          internal.toPush,
          internal.toDelete,
          signal,
        );

        await sidecar.clearPushed(internal.snapshot);
        span.setAttributes({
          [Attr.DATASTORE_FAST_PATH_HIT]: false,
          [Attr.DATASTORE_FILES_PUSHED]: counts.pushed,
          [Attr.DATASTORE_FILES_DELETED]: counts.deleted,
        });
        return counts.changes;
      });
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
      try {
        tlsOpts.ca = Deno.readTextFileSync(parsed.tls.ca);
      } catch (err) {
        throw new Error(
          `Failed to read TLS CA file "${parsed.tls.ca}": ${err}`,
        );
      }
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
            const pong = await commandSpan(
              "PING",
              undefined,
              () => redis.ping(),
            );
            if (pong !== "PONG") {
              return {
                healthy: false,
                message: `Unexpected PING response: ${pong}`,
                latencyMs: Math.round(performance.now() - start),
                datastoreType: "@webframp/valkey-datastore",
              };
            }
            const info = await commandSpan(
              "INFO",
              undefined,
              () => redis.info("server"),
            );
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
