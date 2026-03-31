// Cloudflare API Helper Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { cfApi, cfApiPaginated } from "./api.ts";

// ---------------------------------------------------------------------------
// Mock Cloudflare API Server
// ---------------------------------------------------------------------------

interface MockCfServer {
  url: string;
  server: Deno.HttpServer;
  requests: Array<{ method: string; path: string; body?: unknown }>;
}

function startMockCfServer(
  handler: (
    req: Request,
  ) => Response | Promise<Response>,
): MockCfServer {
  const requests: MockCfServer["requests"] = [];

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.method !== "GET" && req.method !== "HEAD"
      ? await req.json().catch(() => undefined)
      : undefined;

    requests.push({
      method: req.method,
      path: url.pathname + url.search,
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

// Helper to create a successful Cloudflare API response
function cfResponse<T>(result: T, resultInfo?: {
  page: number;
  per_page: number;
  total_count: number;
  total_pages: number;
}): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: resultInfo,
  });
}

// Helper to create an error Cloudflare API response
function cfErrorResponse(code: number, message: string): Response {
  return Response.json({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "cfApi: makes GET request with auth header",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockCfServer(() =>
      cfResponse({ id: "zone-123", name: "example.com" })
    );

    // Temporarily override the API base URL by replacing fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      const result = await cfApi<{ id: string; name: string }>(
        "test-token",
        "GET",
        "/zones/zone-123",
      );

      assertEquals(result.id, "zone-123");
      assertEquals(result.name, "example.com");
      assertEquals(requests.length, 1);
      assertEquals(requests[0].method, "GET");
      assertEquals(requests[0].path, "/zones/zone-123");
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cfApi: makes POST request with body",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockCfServer(() =>
      cfResponse({ id: "record-456", type: "A", content: "1.2.3.4" })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      const result = await cfApi<{ id: string }>(
        "test-token",
        "POST",
        "/zones/zone-123/dns_records",
        { type: "A", name: "www", content: "1.2.3.4" },
      );

      assertEquals(result.id, "record-456");
      assertEquals(requests.length, 1);
      assertEquals(requests[0].method, "POST");
      assertEquals(requests[0].body, {
        type: "A",
        name: "www",
        content: "1.2.3.4",
      });
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cfApi: throws on API error",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer(() =>
      cfErrorResponse(9103, "Unknown zone")
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      await assertRejects(
        () => cfApi("test-token", "GET", "/zones/invalid"),
        Error,
        "Unknown zone",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cfApiPaginated: fetches all pages",
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;
    const { url, server } = startMockCfServer((req) => {
      requestCount++;
      const reqUrl = new URL(req.url);
      const page = parseInt(reqUrl.searchParams.get("page") || "1");

      if (page === 1) {
        return cfResponse(
          [{ id: "zone-1" }, { id: "zone-2" }],
          { page: 1, per_page: 2, total_count: 4, total_pages: 2 },
        );
      } else {
        return cfResponse(
          [{ id: "zone-3" }, { id: "zone-4" }],
          { page: 2, per_page: 2, total_count: 4, total_pages: 2 },
        );
      }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      const results = await cfApiPaginated<{ id: string }>(
        "test-token",
        "/zones",
      );

      assertEquals(results.length, 4);
      assertEquals(results.map((r) => r.id), [
        "zone-1",
        "zone-2",
        "zone-3",
        "zone-4",
      ]);
      assertEquals(requestCount, 2);
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cfApiPaginated: handles single page",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer(() =>
      cfResponse(
        [{ id: "zone-1" }],
        { page: 1, per_page: 50, total_count: 1, total_pages: 1 },
      )
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      const results = await cfApiPaginated<{ id: string }>(
        "test-token",
        "/zones",
      );
      assertEquals(results.length, 1);
      assertEquals(results[0].id, "zone-1");
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cfApiPaginated: passes query params",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockCfServer(() =>
      cfResponse([], { page: 1, per_page: 50, total_count: 0, total_pages: 1 })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      const newUrl = reqUrl.replace(
        "https://api.cloudflare.com/client/v4",
        url,
      );
      return originalFetch(newUrl, init);
    };

    try {
      await cfApiPaginated("test-token", "/zones", { status: "active" });
      assertEquals(requests[0].path.includes("status=active"), true);
    } finally {
      globalThis.fetch = originalFetch;
      await server.shutdown();
    }
  },
});
