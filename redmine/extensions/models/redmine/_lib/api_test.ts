// Redmine API Helper Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  isHttpsUpgrade,
  redmineApi,
  redmineApiPaginated,
  redmineDownload,
  RedmineDownloadTooLargeError,
  redmineFetch,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Mock Redmine API Server
// ---------------------------------------------------------------------------

interface MockServer {
  url: string;
  server: Deno.HttpServer;
  requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  }>;
}

function startMockServer(
  handler: (req: Request) => Response | Promise<Response>,
): MockServer {
  const requests: MockServer["requests"] = [];

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });

    const body = req.method !== "GET" && req.method !== "HEAD"
      ? await req.json().catch(() => undefined)
      : undefined;

    requests.push({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body,
    });

    return handler(req);
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://localhost:${addr.port}`,
    server,
    requests,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "redmineApi: sends X-Redmine-API-Key header",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer(() =>
      Response.json({ user: { id: 1, login: "admin" } })
    );

    try {
      await redmineApi(url, "test-api-key-123", "GET", "/users/current.json");

      assertEquals(requests.length, 1);
      assertEquals(
        requests[0].headers["x-redmine-api-key"],
        "test-api-key-123",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: throws on non-2xx response with status code",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      new Response(
        JSON.stringify({ errors: ["Project not found"] }),
        { status: 404 },
      )
    );

    try {
      await assertRejects(
        () => redmineApi(url, "key", "GET", "/projects/missing.json"),
        Error,
        "404",
      );
      // The error must name the method and path, not just the status code.
      await assertRejects(
        () => redmineApi(url, "key", "GET", "/projects/missing.json"),
        Error,
        "GET /projects/missing.json",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: a network-level failure names the method, path, and host",
  fn: async () => {
    await assertRejects(
      () =>
        redmineApi(
          "http://127.0.0.1:1",
          "key",
          "GET",
          "/issues.json",
        ),
      Error,
      "GET /issues.json",
    );
  },
});

Deno.test({
  name: "redmineApiPaginated: a network-level failure names the path and host",
  fn: async () => {
    await assertRejects(
      () =>
        redmineApiPaginated<{ id: number }>(
          "http://127.0.0.1:1",
          "key",
          "/issues.json",
          "issues",
        ),
      Error,
      "/issues.json",
    );
  },
});

Deno.test({
  name:
    "redmineApiPaginated: fetches all pages by following offset/total_count",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;
    const { url, server } = startMockServer((req) => {
      requestCount++;
      const reqUrl = new URL(req.url);
      const offset = parseInt(reqUrl.searchParams.get("offset") || "0");

      if (offset === 0) {
        return Response.json({
          issues: [{ id: 1 }, { id: 2 }],
          total_count: 5,
          offset: 0,
          limit: 2,
        });
      } else if (offset === 2) {
        return Response.json({
          issues: [{ id: 3 }, { id: 4 }],
          total_count: 5,
          offset: 2,
          limit: 2,
        });
      } else {
        return Response.json({
          issues: [{ id: 5 }],
          total_count: 5,
          offset: 4,
          limit: 2,
        });
      }
    });

    try {
      const results = await redmineApiPaginated<{ id: number }>(
        url,
        "key",
        "/issues.json",
        "issues",
        undefined,
        500, // maxItems high enough to get all
      );

      assertEquals(results.length, 5);
      assertEquals(results.map((r) => r.id), [1, 2, 3, 4, 5]);
      assertEquals(requestCount, 3);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApiPaginated: respects maxItems parameter",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer((req) => {
      const reqUrl = new URL(req.url);
      const offset = parseInt(reqUrl.searchParams.get("offset") || "0");

      // Server claims 200 total items
      return Response.json({
        issues: Array.from({ length: 100 }, (_, i) => ({ id: offset + i + 1 })),
        total_count: 200,
        offset,
        limit: 100,
      });
    });

    try {
      // Request only 50 items
      const results = await redmineApiPaginated<{ id: number }>(
        url,
        "key",
        "/issues.json",
        "issues",
        undefined,
        50,
      );

      // Should return at most 50 items
      assertEquals(results.length, 50);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: sends JSON body on POST with Content-Type header",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer(() =>
      Response.json({ issue: { id: 42, subject: "New bug" } })
    );

    try {
      const result = await redmineApi<{ issue: { id: number } }>(
        url,
        "key",
        "POST",
        "/issues.json",
        { issue: { subject: "New bug", project_id: 1 } },
      );

      assertEquals(result.issue.id, 42);
      assertEquals(requests.length, 1);
      assertEquals(requests[0].method, "POST");
      assertEquals(requests[0].headers["content-type"], "application/json");
      assertEquals(requests[0].body, {
        issue: { subject: "New bug", project_id: 1 },
      });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: retries a 429 (honoring Retry-After) then succeeds",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;
    const { url, server } = startMockServer(() => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return Response.json({ user: { id: 1 } });
    });

    try {
      const result = await redmineApi<{ user: { id: number } }>(
        url,
        "key",
        "GET",
        "/users/current.json",
      );

      assertEquals(result.user.id, 1);
      assertEquals(requestCount, 2);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: gives up after repeated 429s",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;
    const { url, server } = startMockServer(() => {
      requestCount++;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    });

    try {
      await assertRejects(
        () => redmineApi(url, "key", "GET", "/users/current.json"),
        Error,
        "429",
      );
      // Initial attempt + MAX_RETRIES retries.
      assertEquals(requestCount, 5);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: returns null for 204 No Content",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      new Response(null, { status: 204 })
    );

    try {
      const result = await redmineApi(
        url,
        "key",
        "PUT",
        "/issues/1.json",
        { issue: { status_id: 5 } },
      );

      assertEquals(result, null);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineDownload: returns bytes and sends both headers",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer(() =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      })
    );
    try {
      const result = await redmineDownload(
        url,
        "test-api-key-123",
        "/attachments/download/7",
        "user@example.com",
      );
      assertEquals([...result.bytes], [1, 2, 3]);
      assertEquals(result.contentType, "image/png");
      assertEquals(
        requests[0].headers["x-redmine-api-key"],
        "test-api-key-123",
      );
      assertEquals(
        requests[0].headers["x-redmine-username"],
        "user@example.com",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineDownload: rejects a non-2xx response and an oversized body",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer((req) =>
      new URL(req.url).pathname === "/missing"
        ? new Response("no", { status: 404 })
        : new Response(new Uint8Array(10))
    );
    try {
      await assertRejects(
        () => redmineDownload(url, "k", "/missing"),
        Error,
        "failed (404)",
      );
      await assertRejects(
        () => redmineDownload(url, "k", "/big", undefined, 5),
        Error,
        "more than maxBytes=5",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "redmineDownload: stops reading a chunked body without Content-Length at maxBytes",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    // An endless body: the test can only finish if the reader stops at the cap.
    const { url, server } = startMockServer(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(4));
          },
        }),
      )
    );
    try {
      const err = await assertRejects(
        () => redmineDownload(url, "k", "/stream", undefined, 10),
        RedmineDownloadTooLargeError,
        "more than maxBytes=10",
      );
      assertEquals(err.name, "RedmineDownloadTooLargeError");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineDownload: returns a chunked body that stays within maxBytes",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
      )
    );
    try {
      const result = await redmineDownload(
        url,
        "k",
        "/stream",
        undefined,
        4,
      );
      assertEquals([...result.bytes], [1, 2, 3, 4]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "redmineFetch: in strip mode keeps credentials on a same-origin redirect and drops them cross-origin, also after a hop back",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let originUrl = "";
    const other = startMockServer((req) =>
      new URL(req.url).pathname === "/bounce"
        ? new Response(null, {
          status: 302,
          headers: { Location: `${originUrl}/back` },
        })
        : new Response("elsewhere")
    );
    const origin = startMockServer((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/a") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/b" },
        });
      }
      if (path === "/b") {
        return new Response(null, {
          status: 307,
          headers: { Location: `${other.url}/c` },
        });
      }
      if (path === "/back") return new Response("back home");
      if (path === "/leave") {
        return new Response(null, {
          status: 302,
          headers: { Location: `${other.url}/bounce` },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    originUrl = origin.url;
    const headers = {
      "X-Redmine-API-Key": "SECRET",
      "X-Redmine-Username": "someone",
      "Accept": "*/*",
    };
    try {
      const response = await redmineFetch(`${origin.url}/a`, { headers }, {
        crossOrigin: "strip",
      });
      assertEquals(await response.text(), "elsewhere");
      assertEquals(origin.requests.map((r) => r.path), ["/a", "/b"]);
      assertEquals(origin.requests[1].headers["x-redmine-api-key"], "SECRET");
      assertEquals(other.requests.length, 1);
      assertEquals(other.requests[0].headers["x-redmine-api-key"], undefined);
      assertEquals(other.requests[0].headers["x-redmine-username"], undefined);
      assertEquals(other.requests[0].headers["accept"], "*/*");

      // origin -> other -> origin: coming back does not restore the
      // credentials.
      const back = await redmineFetch(`${origin.url}/leave`, { headers }, {
        crossOrigin: "strip",
      });
      assertEquals(await back.text(), "back home");
      assertEquals(origin.requests.at(-2)?.path, "/leave");
      assertEquals(
        origin.requests.at(-2)?.headers["x-redmine-api-key"],
        "SECRET",
      );
      assertEquals(origin.requests.at(-1)?.path, "/back");
      assertEquals(
        origin.requests.at(-1)?.headers["x-redmine-api-key"],
        undefined,
      );
    } finally {
      await origin.server.shutdown();
      await other.server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineFetch: turns a 303 after POST into a bodyless GET",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer((req) =>
      new URL(req.url).pathname === "/post"
        ? new Response(null, { status: 303, headers: { Location: "/done" } })
        : new Response("ok")
    );
    try {
      const response = await redmineFetch(`${url}/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      assertEquals(await response.text(), "ok");
      assertEquals(requests.map((r) => [r.method, r.path]), [
        ["POST", "/post"],
        ["GET", "/done"],
      ]);
      assertEquals(requests[1].headers["content-type"], undefined);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineFetch: stops after too many redirects",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      new Response(null, { status: 302, headers: { Location: "/loop" } })
    );
    try {
      await assertRejects(
        () => redmineFetch(`${url}/loop`, {}),
        Error,
        "more than 5 redirects",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineDownload: aborts a body that stops sending data",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let stall: (() => void) | undefined;
    const { url, server } = startMockServer(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            stall = () => controller.close();
          },
        }),
      )
    );
    try {
      await assertRejects(
        () => redmineDownload(url, "k", "/stall", undefined, undefined, 50),
        Error,
        "failed while reading the body: no data for 50ms",
      );
    } finally {
      stall?.();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "redmineApi: rejects a redirect off the Redmine origin instead of going anonymous",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const other = startMockServer(() => Response.json({ issues: [] }));
    const { url, server } = startMockServer(() =>
      new Response(null, {
        status: 301,
        headers: { Location: `${other.url}/issues.json` },
      })
    );
    try {
      await assertRejects(
        () => redmineApi(url, "SECRET", "GET", "/issues.json"),
        Error,
        `redirected from ${url} to ${other.url}; set host to the Redmine URL it redirects to`,
      );
      assertEquals(other.requests.length, 0);
    } finally {
      await server.shutdown();
      await other.server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: wraps a malformed redirect Location with the request",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://[::1" },
      })
    );
    try {
      await assertRejects(
        () => redmineApi(url, "k", "GET", "/x.json"),
        Error,
        `Redmine GET /x.json request to ${url} failed`,
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineFetch: turns a 301 after POST into a GET",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer((req) =>
      new URL(req.url).pathname === "/old"
        ? new Response(null, { status: 301, headers: { Location: "/new" } })
        : new Response("ok")
    );
    try {
      await (await redmineFetch(`${url}/old`, {
        method: "POST",
        body: "{}",
      })).text();
      assertEquals(requests.map((r) => [r.method, r.path]), [
        ["POST", "/old"],
        ["GET", "/new"],
      ]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test("isHttpsUpgrade: only same host, http to https, default ports", () => {
  const u = (s: string) => new URL(s);
  assertEquals(
    isHttpsUpgrade(u("http://r.corp/a"), u("https://r.corp/a")),
    true,
  );
  assertEquals(
    isHttpsUpgrade(u("http://r.corp/a"), u("https://www.r.corp/a")),
    false,
  );
  assertEquals(isHttpsUpgrade(u("https://r.corp"), u("http://r.corp")), false);
  assertEquals(
    isHttpsUpgrade(u("http://r.corp:8080"), u("https://r.corp")),
    false,
  );
});

Deno.test({
  name: "redmineApi: retries a POST only on 429, not on 502",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let count = 0;
    const { url, server } = startMockServer(() => {
      count++;
      return new Response(null, { status: 502 });
    });
    try {
      await assertRejects(
        () => redmineApi(url, "k", "POST", "/issues.json", { issue: {} }),
        Error,
        "failed (502)",
      );
      assertEquals(count, 1);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi: retries a POST after a 429",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let count = 0;
    const { url, server } = startMockServer(() => {
      count++;
      return count === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
        : Response.json({ issue: { id: 1 } });
    });
    try {
      await redmineApi(url, "k", "POST", "/issues.json", { issue: {} });
      assertEquals(count, 2);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineFetch: aborts an attempt at its signal",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(
      () =>
        new Promise<Response>((r) =>
          setTimeout(() => r(new Response("late")), 500)
        ),
    );
    try {
      await assertRejects(
        () =>
          redmineFetch(`${url}/slow`, {}, {
            makeSignal: () => AbortSignal.timeout(20),
          }),
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineFetch: gives each retry attempt its own default signal",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let count = 0;
    const { url, server } = startMockServer(() =>
      ++count === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
        : new Response("ok")
    );
    const seen: Array<AbortSignal | null | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      seen.push(init?.signal);
      return originalFetch(input, init);
    };
    try {
      await (await redmineFetch(`${url}/x`, {})).text();
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
    assertEquals(seen.length, 2);
    assertEquals(seen.every((sig) => sig instanceof AbortSignal), true);
    assertEquals(seen[0] === seen[1], false);
  },
});

for (const method of ["PUT", "DELETE", "POST"]) {
  Deno.test({
    name: `redmineApi: does not retry a ${method} after a 502`,
    // Server creates connection pool resources that outlive the test
    sanitizeResources: false,
    fn: async () => {
      let count = 0;
      const { url, server } = startMockServer(() => {
        count++;
        return new Response(null, { status: 502 });
      });
      try {
        await assertRejects(
          () => redmineApi(url, "k", method, "/issues/1.json", { issue: {} }),
          Error,
          "failed (502)",
        );
        assertEquals(count, 1);
      } finally {
        await server.shutdown();
      }
    },
  });
}

for (const status of [502, 503, 504]) {
  Deno.test({
    name: `redmineApi: retries a GET after a ${status}`,
    // Server creates connection pool resources that outlive the test
    sanitizeResources: false,
    fn: async () => {
      let count = 0;
      const { url, server } = startMockServer(() =>
        ++count === 1
          ? new Response(null, { status, headers: { "Retry-After": "0" } })
          : Response.json({ ok: true })
      );
      try {
        await redmineApi(url, "k", "GET", "/x.json");
        assertEquals(count, 2);
      } finally {
        await server.shutdown();
      }
    },
  });
}

Deno.test({
  name: "redmineFetch: retries a HEAD after a 502 and keeps HEAD on a 303",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    let count = 0;
    const { url, server, requests } = startMockServer((req) => {
      count++;
      if (count === 1) {
        return new Response(null, {
          status: 502,
          headers: { "Retry-After": "0" },
        });
      }
      return new URL(req.url).pathname === "/a"
        ? new Response(null, { status: 303, headers: { Location: "/b" } })
        : new Response(null);
    });
    try {
      await redmineFetch(`${url}/a`, { method: "HEAD" });
      assertEquals(requests.map((r) => [r.method, r.path]), [
        ["HEAD", "/a"],
        ["HEAD", "/a"],
        ["HEAD", "/b"],
      ]);
    } finally {
      await server.shutdown();
    }
  },
});

for (const method of ["PUT", "DELETE", "POST"]) {
  Deno.test({
    name: `redmineApi: retries a ${method} after a 503 with Retry-After only`,
    // Server creates connection pool resources that outlive the test
    sanitizeResources: false,
    fn: async () => {
      let count = 0;
      let headers: Record<string, string> = { "Retry-After": "0" };
      const { url, server } = startMockServer(() =>
        ++count === 1
          ? new Response(null, { status: 503, headers })
          : Response.json({ ok: true })
      );
      try {
        await redmineApi(url, "k", method, "/issues/1.json", { issue: {} });
        assertEquals(count, 2);
        count = 0;
        headers = {};
        await assertRejects(
          () => redmineApi(url, "k", method, "/issues/1.json", { issue: {} }),
          Error,
          "failed (503)",
        );
        assertEquals(count, 1);
      } finally {
        await server.shutdown();
      }
    },
  });
}

Deno.test({
  name: "redmineApi: waits the Retry-After delay before retrying",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const times: number[] = [];
    const { url, server } = startMockServer(() => {
      times.push(performance.now());
      return times.length === 1
        ? new Response(null, {
          status: 429,
          headers: { "Retry-After": "0.3" },
        })
        : Response.json({ ok: true });
    });
    try {
      await redmineApi(url, "k", "GET", "/x.json");
      assertEquals(times.length, 2);
      const waited = times[1] - times[0];
      // Honors 0.3 s, and not the 1 s exponential default.
      assertEquals(waited >= 280 && waited < 900, true, `waited ${waited}ms`);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test(
  "redmineFetch: keeps credentials across an http to https upgrade of the same host",
  async () => {
    const seen: Array<[string, string | null]> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input);
      seen.push([url, new Headers(init?.headers).get("X-Redmine-API-Key")]);
      if (url.startsWith("http://redmine.test/")) {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { Location: "https://redmine.test/issues.json" },
          }),
        );
      }
      if (url === "https://redmine.test/issues.json") {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.test/file" },
          }),
        );
      }
      return Promise.resolve(new Response("ok"));
    };
    try {
      const response = await redmineFetch(
        "http://redmine.test/issues.json",
        { headers: { "X-Redmine-API-Key": "SECRET" } },
        { crossOrigin: "strip" },
      );
      assertEquals(await response.text(), "ok");
      await assertRejects(
        () =>
          redmineFetch("http://redmine.test/issues.json", {
            headers: { "X-Redmine-API-Key": "SECRET" },
          }),
        Error,
        "redirected from https://redmine.test to https://cdn.test",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(seen.slice(0, 3), [
      ["http://redmine.test/issues.json", "SECRET"],
      ["https://redmine.test/issues.json", "SECRET"],
      ["https://cdn.test/file", null],
    ]);
  },
);

Deno.test({
  name:
    "redmineDownload: follows a redirect to storage on another origin without credentials",
  // Server creates connection pool resources that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const storage = startMockServer(() =>
      new Response(new Uint8Array([9, 8, 7]), {
        headers: { "Content-Type": "image/png" },
      })
    );
    const redmine = startMockServer(() =>
      new Response(null, {
        status: 302,
        headers: { Location: `${storage.url}/bucket/7?sig=x` },
      })
    );
    try {
      const result = await redmineDownload(
        redmine.url,
        "SECRET",
        "/attachments/download/7",
        "someone",
      );
      assertEquals([...result.bytes], [9, 8, 7]);
      assertEquals(redmine.requests[0].headers["x-redmine-api-key"], "SECRET");
      assertEquals(storage.requests.length, 1);
      assertEquals(storage.requests[0].headers["x-redmine-api-key"], undefined);
      assertEquals(
        storage.requests[0].headers["x-redmine-username"],
        undefined,
      );
    } finally {
      await redmine.server.shutdown();
      await storage.server.shutdown();
    }
  },
});
