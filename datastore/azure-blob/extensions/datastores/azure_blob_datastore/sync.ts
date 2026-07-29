// ABOUTME: Azure Blob sync service — shard-first _index/ path index with ETag
// ABOUTME: CAS, single-blob-per-file content storage (no chunking needed —
// ABOUTME: unlike DynamoDB, Blob Storage has no small per-item size ceiling).
// ABOUTME: Targeted shard fetch for dirty-path pushes, parallel blob uploads
// ABOUTME: with bounded concurrency, batched shard CAS, and commitSeq counter.

import type { BlobClient, BlobResponse } from "./rest_client.ts";
import { retryableRequest } from "./_lib/retry.ts";
import { Attr, recordRetry, withSpan } from "./_lib/tracing.ts";
import { Sidecar } from "./sidecar.ts";

export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  twoPhaseSync?: boolean;
}

export interface DatastoreSyncOptions {
  signal?: AbortSignal;
  relPath?: string;
  context?: SyncContext;
  metadataOnly?: boolean;
}

export interface DatastoreSyncService {
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
export type PushManifest = { readonly [PushManifestBrand]: true };

interface FileEntry {
  relPath: string;
  hash: string;
  bytes: Uint8Array;
}

interface ShardEntry {
  hash: string;
  size: number;
  updatedAt: string;
  deletedAt: string | null;
}

type ShardMap = Record<string, ShardEntry>;

interface InternalPushManifest {
  toPush: FileEntry[];
  toTombstone: string[];
  snapshot: {
    dirtyPaths: string[];
    bulkInvalidated: boolean;
    lastPulledAt: string | null;
    lazyPullActive: boolean;
  };
}

export interface TwoPhaseSyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<PushManifest>;
  commitPush(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

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

/** 256-shard bucket, keyed by the first byte of sha256(relPath). */
async function shardKey(relPath: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(relPath));
  return hash.slice(0, 2);
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

async function walkAndCollect(
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
      const childRel = `${relRoot}/${entry.name}`;
      if (entry.isDirectory) {
        await walkAndCollect(childAbs, childRel, onFile, signal);
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

/** Hand-rolled XML extraction, scoped to blob names under our own _index/
 * prefix — those names are fixed hex shard keys we generate ourselves, never
 * user-controlled content, so this never needs to handle XML-escaped input. */
function parseListBlobsResponse(
  xml: string,
): { names: string[]; nextMarker: string | null } {
  const names: string[] = [];
  const blobRegex = /<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/Blob>/g;
  for (const match of xml.matchAll(blobRegex)) {
    names.push(match[1]);
  }
  const markerMatch = xml.match(/<NextMarker>(.*?)<\/NextMarker>/);
  const nextMarker = markerMatch && markerMatch[1] ? markerMatch[1] : null;
  return { names, nextMarker };
}

/**
 * Runs an async operation on each item with bounded concurrency.
 * At most `limit` operations execute simultaneously.
 */
async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(
      (async () => {
        while (idx < items.length) {
          const current = idx++;
          if (current >= items.length) break;
          await fn(items[current]);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

export function createSyncService(
  client: BlobClient,
  container: string,
  prefix: string,
  cachePath: string,
): TwoPhaseSyncService {
  const sidecar = new Sidecar(cachePath);

  function blobPath(relPath: string): string {
    return `/${container}/${prefix}/${relPath}`;
  }

  function shardPath(shard: string): string {
    return `/${container}/${prefix}/_index/${shard}.json`;
  }

  function watermarkPath(): string {
    return `/${container}/${prefix}/_meta/last_pushed_at`;
  }

  function commitSeqPath(): string {
    return `/${container}/${prefix}/_meta/commit_seq`;
  }

  async function listIndexShards(): Promise<string[]> {
    return await withSpan(
      "azure-blob-datastore listIndexShards",
      {},
      async (span) => {
        const names: string[] = [];
        let marker: string | undefined;
        const listPrefix = `${prefix}/_index/`;
        do {
          const resp = await retryableRequest(() =>
            client.request({
              op: "listBlobs",
              method: "GET",
              path: `/${container}`,
              query: {
                restype: "container",
                comp: "list",
                prefix: listPrefix,
                ...(marker ? { marker } : {}),
              },
            })
          );
          if (resp.status !== 200) {
            throw new Error(`List blobs failed (${resp.status})`);
          }
          const { names: pageNames, nextMarker } = parseListBlobsResponse(
            new TextDecoder().decode(resp.body),
          );
          names.push(...pageNames);
          marker = nextMarker ?? undefined;
        } while (marker);
        span.setAttribute(Attr.DATASTORE_SHARDS, names.length);
        return names;
      },
    );
  }

  async function getShard(
    shard: string,
  ): Promise<{ map: ShardMap; etag: string | null }> {
    const resp = await retryableRequest(() =>
      client.request({ op: "getShard", method: "GET", path: shardPath(shard) })
    );
    if (resp.status === 404) return { map: {}, etag: null };
    if (resp.status !== 200) {
      throw new Error(`Get shard ${shard} failed (${resp.status})`);
    }
    const map = JSON.parse(new TextDecoder().decode(resp.body)) as ShardMap;
    return { map, etag: resp.headers.get("etag") };
  }

  async function updateShard(
    shard: string,
    mutator: (map: ShardMap) => ShardMap,
  ): Promise<void> {
    return await withSpan("azure-blob-datastore updateShard", {
      [Attr.DATASTORE_SHARD]: shard,
    }, async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const { map, etag } = await getShard(shard);
        const updated = mutator(map);
        const body = new TextEncoder().encode(JSON.stringify(updated));
        const resp: BlobResponse = await retryableRequest(() =>
          client.request({
            op: "putShard",
            method: "PUT",
            path: shardPath(shard),
            headers: {
              "x-ms-blob-type": "BlockBlob",
              ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
            },
            body,
          })
        );
        if (resp.status === 201 || resp.status === 200) return;
        if (resp.status === 412) {
          // ETag conflict — re-read and retry. This loop is separate from
          // retryableRequest, so the retry event is recorded here too.
          recordRetry(attempt + 1, 0, {
            "retry.reason": "etag_conflict",
            "http.response.status_code": resp.status,
          });
          continue;
        }
        throw new Error(`Update shard ${shard} failed (${resp.status})`);
      }
      throw new Error(
        `Update shard ${shard} exhausted retries on ETag conflict`,
      );
    });
  }

  async function queryAllFileMeta(
    prefixFilter?: string,
  ): Promise<Map<string, ShardEntry>> {
    return await withSpan(
      "azure-blob-datastore queryAllFileMeta",
      {},
      async (span) => {
        const shardBlobNames = await listIndexShards();
        const shards = shardBlobNames.map((name) =>
          name.slice(`${prefix}/_index/`.length, -".json".length)
        );
        // Shard fetches are independent — run them concurrently instead of one
        // round trip at a time, since every sync operation is on this hot path.
        const maps = await Promise.all(shards.map((shard) => getShard(shard)));
        const out = new Map<string, ShardEntry>();
        for (const { map } of maps) {
          for (const [relPath, entry] of Object.entries(map)) {
            if (prefixFilter && !relPath.startsWith(prefixFilter)) continue;
            out.set(relPath, entry);
          }
        }
        span.setAttributes({
          [Attr.DATASTORE_SHARDS]: shards.length,
          [Attr.DATASTORE_ENTRIES]: out.size,
        });
        return out;
      },
    );
  }

  /**
   * Targeted shard fetch: compute shard keys for the given paths (including
   * directory prefixes), fetch only those shards, and return entries that
   * match the requested paths. This avoids downloading all 256 shards when
   * we only need metadata for a handful of known dirty paths.
   */
  async function queryShardsByPaths(
    relPaths: string[],
  ): Promise<Map<string, ShardEntry>> {
    return await withSpan(
      "azure-blob-datastore queryShardsByPaths",
      {},
      async (span) => {
        // For specific file paths, compute shard keys directly. For directory
        // prefixes, we can't know which shards contain children — fall back to
        // fetching all shards only for directory entries. But first, stat each
        // path to determine if it's a file or directory.
        const shardKeysNeeded = new Set<string>();
        const pathFilters = relPaths;

        // Compute shard keys for each path (treating each as a potential file).
        // For directory prefixes, the files underneath have their own shard keys
        // which we can't predict without listing them locally first.
        const localFiles: string[] = [];
        for (const relPath of relPaths) {
          if (isTraversal(relPath)) continue;
          const absPath = `${cachePath}/${relPath}`;
          let stat: Deno.FileInfo | null = null;
          try {
            stat = await Deno.stat(absPath);
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
          if (stat?.isFile) {
            localFiles.push(relPath);
            shardKeysNeeded.add(await shardKey(relPath));
          } else if (stat?.isDirectory) {
            // Walk the directory to find all files and their shard keys.
            await walkAndCollect(absPath, relPath, async (childRel, _bytes) => {
              localFiles.push(childRel);
              shardKeysNeeded.add(await shardKey(childRel));
            });
          } else {
            // Path doesn't exist locally (maybe deleted) — still compute its
            // shard to find its remote metadata for tombstoning.
            shardKeysNeeded.add(await shardKey(relPath));
          }
        }

        const shardKeys = [...shardKeysNeeded];
        const maps = await Promise.all(
          shardKeys.map((shard) => getShard(shard)),
        );
        const out = new Map<string, ShardEntry>();
        for (const { map } of maps) {
          for (const [relPath, entry] of Object.entries(map)) {
            if (
              pathFilters.some((p) =>
                relPath === p || relPath.startsWith(`${p}/`)
              )
            ) {
              out.set(relPath, entry);
            }
          }
        }
        span.setAttributes({
          [Attr.DATASTORE_SHARDS]: shardKeys.length,
          [Attr.DATASTORE_ENTRIES]: out.size,
        });
        return out;
      },
    );
  }

  async function fetchContent(relPath: string): Promise<Uint8Array> {
    const resp = await retryableRequest(() =>
      client.request({ op: "getBlob", method: "GET", path: blobPath(relPath) })
    );
    if (resp.status !== 200) {
      throw new Error(`Get blob ${relPath} failed (${resp.status})`);
    }
    return resp.body;
  }

  async function writeWatermark(): Promise<void> {
    await retryableRequest(() =>
      client.request({
        op: "putWatermark",
        method: "PUT",
        path: watermarkPath(),
        headers: { "x-ms-blob-type": "BlockBlob" },
        body: new TextEncoder().encode(new Date().toISOString()),
      })
    );
  }

  async function readWatermark(): Promise<string | null> {
    const resp = await retryableRequest(() =>
      client.request({
        op: "getWatermark",
        method: "GET",
        path: watermarkPath(),
      })
    );
    if (resp.status !== 200) return null;
    return new TextDecoder().decode(resp.body);
  }

  /**
   * Reads the current commit sequence number. Returns 0 if the blob doesn't
   * exist yet (first push).
   */
  async function readCommitSeq(): Promise<
    { seq: number; etag: string | null }
  > {
    const resp = await retryableRequest(() =>
      client.request({
        op: "getCommitSeq",
        method: "GET",
        path: commitSeqPath(),
      })
    );
    if (resp.status === 404) return { seq: 0, etag: null };
    if (resp.status !== 200) {
      throw new Error(`Read commit_seq failed (${resp.status})`);
    }
    const seq = parseInt(new TextDecoder().decode(resp.body), 10);
    return { seq: isNaN(seq) ? 0 : seq, etag: resp.headers.get("etag") };
  }

  /**
   * Atomically increments the commit sequence counter via ETag-conditional PUT.
   * Retries on ETag conflict (another writer incremented concurrently).
   */
  async function incrementCommitSeq(): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { seq, etag } = await readCommitSeq();
      const nextSeq = seq + 1;
      const body = new TextEncoder().encode(String(nextSeq));
      const resp = await retryableRequest(() =>
        client.request({
          op: "putCommitSeq",
          method: "PUT",
          path: commitSeqPath(),
          headers: {
            "x-ms-blob-type": "BlockBlob",
            ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
          },
          body,
        })
      );
      if (resp.status === 201 || resp.status === 200) return nextSeq;
      if (resp.status === 412) {
        recordRetry(attempt + 1, 0, {
          "retry.reason": "commit_seq_etag_conflict",
          "http.response.status_code": resp.status,
        });
        continue;
      }
      throw new Error(`Increment commit_seq failed (${resp.status})`);
    }
    throw new Error("Increment commit_seq exhausted retries on ETag conflict");
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<
    { changes: number; pulled: number; deleted: number; fastPath: boolean }
  > {
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    if (!scoped && state.lastPulledAt !== null) {
      // Fast-path: check both the commitSeq counter (monotonic, immune to
      // clock skew) and the legacy timestamp watermark. If the remote
      // commitSeq hasn't advanced since our last pull, nothing has changed.
      const remoteSeq = await readCommitSeq();
      if (
        state.lastCommitSeq !== undefined &&
        state.lastCommitSeq !== null &&
        remoteSeq.seq <= state.lastCommitSeq
      ) {
        return { changes: 0, pulled: 0, deleted: 0, fastPath: true };
      }
      // Fall back to timestamp watermark if commitSeq isn't populated yet
      // (backwards compat with datastores that haven't pushed with the new
      // code).
      if (remoteSeq.seq === 0) {
        const lastPushedAt = await readWatermark();
        if (
          lastPushedAt &&
          new Date(lastPushedAt) <= new Date(state.lastPulledAt)
        ) {
          return { changes: 0, pulled: 0, deleted: 0, fastPath: true };
        }
      }
    }

    const pullStartTime = new Date().toISOString();
    const entries: Array<[string, ShardEntry]> = [];
    if (scoped) {
      const all = await queryAllFileMeta();
      for (const [relPath, entry] of all) {
        if (prefixes!.some((p) => relPath.startsWith(p))) {
          entries.push([relPath, entry]);
        }
      }
    } else {
      entries.push(...(await queryAllFileMeta()).entries());
    }

    let changes = 0;
    let deleted = 0;
    let pulled = 0;
    const needContent: string[] = [];
    for (const [relPath, meta] of entries) {
      signal?.throwIfAborted();
      if (isTraversal(relPath)) continue;
      if (meta.deletedAt !== null) {
        try {
          await Deno.remove(`${cachePath}/${relPath}`);
          changes++;
          deleted++;
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
        continue;
      }
      const localPath = `${cachePath}/${relPath}`;
      try {
        const local = await Deno.readFile(localPath);
        if (await sha256Hex(local) === meta.hash) continue;
      } catch { /* file missing — need content */ }
      needContent.push(relPath);
    }

    if (!metadataOnly) {
      for (const relPath of needContent) {
        signal?.throwIfAborted();
        const bytes = await fetchContent(relPath);
        await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
        changes++;
        pulled++;
      }
    }

    if (!scoped && !metadataOnly) {
      await sidecar.setLastPulledAt(pullStartTime);
      // Record the remote commitSeq at pull time so the fast-path can compare
      // against it on subsequent pulls.
      const { seq } = await readCommitSeq();
      await sidecar.setLastCommitSeq(seq);
      await sidecar.setLazyPullActive(false);
    }

    return { changes, pulled, deleted, fastPath: false };
  }

  async function collectDiff(
    relPaths: string[] | null,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<{ toPush: FileEntry[]; toTombstone: string[] }> {
    const remotePathsResolved: Map<string, ShardEntry> = relPaths === null
      ? await queryAllFileMeta()
      : await queryShardsByPaths(relPaths);

    const localFiles: FileEntry[] = [];
    if (relPaths === null) {
      for (const sub of DATASTORE_SUBDIRS) {
        signal?.throwIfAborted();
        await walkAndCollect(
          `${cachePath}/${sub}`,
          sub,
          async (relPath, bytes) => {
            localFiles.push({ relPath, hash: await sha256Hex(bytes), bytes });
          },
          signal,
        );
      }
    } else {
      for (const relPath of relPaths) {
        if (isTraversal(relPath)) continue;
        signal?.throwIfAborted();
        const absPath = `${cachePath}/${relPath}`;
        let stat: Deno.FileInfo | null = null;
        try {
          stat = await Deno.stat(absPath);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
        if (stat?.isFile) {
          const bytes = await Deno.readFile(absPath);
          localFiles.push({ relPath, hash: await sha256Hex(bytes), bytes });
        } else if (stat?.isDirectory) {
          await walkAndCollect(absPath, relPath, async (childRel, bytes) => {
            localFiles.push({
              relPath: childRel,
              hash: await sha256Hex(bytes),
              bytes,
            });
          }, signal);
        }
      }
    }

    const localPathSet = new Set<string>();
    const toPush: FileEntry[] = [];
    for (const f of localFiles) {
      localPathSet.add(f.relPath);
      const existing = remotePathsResolved.get(f.relPath);
      if (existing && existing.deletedAt === null && existing.hash === f.hash) {
        continue;
      }
      toPush.push(f);
    }

    const toTombstone: string[] = [];
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      for (const [relPath, meta] of remotePathsResolved) {
        if (localPathSet.has(relPath) || meta.deletedAt !== null) continue;
        if (new Date(meta.updatedAt) > watermark) continue;
        toTombstone.push(relPath);
      }
    }

    return { toPush, toTombstone };
  }

  async function applyDiff(
    toPush: FileEntry[],
    toTombstone: string[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (toPush.length === 0 && toTombstone.length === 0) return 0;

    // Phase 1: Upload blob content in parallel with bounded concurrency.
    // Blob uploads are independent — they target different blob paths and don't
    // contend with each other or with shard updates.
    const UPLOAD_CONCURRENCY = 12;
    await runBounded(
      toPush,
      UPLOAD_CONCURRENCY,
      async (entry) => {
        signal?.throwIfAborted();
        const putResp = await retryableRequest(() =>
          client.request({
            op: "putBlob",
            method: "PUT",
            path: blobPath(entry.relPath),
            headers: { "x-ms-blob-type": "BlockBlob" },
            body: entry.bytes,
          })
        );
        if (putResp.status !== 201) {
          throw new Error(
            `Put blob ${entry.relPath} failed (${putResp.status})`,
          );
        }
      },
    );

    // Phase 2: Batch shard CAS updates by shard key. Instead of one
    // read-modify-write per file, accumulate all entries destined for the same
    // shard and apply them in a single CAS operation.
    const now = new Date().toISOString();
    const shardBatches = new Map<
      string,
      Array<{ relPath: string; entry: ShardEntry }>
    >();
    for (const f of toPush) {
      const sk = await shardKey(f.relPath);
      const batch = shardBatches.get(sk) ?? [];
      batch.push({
        relPath: f.relPath,
        entry: {
          hash: f.hash,
          size: f.bytes.byteLength,
          updatedAt: now,
          deletedAt: null,
        },
      });
      shardBatches.set(sk, batch);
    }
    for (const relPath of toTombstone) {
      const sk = await shardKey(relPath);
      const batch = shardBatches.get(sk) ?? [];
      batch.push({
        relPath,
        entry: {
          hash: "",
          size: 0,
          updatedAt: now,
          deletedAt: now,
        },
      });
      shardBatches.set(sk, batch);
    }

    // Apply each shard batch as a single CAS update. Shard updates for
    // different shards can proceed in parallel since they target different blobs.
    const SHARD_CAS_CONCURRENCY = 10;
    await runBounded(
      [...shardBatches.entries()],
      SHARD_CAS_CONCURRENCY,
      async ([shard, entries]) => {
        signal?.throwIfAborted();
        await updateShard(shard, (map) => {
          const updated = { ...map };
          for (const { relPath, entry } of entries) {
            updated[relPath] = entry;
          }
          return updated;
        });
      },
    );

    // Phase 3: Update watermark and commitSeq.
    await writeWatermark();
    await incrementCommitSeq();
    return toPush.length + toTombstone.length;
  }

  return {
    capabilities(): SyncCapabilities {
      return { scopedSync: true, lazyHydration: true, twoPhaseSync: true };
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      return sidecar.recordDirty(options?.relPath).then(() => undefined);
    },

    async pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const prefixes = modelPrefixes(options?.context?.models);
      const scoped = prefixes.length > 0;
      return await withSpan("azure-blob-datastore pullChanged", {
        [Attr.DATASTORE_SCOPED]: scoped,
        [Attr.DATASTORE_METADATA_ONLY]: options?.metadataOnly === true,
      }, async (span) => {
        const { changes, pulled, deleted, fastPath } = await pull({
          prefixes: scoped ? prefixes : undefined,
          metadataOnly: options?.metadataOnly,
          signal: options?.signal,
        });
        // `changes` counts local deletions alongside downloads, so the two are
        // reported separately rather than both landing on files_pulled.
        span.setAttributes({
          [Attr.DATASTORE_FILES_PULLED]: pulled,
          [Attr.DATASTORE_FILES_DELETED]: deleted,
          [Attr.DATASTORE_FAST_PATH_HIT]: fastPath,
        });
        return changes;
      });
    },

    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      return await withSpan(
        "azure-blob-datastore pushChanged",
        {},
        async (span) => {
          const signal = options?.signal;

          let snapshot!: {
            dirtyPaths: string[];
            bulkInvalidated: boolean;
            lastPulledAt: string | null;
            lazyPullActive: boolean;
          };
          await sidecar.update((state) => {
            snapshot = {
              dirtyPaths: [...state.dirtyPaths],
              bulkInvalidated: state.bulkInvalidated,
              lastPulledAt: state.lastPulledAt,
              lazyPullActive: state.lazyPullActive,
            };
          });

          if (!snapshot.bulkInvalidated && snapshot.dirtyPaths.length === 0) {
            span.setAttributes({
              [Attr.DATASTORE_FAST_PATH_HIT]: true,
              [Attr.DATASTORE_FILES_PUSHED]: 0,
              [Attr.DATASTORE_FILES_DELETED]: 0,
            });
            return 0;
          }

          const { toPush, toTombstone } = await collectDiff(
            snapshot.bulkInvalidated ? null : snapshot.dirtyPaths,
            snapshot.lastPulledAt,
            snapshot.lazyPullActive,
            signal,
          );
          const changes = await applyDiff(toPush, toTombstone, signal);
          await sidecar.clearPushed(snapshot);
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: false,
            [Attr.DATASTORE_FILES_PUSHED]: toPush.length,
            [Attr.DATASTORE_FILES_DELETED]: toTombstone.length,
          });
          return changes;
        },
      );
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      return await withSpan("azure-blob-datastore hydrateFile", {
        [Attr.DATASTORE_FILE]: relPath,
      }, async (span) => {
        if (isTraversal(relPath)) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }
        // Jump straight to the one shard that owns this path instead of
        // listing+fetching every shard in the index — that's the whole point
        // of the shard-first design, and this is the path meant to be cheap.
        const shard = await shardKey(relPath);
        span.setAttribute(Attr.DATASTORE_SHARD, shard);
        const { map } = await getShard(shard);
        const meta = map[relPath];
        if (!meta || meta.deletedAt !== null) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }
        const bytes = await fetchContent(relPath);
        await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
        span.setAttribute(Attr.DATASTORE_HYDRATED, true);
        return true;
      });
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      return await withSpan(
        "azure-blob-datastore preparePush",
        {},
        async (span) => {
          const signal = options?.signal;

          let snapshot!: {
            dirtyPaths: string[];
            bulkInvalidated: boolean;
            lastPulledAt: string | null;
            lazyPullActive: boolean;
          };
          await sidecar.update((state) => {
            snapshot = {
              dirtyPaths: [...state.dirtyPaths],
              bulkInvalidated: state.bulkInvalidated,
              lastPulledAt: state.lastPulledAt,
              lazyPullActive: state.lazyPullActive,
            };
          });

          let toPush: FileEntry[] = [];
          let toTombstone: string[] = [];
          if (snapshot.bulkInvalidated || snapshot.dirtyPaths.length > 0) {
            const result = await collectDiff(
              snapshot.bulkInvalidated ? null : snapshot.dirtyPaths,
              snapshot.lastPulledAt,
              snapshot.lazyPullActive,
              signal,
            );
            toPush = result.toPush;
            toTombstone = result.toTombstone;
          }

          span.setAttributes({
            [Attr.DATASTORE_FILES_PLANNED_PUSH]: toPush.length,
            [Attr.DATASTORE_FILES_PLANNED_DELETE]: toTombstone.length,
          });

          const internal: InternalPushManifest = {
            toPush,
            toTombstone,
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
      return await withSpan("azure-blob-datastore commitPush", {
        [Attr.DATASTORE_FILES_PLANNED_PUSH]: internal.toPush.length,
        [Attr.DATASTORE_FILES_PLANNED_DELETE]: internal.toTombstone.length,
      }, async (span) => {
        const signal = options?.signal;

        if (internal.toPush.length === 0 && internal.toTombstone.length === 0) {
          await sidecar.clearPushed(internal.snapshot);
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: true,
            [Attr.DATASTORE_FILES_PUSHED]: 0,
            [Attr.DATASTORE_FILES_DELETED]: 0,
          });
          return 0;
        }

        const changes = await applyDiff(
          internal.toPush,
          internal.toTombstone,
          signal,
        );
        await sidecar.clearPushed(internal.snapshot);
        span.setAttributes({
          [Attr.DATASTORE_FAST_PATH_HIT]: false,
          [Attr.DATASTORE_FILES_PUSHED]: internal.toPush.length,
          [Attr.DATASTORE_FILES_DELETED]: internal.toTombstone.length,
        });
        return changes;
      });
    },
  };
}
