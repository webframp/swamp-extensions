// ABOUTME: DynamoDB sync service — chunked push/pull via the gsi1 sparse index,
// ABOUTME: team-safe watermarking via a SYNCSTATE item, retry on throttling.

import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1091.0";
import { Sidecar } from "./sidecar.ts";
import { retryable } from "./_lib/retry.ts";
import { reassembleChunks, splitIntoChunks } from "./chunking.ts";
import {
  fileChunkKey,
  fileChunkPrefix,
  fileMetaKey,
  GSI_FILE_PARTITION,
  GSI_NAME,
  parseChunkIndex,
  SYNC_STATE_KEY,
} from "./keys.ts";

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

interface RemoteFileMeta {
  hash: string;
  deletedAt: string | null;
  updatedAt: Date;
  chunkCount: number;
  chunkVersion: number;
}

interface InternalPushManifest {
  toPush: FileEntry[];
  toTombstone: string[];
  remoteChunkCounts: Map<string, { count: number; version: number }>;
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

/** Splits an array into chunks of at most `size` — used for BatchWriteItem's 25-item cap. */
function batchesOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** True when `candidate` is `boundary` itself, or nested under it as a path
 * segment — never a mere string prefix (so "report.json" doesn't also match
 * "report.json.bak"). Directory-style boundaries already ending in "/" behave
 * exactly like a plain begins_with, preserving existing scoped-pull behavior. */
function matchesPathBoundary(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const dirBoundary = boundary.endsWith("/") ? boundary : `${boundary}/`;
  return candidate.startsWith(dirBoundary);
}

export function createSyncService(
  doc: DynamoDBDocumentClient,
  tableName: string,
  cachePath: string,
  maxChunkBytes: number,
  ensureInfrastructure: () => Promise<void>,
): TwoPhaseSyncService {
  const sidecar = new Sidecar(cachePath);

  async function queryAllFileMeta(
    prefix?: string,
  ): Promise<Map<string, RemoteFileMeta>> {
    const out = new Map<string, RemoteFileMeta>();
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await retryable(() =>
        doc.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: GSI_NAME,
            KeyConditionExpression: prefix
              ? "gsi1pk = :fp AND begins_with(gsi1sk, :prefix)"
              : "gsi1pk = :fp",
            ExpressionAttributeValues: prefix
              ? { ":fp": GSI_FILE_PARTITION, ":prefix": prefix }
              : { ":fp": GSI_FILE_PARTITION },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        )
      );
      for (const item of result.Items ?? []) {
        const relPath = item.gsi1sk as string;
        // begins_with alone would also match unrelated siblings sharing a
        // string prefix (e.g. "report.json" matching "report.json.bak") —
        // require an exact match or a real path-segment boundary.
        if (prefix && !matchesPathBoundary(relPath, prefix)) continue;
        out.set(relPath, {
          hash: item.hash,
          deletedAt: item.deletedAt ?? null,
          updatedAt: new Date(item.updatedAt),
          chunkCount: item.chunkCount ?? 0,
          chunkVersion: item.chunkVersion ?? 0,
        });
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return out;
  }

  /** Sends a BatchWriteCommand and retries any UnprocessedItems with backoff —
   * DynamoDB's BatchWriteItem does not throw on partial throttling, it just
   * returns the items it didn't get to, so callers must resubmit those. */
  async function sendBatchWrite(
    requests: Array<Record<string, unknown>>,
  ): Promise<void> {
    let pending = requests;
    for (let attempt = 0; pending.length > 0 && attempt < 8; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(500 * 2 ** attempt, 5_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const result = await retryable(() =>
        doc.send(
          new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
        )
      );
      pending = (result.UnprocessedItems?.[tableName] ?? []) as Array<
        Record<string, unknown>
      >;
    }
    if (pending.length > 0) {
      throw new Error(
        `BatchWriteItem left ${pending.length} unprocessed item(s) after retrying`,
      );
    }
  }

  /**
   * Fetches and reassembles a file's chunks, bounded to `expectedChunkCount`
   * and verified against `expectedHash`. When `chunkVersion` > 0, only chunks
   * matching that version's prefix are queried — isolating reads from
   * concurrent writes that produce chunks under a different version. Legacy
   * items (chunkVersion 0) use the bare `CHUNK#` prefix for backward compat.
   */
  async function fetchChunks(
    relPath: string,
    expectedChunkCount: number,
    expectedHash: string,
    chunkVersion: number,
  ): Promise<Uint8Array> {
    const { pk, skPrefix } = fileChunkPrefix(relPath, chunkVersion);
    const items: Array<{ sk: string; content: Uint8Array }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await retryable(() =>
        doc.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":pk": pk, ":prefix": skPrefix },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        )
      );
      for (const item of result.Items ?? []) {
        items.push({
          sk: item.sk as string,
          content: item.content as Uint8Array,
        });
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    // Sort numerically (not trusting Query's lexicographic sk order alone)
    // and drop anything beyond expectedChunkCount — stale trailing chunks
    // left over from a not-yet-cleaned-up shrink write must never be read.
    items.sort((a, b) => parseChunkIndex(a.sk) - parseChunkIndex(b.sk));
    const bounded = items.slice(0, expectedChunkCount).map((i) => i.content);
    if (bounded.length !== expectedChunkCount) {
      throw new Error(
        `${relPath}: expected ${expectedChunkCount} chunk(s), found ${bounded.length}`,
      );
    }

    const bytes = reassembleChunks(bounded);
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(
        `${relPath}: reassembled content hash ${actualHash} does not match expected ${expectedHash}`,
      );
    }
    return bytes;
  }

  async function writeFileEntry(
    entry: FileEntry,
    previousChunkCount: number,
    previousChunkVersion: number,
  ): Promise<void> {
    const chunks = splitIntoChunks(entry.bytes, maxChunkBytes);
    const now = new Date().toISOString();
    const { pk: metaPk, sk: metaSk } = fileMetaKey(entry.relPath);
    const newVersion = previousChunkVersion + 1;

    // Write new chunks under the new version prefix — these are invisible
    // to readers until the metadata update below makes newVersion current.
    const writeRequests = chunks.map((content, index) => ({
      PutRequest: {
        Item: { ...fileChunkKey(entry.relPath, index, newVersion), content },
      },
    }));
    for (const batch of batchesOf(writeRequests, 25)) {
      await sendBatchWrite(batch);
    }

    // Metadata written last — readers discover newVersion only after all
    // chunks for that version exist in the table.
    await retryable(() =>
      doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: metaPk,
            sk: metaSk,
            hash: entry.hash,
            size: entry.bytes.byteLength,
            chunkCount: chunks.length,
            chunkVersion: newVersion,
            updatedAt: now,
            deletedAt: null,
            gsi1pk: GSI_FILE_PARTITION,
            gsi1sk: entry.relPath,
          },
        }),
      )
    );

    // Clean up old version's chunks asynchronously. This is best-effort —
    // stale chunks waste storage but never corrupt reads because readers
    // query by version prefix.
    if (previousChunkCount > 0 && previousChunkVersion > 0) {
      const deleteRequests = [];
      for (let i = 0; i < previousChunkCount; i++) {
        deleteRequests.push({
          DeleteRequest: {
            Key: fileChunkKey(entry.relPath, i, previousChunkVersion),
          },
        });
      }
      for (const batch of batchesOf(deleteRequests, 25)) {
        await sendBatchWrite(batch).catch(() => {
          // Cleanup failure is non-fatal — stale chunks are orphaned but
          // harmless. They'll never be read since no metadata points to them.
        });
      }
    }
    // Also clean up legacy unversioned chunks if migrating from v0
    if (previousChunkVersion === 0 && previousChunkCount > 0) {
      const deleteRequests = [];
      for (let i = 0; i < previousChunkCount; i++) {
        deleteRequests.push({
          DeleteRequest: { Key: fileChunkKey(entry.relPath, i, 0) },
        });
      }
      for (const batch of batchesOf(deleteRequests, 25)) {
        await sendBatchWrite(batch).catch(() => {});
      }
    }
  }

  async function tombstonePath(relPath: string): Promise<void> {
    const { pk, sk } = fileMetaKey(relPath);
    await retryable(() =>
      doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk,
            sk,
            hash: "",
            size: 0,
            chunkCount: 0,
            updatedAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            gsi1pk: GSI_FILE_PARTITION,
            gsi1sk: relPath,
          },
        }),
      )
    );
  }

  async function writeWatermark(): Promise<void> {
    await retryable(() =>
      doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...SYNC_STATE_KEY, lastPushedAt: new Date().toISOString() },
        }),
      )
    );
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<number> {
    await ensureInfrastructure();
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    if (!scoped && state.lastPulledAt !== null) {
      const watermark = await retryable(() =>
        doc.send(
          new GetCommand({ TableName: tableName, Key: { ...SYNC_STATE_KEY } }),
        )
      );
      const lastPushedAt = watermark.Item?.lastPushedAt as string | undefined;
      if (
        lastPushedAt && new Date(lastPushedAt) <= new Date(state.lastPulledAt)
      ) {
        return 0;
      }
    }

    const pullStartTime = new Date().toISOString();
    const entries: Array<[string, RemoteFileMeta]> = [];
    if (scoped) {
      for (const prefix of prefixes!) {
        const map = await queryAllFileMeta(prefix);
        entries.push(...map.entries());
      }
    } else {
      const map = await queryAllFileMeta();
      entries.push(...map.entries());
    }

    let changes = 0;
    const needContent: Array<[string, RemoteFileMeta]> = [];
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
      if (
        !scoped && state.lastPulledAt !== null &&
        meta.updatedAt < new Date(state.lastPulledAt)
      ) {
        continue;
      }
      const localPath = `${cachePath}/${relPath}`;
      try {
        const local = await Deno.readFile(localPath);
        if (await sha256Hex(local) === meta.hash) continue;
      } catch { /* file missing — need content */ }
      needContent.push([relPath, meta]);
    }

    for (const [relPath, meta] of needContent) {
      signal?.throwIfAborted();
      const bytes = await fetchChunks(
        relPath,
        meta.chunkCount,
        meta.hash,
        meta.chunkVersion,
      );
      await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
      changes++;
    }

    if (!scoped && !metadataOnly) {
      await sidecar.setLastPulledAt(pullStartTime);
      await sidecar.setLazyPullActive(false);
    }

    return changes;
  }

  async function collectDiff(
    relPaths: string[] | null, // null = full walk
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<
    {
      toPush: FileEntry[];
      toTombstone: string[];
      remoteChunkCounts: Map<string, { count: number; version: number }>;
    }
  > {
    const remotePaths = relPaths === null
      ? await queryAllFileMeta()
      : (await Promise.all(relPaths.map((p) => queryAllFileMeta(p)))).reduce(
        (acc, m) => {
          for (const [k, v] of m) acc.set(k, v);
          return acc;
        },
        new Map<string, RemoteFileMeta>(),
      );

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
    const remoteChunkCounts = new Map<
      string,
      { count: number; version: number }
    >();
    for (const f of localFiles) {
      localPathSet.add(f.relPath);
      const existing = remotePaths.get(f.relPath);
      if (existing) {
        remoteChunkCounts.set(f.relPath, {
          count: existing.chunkCount,
          version: existing.chunkVersion,
        });
      }
      if (existing && existing.deletedAt === null && existing.hash === f.hash) {
        continue;
      }
      toPush.push(f);
    }

    const toTombstone: string[] = [];
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      for (const [relPath, meta] of remotePaths) {
        if (localPathSet.has(relPath) || meta.deletedAt !== null) continue;
        if (meta.updatedAt > watermark) continue;
        toTombstone.push(relPath);
      }
    }

    return { toPush, toTombstone, remoteChunkCounts };
  }

  async function applyDiff(
    toPush: FileEntry[],
    toTombstone: string[],
    remoteChunkCounts: Map<string, { count: number; version: number }>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (toPush.length === 0 && toTombstone.length === 0) return 0;
    let count = 0;
    for (const f of toPush) {
      signal?.throwIfAborted();
      const prev = remoteChunkCounts.get(f.relPath);
      await writeFileEntry(f, prev?.count ?? 0, prev?.version ?? 0);
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
      await ensureInfrastructure();
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

      const { toPush, toTombstone, remoteChunkCounts } = await collectDiff(
        snapshot.bulkInvalidated ? null : snapshot.dirtyPaths,
        snapshot.lastPulledAt,
        snapshot.lazyPullActive,
        signal,
      );
      const changes = await applyDiff(
        toPush,
        toTombstone,
        remoteChunkCounts,
        signal,
      );
      await sidecar.clearPushed(snapshot);
      return changes;
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      if (isTraversal(relPath)) return false;
      await ensureInfrastructure();
      const map = await queryAllFileMeta(relPath);
      const meta = map.get(relPath);
      if (!meta || meta.deletedAt !== null) return false;
      const bytes = await fetchChunks(
        relPath,
        meta.chunkCount,
        meta.hash,
        meta.chunkVersion,
      );
      await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
      return true;
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      await ensureInfrastructure();
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
      let remoteChunkCounts = new Map<
        string,
        { count: number; version: number }
      >();

      if (snapshot.bulkInvalidated || snapshot.dirtyPaths.length > 0) {
        const result = await collectDiff(
          snapshot.bulkInvalidated ? null : snapshot.dirtyPaths,
          snapshot.lastPulledAt,
          snapshot.lazyPullActive,
          signal,
        );
        toPush = result.toPush;
        toTombstone = result.toTombstone;
        remoteChunkCounts = result.remoteChunkCounts;
      }

      const internal: InternalPushManifest = {
        toPush,
        toTombstone,
        remoteChunkCounts,
        snapshot,
      };
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

      await ensureInfrastructure();
      const changes = await applyDiff(
        internal.toPush,
        internal.toTombstone,
        internal.remoteChunkCounts,
        signal,
      );
      await sidecar.clearPushed(internal.snapshot);
      return changes;
    },
  };
}
