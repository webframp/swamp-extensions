// ABOUTME: PostgreSQL datastore extension for swamp — provides row-based distributed
// ABOUTME: locking, team-safe sync, and ACID-backed storage for shared datastores.

import { z } from "zod";
import postgres from "npm:postgres@3.4.9";
import {
  createSyncService as createSync,
  type TwoPhaseSyncService,
} from "./sync.ts";
import { Attr, recordRetry, sqlSpan, withSpan } from "./_lib/tracing.ts";

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
  signal?: AbortSignal;
}

interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  heartbeat(): Promise<boolean>;
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

const ConfigSchema = z.object({
  connectionString: z.string().min(1).describe(
    "PostgreSQL connection URI (supports RDS, Aurora, Aurora Serverless v2)",
  ),
  schema: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message:
      "Schema must be a valid SQL identifier (letters, digits, underscores)",
  }).default("swamp").describe(
    "PostgreSQL schema for swamp tables",
  ),
  ssl: z.enum(["disable", "require", "verify-ca"]).default("require").describe(
    "SSL mode: disable (no TLS), require (TLS without CA verify), verify-ca (TLS with CA bundle)",
  ),
  sslCaPath: z.string().optional().describe(
    "Path to CA certificate bundle (e.g., RDS global-bundle.pem). Required when ssl=verify-ca.",
  ),
}).refine(
  (data) => data.ssl !== "verify-ca" || data.sslCaPath !== undefined,
  { message: "sslCaPath is required when ssl=verify-ca", path: ["sslCaPath"] },
).refine(
  (data) => !data.sslCaPath || !data.sslCaPath.split(/[/\\]/).includes(".."),
  {
    message: "sslCaPath must not contain '..' path segments",
    path: ["sslCaPath"],
  },
);

type PostgresConfig = z.output<typeof ConfigSchema>;

function buildSslConfig(
  parsed: PostgresConfig,
): boolean | "require" | "prefer" | object {
  if (parsed.ssl === "disable") return false;
  if (parsed.ssl === "verify-ca") {
    if (!parsed.sslCaPath) {
      throw new Error("sslCaPath is required when ssl=verify-ca");
    }
    return {
      rejectUnauthorized: true,
      ca: Deno.readTextFileSync(parsed.sslCaPath),
    };
  }
  return "require";
}

/**
 * Builds a row-based distributed lock over the given connection.
 *
 * Exported for tests: the lock is otherwise reachable only through
 * `createProvider`, which opens its own real connection, so its spans could
 * not be asserted anywhere a database is unavailable.
 */
export function createPostgresLock(
  sql: postgres.Sql,
  locksTable: string,
  datastorePath: string,
  options?: LockOptions,
  ensureInfra?: () => Promise<void>,
): DistributedLock {
  const key = options?.lockKey ?? datastorePath;
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  let nonce: string | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;

  const acquire = async () => {
    return await withSpan("postgres-datastore lock acquire", {
      [Attr.LOCK_KEY]: key,
      [Attr.LOCK_TIMEOUT_MS]: maxWaitMs,
      [Attr.LOCK_TTL_MS]: ttlMs,
    }, async (span) => {
      if (nonce !== undefined) {
        throw new Error("Lock already acquired; call release() first");
      }
      if (ensureInfra) await ensureInfra();
      const signal = options?.signal;
      const start = Date.now();
      const candidateNonce = crypto.randomUUID();
      nonce = candidateNonce;
      let contended = false;
      try {
        const holder = `${
          Deno.env.get("USER") ?? "unknown"
        }@${Deno.hostname()}`;
        const hostname = Deno.hostname();
        const pid = Deno.pid;
        let attempt = 0;

        while (Date.now() - start < maxWaitMs) {
          if (signal?.aborted) {
            throw new DOMException("Lock acquisition aborted", "AbortError");
          }
          const rows: postgres.Row[] = await sqlSpan(
            "acquireLock",
            "INSERT",
            locksTable,
            () =>
              sql.unsafe(
                `INSERT INTO ${locksTable} (key, holder, hostname, pid, acquired_at, ttl_ms, nonce)
           VALUES ($1, $2, $3, $4, now(), $5, $6)
           ON CONFLICT (key) DO UPDATE
             SET holder = EXCLUDED.holder,
                 hostname = EXCLUDED.hostname,
                 pid = EXCLUDED.pid,
                 acquired_at = EXCLUDED.acquired_at,
                 ttl_ms = EXCLUDED.ttl_ms,
                 nonce = EXCLUDED.nonce
             WHERE ${locksTable}.acquired_at + make_interval(secs => ${locksTable}.ttl_ms / 1000.0) < now()
           RETURNING nonce`,
                [key, holder, hostname, pid, ttlMs, candidateNonce],
              ),
          );

          if (rows.length > 0 && rows[0].nonce === candidateNonce) {
            const acquiredNonce = candidateNonce;
            heartbeatId = setInterval(async () => {
              try {
                await sql.unsafe(
                  `UPDATE ${locksTable} SET acquired_at = now() WHERE key = $1 AND nonce = $2`,
                  [key, acquiredNonce],
                );
              } catch {
                // Connection lost — lock will expire via TTL
              }
            }, ttlMs / 3);
            // Unref so the timer doesn't prevent process exit if release is never called
            Deno.unrefTimer(heartbeatId);
            span.setAttributes({
              [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
              [Attr.LOCK_CONTENDED]: contended,
            });
            return;
          }
          contended = true;
          // Jittered backoff: base interval * (1 + random * 0.5), capped at 2x base
          const backoff = Math.min(
            retryIntervalMs * Math.pow(1.5, Math.min(attempt, 4)),
            retryIntervalMs * 2,
          );
          const jitter = backoff * (0.5 + Math.random() * 0.5);
          const delay = Math.floor(jitter);
          recordRetry(attempt + 1, delay, {
            "retry.reason": "lock_contended",
          });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (signal) signal.removeEventListener("abort", onAbort);
              resolve();
            }, delay);
            const onAbort = () => {
              clearTimeout(timer);
              reject(
                new DOMException("Lock acquisition aborted", "AbortError"),
              );
            };
            if (signal) {
              if (signal.aborted) {
                clearTimeout(timer);
                reject(
                  new DOMException("Lock acquisition aborted", "AbortError"),
                );
                return;
              }
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          attempt++;
        }
      } catch (e) {
        nonce = undefined;
        throw e;
      }
      nonce = undefined;
      span.setAttributes({
        [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
        [Attr.LOCK_CONTENDED]: contended,
      });
      throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
    });
  };

  const release = async () => {
    return await withSpan("postgres-datastore lock release", {
      [Attr.LOCK_KEY]: key,
    }, async () => {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId);
        heartbeatId = undefined;
      }
      if (nonce) {
        const releaseNonce = nonce;
        try {
          await sqlSpan(
            "releaseLock",
            "DELETE",
            locksTable,
            () =>
              sql.unsafe(
                `DELETE FROM ${locksTable} WHERE key = $1 AND nonce = $2`,
                [key, releaseNonce],
              ),
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

    heartbeat: async (): Promise<boolean> => {
      if (!nonce) return false;
      // Deliberately not wrapped in a span (see otel_test.ts) — heartbeats
      // fire every ttlMs/3 and would dominate trace volume. Context is
      // still added to the error message so a connection failure here
      // names the lock key rather than surfacing a bare driver error.
      try {
        const result = await sql.unsafe(
          `UPDATE ${locksTable} SET acquired_at = now() WHERE key = $1 AND nonce = $2`,
          [key, nonce],
        );
        return Number(result.count) > 0;
      } catch (err) {
        throw new Error(
          `postgres-datastore heartbeat failed for lock key "${key}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      return await withSpan("postgres-datastore lock withLock", {
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
      return await withSpan("postgres-datastore lock inspect", {
        [Attr.LOCK_KEY]: key,
      }, async (span) => {
        const rows: postgres.Row[] = await sqlSpan(
          "inspectLock",
          "SELECT",
          locksTable,
          () =>
            sql.unsafe(
              `SELECT holder, hostname, pid, acquired_at, ttl_ms, nonce FROM ${locksTable} WHERE key = $1`,
              [key],
            ),
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        if (row.holder) {
          span.setAttribute(
            Attr.LOCK_HOLDER,
            `${row.holder} (pid ${row.pid})`,
          );
        }
        return {
          holder: row.holder,
          hostname: row.hostname,
          pid: row.pid,
          acquiredAt: String(row.acquired_at),
          ttlMs: row.ttl_ms,
          nonce: row.nonce,
        };
      });
    },

    forceRelease: async (expectedNonce: string) => {
      return await withSpan("postgres-datastore lock forceRelease", {
        [Attr.LOCK_KEY]: key,
      }, async () => {
        const result = await sqlSpan(
          "forceReleaseLock",
          "DELETE",
          locksTable,
          () =>
            sql.unsafe(
              `DELETE FROM ${locksTable} WHERE key = $1 AND nonce = $2`,
              [key, expectedNonce],
            ),
        );
        return Number(result.count) > 0;
      });
    },
  };
}

/**
 * PostgreSQL datastore provider for swamp.
 *
 * Stores runtime data in PostgreSQL using row-based distributed locking
 * with fencing tokens. Compatible with AWS RDS, Aurora, and Aurora
 * Serverless v2.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * datastore:
 *   type: "@webframp/postgres-datastore"
 *   config:
 *     connectionString: "postgres://user:pass@host:5432/db"
 * ```
 */
export const datastore = {
  type: "@webframp/postgres-datastore",
  name: "PostgreSQL Datastore",
  description:
    "Stores swamp runtime data in PostgreSQL with row-based distributed locking. Compatible with AWS RDS, Aurora, and Aurora Serverless v2.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>): DatastoreProvider => {
    const parsed = ConfigSchema.parse(config);
    const sslConfig = buildSslConfig(parsed);

    const sql = postgres(parsed.connectionString, {
      ssl: sslConfig,
      max: 5,
      idle_timeout: 0,
    });

    const locksTable = `${parsed.schema}.locks`;

    let infraPromise: Promise<void> | undefined;
    function ensureInfrastructure(): Promise<void> {
      if (!infraPromise) {
        infraPromise = (async () => {
          await withSpan("postgres-datastore ensureInfrastructure", {
            [Attr.DB_SYSTEM]: "postgresql",
            [Attr.DB_COLLECTION]: locksTable,
          }, async () => {
            await sqlSpan(
              "createSchema",
              "CREATE SCHEMA",
              parsed.schema,
              () =>
                sql.unsafe(
                  `CREATE SCHEMA IF NOT EXISTS ${parsed.schema}`,
                ),
            );
            await sqlSpan(
              "createLocksTable",
              "CREATE TABLE",
              locksTable,
              () =>
                sql.unsafe(`
            CREATE TABLE IF NOT EXISTS ${locksTable} (
              key         TEXT PRIMARY KEY,
              holder      TEXT NOT NULL,
              hostname    TEXT NOT NULL,
              pid         INTEGER NOT NULL,
              acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              ttl_ms      INTEGER NOT NULL DEFAULT 30000,
              nonce       TEXT NOT NULL
            )
          `),
            );
          });
        })().catch((e) => {
          infraPromise = undefined;
          throw e;
        });
      }
      return infraPromise;
    }

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createPostgresLock(
          sql,
          locksTable,
          datastorePath,
          options,
          ensureInfrastructure,
        );
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            await ensureInfrastructure();
            const [row] = await sqlSpan(
              "serverVersion",
              "SELECT",
              "pg_catalog",
              () =>
                sql`
              SELECT version() AS v,
                     current_setting('server_version') AS sv,
                     pg_is_in_recovery() AS is_replica
            `,
            );
            if (row.is_replica) {
              return {
                healthy: false,
                message:
                  "Connected to read replica — datastore requires writer endpoint",
                latencyMs: Math.round(performance.now() - start),
                datastoreType: "@webframp/postgres-datastore",
              };
            }
            return {
              healthy: true,
              message: "OK",
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/postgres-datastore",
              details: { version: row.sv, schema: parsed.schema },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/postgres-datastore",
            };
          }
        },
      }),

      resolveDatastorePath: (_repoDir: string): string =>
        `pg://${parsed.schema}.datastore`,

      createSyncService: (
        _repoDir: string,
        cachePath: string,
      ) => {
        const filesTable = `${parsed.schema}.files`;
        return createSync(sql, filesTable, cachePath);
      },

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },
    };
  },
};
