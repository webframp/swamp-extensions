// Redmine API Helper Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { redmineApi, redmineApiPaginated } from "./api.ts";

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
    } finally {
      await server.shutdown();
    }
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
