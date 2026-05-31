// ABOUTME: PostgreSQL sync service — transaction-wrapped push with batched inserts,
// ABOUTME: team-safe watermarking via sync_state table, retry on transient errors.

import type postgres from "npm:postgres@3.4.7";
import { Sidecar } from "./sidecar.ts";
import { retryable } from "./_lib/retry.ts";
import { tracerFromEnv } from "./_lib/trace.ts";

export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
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
): DatastoreSyncService {
  const sidecar = new Sidecar(cachePath);
  const trace = tracerFromEnv();

  if (!filesTable.endsWith(".files")) {
    throw new Error(
      `createSyncService: filesTable must end with ".files", got "${filesTable}"`,
    );
  }
  const syncStateTable = filesTable.replace(/\.files$/, ".sync_state");

  async function ensureSchema(): Promise<void> {
    await retryable(() =>
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
    );
    await retryable(() =>
      sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${
        filesTable.replaceAll(".", "_")
      }_updated_at
      ON ${filesTable} (updated_at)
    `)
    );
    await retryable(() =>
      sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${syncStateTable} (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
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
    const [row] = await retryable(() => sql.unsafe(`SELECT now()::text AS ts`));
    return row.ts as string;
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<number> {
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
      // The DB watermark is authoritative for team-wide changes.
      try {
        const [stateRow] = await retryable(() =>
          sql.unsafe(
            `SELECT value FROM ${syncStateTable} WHERE key = 'last_pushed_at'`,
          )
        );
        if (stateRow) {
          const dbPushedAt = String(stateRow.value);
          if (new Date(dbPushedAt) <= new Date(state.lastPulledAt)) {
            trace.summary("pull", 0, { files: 0, skipped: "no_changes" });
            return 0;
          }
        }
      } catch {
        // sync_state table might not exist yet — continue with full scan
      }
      params.push(state.lastPulledAt);
      conditions.push(`updated_at >= $${paramIdx++}`);
    }

    if (metadataOnly) {
      conditions.push(`NOT (path ~ '^data/.*/raw$')`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const metaScanDone = trace.startTimer("pull", "metadata_scan");
    const metaRows: postgres.Row[] = await retryable(() =>
      sql.unsafe(
        `SELECT path, hash, deleted_at FROM ${filesTable} ${where}`,
        params,
      )
    );
    metaScanDone();

    signal?.throwIfAborted();

    let changes = 0;
    const needContent: string[] = [];

    for (const row of metaRows) {
      signal?.throwIfAborted();
      const relPath = row.path as string;
      if (isTraversal(relPath)) continue;

      if (row.deleted_at !== null) {
        try {
          await Deno.remove(`${cachePath}/${relPath}`);
          changes++;
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

    // Phase 2: fetch content only for changed/missing files
    const contentFetchDone = trace.startTimer("pull", "content_fetch");
    const BATCH_SIZE = 100;
    for (let i = 0; i < needContent.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = needContent.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(", ");
      const contentRows: postgres.Row[] = await retryable(() =>
        sql.unsafe(
          `SELECT path, content FROM ${filesTable} WHERE path IN (${placeholders}) AND deleted_at IS NULL`,
          batch,
        )
      );
      for (const row of contentRows) {
        signal?.throwIfAborted();
        const relPath = row.path as string;
        const content = row.content as Uint8Array;
        await writeFileAtomic(`${cachePath}/${relPath}`, content);
        changes++;
      }
    }
    contentFetchDone();

    if (!scoped && !metadataOnly) {
      await sidecar.setLastPulledAt(pullStartTime);
      await sidecar.setLazyPullActive(false);
    }

    trace.summary("pull", Math.round(performance.now() - pullStart), {
      files: changes,
      scanned: metaRows.length,
      fetched: needContent.length,
    });

    return changes;
  }

  async function fullWalkPush(
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    const pushStart = performance.now();
    await ready();

    // Fetch remote manifest for diff (metadata only, no content)
    const manifestDone = trace.startTimer("push", "manifest_fetch");
    const remoteRows: postgres.Row[] = await retryable(() =>
      sql.unsafe(
        `SELECT path, hash, deleted_at, updated_at FROM ${filesTable} WHERE deleted_at IS NULL`,
      )
    );
    manifestDone();
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

    // Collect all files that need pushing (diff against remote)
    const localPaths = new Set<string>();
    const toPush: Array<{ relPath: string; hash: string; bytes: Uint8Array }> =
      [];

    for (const sub of DATASTORE_SUBDIRS) {
      signal?.throwIfAborted();
      await walkAndPush(
        `${cachePath}/${sub}`,
        sub,
        async (relPath, bytes) => {
          signal?.throwIfAborted();
          localPaths.add(relPath);
          const hash = await sha256Hex(bytes);
          const existing = remotePaths.get(relPath);
          if (
            existing && existing.deletedAt === null && existing.hash === hash
          ) {
            return;
          }
          toPush.push({ relPath, hash, bytes });
        },
        signal,
      );
    }

    // Collect tombstones
    const toTombstone: string[] = [];
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      for (const [relPath, doc] of remotePaths) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        toTombstone.push(relPath);
      }
    }

    if (toPush.length === 0 && toTombstone.length === 0) {
      trace.summary("push", Math.round(performance.now() - pushStart), {
        files: 0,
        tombstones: 0,
      });
      return 0;
    }

    // Execute all writes in a single transaction
    const txDone = trace.startTimer("push", "transaction");
    const changes = await retryable(async () => {
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
        // Update team-global watermark
        await tx.unsafe(
          `INSERT INTO ${syncStateTable} (key, value, updated_at)
           VALUES ('last_pushed_at', to_jsonb(now()::text), now())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text), updated_at = now()`,
        );
      });
      return count;
    });
    txDone();

    trace.summary("push", Math.round(performance.now() - pushStart), {
      files: toPush.length,
      tombstones: toTombstone.length,
    });

    return changes;
  }

  async function pushOneRel(
    relPath: string,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    if (isTraversal(relPath)) return 0;
    await ready();
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
    const remoteRows: postgres.Row[] = await retryable(() =>
      sql.unsafe(
        `SELECT path, hash, deleted_at, updated_at FROM ${filesTable}
       WHERE path = $1 OR path LIKE $2 ESCAPE '\\'`,
        [relPath, escapeLike(relPath) + "/%"],
      )
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

    if (toPush.length === 0 && toTombstone.length === 0) return 0;

    // Execute all writes in a single transaction
    const changes = await retryable(async () => {
      let count = 0;
      await sql.begin(async (tx) => {
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
        for (const path of toTombstone) {
          await tx.unsafe(
            `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
            [path],
          );
          count++;
        }
        // Update team-global watermark
        await tx.unsafe(
          `INSERT INTO ${syncStateTable} (key, value, updated_at)
           VALUES ('last_pushed_at', to_jsonb(now()::text), now())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text), updated_at = now()`,
        );
      });
      return count;
    });

    return changes;
  }

  return {
    capabilities(): SyncCapabilities {
      return { scopedSync: true, lazyHydration: true };
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
      if (snapshot.bulkInvalidated) {
        changes = await fullWalkPush(snapshot.lastPulledAt, lazy, signal);
      } else if (snapshot.dirtyPaths.length === 0) {
        return 0;
      } else {
        changes = 0;
        for (const relPath of snapshot.dirtyPaths) {
          signal?.throwIfAborted();
          changes += await pushOneRel(
            relPath,
            snapshot.lastPulledAt,
            lazy,
            signal,
          );
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
      return changes;
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      if (isTraversal(relPath)) return false;
      await ready();
      const rows: postgres.Row[] = await retryable(() =>
        sql.unsafe(
          `SELECT content FROM ${filesTable} WHERE path = $1 AND deleted_at IS NULL`,
          [relPath],
        )
      );
      if (rows.length === 0) return false;

      const content = rows[0].content as Uint8Array;
      await writeFileAtomic(`${cachePath}/${relPath}`, content);
      return true;
    },
  };
}
