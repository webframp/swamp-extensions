// PostgreSQL Datastore Sync Service
// SPDX-License-Identifier: Apache-2.0

import type postgres from "npm:postgres@3.4.7";
import { Sidecar } from "./sidecar.ts";

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

function modelPrefixes(
  models: ReadonlyArray<{ modelType: string; modelId: string }> | undefined,
): string[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => `data/${m.modelType}/${m.modelId}/`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
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
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = `${relRoot}/${entry.name}`;
      if (entry.isDirectory) {
        await walkAndPush(childAbs, childRel, onFile);
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

  async function ensureSchema(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${filesTable} (
        path       TEXT PRIMARY KEY,
        hash       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        content    BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${filesTable.replace(".", "_")}_updated_at
      ON ${filesTable} (updated_at)
    `);
  }

  let schemaEnsured = false;
  async function ready(): Promise<void> {
    if (!schemaEnsured) {
      await ensureSchema();
      schemaEnsured = true;
    }
  }

  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<number> {
    await ready();
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const signal = opts?.signal;

    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    // Build WHERE clause
    const conditions: string[] = [];
    const params: string[] = [];
    let paramIdx = 1;

    if (scoped) {
      const orClauses = prefixes!.map((p) => {
        params.push(p + "%");
        return `path LIKE $${paramIdx++}`;
      });
      conditions.push(`(${orClauses.join(" OR ")})`);
    } else if (state.lastPulledAt !== null) {
      params.push(state.lastPulledAt);
      conditions.push(`updated_at > $${paramIdx++}`);
    }

    if (metadataOnly) {
      conditions.push(`NOT (path ~ '^data/.*/raw$')`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const rows: postgres.Row[] = await sql.unsafe(
      `SELECT path, hash, size, content, deleted_at, updated_at FROM ${filesTable} ${where}`,
      params,
    );

    let changes = 0;
    let maxUpdatedAt = state.lastPulledAt
      ? new Date(state.lastPulledAt).getTime()
      : 0;

    for (const row of rows) {
      signal?.throwIfAborted();
      const relPath = row.path as string;
      if (relPath.split("/").some((s) => s === "..")) continue;
      const updatedMs = new Date(String(row.updated_at)).getTime();
      if (updatedMs > maxUpdatedAt) maxUpdatedAt = updatedMs;

      if (row.deleted_at !== null) {
        // Remove local file
        try {
          await Deno.remove(`${cachePath}/${relPath}`);
          changes++;
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      } else {
        // Write content to cache
        const content = row.content as Uint8Array;
        const localPath = `${cachePath}/${relPath}`;
        // Skip if local hash matches
        try {
          const local = await Deno.readFile(localPath);
          if (await sha256Hex(local) === (row.hash as string)) continue;
        } catch { /* file missing or unreadable — download */ }
        await writeFileAtomic(localPath, content);
        changes++;
      }
    }

    if (!scoped && !metadataOnly) {
      const watermark = maxUpdatedAt > 0
        ? new Date(maxUpdatedAt).toISOString()
        : new Date().toISOString();
      await sidecar.setLastPulledAt(watermark);
      await sidecar.setLazyPullActive(false);
    }

    return changes;
  }

  async function fullWalkPush(
    lastPulledAt: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    await ready();
    let changes = 0;

    // Fetch remote manifest for diff
    const remoteRows: postgres.Row[] = await sql.unsafe(
      `SELECT path, hash, deleted_at, updated_at FROM ${filesTable}`,
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

    const localPaths = new Set<string>();

    const onFile = async (relPath: string, bytes: Uint8Array) => {
      localPaths.add(relPath);
      const hash = await sha256Hex(bytes);
      const existing = remotePaths.get(relPath);
      if (existing && existing.deletedAt === null && existing.hash === hash) {
        return;
      }
      await sql.unsafe(
        `INSERT INTO ${filesTable} (path, hash, size, content, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, now(), NULL)
         ON CONFLICT (path) DO UPDATE SET
           hash = EXCLUDED.hash, size = EXCLUDED.size,
           content = EXCLUDED.content, updated_at = now(), deleted_at = NULL`,
        [relPath, hash, bytes.byteLength, bytes],
      );
      changes++;
    };

    for (const sub of DATASTORE_SUBDIRS) {
      await walkAndPush(`${cachePath}/${sub}`, sub, onFile);
    }

    // Tombstone pass — skip when lazyPullActive
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      for (const [relPath, doc] of remotePaths) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        await sql.unsafe(
          `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
          [relPath],
        );
        changes++;
      }
    }

    return changes;
  }

  async function pushOneRel(
    relPath: string,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    if (relPath.split("/").some((s) => s === "..")) return 0;
    await ready();
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
      });
    }

    // Fetch remote state for this subtree
    const remoteRows: postgres.Row[] = await sql.unsafe(
      `SELECT path, hash, deleted_at, updated_at FROM ${filesTable}
       WHERE path = $1 OR path LIKE $2`,
      [relPath, relPath + "/%"],
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

    let changes = 0;
    for (const f of localFiles) {
      const existing = remotePaths.get(f.relPath);
      if (existing && existing.deletedAt === null && existing.hash === f.hash) {
        continue;
      }
      await sql.unsafe(
        `INSERT INTO ${filesTable} (path, hash, size, content, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, now(), NULL)
         ON CONFLICT (path) DO UPDATE SET
           hash = EXCLUDED.hash, size = EXCLUDED.size,
           content = EXCLUDED.content, updated_at = now(), deleted_at = NULL`,
        [f.relPath, f.hash, f.bytes.byteLength, f.bytes],
      );
      changes++;
    }

    // Tombstone — skip when lazyPullActive
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      const localPathSet = new Set(localFiles.map((f) => f.relPath));
      for (const [path, doc] of remotePaths) {
        if (localPathSet.has(path) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        await sql.unsafe(
          `UPDATE ${filesTable} SET deleted_at = now(), updated_at = now() WHERE path = $1`,
          [path],
        );
        changes++;
      }
    }

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

    async pushChanged(_options?: DatastoreSyncOptions): Promise<number> {
      await ready();
      const state = await sidecar.read();
      const lazy = state.lazyPullActive;

      if (state.bulkInvalidated) {
        const changes = await fullWalkPush(state.lastPulledAt, lazy);
        await sidecar.clearDirty();
        return changes;
      }

      if (state.dirtyPaths.length === 0) return 0;
      let changes = 0;
      for (const relPath of state.dirtyPaths) {
        changes += await pushOneRel(relPath, state.lastPulledAt, lazy);
      }
      await sidecar.clearDirty();
      return changes;
    },

    async hydrateFile(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      if (relPath.split("/").some((s) => s === "..")) return false;
      await ready();
      const rows: postgres.Row[] = await sql.unsafe(
        `SELECT content, hash FROM ${filesTable} WHERE path = $1 AND deleted_at IS NULL`,
        [relPath],
      );
      if (rows.length === 0) return false;

      const content = rows[0].content as Uint8Array;
      await writeFileAtomic(`${cachePath}/${relPath}`, content);
      return true;
    },
  };
}
