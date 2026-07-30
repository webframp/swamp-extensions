// ABOUTME: PostgreSQL sync service — transaction-wrapped push with batched inserts,
// ABOUTME: team-safe watermarking via sync_state table, retry on transient errors.
// ABOUTME: Uses BIGSERIAL commitSeq for monotonic ordering and tombstone GC.

import type postgres from "npm:postgres@3.4.9";
import { Sidecar } from "./sidecar.ts";
import { retryable } from "./_lib/retry.ts";
import { tracerFromEnv } from "./_lib/trace.ts";
import { Attr, sqlSpan, withSpan } from "./_lib/tracing.ts";

/** Number of content-fetch batches to run concurrently during pull phase 2. */
const CONTENT_FETCH_CONCURRENCY = 3;

/** Tombstones older than this are eligible for garbage collection. */
const TOMBSTONE_GC_AGE_DAYS = 7;

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

interface InternalPushManifest {
  toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
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

/**
 * Outcome of a push. `changes` counts every row written (files plus
 * tombstones) and is what the public API returns; `pushed` and `deleted` are
 * tracked separately so span attributes report each honestly.
 */
interface PushCounts {
  changes: number;
  pushed: number;
  deleted: number;
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

/** Escape SQL LIKE wildcards in a literal prefix. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
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

async function walkAndPush(
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
        await walkAndPush(childAbs, childRel, onFile, signal);
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

export function createSyncService(
  sql: postgres.Sql,
  filesTable: string,
  cachePath: string,
): TwoPhaseSyncService {
  const sidecar = new Sidecar(cachePath);
  const trace = tracerFromEnv();

  if (!filesTable.endsWith(".files")) {
    throw new Error(
      `createSyncService: filesTable must end with ".files", got "${filesTable}"`,
    );
  }
  const syncStateTable = filesTable.replace(/\.files$/, ".sync_state");

  // Derive the sequence name from the filesTable schema (e.g. "swamp.commit_seq")
  const commitSeqName = filesTable.replace(/\.files$/, ".commit_seq");

  async function ensureSchema(): Promise<void> {
    await sqlSpan(
      "createFilesTable",
      "CREATE TABLE",
      filesTable,
      () =>
        retryable(() =>
          sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${filesTable} (
        path       TEXT PRIMARY KEY,
        hash       TEXT NOT NULL,
        size       BIGINT NOT NULL,
        content    BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `)
        ),
    );
    await sqlSpan(
      "createUpdatedAtIndex",
      "CREATE INDEX",
      filesTable,
      () =>
        retryable(() =>
          sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${
            filesTable.replaceAll(".", "_")
          }_updated_at
      ON ${filesTable} (updated_at)
    `)
        ),
    );
    await sqlSpan(
      "createSyncStateTable",
      "CREATE TABLE",
      syncStateTable,
      () =>
        retryable(() =>
          sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${syncStateTable} (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
        ),
    );
    // BIGSERIAL sequence for monotonic commit ordering — eliminates clock skew
    // concerns with concurrent pushers.
    await sqlSpan(
      "createCommitSeq",
      "CREATE SEQUENCE",
      commitSeqName,
      () =>
        retryable(() =>
          sql.unsafe(
            `CREATE SEQUENCE IF NOT EXISTS ${commitSeqName} AS BIGINT`,
          )
        ),
    );
  }

  let schemaEnsured = false;
  async function ready(): Promise<void> {
    if (!schemaEnsured) {
      await ensureSchema();
      schemaEnsured = true;
    }
  }

  async function serverNow(): Promise<string> {
    const [row] = await sqlSpan(
      "serverNow",
      "SELECT",
      "pg_catalog",
      () => retryable(() => sql.unsafe(`SELECT now()::text AS ts`)),
    );
    return row.ts as string;
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<
    { changes: number; pulled: number; deleted: number; fastPath: boolean }
  > {
    const pullStart = performance.now();
    await ready();
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    // Capture server time BEFORE the data query for safe watermark.
    const pullStartTime = await serverNow();

    // Phase 1: fetch metadata only (no content BYTEA)
    const conditions: string[] = [];
    const params: string[] = [];
    let paramIdx = 1;

    if (scoped) {
      const orClauses = prefixes!.map((p) => {
        params.push(escapeLike(p) + "%");
        return `path LIKE $${paramIdx++} ESCAPE '\\'`;
      });
      conditions.push(`(${orClauses.join(" OR ")})`);
    } else if (state.lastPulledAt !== null) {
      // Skip pull entirely if nothing was pushed since our last pull.
      // Use commitSeq (monotonic integer) as the authoritative check;
      // fall back to timestamp watermark for backwards compatibility.
      try {
        const [seqRow] = await sqlSpan(
          "readCommitSeq",
          "SELECT",
          syncStateTable,
          () =>
            retryable(() =>
              sql.unsafe(
                `SELECT value FROM ${syncStateTable} WHERE key = 'commit_seq'`,
              )
            ),
        );
        if (seqRow) {
          const dbSeq = Number(seqRow.value);
          const localSeq = state.commitSeq ?? 0;
          if (dbSeq <= localSeq) {
            trace.summary("pull", 0, { files: 0, skipped: "no_changes" });
            return { changes: 0, pulled: 0, deleted: 0, fastPath: true };
          }
        } else {
          // No commit_seq yet — fall back to timestamp watermark
          const [stateRow] = await sqlSpan(
            "readWatermark",
            "SELECT",
            syncStateTable,
            () =>
              retryable(() =>
                sql.unsafe(
                  `SELECT value FROM ${syncStateTable} WHERE key = 'last_pushed_at'`,
                )
              ),
          );
          if (stateRow) {
            const dbPushedAt = String(stateRow.value);
            if (new Date(dbPushedAt) <= new Date(state.lastPulledAt)) {
              trace.summary("pull", 0, { files: 0, skipped: "no_changes" });
              return { changes: 0, pulled: 0, deleted: 0, fastPath: true };
            }
          }
        }
      } catch {
        // sync_state table might not exist yet — continue with full scan
      }
      params.push(state.lastPulledAt);
      conditions.push(`updated_at >= $${paramIdx++}`);
    }

    // Capture commitSeq BEFORE the metadata scan so concurrent pushes that
    // arrive during the scan don't get their seq stored without their data.
    let preScanCommitSeq: number | null = null;
    if (!scoped && !metadataOnly) {
      try {
        const [seqRow] = await sqlSpan(
          "capturePreScanCommitSeq",
          "SELECT",
          syncStateTable,
          () =>
            retryable(() =>
              sql.unsafe(
                `SELECT value FROM ${syncStateTable} WHERE key = 'commit_seq'`,
              )
            ),
        );
        if (seqRow) {
          preScanCommitSeq = Number(seqRow.value);
        }
      } catch {
        // commit_seq may not exist yet — non-fatal
      }
    }

    if (metadataOnly) {
      conditions.push(`NOT (path ~ '^data/.*/raw$')`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const metaScanDone = trace.startTimer("pull", "metadata_scan");
    const metaRows: postgres.Row[] = await sqlSpan(
      "scanFileMetadata",
      "SELECT",
      filesTable,
      async (span) => {
        const rows: postgres.Row[] = await retryable(() =>
          sql.unsafe(
            `SELECT path, hash, deleted_at FROM ${filesTable} ${where}`,
            params,
          )
        );
        span.setAttribute(Attr.DB_RETURNED_ROWS, rows.length);
        return rows;
      },
    );
    metaScanDone();

    signal?.throwIfAborted();

    let changes = 0;
    let deleted = 0;
    let pulled = 0;
    const needContent: string[] = [];

    for (const row of metaRows) {
      signal?.throwIfAborted();
      const relPath = row.path as string;
      if (isTraversal(relPath)) continue;

      if (row.deleted_at !== null) {
        try {
          await Deno.remove(`${cachePath}/${relPath}`);
          changes++;
          deleted++;
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      } else {
        // Check if local hash matches — if so, skip content fetch
        const localPath = `${cachePath}/${relPath}`;
        try {
          const local = await Deno.readFile(localPath);
          if (await sha256Hex(local) === (row.hash as string)) continue;
        } catch { /* file missing — need content */ }
        needContent.push(relPath);
      }
    }

    // Phase 2: fetch content only for changed/missing files (concurrent batches)
    const contentFetchDone = trace.startTimer("pull", "content_fetch");
    const BATCH_SIZE = 100;
    const batches: string[][] = [];
    for (let i = 0; i < needContent.length; i += BATCH_SIZE) {
      batches.push(needContent.slice(i, i + BATCH_SIZE));
    }

    // Run batches with limited concurrency to avoid exhausting the pool
    for (
      let chunk = 0;
      chunk < batches.length;
      chunk += CONTENT_FETCH_CONCURRENCY
    ) {
      signal?.throwIfAborted();
      const concurrent = batches.slice(
        chunk,
        chunk + CONTENT_FETCH_CONCURRENCY,
      );
      const results = await Promise.all(
        concurrent.map((batch) => {
          const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(", ");
          return sqlSpan(
            "fetchFileContent",
            "SELECT",
            filesTable,
            async (span) => {
              const rows: postgres.Row[] = await retryable(() =>
                sql.unsafe(
                  `SELECT path, content FROM ${filesTable} WHERE path IN (${placeholders}) AND deleted_at IS NULL`,
                  batch,
                )
              );
              span.setAttribute(Attr.DB_RETURNED_ROWS, rows.length);
              return rows;
            },
          );
        }),
      );
      for (const contentRows of results) {
        for (const row of contentRows) {
          signal?.throwIfAborted();
          const relPath = row.path as string;
          const content = row.content as Uint8Array;
          await writeFileAtomic(`${cachePath}/${relPath}`, content);
          changes++;
          pulled++;
        }
      }
    }
    contentFetchDone();

    if (!scoped && !metadataOnly) {
      await sidecar.setLastPulledAt(pullStartTime);
      await sidecar.setLazyPullActive(false);
      // Store the commitSeq captured BEFORE the metadata scan — any pushes
      // that landed after our snapshot will have a higher seq and will be
      // picked up on the next pull.
      if (preScanCommitSeq !== null) {
        await sidecar.setCommitSeq(preScanCommitSeq);
      }
    }

    trace.summary("pull", Math.round(performance.now() - pullStart), {
      files: changes,
      scanned: metaRows.length,
      fetched: needContent.length,
    });

    return { changes, pulled, deleted, fastPath: false };
  }

  async function collectFullWalkDiff(
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<{
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
    toTombstone: string[];
  }> {
    // Collect all local files first so we know what paths to query
    const localFiles: Array<
      { relPath: string; hash: string; bytes: Uint8Array }
    > = [];
    for (const sub of DATASTORE_SUBDIRS) {
      signal?.throwIfAborted();
      await walkAndPush(
        `${cachePath}/${sub}`,
        sub,
        async (relPath, bytes) => {
          signal?.throwIfAborted();
          const hash = await sha256Hex(bytes);
          localFiles.push({ relPath, hash, bytes });
        },
        signal,
      );
    }
    const localPathSet = new Set(localFiles.map((f) => f.relPath));

    // Fetch remote manifest for diff — use narrowed batch lookups for known
    // local paths, and a full scan only for tombstone detection.
    const manifestDone = trace.startTimer("push", "manifest_fetch");

    // For known local paths, batch-query their remote hashes instead of
    // fetching the entire manifest.
    const MANIFEST_BATCH_SIZE = 200;
    const remoteByPath = new Map<
      string,
      { hash: string; deletedAt: unknown; updatedAt: Date }
    >();
    const localPathList = [...localPathSet];
    for (let i = 0; i < localPathList.length; i += MANIFEST_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = localPathList.slice(i, i + MANIFEST_BATCH_SIZE);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(", ");
      const rows: postgres.Row[] = await sqlSpan(
        "fetchRemoteManifestBatch",
        "SELECT",
        filesTable,
        async (span) => {
          const result: postgres.Row[] = await retryable(() =>
            sql.unsafe(
              `SELECT path, hash, deleted_at, updated_at FROM ${filesTable} WHERE path IN (${placeholders})`,
              batch,
            )
          );
          span.setAttribute(Attr.DB_RETURNED_ROWS, result.length);
          return result;
        },
      );
      for (const r of rows) {
        remoteByPath.set(r.path as string, {
          hash: r.hash as string,
          deletedAt: r.deleted_at,
          updatedAt: new Date(String(r.updated_at)),
        });
      }
    }

    // For tombstone detection we need to find remote-only files that the local
    // side has deleted. Use lastPulledAt as a bound to narrow the scan.
    const remoteOnlyPaths = new Map<
      string,
      { hash: string; deletedAt: unknown; updatedAt: Date }
    >();
    if (lastPulledAt !== null && !lazyPullActive) {
      const tombstoneRows: postgres.Row[] = await sqlSpan(
        "fetchRemoteTombstoneCandidates",
        "SELECT",
        filesTable,
        async (span) => {
          const rows: postgres.Row[] = await retryable(() =>
            sql.unsafe(
              `SELECT path, hash, deleted_at, updated_at FROM ${filesTable} WHERE deleted_at IS NULL AND updated_at <= $1`,
              [lastPulledAt],
            )
          );
          span.setAttribute(Attr.DB_RETURNED_ROWS, rows.length);
          return rows;
        },
      );
      for (const r of tombstoneRows) {
        const path = r.path as string;
        if (!localPathSet.has(path)) {
          remoteOnlyPaths.set(path, {
            hash: r.hash as string,
            deletedAt: r.deleted_at,
            updatedAt: new Date(String(r.updated_at)),
          });
        }
      }
    }
    manifestDone();

    // Diff: find files to push
    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];
    for (const f of localFiles) {
      signal?.throwIfAborted();
      const existing = remoteByPath.get(f.relPath);
      if (
        existing && existing.deletedAt === null && existing.hash === f.hash
      ) {
        continue;
      }
      toPush.push(f);
    }

    // Collect tombstones: remote-only files not updated after watermark
    const toTombstone: string[] = [];
    if (lastPulledAt !== null && !lazyPullActive) {
      for (const [relPath] of remoteOnlyPaths) {
        toTombstone.push(relPath);
      }
    }

    return { toPush, toTombstone };
  }

  async function fullWalkPush(
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<PushCounts> {
    const pushStart = performance.now();
    await ready();

    const { toPush, toTombstone } = await collectFullWalkDiff(
      lastPulledAt,
      lazyPullActive,
      signal,
    );

    if (toPush.length === 0 && toTombstone.length === 0) {
      trace.summary("push", Math.round(performance.now() - pushStart), {
        files: 0,
        tombstones: 0,
      });
      return { changes: 0, pushed: 0, deleted: 0 };
    }

    // Execute all writes in a single transaction
    const txDone = trace.startTimer("push", "transaction");
    const changes = await retryable(() =>
      sqlSpan(
        "fullWalkPushTransaction",
        "TRANSACTION",
        filesTable,
        async () => {
          let count = 0;
          await sql.begin(async (tx) => {
            // Batch upsert files
            for (const f of toPush) {
              await tx.unsafe(
                `INSERT INTO ${filesTable} (path, hash, size, content, updated_at, deleted_at)
             VALUES ($1, $2, $3, $4, now(), NULL)
             ON CONFLICT (path) DO UPDATE SET
               hash = EXCLUDED.hash, size = EXCLUDED.size,
               content = EXCLUDED.content, updated_at = now(), deleted_at = NULL`,
                [f.relPath, f.hash, f.bytes.byteLength, f.bytes],
              );
              count++;
            }
            // Tombstone deleted files
            for (const path of toTombstone) {
              await tx.unsafe(
                `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
                [path],
              );
              count++;
            }
            // Advance commitSeq and persist it in sync_state
            const [{ nextval: seq }] = await tx.unsafe(
              `SELECT nextval('${commitSeqName}') AS nextval`,
            );
            await tx.unsafe(
              `INSERT INTO ${syncStateTable} (key, value, updated_at)
           VALUES ('commit_seq', to_jsonb($1::bigint), now())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::bigint), updated_at = now()`,
              [seq],
            );
            // Keep legacy timestamp watermark for backward compat
            await tx.unsafe(
              `INSERT INTO ${syncStateTable} (key, value, updated_at)
           VALUES ('last_pushed_at', to_jsonb(now()::text), now())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text), updated_at = now()`,
            );
          });
          return count;
        },
      )
    );
    txDone();

    // Tombstone GC: fire-and-forget outside the transaction. A failure here
    // (e.g. missing DELETE privilege) must never block pushes.
    try {
      await sql.unsafe(
        `DELETE FROM ${filesTable} WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '${TOMBSTONE_GC_AGE_DAYS} days'`,
      );
    } catch { /* GC failure is non-fatal */ }

    trace.summary("push", Math.round(performance.now() - pushStart), {
      files: toPush.length,
      tombstones: toTombstone.length,
    });

    return {
      changes,
      pushed: toPush.length,
      deleted: toTombstone.length,
    };
  }

  async function collectOneRelDiff(
    relPath: string,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<{
    toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }>;
    toTombstone: string[];
  }> {
    if (isTraversal(relPath)) return { toPush: [], toTombstone: [] };
    signal?.throwIfAborted();
    const absPath = `${cachePath}/${relPath}`;
    let stat: Deno.FileInfo | null = null;
    try {
      stat = await Deno.stat(absPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    // Collect local files
    const localFiles: Array<
      { relPath: string; hash: string; bytes: Uint8Array }
    > = [];
    if (stat?.isFile) {
      const bytes = await Deno.readFile(absPath);
      localFiles.push({ relPath, hash: await sha256Hex(bytes), bytes });
    } else if (stat?.isDirectory) {
      await walkAndPush(absPath, relPath, async (childRel, bytes) => {
        localFiles.push({
          relPath: childRel,
          hash: await sha256Hex(bytes),
          bytes,
        });
      }, signal);
    }

    // Fetch remote state for this subtree (escaped LIKE)
    const remoteRows: postgres.Row[] = await sqlSpan(
      "fetchRemoteSubtree",
      "SELECT",
      filesTable,
      async (span) => {
        const rows: postgres.Row[] = await retryable(() =>
          sql.unsafe(
            `SELECT path, hash, deleted_at, updated_at FROM ${filesTable}
       WHERE path = $1 OR path LIKE $2 ESCAPE '\\'`,
            [relPath, escapeLike(relPath) + "/%"],
          )
        );
        span.setAttribute(Attr.DB_RETURNED_ROWS, rows.length);
        return rows;
      },
    );
    const remotePaths = new Map<
      string,
      { hash: string; deletedAt: unknown; updatedAt: Date }
    >();
    for (const r of remoteRows) {
      remotePaths.set(r.path as string, {
        hash: r.hash as string,
        deletedAt: r.deleted_at,
        updatedAt: new Date(String(r.updated_at)),
      });
    }

    // Diff: find files to push and paths to tombstone
    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];
    for (const f of localFiles) {
      signal?.throwIfAborted();
      const existing = remotePaths.get(f.relPath);
      if (existing && existing.deletedAt === null && existing.hash === f.hash) {
        continue;
      }
      toPush.push(f);
    }

    const toTombstone: string[] = [];
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      const localPathSet = new Set(localFiles.map((f) => f.relPath));
      for (const [path, doc] of remotePaths) {
        if (localPathSet.has(path) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        toTombstone.push(path);
      }
    }

    return { toPush, toTombstone };
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
      return await withSpan("postgres-datastore pullChanged", {
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
        "postgres-datastore pushChanged",
        {},
        async (span) => {
          const pushStart = performance.now();
          await ready();
          const signal = options?.signal;

          // Capture snapshot inside the serialized update chain — ensures
          // concurrent recordDirty calls either land before or after this read.
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

          const lazy = snapshot.lazyPullActive;

          let changes: number;
          let pushed = 0;
          let deleted = 0;
          if (snapshot.bulkInvalidated) {
            const counts = await fullWalkPush(
              snapshot.lastPulledAt,
              lazy,
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
            // Batch all dirty paths into a single transaction instead of
            // N separate pushOneRel calls — eliminates per-path round trips.
            const allToPush: Array<
              { relPath: string; hash: string; bytes: Uint8Array }
            > = [];
            const allToTombstone: string[] = [];

            for (const relPath of snapshot.dirtyPaths) {
              signal?.throwIfAborted();
              const { toPush, toTombstone } = await collectOneRelDiff(
                relPath,
                snapshot.lastPulledAt,
                lazy,
                signal,
              );
              allToPush.push(...toPush);
              allToTombstone.push(...toTombstone);
            }

            if (allToPush.length === 0 && allToTombstone.length === 0) {
              changes = 0;
            } else {
              await ready();
              changes = await retryable(() =>
                sqlSpan(
                  "batchDirtyPushTransaction",
                  "TRANSACTION",
                  filesTable,
                  async () => {
                    let count = 0;
                    await sql.begin(async (tx) => {
                      for (const f of allToPush) {
                        signal?.throwIfAborted();
                        await tx.unsafe(
                          `INSERT INTO ${filesTable} (path, hash, size, content, updated_at, deleted_at)
                     VALUES ($1, $2, $3, $4, now(), NULL)
                     ON CONFLICT (path) DO UPDATE SET
                       hash = EXCLUDED.hash, size = EXCLUDED.size,
                       content = EXCLUDED.content, updated_at = now(), deleted_at = NULL`,
                          [f.relPath, f.hash, f.bytes.byteLength, f.bytes],
                        );
                        count++;
                      }
                      for (const path of allToTombstone) {
                        signal?.throwIfAborted();
                        await tx.unsafe(
                          `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
                          [path],
                        );
                        count++;
                      }
                      // Advance commitSeq and persist
                      const [{ nextval: seq }] = await tx.unsafe(
                        `SELECT nextval('${commitSeqName}') AS nextval`,
                      );
                      await tx.unsafe(
                        `INSERT INTO ${syncStateTable} (key, value, updated_at)
                   VALUES ('commit_seq', to_jsonb($1::bigint), now())
                   ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::bigint), updated_at = now()`,
                        [seq],
                      );
                      // Keep legacy timestamp watermark
                      await tx.unsafe(
                        `INSERT INTO ${syncStateTable} (key, value, updated_at)
                   VALUES ('last_pushed_at', to_jsonb(now()::text), now())
                   ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text), updated_at = now()`,
                      );
                      // Tombstone GC — moved outside transaction below
                    });
                    return count;
                  },
                )
              );
              // Tombstone GC: fire-and-forget outside the transaction.
              try {
                await sql.unsafe(
                  `DELETE FROM ${filesTable} WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '${TOMBSTONE_GC_AGE_DAYS} days'`,
                );
              } catch { /* GC failure is non-fatal */ }
              pushed = allToPush.length;
              deleted = allToTombstone.length;
            }
            trace.summary(
              "push_incremental",
              Math.round(performance.now() - pushStart),
              {
                files: changes,
                paths: snapshot.dirtyPaths.length,
              },
            );
          }

          // Selectively clear only the paths we just pushed — preserves any
          // dirty marks added by concurrent recordDirty() during the push.
          await sidecar.clearPushed(snapshot);
          // `changes` counts writes and tombstones together, so the file
          // counts are tracked separately to keep each attribute honest and
          // consistent with the other datastore extensions.
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
      return await withSpan("postgres-datastore hydrateFile", {
        [Attr.DATASTORE_FILE]: relPath,
      }, async (span) => {
        if (isTraversal(relPath)) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }
        await ready();
        const rows: postgres.Row[] = await sqlSpan(
          "fetchOneFile",
          "SELECT",
          filesTable,
          async (querySpan) => {
            const result: postgres.Row[] = await retryable(() =>
              sql.unsafe(
                `SELECT content FROM ${filesTable} WHERE path = $1 AND deleted_at IS NULL`,
                [relPath],
              )
            );
            querySpan.setAttribute(Attr.DB_RETURNED_ROWS, result.length);
            return result;
          },
        );
        if (rows.length === 0) {
          span.setAttribute(Attr.DATASTORE_HYDRATED, false);
          return false;
        }

        const content = rows[0].content as Uint8Array;
        await writeFileAtomic(`${cachePath}/${relPath}`, content);
        span.setAttribute(Attr.DATASTORE_HYDRATED, true);
        return true;
      });
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      return await withSpan(
        "postgres-datastore preparePush",
        {},
        async (span) => {
          await ready();
          const signal = options?.signal;

          // Capture snapshot (same as pushChanged)
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

          const lazy = snapshot.lazyPullActive;
          let toPush: Array<
            { relPath: string; hash: string; bytes: Uint8Array }
          > = [];
          let toTombstone: string[] = [];

          if (snapshot.bulkInvalidated) {
            // Mirror fullWalkPush logic but only collect, don't write
            const result = await collectFullWalkDiff(
              snapshot.lastPulledAt,
              lazy,
              signal,
            );
            toPush = result.toPush;
            toTombstone = result.toTombstone;
          } else if (snapshot.dirtyPaths.length > 0) {
            // Mirror pushOneRel logic for each dirty path
            for (const relPath of snapshot.dirtyPaths) {
              signal?.throwIfAborted();
              const result = await collectOneRelDiff(
                relPath,
                snapshot.lastPulledAt,
                lazy,
                signal,
              );
              toPush.push(...result.toPush);
              toTombstone.push(...result.toTombstone);
            }
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
      return await withSpan("postgres-datastore commitPush", {
        [Attr.DATASTORE_FILES_PLANNED_PUSH]: internal.toPush.length,
        [Attr.DATASTORE_FILES_PLANNED_DELETE]: internal.toTombstone.length,
      }, async (span) => {
        const signal = options?.signal;

        if (internal.toPush.length === 0 && internal.toTombstone.length === 0) {
          // Still clear sidecar dirty state even on no-op
          await sidecar.clearPushed(internal.snapshot);
          span.setAttributes({
            [Attr.DATASTORE_FAST_PATH_HIT]: true,
            [Attr.DATASTORE_FILES_PUSHED]: 0,
            [Attr.DATASTORE_FILES_DELETED]: 0,
          });
          return 0;
        }

        await ready();

        const changes = await retryable(() =>
          sqlSpan(
            "commitPushTransaction",
            "TRANSACTION",
            filesTable,
            async () => {
              let count = 0;
              await sql.begin(async (tx) => {
                for (const f of internal.toPush) {
                  signal?.throwIfAborted();
                  await tx.unsafe(
                    `INSERT INTO ${filesTable} (path, hash, size, content, updated_at, deleted_at)
               VALUES ($1, $2, $3, $4, now(), NULL)
               ON CONFLICT (path) DO UPDATE SET
                 hash = EXCLUDED.hash, size = EXCLUDED.size,
                 content = EXCLUDED.content, updated_at = now(), deleted_at = NULL`,
                    [f.relPath, f.hash, f.bytes.byteLength, f.bytes],
                  );
                  count++;
                }
                for (const path of internal.toTombstone) {
                  signal?.throwIfAborted();
                  await tx.unsafe(
                    `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
                    [path],
                  );
                  count++;
                }
                // Advance commitSeq and persist
                const [{ nextval: seq }] = await tx.unsafe(
                  `SELECT nextval('${commitSeqName}') AS nextval`,
                );
                await tx.unsafe(
                  `INSERT INTO ${syncStateTable} (key, value, updated_at)
             VALUES ('commit_seq', to_jsonb($1::bigint), now())
             ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::bigint), updated_at = now()`,
                  [seq],
                );
                // Keep legacy timestamp watermark
                await tx.unsafe(
                  `INSERT INTO ${syncStateTable} (key, value, updated_at)
             VALUES ('last_pushed_at', to_jsonb(now()::text), now())
             ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text), updated_at = now()`,
                );
                // Tombstone GC — moved outside transaction below
              });
              return count;
            },
          )
        );

        // Tombstone GC: fire-and-forget outside the transaction.
        try {
          await sql.unsafe(
            `DELETE FROM ${filesTable} WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '${TOMBSTONE_GC_AGE_DAYS} days'`,
          );
        } catch { /* GC failure is non-fatal */ }

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
