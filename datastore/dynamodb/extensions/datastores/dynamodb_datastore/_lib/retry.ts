// ABOUTME: Retryable DynamoDB wrapper with exponential backoff, jitter, and
// ABOUTME: abort signal support for transient throttling/connection errors.

const RETRYABLE_ERROR_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
  "LimitExceededException",
]);

const RETRYABLE_SYSTEM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

const JITTER_FRACTION = 0.25;

export function isRetryableDynamoError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as Error & { name?: string }).name;
  if (name && RETRYABLE_ERROR_NAMES.has(name)) return true;
  const code = (err as Error & { code?: string }).code;
  if (code && RETRYABLE_SYSTEM_CODES.has(code)) return true;
  return false;
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

export async function retryable<T>(
  op: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const signal = options?.signal;

  if (maxAttempts < 1) {
    throw new Error(
      `retryable: maxAttempts must be >= 1, got ${maxAttempts}`,
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
    try {
      return await op();
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryableDynamoError(err)) throw err;
      const raw = baseDelayMs * Math.pow(3, attempt);
      const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.floor(raw + jitter));
      await abortableSleep(delay, signal);
      attempt++;
    }
  }
}
