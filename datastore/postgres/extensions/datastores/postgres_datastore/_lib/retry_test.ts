// ABOUTME: Tests for the retryable SQL wrapper — exponential backoff, jitter,
// ABOUTME: abort signal support, and PostgreSQL error code classification.

import { assertEquals, assertRejects } from "@std/assert";
import {
  isRetryablePgError,
  retryable,
} from "./retry.ts";

Deno.test("isRetryablePgError: serialization_failure is retryable", () => {
  const err = Object.assign(new Error("serialization"), { code: "40001" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: deadlock_detected is retryable", () => {
  const err = Object.assign(new Error("deadlock"), { code: "40P01" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: cannot_connect_now is retryable", () => {
  const err = Object.assign(new Error("startup"), { code: "57P03" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: connection_failure is retryable", () => {
  const err = Object.assign(new Error("conn"), { code: "08006" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: connection_does_not_exist is retryable", () => {
  const err = Object.assign(new Error("conn"), { code: "08003" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: query_canceled is retryable", () => {
  const err = Object.assign(new Error("cancel"), { code: "57014" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: auth failure is NOT retryable", () => {
  const err = Object.assign(new Error("auth"), { code: "28P01" });
  assertEquals(isRetryablePgError(err), false);
});

Deno.test("isRetryablePgError: constraint violation is NOT retryable", () => {
  const err = Object.assign(new Error("unique"), { code: "23505" });
  assertEquals(isRetryablePgError(err), false);
});

Deno.test("isRetryablePgError: syntax error is NOT retryable", () => {
  const err = Object.assign(new Error("syntax"), { code: "42601" });
  assertEquals(isRetryablePgError(err), false);
});

Deno.test("isRetryablePgError: non-Error is not retryable", () => {
  assertEquals(isRetryablePgError("string error"), false);
});

Deno.test("isRetryablePgError: Error without code is not retryable", () => {
  assertEquals(isRetryablePgError(new Error("generic")), false);
});

Deno.test("isRetryablePgError: ECONNRESET (no code) is retryable", () => {
  const err = Object.assign(new Error("connection reset"), {
    code: "ECONNRESET",
  });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("isRetryablePgError: ECONNREFUSED is retryable", () => {
  const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  assertEquals(isRetryablePgError(err), true);
});

Deno.test("retryable: succeeds on first attempt", async () => {
  let calls = 0;
  const result = await retryable(() => {
    calls++;
    return Promise.resolve("ok");
  }, { maxAttempts: 3, baseDelayMs: 1 });
  assertEquals(result, "ok");
  assertEquals(calls, 1);
});

Deno.test("retryable: retries on transient error then succeeds", async () => {
  let calls = 0;
  const result = await retryable(() => {
    calls++;
    if (calls < 3) {
      throw Object.assign(new Error("retry me"), { code: "40001" });
    }
    return Promise.resolve("recovered");
  }, { maxAttempts: 3, baseDelayMs: 1 });
  assertEquals(result, "recovered");
  assertEquals(calls, 3);
});

Deno.test("retryable: throws immediately on non-retryable error", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      retryable(() => {
        calls++;
        throw Object.assign(new Error("auth fail"), { code: "28P01" });
      }, { maxAttempts: 3, baseDelayMs: 1 }),
    Error,
    "auth fail",
  );
  assertEquals(calls, 1);
});

Deno.test("retryable: exhausts max attempts then throws", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      retryable(() => {
        calls++;
        throw Object.assign(new Error("always fail"), { code: "40001" });
      }, { maxAttempts: 3, baseDelayMs: 1 }),
    Error,
    "always fail",
  );
  assertEquals(calls, 3);
});

Deno.test("retryable: respects abort signal before first attempt", async () => {
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      retryable(() => Promise.resolve("never"), {
        maxAttempts: 3,
        baseDelayMs: 1,
        signal: controller.signal,
      }),
    DOMException,
  );
});

Deno.test("retryable: respects abort signal during backoff", async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = retryable(() => {
    calls++;
    if (calls === 1) {
      // Abort during the backoff sleep after first failure
      setTimeout(() => controller.abort(), 5);
      throw Object.assign(new Error("transient"), { code: "40001" });
    }
    return Promise.resolve("never");
  }, { maxAttempts: 3, baseDelayMs: 500, signal: controller.signal });

  await assertRejects(() => promise, DOMException);
  assertEquals(calls, 1);
});

Deno.test("retryable: maxAttempts must be >= 1", async () => {
  await assertRejects(
    () => retryable(() => Promise.resolve("x"), { maxAttempts: 0, baseDelayMs: 1 }),
    Error,
    "maxAttempts must be >= 1",
  );
});

Deno.test("retryable: backoff timing grows exponentially", async () => {
  const delays: number[] = [];
  let calls = 0;
  let lastCall = Date.now();

  try {
    await retryable(() => {
      calls++;
      const now = Date.now();
      if (calls > 1) delays.push(now - lastCall);
      lastCall = now;
      if (calls < 3) {
        throw Object.assign(new Error("retry"), { code: "40001" });
      }
      return Promise.resolve("done");
    }, { maxAttempts: 3, baseDelayMs: 50 });
  } finally {
    // Verify delays grow (with jitter tolerance)
    // First delay should be ~50ms (baseDelayMs * 3^0 = 50)
    // Second delay should be ~150ms (baseDelayMs * 3^1 = 150)
    if (delays.length >= 2) {
      // Second delay should be larger than first (within jitter)
      assertEquals(delays[1] > delays[0] * 1.5, true);
    }
  }
});
