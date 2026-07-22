// ABOUTME: DistributedLock over DynamoDB conditional writes — fencing-token
// ABOUTME: nonces provide compare-and-swap safety; native TTL is defense-in-depth only.

import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1091.0";
import { lockKey } from "./keys.ts";

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

export function createDynamoLock(
  doc: DynamoDBDocumentClient,
  tableName: string,
  datastorePath: string,
  options?: LockOptions,
): DistributedLock {
  const key = options?.lockKey ?? datastorePath;
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  const { pk, sk } = lockKey(key);
  let nonce: string | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;

  const acquire = async () => {
    if (nonce !== undefined) {
      throw new Error("Lock already acquired; call release() first");
    }
    const signal = options?.signal;
    const start = Date.now();
    const candidateNonce = crypto.randomUUID();
    const holder = `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`;
    const hostname = Deno.hostname();
    const pid = Deno.pid;
    let attempt = 0;

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
          heartbeatId = setInterval(async () => {
            try {
              const heartbeatNowMs = Date.now();
              await doc.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { pk, sk },
                  UpdateExpression:
                    "SET acquiredAt = :at, acquiredAtMs = :atMs, expiresAtMs = :exp, #ttl = :ttlVal",
                  ConditionExpression: "nonce = :nonce",
                  ExpressionAttributeNames: { "#ttl": "ttl" },
                  ExpressionAttributeValues: {
                    ":at": new Date(heartbeatNowMs).toISOString(),
                    ":atMs": heartbeatNowMs,
                    ":exp": heartbeatNowMs + ttlMs,
                    ":ttlVal": Math.floor((heartbeatNowMs + ttlMs) / 1000) +
                      TTL_SWEEP_BUFFER_SECONDS,
                    ":nonce": acquiredNonce,
                  },
                }),
              );
            } catch {
              // Connection lost or lock lost — lock will expire via expiresAtMs check
            }
          }, ttlMs / 3);
          Deno.unrefTimer(heartbeatId);
          return;
        } catch (err) {
          if (!isConditionalCheckFailed(err)) throw err;
          // Lost the race — another holder has a non-expired lock. Fall through to backoff.
        }

        const backoff = Math.min(
          retryIntervalMs * Math.pow(1.5, Math.min(attempt, 4)),
          retryIntervalMs * 2,
        );
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        const delay = Math.floor(jitter);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Lock acquisition aborted", "AbortError"));
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
    throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
  };

  const release = async () => {
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
  };

  return {
    acquire,
    release,

    heartbeat: async (): Promise<boolean> => {
      if (!nonce) return false;
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
              ":nonce": nonce,
            },
          }),
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await fn();
      } finally {
        await release();
      }
    },

    inspect: async () => {
      const result = await doc.send(
        new GetCommand({ TableName: tableName, Key: { pk, sk } }),
      );
      const item = result.Item;
      if (!item) return null;
      return {
        holder: item.holder,
        hostname: item.hostname,
        pid: item.pid,
        acquiredAt: item.acquiredAt,
        ttlMs: item.ttlMs,
        nonce: item.nonce,
      };
    },

    forceRelease: async (expectedNonce: string): Promise<boolean> => {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { pk, sk },
            ConditionExpression: "nonce = :nonce",
            ExpressionAttributeValues: { ":nonce": expectedNonce },
          }),
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },
  };
}
