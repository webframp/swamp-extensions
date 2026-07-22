// ABOUTME: DistributedLock over native Azure Blob leases — the lease ID
// ABOUTME: doubles as the fencing-token nonce; Azure enforces compare-and-swap
// ABOUTME: server-side, so this implementation is simpler than a hand-rolled CAS.

import type { BlobClient, BlobResponse } from "./rest_client.ts";
import { retryableRequest } from "./_lib/retry.ts";

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

const MIN_LEASE_SECONDS = 15;
const MAX_LEASE_SECONDS = 60;

function clampLeaseSeconds(ttlMs: number): number {
  return Math.min(
    MAX_LEASE_SECONDS,
    Math.max(MIN_LEASE_SECONDS, Math.round(ttlMs / 1000)),
  );
}

function lockBlobPath(container: string, prefix: string, key: string): string {
  return `/${container}/${prefix}/_locks/${encodeURIComponent(key)}.lock`;
}

async function leaseAction(
  client: BlobClient,
  path: string,
  action: "acquire" | "renew" | "release" | "break",
  leaseId?: string,
  durationSeconds?: number,
): Promise<BlobResponse> {
  const headers: Record<string, string> = { "x-ms-lease-action": action };
  if (leaseId) headers["x-ms-lease-id"] = leaseId;
  if (durationSeconds !== undefined) {
    headers["x-ms-lease-duration"] = String(durationSeconds);
  }
  return await retryableRequest(() =>
    client.request({
      method: "PUT",
      path,
      query: { comp: "lease" },
      headers,
    })
  );
}

async function ensureBlobExists(
  client: BlobClient,
  path: string,
): Promise<void> {
  const resp = await retryableRequest(() =>
    client.request({
      method: "PUT",
      path,
      headers: {
        "If-None-Match": "*",
        "Content-Length": "0",
        "x-ms-blob-type": "BlockBlob",
      },
      body: new Uint8Array(0),
    })
  );
  // 201 Created, or 412 Precondition Failed (If-None-Match: * means "already
  // exists" — NOT 409, which Azure reserves for lease conflicts) are both fine.
  if (resp.status !== 201 && resp.status !== 412) {
    const message = new TextDecoder().decode(resp.body);
    throw new Error(`Failed to create lock blob (${resp.status}): ${message}`);
  }
}

export function createBlobLock(
  client: BlobClient,
  container: string,
  prefix: string,
  datastorePath: string,
  options?: LockOptions,
): DistributedLock {
  const key = options?.lockKey ?? datastorePath;
  const path = lockBlobPath(container, prefix, key);
  const ttlMs = options?.ttlMs ?? 30_000;
  const leaseSeconds = clampLeaseSeconds(ttlMs);
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  let leaseId: string | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;

  const stampMetadata = async (id: string): Promise<void> => {
    const holder = `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`;
    const resp = await retryableRequest(() =>
      client.request({
        method: "PUT",
        path,
        query: { comp: "metadata" },
        headers: {
          "x-ms-lease-id": id,
          "x-ms-meta-holder": holder,
          "x-ms-meta-hostname": Deno.hostname(),
          "x-ms-meta-pid": String(Deno.pid),
          "x-ms-meta-acquiredat": new Date().toISOString(),
          "x-ms-meta-ttlms": String(ttlMs),
          "x-ms-meta-nonce": id,
        },
      })
    );
    if (resp.status !== 200) {
      const message = new TextDecoder().decode(resp.body);
      throw new Error(
        `Failed to stamp lock metadata (${resp.status}): ${message}`,
      );
    }
  };

  const acquire = async () => {
    if (leaseId !== undefined) {
      throw new Error("Lock already acquired; call release() first");
    }
    await ensureBlobExists(client, path);
    const signal = options?.signal;
    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < maxWaitMs) {
      if (signal?.aborted) {
        throw new DOMException("Lock acquisition aborted", "AbortError");
      }
      const resp = await leaseAction(
        client,
        path,
        "acquire",
        undefined,
        leaseSeconds,
      );
      if (resp.status === 201) {
        const acquiredId = resp.headers.get("x-ms-lease-id");
        if (!acquiredId) {
          throw new Error("Azure did not return a lease ID on acquire");
        }
        try {
          await stampMetadata(acquiredId);
        } catch (err) {
          // Don't leave this instance permanently wedged (leaseId was never
          // set, so acquire() can be retried) and don't strand the lease we
          // just took on Azure — best-effort release it back.
          try {
            await leaseAction(client, path, "release", acquiredId);
          } catch {
            // Ignore — the lease will expire via its fixed duration anyway.
          }
          throw err;
        }
        leaseId = acquiredId;
        heartbeatId = setInterval(async () => {
          try {
            await leaseAction(client, path, "renew", acquiredId);
          } catch {
            // Connection lost or lease lost — lease will expire via its fixed duration
          }
        }, (leaseSeconds * 1000) / 3);
        Deno.unrefTimer(heartbeatId);
        return;
      }
      if (resp.status !== 409) {
        const message = new TextDecoder().decode(resp.body);
        throw new Error(`Lease acquire failed (${resp.status}): ${message}`);
      }
      // 409 LeaseAlreadyPresent — another holder has a live lease. Backoff and
      // retry. Cap at 1.5^4 (≈5x) so all 5 graduated tiers are distinct —
      // capping lower would collapse most of them to the same flat value.
      const backoff = Math.min(
        retryIntervalMs * Math.pow(1.5, Math.min(attempt, 4)),
        retryIntervalMs * Math.pow(1.5, 4),
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
            reject(new DOMException("Lock acquisition aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      attempt++;
    }
    throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
  };

  const release = async () => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
    if (leaseId) {
      const releaseId = leaseId;
      leaseId = undefined;
      try {
        await leaseAction(client, path, "release", releaseId);
      } catch {
        // Already released/expired, or connection lost — lease will expire via its fixed duration
      }
    }
  };

  return {
    acquire,
    release,

    heartbeat: async (): Promise<boolean> => {
      if (!leaseId) return false;
      const resp = await leaseAction(client, path, "renew", leaseId);
      return resp.status === 200;
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
      const resp = await client.request({
        method: "GET",
        path,
        query: { comp: "metadata" },
      });
      if (resp.status === 404) return null;
      if (resp.status !== 200) return null;
      const leaseState = resp.headers.get("x-ms-lease-state");
      if (leaseState !== "leased") return null;
      const meta = (name: string) =>
        resp.headers.get(`x-ms-meta-${name}`) ?? "";
      return {
        holder: meta("holder"),
        hostname: meta("hostname"),
        pid: Number(meta("pid")) || 0,
        acquiredAt: meta("acquiredat"),
        ttlMs: Number(meta("ttlms")) || ttlMs,
        nonce: meta("nonce") || undefined,
      };
    },

    forceRelease: async (expectedNonce: string): Promise<boolean> => {
      const resp = await leaseAction(client, path, "release", expectedNonce);
      if (resp.status !== 200) return false;
      // If this instance itself held that lease, clear its local state too —
      // otherwise a subsequent acquire() on this same object would wrongly
      // throw "already acquired" even though the lease is now free on Azure.
      if (leaseId === expectedNonce) {
        if (heartbeatId !== undefined) {
          clearInterval(heartbeatId);
          heartbeatId = undefined;
        }
        leaseId = undefined;
      }
      return true;
    },
  };
}
