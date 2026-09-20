// Tests for teams.ts model methods
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { model } from "./teams.ts";

// ---------------------------------------------------------------------------
// Mock Server Helpers
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = "test-tenant-id";
const TEST_CLIENT_ID = "test-client-id";
const TEST_REFRESH_TOKEN = "test-refresh-token";

function startMockServer(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

// Rewrites both Microsoft auth requests and Graph requests to the same mock
// server, distinguished by path, since attention/list_chats hit both hosts
// via the global fetch (getAccessToken has no fetch-injection point).
function installMicrosoftMock(mockBaseUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input.toString();
    const rewritten = raw
      .replace("https://login.microsoftonline.com", mockBaseUrl)
      .replace("https://graph.microsoft.com/v1.0", mockBaseUrl);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: {
      tenantId: TEST_TENANT_ID,
      clientId: TEST_CLIENT_ID,
      refreshToken: TEST_REFRESH_TOKEN,
    },
    definition: { id: "test-id", name: "test-teams", version: 1, tags: {} },
  });
}

function tokenResponse(): Response {
  return Response.json({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token-2",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "Chat.Read offline_access User.Read",
  });
}

// ---------------------------------------------------------------------------
// attention
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "attention: requests viewpoint via $select (not $expand) and surfaces an unread chat",
  sanitizeResources: false,
  fn: async () => {
    let capturedChatsUrl: URL | null = null;
    const { url, server } = startMockServer((req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname.endsWith("/oauth2/v2.0/token")) {
        return tokenResponse();
      }
      if (reqUrl.pathname === "/me/chats") {
        capturedChatsUrl = reqUrl;
        return Response.json({
          value: [
            {
              id: "chat-1",
              chatType: "oneOnOne",
              topic: null,
              lastUpdatedDateTime: "2026-09-18T12:00:00Z",
              viewpoint: {
                isHidden: false,
                lastMessageReadDateTime: "2026-09-17T00:00:00Z",
              },
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installMicrosoftMock(url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.attention.execute(
        { chatLimit: 50, mode: "unread_only", since: "2026-09-17T00:00:00Z" },
        context as unknown as Parameters<
          typeof model.methods.attention.execute
        >[1],
      );

      // The bug: Graph rejects viewpoint under $expand since it isn't a
      // navigation property. Only members may be expanded; viewpoint must
      // be requested via $select.
      const expand = capturedChatsUrl!.searchParams.get("$expand");
      const select = capturedChatsUrl!.searchParams.get("$select");
      assertEquals(expand, "members");
      assertEquals(select?.includes("viewpoint"), true);
      assertEquals(expand?.includes("viewpoint"), false);

      const written = getWrittenResources();
      assertEquals(written.length, 1);
      const data = written[0].data as {
        items: Array<{ reason: string; chat: { id: string } }>;
        totalItems: number;
      };
      assertEquals(data.totalItems, 1);
      assertEquals(data.items[0].reason, "unread_chat");
      assertEquals(data.items[0].chat.id, "chat-1");
      assertEquals(result.dataHandles.length, 1);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// list_chats
// ---------------------------------------------------------------------------

Deno.test({
  name: "list_chats: requests viewpoint via $select (not $expand)",
  sanitizeResources: false,
  fn: async () => {
    let capturedChatsUrl: URL | null = null;
    const { url, server } = startMockServer((req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname.endsWith("/oauth2/v2.0/token")) {
        return tokenResponse();
      }
      if (reqUrl.pathname === "/me/chats") {
        capturedChatsUrl = reqUrl;
        return Response.json({
          value: [
            {
              id: "chat-1",
              chatType: "group",
              topic: "Gateways",
              lastUpdatedDateTime: "2026-09-18T12:00:00Z",
              viewpoint: { isHidden: false, lastMessageReadDateTime: null },
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installMicrosoftMock(url);

    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_chats.execute(
        { limit: 20 },
        context as unknown as Parameters<
          typeof model.methods.list_chats.execute
        >[1],
      );

      const expand = capturedChatsUrl!.searchParams.get("$expand");
      const select = capturedChatsUrl!.searchParams.get("$select");
      assertEquals(expand, "members");
      assertEquals(select?.includes("viewpoint"), true);

      const written = getWrittenResources();
      const data = written[0].data as {
        chats: Array<{ id: string; viewpoint?: unknown }>;
      };
      assertEquals(data.chats.length, 1);
      assertEquals(data.chats[0].id, "chat-1");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
