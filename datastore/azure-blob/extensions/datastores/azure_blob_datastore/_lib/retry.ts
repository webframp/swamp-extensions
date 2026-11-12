// ABOUTME: Retryable HTTP wrapper with exponential backoff, jitter, and abort
// ABOUTME: signal support for transient Azure Blob Storage errors (429/5xx).

import { recordRetry } from "./tracing.ts";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const JITTER_FRACTION = 0.25;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new DOMException(
          signal?.reason instanceof Error ? signal.reason.message : "Aborted",
          "AbortError",
        ),
      );
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(
          new DOMException(
            signal.reason instanceof Error ? signal.reason.message : "Aborted",
            "AbortError",
          ),
        );
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Retry a request-deadline `TimeoutError` (default true). Disable for
   * operations that are unsafe to repeat after an unobserved success, such as
   * a lease acquire whose lost response leaves an orphaned lease. */
  retryTimeouts?: boolean;
}

/** True for the `TimeoutError` that `AbortSignal.timeout` rejects with. A
 * caller-initiated abort is an `AbortError` and is deliberately not matched. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

/** Retries `op` while it returns a retryable HTTP status or rejects with a
 * request-deadline `TimeoutError`; stops once `op` returns a non-retryable
 * status or `maxAttempts` is exhausted (the last timeout is rethrown). Other
 * network errors thrown by `op` propagate immediately (not retried here). */
export async function retryableRequest<T extends { status: number }>(
  op: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const signal = options?.signal;
  const retryTimeouts = options?.retryTimeouts ?? true;

  if (maxAttempts < 1) {
    throw new Error(
      `retryableRequest: maxAttempts must be >= 1, got ${maxAttempts}`,
    );
  }

  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      throw new DOMException(
        signal.reason instanceof Error ? signal.reason.message : "Aborted",
        "AbortError",
      );
    }
    const isLastAttempt = attempt === maxAttempts - 1;
    let result: T | undefined;
    try {
      result = await op();
    } catch (err) {
      if (isLastAttempt || !retryTimeouts || !isTimeoutError(err)) throw err;
    }
    if (result !== undefined) {
      if (isLastAttempt || !isRetryableStatus(result.status)) return result;
    }
    const raw = baseDelayMs * Math.pow(3, attempt);
    const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.floor(raw + jitter));
    recordRetry(
      attempt + 1,
      delay,
      result === undefined ? { "retry.reason": "request_timeout" } : {
        "retry.reason": "retryable_status",
        "http.response.status_code": result.status,
      },
    );
    await abortableSleep(delay, signal);
    attempt++;
  }
}
