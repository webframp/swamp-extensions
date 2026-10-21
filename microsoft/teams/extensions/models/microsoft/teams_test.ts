// Tests for teams.ts model methods
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { model, REFRESH_TOKEN_VAULT_KEY } from "./teams.ts";
import { MicrosoftAuthError } from "./_lib/auth.ts";

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

// ---------------------------------------------------------------------------
// bootstrap: refresh token lands in a vault, never in persisted data
// ---------------------------------------------------------------------------

function fieldMeta(schema: unknown, field: string): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  let f = (schema as any).shape[field];
  // Merge meta across .optional()/.describe() wrappers, as swamp does.
  const merged: Record<string, unknown> = {};
  while (f) {
    Object.assign(merged, f.meta() ?? {});
    f = typeof f.unwrap === "function" ? f.unwrap() : undefined;
  }
  return merged;
}

Deno.test("bootstrap resource declares refreshToken as a sensitive vault field", () => {
  const meta = fieldMeta(model.resources.bootstrap.schema, "refreshToken");
  assertEquals(meta.sensitive, true);
  assertEquals(meta.vaultKey, REFRESH_TOKEN_VAULT_KEY);
});

Deno.test("refreshToken global argument is sensitive and optional", () => {
  const meta = fieldMeta(model.globalArguments, "refreshToken");
  assertEquals(meta.sensitive, true);
  const parsed = model.globalArguments.safeParse({
    tenantId: TEST_TENANT_ID,
    clientId: TEST_CLIENT_ID,
  });
  assertEquals(parsed.success, true);
});

Deno.test({
  name:
    "bootstrap: writes the refresh token only to the declared sensitive field",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer((req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname.endsWith("/oauth2/v2.0/devicecode")) {
        return Response.json({
          device_code: "dc",
          user_code: "UC",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 60,
          interval: 0,
          message: "go",
        });
      }
      if (reqUrl.pathname.endsWith("/oauth2/v2.0/token")) {
        return Response.json({
          access_token: "test-access-token",
          refresh_token: "minted-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "offline_access",
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installMicrosoftMock(url);
    try {
      const { context, getWrittenResources, getLogs } = createModelTestContext({
        globalArgs: { tenantId: TEST_TENANT_ID, clientId: TEST_CLIENT_ID },
        definition: { id: "test-id", name: "test-teams", version: 1, tags: {} },
      });
      await model.methods.bootstrap.execute(
        {} as Record<string, never>,
        context as unknown as Parameters<
          typeof model.methods.bootstrap.execute
        >[1],
      );
      const written = getWrittenResources();
      assertEquals(written.length, 1);
      const data = written[0].data as Record<string, unknown>;
      // The token is carried only by the sensitive field, which swamp
      // replaces with a vault.get reference before persisting.
      const parsed = model.resources.bootstrap.schema.parse(data);
      assertEquals(parsed.refreshToken, "minted-refresh-token");
      const withoutToken = JSON.stringify({ ...data, refreshToken: undefined });
      assertEquals(withoutToken.includes("minted-refresh-token"), false);
      assertEquals(
        String(data.message).includes(REFRESH_TOKEN_VAULT_KEY),
        true,
      );
      assertEquals(
        JSON.stringify(getLogs()).includes("minted-refresh-token"),
        false,
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test("methods fail with guidance when refreshToken is unset", async () => {
  const { context } = createModelTestContext({
    globalArgs: { tenantId: TEST_TENANT_ID, clientId: TEST_CLIENT_ID },
    definition: { id: "test-id", name: "test-teams", version: 1, tags: {} },
  });
  const err = await assertRejects(
    () =>
      model.methods.list_teams.execute(
        {} as Record<string, never>,
        context as unknown as Parameters<
          typeof model.methods.list_teams.execute
        >[1],
      ),
    MicrosoftAuthError,
  );
  assertEquals((err as MicrosoftAuthError).code, "missing_refresh_token");
});
