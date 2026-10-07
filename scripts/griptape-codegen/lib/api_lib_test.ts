/**
 * Behavior tests for the shared `_lib/api.ts` helper emitted by generateApiLib.
 *
 * The helper ships verbatim into every extension, so these tests write the
 * generated source to a temp module, import it, and drive it against a local
 * HTTP server.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { generateApiLib } from "./extension_generator.ts";

interface ApiLib {
  griptapeApi: <T>(
    apiKey: string,
    method: string,
    path: string,
    body?: unknown,
    baseUrl?: string,
  ) => Promise<T>;
  griptapeApiPaginated: <T>(
    apiKey: string,
    path: string,
    itemsKey: string,
    params?: Record<string, string>,
    baseUrl?: string,
  ) => Promise<{ results: T[]; truncated: boolean; totalFetched: number }>;
}

let apiLibPromise: Promise<ApiLib> | undefined;
function loadApiLib(): Promise<ApiLib> {
  apiLibPromise ??= (async () => {
    const dir = await Deno.makeTempDir();
    const file = `${dir}/api.ts`;
    await Deno.writeTextFile(file, generateApiLib());
    return await import(`file://${file}`) as ApiLib;
  })();
  return apiLibPromise;
}

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseUrl: string) => Promise<void>,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const saved = Object.keys(env).map((k) => [k, Deno.env.get(k)] as const);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  try {
    await fn(`http://localhost:${(server.addr as Deno.NetAddr).port}`);
  } finally {
    await server.shutdown();
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// The local server and timeout timers outlive individual awaits; the helper
// under test is what is being checked, not Deno's resource accounting.
const NO_SANITIZE = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "api lib: an empty 202 body resolves to undefined, not a parse error",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    await withServer(() => new Response("", { status: 202 }), async (base) => {
      assertEquals(
        await griptapeApi("k", "POST", "/api/x", { a: 1 }, base),
        undefined,
      );
    });
  },
});

Deno.test({
  name: "api lib: 204 No Content resolves to undefined",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    await withServer(
      () => new Response(null, { status: 204 }),
      async (base) => {
        assertEquals(
          await griptapeApi("k", "DELETE", "/api/x", undefined, base),
          undefined,
        );
      },
    );
  },
});

Deno.test({
  name:
    "api lib: malformed JSON names the status and request, not a bare SyntaxError",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    await withServer(
      () => new Response("<html>gateway</html>", { status: 200 }),
      async (base) => {
        const err = await assertRejects(
          () => griptapeApi("k", "GET", "/api/things", undefined, base),
          Error,
        );
        assertEquals(err instanceof SyntaxError, false);
        assertStringIncludes(err.message, "malformed JSON");
        assertStringIncludes(err.message, "GET /api/things");
        assertStringIncludes(err.message, "HTTP 200");
        assertStringIncludes(err.message, "<html>gateway</html>");
      },
    );
  },
});

Deno.test({
  name: "api lib: HTTP errors carry status, request, and body snippet",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    await withServer(
      () => Response.json({ message: "nope" }, { status: 403 }),
      async (base) => {
        const err = await assertRejects(
          () => griptapeApi("k", "GET", "/api/things", undefined, base),
          Error,
        );
        assertStringIncludes(err.message, "GET /api/things");
        assertStringIncludes(err.message, "403");
        assertStringIncludes(err.message, "nope");
      },
    );
  },
});

Deno.test({
  name: "api lib: a stalled request times out with a clear error",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    await withServer(
      async () => {
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({});
      },
      async (base) => {
        const err = await assertRejects(
          () => griptapeApi("k", "GET", "/api/slow", undefined, base),
          Error,
        );
        assertStringIncludes(err.message, "timed out after 50ms");
        assertStringIncludes(err.message, "GET /api/slow");
      },
      { GT_CLOUD_TIMEOUT_MS: "50" },
    );
  },
});

Deno.test({
  name: "api lib: an invalid GT_CLOUD_TIMEOUT_MS is rejected up front",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    for (const bad of ["abc", "0", "-5", "1.5", "1e20", "2147483648"]) {
      await withServer(() => Response.json({}), async (base) => {
        const err = await assertRejects(
          () => griptapeApi("k", "GET", "/api/x", undefined, base),
          Error,
        );
        assertStringIncludes(err.message, "GT_CLOUD_TIMEOUT_MS");
      }, { GT_CLOUD_TIMEOUT_MS: bad });
    }
  },
});

Deno.test({
  name: "api lib: a falsy-but-defined body is still sent",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    let received = "";
    await withServer(async (req) => {
      received = await req.text();
      return Response.json({});
    }, async (base) => {
      await griptapeApi("k", "POST", "/api/x", [], base);
    });
    assertEquals(received, "[]");
  },
});

Deno.test({
  name: "api lib: 429 is retried honoring Retry-After, then succeeds",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    let calls = 0;
    await withServer(() => {
      calls++;
      return calls === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
        : Response.json({ ok: true });
    }, async (base) => {
      assertEquals(
        await griptapeApi("k", "GET", "/api/x", undefined, base),
        { ok: true },
      );
    });
    assertEquals(calls, 2);
  },
});

Deno.test({
  name: "api lib: persistent 429 gives up after the bounded retries",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApi } = await loadApiLib();
    let calls = 0;
    await withServer(() => {
      calls++;
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }, async (base) => {
      const err = await assertRejects(
        () => griptapeApi("k", "GET", "/api/x", undefined, base),
        Error,
      );
      assertStringIncludes(err.message, "rate limited after 3 retries");
    });
    assertEquals(calls, 4);
  },
});

Deno.test({
  name: "api lib: paginated list treats an empty 2xx body as an empty page",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    await withServer(
      () => new Response(null, { status: 204 }),
      async (base) => {
        const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
        assertEquals(out, { results: [], truncated: false, totalFetched: 0 });
      },
    );
    await withServer(() => new Response("", { status: 200 }), async (base) => {
      const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
      assertEquals(out.results, []);
    });
  },
});

Deno.test({
  name:
    "api lib: paginated list rejects malformed or non-object bodies clearly",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    await withServer(
      () => new Response("<html>", { status: 200 }),
      async (base) => {
        const err = await assertRejects(
          () => griptapeApiPaginated("k", "/api/x", "xs", {}, base),
          Error,
        );
        assertStringIncludes(err.message, "malformed JSON");
        assertStringIncludes(err.message, "GET /api/x");
      },
    );
    for (const body of ["[1,2]", "null", '"str"']) {
      await withServer(
        () => new Response(body, { status: 200 }),
        async (base) => {
          const err = await assertRejects(
            () => griptapeApiPaginated("k", "/api/x", "xs", {}, base),
            Error,
          );
          assertStringIncludes(err.message, "expected a JSON object");
        },
      );
    }
  },
});

Deno.test({
  name:
    "api lib: paginated list stops on its own page counter, not the echoed page_number",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    let calls = 0;
    // A server that ignores ?page and always echoes page 1 of 3.
    await withServer(() => {
      calls++;
      return Response.json({
        xs: [{ n: calls }],
        pagination: { page_number: 1, total_pages: 3 },
      });
    }, async (base) => {
      const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
      assertEquals(out.results.length, 3);
      assertEquals(out.truncated, false);
    });
    assertEquals(calls, 3);
  },
});

Deno.test({
  name:
    "api lib: paginated list stops on an empty page and marks truncation honestly",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    await withServer(
      () =>
        Response.json({
          xs: [],
          pagination: { page_number: 1, total_pages: 9 },
        }),
      async (base) => {
        const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
        assertEquals(out.results, []);
        assertEquals(out.truncated, false);
      },
    );

    let calls = 0;
    await withServer(() => {
      calls++;
      return Response.json({
        xs: [{ n: calls }],
        pagination: { total_pages: 1000 },
      });
    }, async (base) => {
      const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
      assertEquals(out.truncated, true);
      assertEquals(out.results.length, 20);
    });
    assertEquals(calls, 20);
  },
});

Deno.test({
  name: "api lib: paginated list sends page, page_size, and caller params",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    let seen = "";
    await withServer((req) => {
      seen = new URL(req.url).search;
      return Response.json({ xs: [{ a: 1 }], pagination: { total_pages: 1 } });
    }, async (base) => {
      await griptapeApiPaginated("k", "/api/x", "xs", { status: "a,b" }, base);
    });
    const q = new URLSearchParams(seen);
    assertEquals(q.get("status"), "a,b");
    assertEquals(q.get("page"), "1");
    assertEquals(q.get("page_size"), "50");
  },
});

Deno.test({
  name:
    "api lib: null total_pages is not treated as 'one page'; next_page keeps a short page going",
  ...NO_SANITIZE,
  fn: async () => {
    const { griptapeApiPaginated } = await loadApiLib();
    let calls = 0;
    // A server that caps page_size below 50 and signals more via next_page.
    await withServer((req) => {
      calls++;
      const page = Number(new URL(req.url).searchParams.get("page"));
      return Response.json({
        xs: [{ page }],
        pagination: {
          total_pages: null,
          // Mix numeric and string forms: both must keep pagination going.
          next_page: page < 3
            ? (page % 2 ? page + 1 : String(page + 1))
            : undefined,
        },
      });
    }, async (base) => {
      const out = await griptapeApiPaginated("k", "/api/x", "xs", {}, base);
      assertEquals(out.results.length, 3);
      assertEquals(out.truncated, false);
    });
    assertEquals(calls, 3);
  },
});

Deno.test("api lib: generated source applies a deadline to every fetch", () => {
  const src = generateApiLib();
  assert(src.includes("AbortSignal.timeout("));
  // The only fetch call sits behind fetchOnce, which sets the signal.
  assertEquals(src.match(/\bawait fetch\(/g)?.length, 1);
});
