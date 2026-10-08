// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime tests for the generated shared `_lib/api.ts` helper. The helper is
 * emitted as a string, written to a temp file, imported, and driven with a
 * stubbed `fetch`, so these exercise the exact code every extension ships.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { generateApiLib } from "./extension_generator.ts";

// deno-lint-ignore no-explicit-any
type Lib = any;

async function loadLib(): Promise<{ lib: Lib; cleanup: () => Promise<void> }> {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tmp, generateApiLib());
  const lib = await import(`file://${tmp}`);
  return { lib, cleanup: () => Deno.remove(tmp) };
}

/** Replace global fetch for the duration of `fn`, recording each call. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/vnd.api+json" },
  });

Deno.test("snykApi: empty 2xx bodies (202, 204, empty 200) return {}", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    for (const status of [200, 202, 204]) {
      await withFetch(() => new Response(null, { status }), async () => {
        assertEquals(await lib.snykApi("t", "POST", "/orgs/o/x", "v"), {});
      });
    }
    // Whitespace-only body is also empty.
    await withFetch(() => new Response("  \n", { status: 202 }), async () => {
      assertEquals(await lib.snykApi("t", "POST", "/orgs/o/x", "v"), {});
    });
  } finally {
    await cleanup();
  }
});

Deno.test("snykApi: malformed JSON reports status and request, not a bare SyntaxError", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(
      () => new Response("<html>oops", { status: 200 }),
      async () => {
        const err = await assertRejects(
          () => lib.snykApi("t", "GET", "/orgs/o/projects?x=1", "v"),
          Error,
        );
        assertEquals(err instanceof SyntaxError, false);
        assertStringIncludes(err.message, "HTTP 200");
        assertStringIncludes(err.message, "GET /orgs/o/projects");
        assertStringIncludes(err.message, "<html>oops");
        // The query string (which may carry filters) stays out of the label.
        assertEquals(err.message.includes("x=1"), false);
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("snykApi: HTTP errors carry status, API detail and request label", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(
      () =>
        json({
          jsonapi: { version: "1.0" },
          errors: [{ status: "403", detail: "no access" }],
        }, 403),
      async () => {
        const err = await assertRejects(
          () => lib.snykApi("t", "DELETE", "/orgs/o/projects/p", "v"),
          Error,
        );
        assertStringIncludes(err.message, "HTTP 403: no access");
        assertStringIncludes(err.message, "DELETE /orgs/o/projects/p");
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("snykApi: a request that never answers fails with a labelled timeout", async () => {
  const { lib, cleanup } = await loadLib();
  const originalTimeout = AbortSignal.timeout;
  // Shrink the 30s deadline so the test is fast; the helper must pass a signal.
  AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 30);
  try {
    await withFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) return; // would hang forever: the test would time out
          init.signal.addEventListener("abort", () =>
            reject(init.signal!.reason));
        }) as unknown as Response,
      async () => {
        const err = await assertRejects(
          () => lib.snykApi("t", "GET", "/orgs/o/slow", "v"),
          Error,
        );
        assertStringIncludes(err.message, "timed out");
        assertStringIncludes(err.message, "GET /orgs/o/slow");
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
    await cleanup();
  }
});

Deno.test("snykApi: a body that stalls after headers also times out", async () => {
  const { lib, cleanup } = await loadLib();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 30);
  try {
    await withFetch(
      (_url, init) => {
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal!.reason),
            );
          },
        });
        return new Response(stream, { status: 200 });
      },
      async () => {
        const err = await assertRejects(
          () => lib.snykApi("t", "GET", "/orgs/o/stall", "v"),
          Error,
        );
        assertStringIncludes(err.message, "timed out");
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
    await cleanup();
  }
});

Deno.test("snykApi: flattens JSON:API data and sends token + version", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(
      () => json({ data: { id: "1", type: "t", attributes: { a: 1 } } }),
      async (calls) => {
        assertEquals(
          await lib.snykApi("tok", "GET", "/orgs/o/x?q=1", "2024-10-15"),
          {
            id: "1",
            type: "t",
            a: 1,
          },
        );
        assertEquals(
          calls[0].url,
          "https://api.snyk.io/rest/orgs/o/x?q=1&version=2024-10-15",
        );
        assertEquals(
          (calls[0].init?.headers as Record<string, string>)["Authorization"],
          "token tok",
        );
        assertEquals(calls[0].init?.signal instanceof AbortSignal, true);
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("snykApiPaginated: empty and malformed pages are handled", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(() => new Response(null, { status: 204 }), async () => {
      const r = await lib.snykApiPaginated("t", "/orgs/o/x", "v");
      assertEquals(r, { results: [], truncated: false, totalFetched: 0 });
    });
    await withFetch(
      () => new Response("not json", { status: 200 }),
      async () => {
        const err = await assertRejects(
          () => lib.snykApiPaginated("t", "/orgs/o/x", "v"),
          Error,
        );
        assertEquals(err instanceof SyntaxError, false);
        assertStringIncludes(err.message, "GET /orgs/o/x");
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("snykApiPaginated: follows relative links with and without the /rest prefix", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    for (
      const next of [
        "/rest/orgs/o/x?starting_after=a",
        "/orgs/o/x?starting_after=a",
      ]
    ) {
      let n = 0;
      await withFetch(
        () =>
          n++ === 0
            ? json({ data: [{ id: "1" }], links: { next } })
            : json({ data: [{ id: "2" }], links: { next: null } }),
        async (calls) => {
          const r = await lib.snykApiPaginated("t", "/orgs/o/x", "v", [[
            "a",
            "b",
          ]]);
          assertEquals(r.results.map((x: { id: string }) => x.id), ["1", "2"]);
          assertEquals(r.truncated, false);
          assertEquals(
            calls[0].url,
            "https://api.snyk.io/rest/orgs/o/x?version=v&limit=100&a=b",
          );
          assertEquals(
            calls[1].url,
            "https://api.snyk.io/rest/orgs/o/x?starting_after=a",
          );
        },
      );
    }
  } finally {
    await cleanup();
  }
});

Deno.test("snykApiPaginated: refuses a next link on another origin and never sends the token there", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(
      () =>
        json({
          data: [{ id: "1" }],
          links: { next: "https://evil.example/steal" },
        }),
      async (calls) => {
        const err = await assertRejects(
          () => lib.snykApiPaginated("secret", "/orgs/o/x", "v"),
          Error,
        );
        assertStringIncludes(err.message, "another origin");
        assertEquals(calls.length, 1);
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("snykApiPaginated: sets truncated when the page cap leaves a next link", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withFetch(
      () =>
        json({
          data: [{ id: "1" }],
          links: { next: "/rest/orgs/o/x?starting_after=z" },
        }),
      async (calls) => {
        const r = await lib.snykApiPaginated("t", "/orgs/o/x", "v");
        assertEquals(r.truncated, true);
        assertEquals(calls.length, 20);
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("queryEntries: maps argument names to API names and serializes arrays", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    const entries = lib.queryEntries(
      {
        meta_count: "with",
        provider: ["a", "b"],
        expand: ["x", "y"],
        skipped: undefined,
        nulled: null,
        blank: "",
        empty: [],
        zero: 0,
        no: false,
        unlisted: "ignored",
      },
      {
        meta_count: { name: "meta.count" },
        provider: { name: "provider" },
        expand: { name: "expand", comma: true },
        skipped: { name: "skipped" },
        nulled: { name: "nulled" },
        blank: { name: "blank" },
        empty: { name: "empty" },
        zero: { name: "zero" },
        no: { name: "no" },
      },
    );
    assertEquals(entries, [
      ["meta.count", "with"],
      ["provider", "a"],
      ["provider", "b"],
      ["expand", "x,y"],
      ["zero", "0"],
      ["no", "false"],
    ]);
    assertEquals(lib.toQueryString([]), "");
    assertEquals(
      lib.toQueryString([["meta.count", "with"], ["q", "a b&c"]]),
      "?meta.count=with&q=a%20b%26c",
    );
  } finally {
    await cleanup();
  }
});

/** Run `fn` with setTimeout recording delays and firing immediately. */
async function withInstantTimers(
  fn: (delays: number[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return original(cb, 0);
  }) as typeof setTimeout;
  try {
    await fn(delays);
  } finally {
    globalThis.setTimeout = original;
  }
}

Deno.test("429 exhaustion surfaces the rate-limit error, not a consumed-body TypeError", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withInstantTimers(async (delays) => {
      for (
        const call of [
          () => lib.snykApi("t", "GET", "/orgs/o/x", "v"),
          () => lib.snykApiPaginated("t", "/orgs/o/x", "v"),
        ]
      ) {
        await withFetch(
          () =>
            new Response("slow down", {
              status: 429,
              headers: { "Retry-After": "0" },
            }),
          async (calls) => {
            const err = await assertRejects(call, Error);
            assertEquals(err instanceof TypeError, false);
            assertStringIncludes(err.message, "rate limited after 3 retries");
            assertStringIncludes(err.message, "GET /orgs/o/x");
            assertEquals(calls.length, 4);
          },
        );
      }
      assertEquals(delays.length > 0, true);
    });
  } finally {
    await cleanup();
  }
});

Deno.test("429 followed by success retries and returns the data", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    await withInstantTimers(async () => {
      let n = 0;
      await withFetch(
        () =>
          n++ === 0
            ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
            : json({ data: { id: "1" } }),
        async (calls) => {
          assertEquals(await lib.snykApi("t", "GET", "/orgs/o/x", "v"), {
            id: "1",
          });
          assertEquals(calls.length, 2);
        },
      );
    });
  } finally {
    await cleanup();
  }
});

Deno.test("Retry-After is clamped to 30s and floored at 0", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    for (
      const [header, expected] of [["86400", 30000], ["-5", 0], [
        "2",
        2000,
      ]] as const
    ) {
      await withInstantTimers(async (delays) => {
        await withFetch(
          () =>
            new Response("", {
              status: 429,
              headers: { "Retry-After": header },
            }),
          async () => {
            await assertRejects(
              () => lib.snykApi("t", "GET", "/orgs/o/x", "v"),
              Error,
            );
          },
        );
        // Our retry sleeps are the 3 delays equal to the clamped value.
        assertEquals(delays.filter((d) => d === expected).length >= 3, true);
        assertEquals(Math.max(...delays) <= 30000, true);
      });
    }
  } finally {
    await cleanup();
  }
});

Deno.test("snykApiPaginated: refuses same-origin links that leave the /rest prefix", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    for (
      const next of [
        "https://api.snyk.io/other",
        "/rest/../../x?a=1",
        "rest/../../x",
      ]
    ) {
      await withFetch(
        () => json({ data: [{ id: "1" }], links: { next } }),
        async (calls) => {
          const err = await assertRejects(
            () => lib.snykApiPaginated("t", "/orgs/o/x", "v"),
            Error,
          );
          assertStringIncludes(err.message, "pagination link");
          assertEquals(calls.length, 1);
        },
      );
    }
  } finally {
    await cleanup();
  }
});

Deno.test("requireBody rejects an empty result and passes data through", async () => {
  const { lib, cleanup } = await loadLib();
  try {
    assertEquals(lib.requireBody({ id: "1" }, "get_x"), { id: "1" });
    try {
      lib.requireBody({}, "get_x");
      throw new Error("expected requireBody to throw");
    } catch (e) {
      assertStringIncludes((e as Error).message, "empty response body: get_x");
    }
  } finally {
    await cleanup();
  }
});
