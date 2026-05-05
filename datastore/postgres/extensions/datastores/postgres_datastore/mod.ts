// PostgreSQL Datastore Extension
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";
import postgres from "npm:postgres@3.4.7";

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

interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  resolveDatastorePath(repoDir: string): string;
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

function createPostgresLock(
  sql: postgres.Sql,
  locksTable: string,
  datastorePath: string,
  options?: LockOptions,
): DistributedLock {
  const key = options?.lockKey ?? datastorePath;
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  let nonce: string | undefined;
  let heartbeatId: number | undefined;

  const acquire = async () => {
    if (nonce !== undefined) {
      throw new Error("Lock already acquired; call release() first");
    }
    const start = Date.now();
    nonce = crypto.randomUUID();
    try {
      const holder = `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`;
      const hostname = Deno.hostname();
      const pid = Deno.pid;

      while (Date.now() - start < maxWaitMs) {
        const rows: postgres.Row[] = await sql.unsafe(
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
          [key, holder, hostname, pid, ttlMs, nonce],
        );

        if (rows.length > 0 && rows[0].nonce === nonce) {
          const acquiredNonce = nonce;
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
          return;
        }
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    } catch (e) {
      nonce = undefined;
      throw e;
    }
    nonce = undefined;
    throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
  };

  const release = async () => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
    if (nonce) {
      try {
        await sql.unsafe(
          `DELETE FROM ${locksTable} WHERE key = $1 AND nonce = $2`,
          [key, nonce],
        );
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
      const rows: postgres.Row[] = await sql.unsafe(
        `SELECT holder, hostname, pid, acquired_at, ttl_ms, nonce FROM ${locksTable} WHERE key = $1`,
        [key],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        holder: row.holder,
        hostname: row.hostname,
        pid: row.pid,
        acquiredAt: String(row.acquired_at),
        ttlMs: row.ttl_ms,
        nonce: row.nonce,
      };
    },

    forceRelease: async (expectedNonce: string) => {
      const result = await sql.unsafe(
        `DELETE FROM ${locksTable} WHERE key = $1 AND nonce = $2`,
        [key, expectedNonce],
      );
      return Number(result.count) > 0;
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

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createPostgresLock(sql, locksTable, datastorePath, options);
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            const [row] = await sql`
              SELECT version() AS v,
                     current_setting('server_version') AS sv,
                     pg_is_in_recovery() AS is_replica
            `;
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
    };
  },
};
