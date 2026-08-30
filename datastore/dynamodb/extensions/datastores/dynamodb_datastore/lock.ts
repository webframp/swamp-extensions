// ABOUTME: DistributedLock over DynamoDB conditional writes — fencing-token
// ABOUTME: nonces provide compare-and-swap safety; native TTL is defense-in-depth only.

import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1121.0";
import { lockKey } from "./keys.ts";
import {
  Attr,
  detached,
  instrumentClient,
  recordRetry,
  withSpan,
} from "./_lib/tracing.ts";

export interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

export interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  heartbeat(): Promise<boolean>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

/** Extra buffer added on top of TTL when stamping the native `ttl` attribute, so
 * the sweep never races an in-flight heartbeat renewal. Defense-in-depth only. */
const TTL_SWEEP_BUFFER_SECONDS = 3600;

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/**
 * Wraps a DynamoDB SDK failure with the lock operation, key, and table that
 * was in flight. `ConditionalCheckFailedException` passes through unchanged
 * — callers treat it as an expected contention signal, not a failure — but
 * every other SDK error (throttling, network failure, missing table,
 * expired credentials) would otherwise surface as a bare AWS error with no
 * indication of which lock was affected.
 */
function wrapLockError(
  op: string,
  tableName: string,
  key: string,
  err: unknown,
): never {
  if (isConditionalCheckFailed(err)) throw err;
  const reason = err instanceof Error ? err.message : String(err);
  throw new Error(
    `DynamoDB ${op} failed for lock "${key}" in table "${tableName}": ${reason}`,
    { cause: err },
  );
}

export function createDynamoLock(
  rawDoc: DynamoDBDocumentClient,
  tableName: string,
  datastorePath: string,
  options?: LockOptions,
  ensureInfrastructure?: () => Promise<void>,
): DistributedLock {
  // Wrapped here rather than in createClients() so the spans are emitted no
  // matter how the caller obtained the client.
  const doc = instrumentClient(rawDoc);
  const key = options?.lockKey ?? datastorePath;
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  const { pk, sk } = lockKey(key);
  let nonce: string | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;

  /** Shared by heartbeat() and the periodic auto-renewal timer, so the two
   * renewal paths can never silently diverge in what they persist. */
  const renewLock = async (currentNonce: string): Promise<boolean> => {
    const nowMs = Date.now();
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk },
          UpdateExpression:
            "SET acquiredAt = :at, acquiredAtMs = :atMs, expiresAtMs = :exp, #ttl = :ttlVal",
          ConditionExpression: "nonce = :nonce",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":at": new Date(nowMs).toISOString(),
            ":atMs": nowMs,
            ":exp": nowMs + ttlMs,
            ":ttlVal": Math.floor((nowMs + ttlMs) / 1000) +
              TTL_SWEEP_BUFFER_SECONDS,
            ":nonce": currentNonce,
          },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      wrapLockError("renew", tableName, key, err);
    }
  };

  const acquire = async () => {
    return await withSpan("dynamodb-datastore lock acquire", {
      [Attr.LOCK_KEY]: key,
      [Attr.LOCK_TIMEOUT_MS]: maxWaitMs,
      [Attr.LOCK_TTL_MS]: ttlMs,
    }, async (span) => {
      if (nonce !== undefined) {
        throw new Error("Lock already acquired; call release() first");
      }
      if (ensureInfrastructure) await ensureInfrastructure();
      const signal = options?.signal;
      const start = Date.now();
      const candidateNonce = crypto.randomUUID();
      const holder = `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`;
      const hostname = Deno.hostname();
      const pid = Deno.pid;
      let attempt = 0;
      let contended = false;

      try {
        while (Date.now() - start < maxWaitMs) {
          if (signal?.aborted) {
            throw new DOMException("Lock acquisition aborted", "AbortError");
          }
          const nowMs = Date.now();
          try {
            await doc.send(
              new PutCommand({
                TableName: tableName,
                Item: {
                  pk,
                  sk,
                  holder,
                  hostname,
                  pid,
                  acquiredAt: new Date(nowMs).toISOString(),
                  acquiredAtMs: nowMs,
                  ttlMs,
                  expiresAtMs: nowMs + ttlMs,
                  nonce: candidateNonce,
                  ttl: Math.floor((nowMs + ttlMs) / 1000) +
                    TTL_SWEEP_BUFFER_SECONDS,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) OR expiresAtMs < :now",
                ExpressionAttributeValues: { ":now": nowMs },
              }),
            );
            nonce = candidateNonce;
            const acquiredNonce = candidateNonce;
            heartbeatId = setInterval(() => {
              // Detached so the renewal span is its own trace rather than a
              // child of this acquire span, which has already ended by then.
              detached(async () => {
                try {
                  await renewLock(acquiredNonce);
                } catch {
                  // Connection lost or lock lost — lock will expire via expiresAtMs check
                }
              });
            }, ttlMs / 3);
            Deno.unrefTimer(heartbeatId);
            span.setAttributes({
              [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
              [Attr.LOCK_CONTENDED]: contended,
            });
            return;
          } catch (err) {
            if (!isConditionalCheckFailed(err)) {
              wrapLockError("acquire", tableName, key, err);
            }
            // Lost the race — another holder has a non-expired lock. Fall through to backoff.
            contended = true;
          }

          const backoff = Math.min(
            retryIntervalMs * Math.pow(1.5, Math.min(attempt, 4)),
            retryIntervalMs * 2,
          );
          const jitter = backoff * (0.5 + Math.random() * 0.5);
          const delay = Math.floor(jitter);
          recordRetry(attempt + 1, delay, { "retry.reason": "lock_contended" });
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
    return await withSpan("dynamodb-datastore lock release", {
      [Attr.LOCK_KEY]: key,
    }, async () => {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId);
        heartbeatId = undefined;
      }
      if (nonce) {
        const releaseNonce = nonce;
        nonce = undefined;
        try {
          await doc.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { pk, sk },
              ConditionExpression: "nonce = :nonce",
              ExpressionAttributeValues: { ":nonce": releaseNonce },
            }),
          );
        } catch {
          // Already released/stale, or connection lost — lock will expire via expiresAtMs check
        }
      }
    });
  };

  return {
    acquire,
    release,

    heartbeat: async (): Promise<boolean> => {
      if (!nonce) return false;
      return await renewLock(nonce);
    },

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      return await withSpan("dynamodb-datastore lock withLock", {
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
      return await withSpan("dynamodb-datastore lock inspect", {
        [Attr.LOCK_KEY]: key,
      }, async (span) => {
        let result;
        try {
          result = await doc.send(
            new GetCommand({ TableName: tableName, Key: { pk, sk } }),
          );
        } catch (err) {
          wrapLockError("inspect", tableName, key, err);
        }
        const item = result.Item;
        if (!item) return null;
        if (item.holder) {
          span.setAttribute(
            Attr.LOCK_HOLDER,
            `${item.holder} (pid ${item.pid})`,
          );
        }
        return {
          holder: item.holder,
          hostname: item.hostname,
          pid: item.pid,
          acquiredAt: item.acquiredAt,
          ttlMs: item.ttlMs,
          nonce: item.nonce,
        };
      });
    },

    forceRelease: async (expectedNonce: string): Promise<boolean> => {
      return await withSpan("dynamodb-datastore lock forceRelease", {
        [Attr.LOCK_KEY]: key,
      }, async () => {
        try {
          await doc.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { pk, sk },
              ConditionExpression: "nonce = :nonce",
              ExpressionAttributeValues: { ":nonce": expectedNonce },
            }),
          );
          // If this instance itself held that lock, drop its local state too.
          // Leaving the heartbeat running would keep renewing a lock this
          // object no longer owns, and keeps the interval alive for the
          // lifetime of the process.
          if (nonce === expectedNonce) {
            if (heartbeatId !== undefined) {
              clearInterval(heartbeatId);
              heartbeatId = undefined;
            }
            nonce = undefined;
          }
          return true;
        } catch (err) {
          if (isConditionalCheckFailed(err)) return false;
          wrapLockError("forceRelease", tableName, key, err);
        }
      });
    },
  };
}
