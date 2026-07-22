// ABOUTME: Azure Blob sync service — shard-first _index/ path index with ETag
// ABOUTME: CAS, single-blob-per-file content storage (no chunking needed —
// ABOUTME: unlike DynamoDB, Blob Storage has no small per-item size ceiling).

import type { BlobClient, BlobResponse } from "./rest_client.ts";
import { retryableRequest } from "./_lib/retry.ts";
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

  async function listIndexShards(): Promise<string[]> {
    const names: string[] = [];
    let marker: string | undefined;
    const listPrefix = `${prefix}/_index/`;
    do {
      const resp = await retryableRequest(() =>
        client.request({
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
    return names;
  }

  async function getShard(
    shard: string,
  ): Promise<{ map: ShardMap; etag: string | null }> {
    const resp = await retryableRequest(() =>
      client.request({ method: "GET", path: shardPath(shard) })
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
    for (let attempt = 0; attempt < 10; attempt++) {
      const { map, etag } = await getShard(shard);
      const updated = mutator(map);
      const body = new TextEncoder().encode(JSON.stringify(updated));
      const resp: BlobResponse = await retryableRequest(() =>
        client.request({
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
      if (resp.status === 412) continue; // ETag conflict — re-read and retry
      throw new Error(`Update shard ${shard} failed (${resp.status})`);
    }
    throw new Error(`Update shard ${shard} exhausted retries on ETag conflict`);
  }

  async function queryAllFileMeta(
    prefixFilter?: string,
  ): Promise<Map<string, ShardEntry>> {
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
    return out;
  }

  async function fetchContent(relPath: string): Promise<Uint8Array> {
    const resp = await retryableRequest(() =>
      client.request({ method: "GET", path: blobPath(relPath) })
    );
    if (resp.status !== 200) {
      throw new Error(`Get blob ${relPath} failed (${resp.status})`);
    }
    return resp.body;
  }

  async function writeFileEntry(entry: FileEntry): Promise<void> {
    const putResp = await retryableRequest(() =>
      client.request({
        method: "PUT",
        path: blobPath(entry.relPath),
        headers: { "x-ms-blob-type": "BlockBlob" },
        body: entry.bytes,
      })
    );
    if (putResp.status !== 201) {
      throw new Error(`Put blob ${entry.relPath} failed (${putResp.status})`);
    }
    const shard = await shardKey(entry.relPath);
    await updateShard(shard, (map) => ({
      ...map,
      [entry.relPath]: {
        hash: entry.hash,
        size: entry.bytes.byteLength,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    }));
  }

  async function tombstonePath(relPath: string): Promise<void> {
    const shard = await shardKey(relPath);
    await updateShard(shard, (map) => ({
      ...map,
      [relPath]: {
        hash: "",
        size: 0,
        updatedAt: new Date().toISOString(),
        deletedAt: new Date().toISOString(),
      },
    }));
  }

  async function writeWatermark(): Promise<void> {
    await retryableRequest(() =>
      client.request({
        method: "PUT",
        path: watermarkPath(),
        headers: { "x-ms-blob-type": "BlockBlob" },
        body: new TextEncoder().encode(new Date().toISOString()),
      })
    );
  }

  async function readWatermark(): Promise<string | null> {
    const resp = await retryableRequest(() =>
      client.request({ method: "GET", path: watermarkPath() })
    );
    if (resp.status !== 200) return null;
    return new TextDecoder().decode(resp.body);
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<number> {
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    if (!scoped && state.lastPulledAt !== null) {
      const lastPushedAt = await readWatermark();
      if (
        lastPushedAt && new Date(lastPushedAt) <= new Date(state.lastPulledAt)
      ) {
        return 0;
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
    const needContent: string[] = [];
    for (const [relPath, meta] of entries) {
      signal?.throwIfAborted();
      if (isTraversal(relPath)) continue;
      if (meta.deletedAt !== null) {
        try {
          await Deno.remove(`${cachePath}/${relPath}`);
          changes++;
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
      }
    }

    if (!scoped && !metadataOnly) {
      await sidecar.setLastPulledAt(pullStartTime);
      await sidecar.setLazyPullActive(false);
    }

    return changes;
  }

  async function collectDiff(
    relPaths: string[] | null,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<{ toPush: FileEntry[]; toTombstone: string[] }> {
    const remotePaths = relPaths === null ? await queryAllFileMeta() : (() => {
      const filters = relPaths;
      return queryAllFileMeta().then((all) => {
        const filtered = new Map<string, ShardEntry>();
        for (const [k, v] of all) {
          if (filters.some((p) => k === p || k.startsWith(`${p}/`))) {
            filtered.set(k, v);
          }
        }
        return filtered;
      });
    })();
    const remotePathsResolved = await remotePaths;

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
    let count = 0;
    for (const f of toPush) {
      signal?.throwIfAborted();
      await writeFileEntry(f);
      count++;
    }
    for (const relPath of toTombstone) {
      signal?.throwIfAborted();
      await tombstonePath(relPath);
      count++;
    }
    await writeWatermark();
    return count;
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
      return await pull({
        prefixes: prefixes.length > 0 ? prefixes : undefined,
        metadataOnly: options?.metadataOnly,
        signal: options?.signal,
      });
    },

    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
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
      return changes;
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      if (isTraversal(relPath)) return false;
      // Jump straight to the one shard that owns this path instead of
      // listing+fetching every shard in the index — that's the whole point
      // of the shard-first design, and this is the path meant to be cheap.
      const shard = await shardKey(relPath);
      const { map } = await getShard(shard);
      const meta = map[relPath];
      if (!meta || meta.deletedAt !== null) return false;
      const bytes = await fetchContent(relPath);
      await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
      return true;
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
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

      const internal: InternalPushManifest = { toPush, toTombstone, snapshot };
      return internal as unknown as PushManifest;
    },

    async commitPush(
      manifest: PushManifest,
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      const internal = manifest as unknown as InternalPushManifest;
      const signal = options?.signal;

      if (internal.toPush.length === 0 && internal.toTombstone.length === 0) {
        await sidecar.clearPushed(internal.snapshot);
        return 0;
      }

      const changes = await applyDiff(
        internal.toPush,
        internal.toTombstone,
        signal,
      );
      await sidecar.clearPushed(internal.snapshot);
      return changes;
    },
  };
}
