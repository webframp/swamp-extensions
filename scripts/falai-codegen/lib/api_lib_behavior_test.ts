// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the generated _lib/api.ts helper. Unlike the
 * source-text assertions in extension_generator_test.ts, these write the
 * generated helper to disk, import it, and drive it against a mocked fetch.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { generateApiLib } from "./extension_generator.ts";

interface ApiModule {
  falApi: <T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<T>;
  falApiData: <T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<T>;
  falApiPaginated: <T>(
    token: string,
    path: string,
    resultsField: string,
    params?: Record<string, string | string[]>,
    options?: { limit?: number; cursor?: string },
  ) => Promise<{ results: T[]; truncated: boolean; totalFetched: number }>;
}

let cached: ApiModule | undefined;
async function loadApi(): Promise<ApiModule> {
  if (cached) return cached;
  const dir = await Deno.makeTempDir();
  const file = `${dir}/api.ts`;
  await Deno.writeTextFile(file, generateApiLib());
  cached = await import(`file://${file}`) as ApiModule;
  return cached;
}

type FetchFn = typeof globalThis.fetch;

async function withFetch(
  handler: FetchFn,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("api.ts: falApi returns undefined for an empty 202 body", async () => {
  const { falApi } = await loadApi();
  await withFetch(
    () => Promise.resolve(new Response("", { status: 202 })),
    async () => {
      assertEquals(await falApi("tok", "POST", "/x", {}), undefined);
    },
  );
});

Deno.test("api.ts: falApi returns undefined for a 204", async () => {
  const { falApi } = await loadApi();
  await withFetch(
    () => Promise.resolve(new Response(null, { status: 204 })),
    async () => {
      assertEquals(await falApi("tok", "DELETE", "/x"), undefined);
    },
  );
});

Deno.test("api.ts: falApi malformed JSON error names method, path and status", async () => {
  const { falApi } = await loadApi();
  await withFetch(
    () => Promise.resolve(new Response("<html>oops", { status: 200 })),
    async () => {
      const err = await assertRejects(
        () => falApi("tok", "GET", "/models/pricing"),
        Error,
        "malformed JSON",
      );
      assertStringIncludes(err.message, "GET /models/pricing");
      assertStringIncludes(err.message, "status 200");
      assertStringIncludes(err.message, "<html>oops");
      assertEquals(err instanceof SyntaxError, false);
    },
  );
});

Deno.test("api.ts: falApiPaginated treats an empty 200 body as an empty page", async () => {
  const { falApiPaginated } = await loadApi();
  await withFetch(
    () => Promise.resolve(new Response("", { status: 200 })),
    async () => {
      const res = await falApiPaginated("tok", "/things", "things");
      assertEquals(res.results, []);
      assertEquals(res.truncated, false);
    },
  );
});

Deno.test("api.ts: falApiPaginated malformed JSON error names path and status", async () => {
  const { falApiPaginated } = await loadApi();
  await withFetch(
    () => Promise.resolve(new Response("not json", { status: 200 })),
    async () => {
      const err = await assertRejects(
        () => falApiPaginated("tok", "/things", "things"),
        Error,
        "malformed JSON",
      );
      assertStringIncludes(err.message, "GET /things");
      assertStringIncludes(err.message, "status 200");
    },
  );
});

Deno.test("api.ts: every request carries a timeout signal and a hang becomes a descriptive error", async () => {
  const { falApi } = await loadApi();
  const originalTimeout = AbortSignal.timeout;
  let sawSignal = false;
  // Shrink the 60s deadline so the test does not wait on it.
  AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 20);
  try {
    await withFetch(
      (_input, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
          );
        });
      },
      async () => {
        const err = await assertRejects(
          () => falApi("tok", "GET", "/slow"),
          Error,
          "timed out",
        );
        assertStringIncludes(err.message, "60s");
        assertStringIncludes(err.message, "GET https://api.fal.ai/v1/slow");
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assertEquals(sawSignal, true);
});

Deno.test("api.ts: a stalled body drain is covered by the same timeout", async () => {
  const { falApi } = await loadApi();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 20);
  try {
    await withFetch(
      (_input, init) => {
        // Headers arrive immediately; the body never completes.
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal!.reason),
            );
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
      async () => {
        await assertRejects(
          () => falApi("tok", "GET", "/stall"),
          Error,
          "timed out",
        );
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

Deno.test("api.ts: Retry-After is capped so a huge value cannot stall the caller", async () => {
  const { falApi } = await loadApi();
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  };
  try {
    await withFetch(
      () =>
        Promise.resolve(
          new Response("slow down", {
            status: 429,
            headers: { "Retry-After": "3600" },
          }),
        ),
      async () => {
        await assertRejects(
          () => falApi("tok", "GET", "/busy"),
          Error,
          "rate limited",
        );
      },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assertEquals(delays.length, 3);
  for (const d of delays) assertEquals(d, 30_000);
});

Deno.test("api.ts: falApiData rejects an empty 2xx body with a clear error", async () => {
  const { falApiData } = await loadApi();
  for (const body of ["", "   \n", "null"]) {
    await withFetch(
      () => Promise.resolve(new Response(body, { status: 200 })),
      async () => {
        const err = await assertRejects(
          () => falApiData("tok", "GET", "/models/pricing"),
          Error,
          "empty response body",
        );
        assertStringIncludes(err.message, "GET /models/pricing");
      },
    );
  }
});

Deno.test("api.ts: falApiData returns the parsed body when present", async () => {
  const { falApiData } = await loadApi();
  await withFetch(
    () => Promise.resolve(Response.json({ a: 1 })),
    async () => {
      assertEquals(await falApiData("tok", "GET", "/x"), { a: 1 });
    },
  );
});
