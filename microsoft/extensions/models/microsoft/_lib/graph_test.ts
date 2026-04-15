// Tests for _lib/graph.ts
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { GraphApiError, graphRequest, graphRequestPaginated } from "./graph.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startMockGraphServer(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installGraphMock(mockBaseUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input.toString();
    const rewritten = raw.replace(
      "https://graph.microsoft.com/v1.0",
      mockBaseUrl,
    );
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// graphRequest
// ---------------------------------------------------------------------------

Deno.test({
  name: "graphRequest: returns parsed JSON on success",
  sanitizeResources: false,
  fn: async () => {
    const payload = { id: "user-1", displayName: "Test User" };
    const { url, server } = startMockGraphServer((_req) =>
      Response.json(payload)
    );
    const restore = installGraphMock(url);

    try {
      const result = await graphRequest<typeof payload>(
        "fake-token",
        "GET",
        "/me",
      );
      assertEquals(result.id, "user-1");
      assertEquals(result.displayName, "Test User");
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "graphRequest: sends Authorization header",
  sanitizeResources: false,
  fn: async () => {
    let capturedAuth = "";
    const { url, server } = startMockGraphServer((req) => {
      capturedAuth = req.headers.get("Authorization") ?? "";
      return Response.json({ ok: true });
    });
    const restore = installGraphMock(url);

    try {
      await graphRequest("my-access-token", "GET", "/me");
      assertEquals(capturedAuth, "Bearer my-access-token");
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "graphRequest: throws GraphApiError on non-2xx",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockGraphServer((_req) =>
      Response.json(
        {
          error: {
            code: "ResourceNotFound",
            message: "Resource not found",
          },
        },
        { status: 404 },
      )
    );
    const restore = installGraphMock(url);

    try {
      const err = await assertRejects(
        () => graphRequest("token", "GET", "/me/messages/nonexistent"),
        GraphApiError,
      );
      assertEquals(err.statusCode, 404);
      assertEquals(err.graphCode, "ResourceNotFound");
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "graphRequest: returns empty object on 204 No Content",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockGraphServer((_req) =>
      new Response(null, { status: 204 })
    );
    const restore = installGraphMock(url);

    try {
      const result = await graphRequest("token", "PATCH", "/me/messages/1");
      assertEquals(result, {});
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "graphRequest: sends request body as JSON",
  sanitizeResources: false,
  fn: async () => {
    let capturedBody = "";
    const { url, server } = startMockGraphServer(async (req) => {
      capturedBody = await req.text();
      return Response.json({ ok: true });
    });
    const restore = installGraphMock(url);

    try {
      await graphRequest("token", "POST", "/me/sendMail", {
        message: { subject: "Test" },
      });
      const parsed = JSON.parse(capturedBody);
      assertEquals(parsed.message.subject, "Test");
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// graphRequestPaginated
// ---------------------------------------------------------------------------

Deno.test({
  name: "graphRequestPaginated: returns all items across pages",
  sanitizeResources: false,
  fn: async () => {
    let page = 0;
    const { url, server } = startMockGraphServer((req) => {
      const reqUrl = new URL(req.url);
      const isPage2 = reqUrl.searchParams.get("$skip") === "2";
      page++;

      if (!isPage2) {
        // nextLink uses the Graph base URL so the mock intercept can rewrite it.
        return Response.json({
          value: [{ id: "msg-1" }, { id: "msg-2" }],
          "@odata.nextLink":
            `https://graph.microsoft.com/v1.0/me/messages?$skip=2`,
        });
      }

      return Response.json({
        value: [{ id: "msg-3" }],
      });
    });
    const restore = installGraphMock(url);

    try {
      const items = await graphRequestPaginated<{ id: string }>(
        "token",
        "/me/messages",
      );
      assertEquals(items.length, 3);
      assertEquals(items[0].id, "msg-1");
      assertEquals(items[2].id, "msg-3");
      assertEquals(page, 2);
    } finally {
      restore();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "graphRequestPaginated: passes query params on first request",
  sanitizeResources: false,
  fn: async () => {
    let capturedUrl = "";
    const { url, server } = startMockGraphServer((req) => {
      capturedUrl = req.url;
      return Response.json({ value: [] });
    });
    const restore = installGraphMock(url);

    try {
      await graphRequestPaginated("token", "/me/messages", {
        "$filter": "isRead eq false",
        "$top": "10",
      });
      const parsed = new URL(capturedUrl);
      assertEquals(parsed.searchParams.get("$filter"), "isRead eq false");
      assertEquals(parsed.searchParams.get("$top"), "10");
    } finally {
      restore();
      await server.shutdown();
    }
  },
});
