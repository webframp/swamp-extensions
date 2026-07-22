// ABOUTME: Retryable HTTP wrapper with exponential backoff, jitter, and abort
// ABOUTME: signal support for transient Azure Blob Storage errors (429/5xx).

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
}

/** Retries `op` while it returns a retryable HTTP status; stops retrying once
 * `op` returns a non-retryable status or `maxAttempts` is exhausted — network
 * errors thrown by `op` itself propagate immediately (not retried here). */
export async function retryableRequest<T extends { status: number }>(
  op: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const signal = options?.signal;

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
    const result = await op();
    const isLastAttempt = attempt === maxAttempts - 1;
    if (isLastAttempt || !isRetryableStatus(result.status)) return result;
    const raw = baseDelayMs * Math.pow(3, attempt);
    const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.floor(raw + jitter));
    await abortableSleep(delay, signal);
    attempt++;
  }
}
