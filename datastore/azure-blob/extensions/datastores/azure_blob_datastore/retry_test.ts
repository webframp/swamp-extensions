import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { isTimeoutError, retryableRequest } from "./_lib/retry.ts";

const timeout = () => new DOMException("deadline", "TimeoutError");

Deno.test("retryableRequest retries a TimeoutError and returns the later success", async () => {
  let calls = 0;
  const result = await retryableRequest(() => {
    calls++;
    if (calls < 3) return Promise.reject(timeout());
    return Promise.resolve({ status: 200 });
  }, { baseDelayMs: 1 });
  assertEquals(result.status, 200);
  assertEquals(calls, 3);
});

Deno.test("retryableRequest rethrows the TimeoutError after maxAttempts", async () => {
  let calls = 0;
  const err = await assertRejects(() =>
    retryableRequest(() => {
      calls++;
      return Promise.reject(timeout());
    }, { maxAttempts: 2, baseDelayMs: 1 })
  );
  assertEquals(isTimeoutError(err), true);
  assertEquals(calls, 2);
});

Deno.test("retryableRequest does not retry an AbortError or a plain network error", async () => {
  for (
    const failure of [
      new DOMException("aborted", "AbortError"),
      new TypeError("fetch failed"),
    ]
  ) {
    let calls = 0;
    await assertRejects(() =>
      retryableRequest(() => {
        calls++;
        return Promise.reject(failure);
      }, { baseDelayMs: 1 })
    );
    assertEquals(calls, 1);
  }
});

Deno.test("retryableRequest with retryTimeouts:false rethrows the first TimeoutError", async () => {
  let calls = 0;
  const err = await assertRejects(() =>
    retryableRequest(() => {
      calls++;
      return Promise.reject(timeout());
    }, { retryTimeouts: false, baseDelayMs: 1 })
  );
  assertEquals(isTimeoutError(err), true);
  assertEquals(calls, 1);
});
