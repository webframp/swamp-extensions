// ABOUTME: DynamoDB sync service — per-model GSI partitions with time-ordered
// ABOUTME: sort keys for O(changed items) sync, partition registry for discovery,
// ABOUTME: team-safe watermarking via a SYNCSTATE item, retry on throttling.

import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1094.0";
import { Sidecar } from "./sidecar.ts";
import { retryable } from "./_lib/retry.ts";
import { reassembleChunks, splitIntoChunks } from "./chunking.ts";
import {
  fileChunkKey,
  fileChunkPrefix,
  fileMetaKey,
  GSI_NAME,
  gsiFilePartition,
  gsiFileSortKey,
  gsiPartitionsForModels,
  gsiSystemPartitions,
  parseChunkIndex,
  parseGsiFileSortKey,
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

export function createSyncService(
  doc: DynamoDBDocumentClient,
  tableName: string,
  cachePath: string,
  maxChunkBytes: number,
  ensureInfrastructure: () => Promise<void>,
): TwoPhaseSyncService {
  const sidecar = new Sidecar(cachePath);

  async function queryPartitionMeta(
    partition: string,
    sinceTimestamp?: string | null,
  ): Promise<Map<string, RemoteFileMeta>> {
    const out = new Map<string, RemoteFileMeta>();
    let exclusiveStartKey: Record<string, unknown> | undefined;

    // When sinceTimestamp is provided, use a key condition range query on
    // gsi1sk > :since — DynamoDB evaluates this at the storage layer, reading
    // only items updated after the timestamp. This is the core performance win:
    // O(items changed since last pull) instead of O(total items in partition).
    const useTimeRange = sinceTimestamp != null && sinceTimestamp.length > 0;

    do {
      const result = await retryable(() =>
        doc.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: GSI_NAME,
            KeyConditionExpression: useTimeRange
              ? "gsi1pk = :fp AND gsi1sk > :since"
              : "gsi1pk = :fp",
            ExpressionAttributeValues: useTimeRange
              ? { ":fp": partition, ":since": sinceTimestamp }
              : { ":fp": partition },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        )
      );
      for (const item of result.Items ?? []) {
        const { relPath } = parseGsiFileSortKey(item.gsi1sk as string);
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

  /** Queries metadata for specific relPaths by looking up their individual
   * items via the primary key (not the GSI). This is O(k) where k is the
   * number of paths — used for scoped push when dirtyPaths is small. */
  async function querySpecificPaths(
    relPaths: string[],
  ): Promise<Map<string, RemoteFileMeta>> {
    const out = new Map<string, RemoteFileMeta>();
    for (const relPath of relPaths) {
      const { pk, sk } = fileMetaKey(relPath);
      const result = await retryable(() =>
        doc.send(
          new GetCommand({ TableName: tableName, Key: { pk, sk } }),
        )
      );
      if (result.Item) {
        out.set(relPath, {
          hash: result.Item.hash,
          deletedAt: result.Item.deletedAt ?? null,
          updatedAt: new Date(result.Item.updatedAt),
          chunkCount: result.Item.chunkCount ?? 0,
          chunkVersion: result.Item.chunkVersion ?? 0,
        });
      }
    }
    return out;
  }

  /** Queries all file metadata across all known partitions. Used only as a
   * fallback for full-sync scenarios (bulkInvalidated, initial clone). Fans
   * out one query per partition concurrently for parallelism. */
  async function queryAllPartitions(
    sinceTimestamp?: string | null,
  ): Promise<Map<string, RemoteFileMeta>> {
    const systemPartitions = gsiSystemPartitions(DATASTORE_SUBDIRS);
    const allMeta = new Map<string, RemoteFileMeta>();

    // Query system partitions concurrently
    const systemResults = await Promise.all(
      systemPartitions.map((p) => queryPartitionMeta(p, sinceTimestamp)),
    );
    for (const map of systemResults) {
      for (const [k, v] of map) allMeta.set(k, v);
    }

    // Query the PARTITIONS registry to discover all model partitions,
    // then fan out queries to each concurrently.
    const registryResult = await retryable(() =>
      doc.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: "PARTITIONS#registry", sk: "LIST" },
        }),
      )
    );
    const knownPartitions: string[] =
      (registryResult.Item?.partitions as string[]) ?? [];
    if (knownPartitions.length > 0) {
      const modelResults = await Promise.all(
        knownPartitions.map((p) => queryPartitionMeta(p, sinceTimestamp)),
      );
      for (const map of modelResults) {
        for (const [k, v] of map) allMeta.set(k, v);
      }
    }

    return allMeta;
  }

  /** Registers a GSI partition key in the PARTITIONS registry so that
   * full-sync pulls can discover all model partitions without a table scan.
   * Uses an in-memory set to skip redundant DynamoDB reads for partitions
   * already registered in this process lifetime. */
  const knownRegisteredPartitions = new Set<string>();

  /** Max partitions tracked in the registry. At ~50 bytes per partition key,
   * 4000 entries stays well under DynamoDB's 400KB item limit. */
  const MAX_REGISTRY_PARTITIONS = 4000;

  async function registerPartition(partition: string): Promise<void> {
    // Fast path: skip the DynamoDB read if we've already registered this
    // partition in the current process.
    if (knownRegisteredPartitions.has(partition)) return;

    const result = await retryable(() =>
      doc.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: "PARTITIONS#registry", sk: "LIST" },
        }),
      )
    );
    const existing: string[] = (result.Item?.partitions as string[]) ?? [];
    const partitionSet = new Set(existing);
    if (partitionSet.has(partition)) {
      knownRegisteredPartitions.add(partition);
      return;
    }
    if (partitionSet.size >= MAX_REGISTRY_PARTITIONS) {
      // Registry full — skip. Scoped pulls still work; only full-sync misses
      // this partition until old entries are pruned.
      knownRegisteredPartitions.add(partition);
      return;
    }
    partitionSet.add(partition);
    await retryable(() =>
      doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: "PARTITIONS#registry",
            sk: "LIST",
            partitions: [...partitionSet],
          },
        }),
      )
    );
    knownRegisteredPartitions.add(partition);
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
    const partition = gsiFilePartition(entry.relPath);
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
            gsi1pk: partition,
            gsi1sk: gsiFileSortKey(now, entry.relPath),
          },
        }),
      )
    );

    // Register the partition so full-sync pulls can discover it.
    await registerPartition(partition);

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
    const now = new Date().toISOString();
    const partition = gsiFilePartition(relPath);
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
            updatedAt: now,
            deletedAt: now,
            gsi1pk: partition,
            gsi1sk: gsiFileSortKey(now, relPath),
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
    context?: SyncContext;
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<number> {
    await ensureInfrastructure();
    const models = opts?.context?.models;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = models !== undefined && models.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    // Watermark fast-path: if nothing has been pushed since our last pull,
    // skip the partition queries entirely — applies to both scoped and unscoped.
    if (state.lastPulledAt !== null) {
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
      // Scoped pull: query exactly the model partitions requested
      const partitions = gsiPartitionsForModels(models!);
      const results = await Promise.all(
        partitions.map((p) => queryPartitionMeta(p, state.lastPulledAt)),
      );
      for (const map of results) entries.push(...map.entries());
    } else {
      // Unscoped pull: query all known partitions
      const map = await queryAllPartitions(state.lastPulledAt);
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
    // When relPaths is provided, use direct item lookups — O(k) where k is
    // the number of dirty paths. This avoids partition scans entirely for the
    // common scoped-push case.
    const remotePaths = relPaths === null
      ? await queryAllPartitions(null)
      : await querySpecificPaths(relPaths);

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
      return await pull({
        context: options?.context,
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
      const map = await querySpecificPaths([relPath]);
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
