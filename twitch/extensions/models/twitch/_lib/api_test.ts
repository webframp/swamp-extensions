// Twitch Helix API Client Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { TwitchCredentials } from "./types.ts";
import {
  clearTokenCache,
  helixApi,
  helixApiPaginated,
  refreshAccessToken,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Start a local HTTP server that handles Twitch Helix + OAuth2 mock routes */
function startMockTwitchServer(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

/** Install fetch mock that redirects Twitch API calls to local server */
function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const newUrl = reqUrl
      .replace("https://api.twitch.tv/helix", mockUrl)
      .replace("https://id.twitch.tv/oauth2/token", `${mockUrl}/oauth2/token`);
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeCreds(overrides?: Partial<TwitchCredentials>): TwitchCredentials {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "helixApi: makes GET request with correct auth headers",
  // Deno.serve creates resources that outlive the test callback
  sanitizeResources: false,
  fn: async () => {
    let capturedHeaders: Record<string, string> = {};

    const { url, server } = startMockTwitchServer((req) => {
      capturedHeaders = {
        authorization: req.headers.get("Authorization") ?? "",
        clientId: req.headers.get("Client-Id") ?? "",
      };
      return Response.json({
        data: [{ id: "123", login: "testuser" }],
      }, {
        headers: { "Ratelimit-Remaining": "100" },
      });
    });
    const uninstall = installFetchMock(url);

    try {
      const creds = makeCreds();
      const result = await helixApi<{ id: string; login: string }>(
        creds,
        "/users?login=testuser",
      );

      assertEquals(capturedHeaders.authorization, "Bearer test-access-token");
      assertEquals(capturedHeaders.clientId, "test-client-id");
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].login, "testuser");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "helixApi: makes POST request with body",
  sanitizeResources: false,
  fn: async () => {
    let capturedMethod = "";
    let capturedBody = "";

    const { url, server } = startMockTwitchServer(async (req) => {
      capturedMethod = req.method;
      capturedBody = await req.text();
      return Response.json({
        data: [{ id: "ban-1" }],
      }, {
        headers: { "Ratelimit-Remaining": "100" },
      });
    });
    const uninstall = installFetchMock(url);

    try {
      const creds = makeCreds();
      const body = { data: { user_id: "456", reason: "spam" } };
      const result = await helixApi<{ id: string }>(
        creds,
        "/moderation/bans",
        "POST",
        body,
      );

      assertEquals(capturedMethod, "POST");
      assertEquals(JSON.parse(capturedBody), body);
      assertEquals(result.data[0].id, "ban-1");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "helixApiPaginated: fetches all pages via cursor",
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;

    const { url, server } = startMockTwitchServer((req) => {
      const reqUrl = new URL(req.url);
      const after = reqUrl.searchParams.get("after");
      requestCount++;

      if (!after) {
        // First page
        return Response.json({
          data: [{ id: "1" }, { id: "2" }],
          pagination: { cursor: "page2cursor" },
        }, {
          headers: { "Ratelimit-Remaining": "100" },
        });
      } else {
        // Second (final) page
        return Response.json({
          data: [{ id: "3" }],
          pagination: {},
        }, {
          headers: { "Ratelimit-Remaining": "100" },
        });
      }
    });
    const uninstall = installFetchMock(url);

    try {
      const creds = makeCreds();
      const results = await helixApiPaginated<{ id: string }>(
        creds,
        "/moderation/moderators?broadcaster_id=999",
      );

      assertEquals(requestCount, 2);
      assertEquals(results.length, 3);
      assertEquals(results[0].id, "1");
      assertEquals(results[2].id, "3");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "helixApi: refreshes token on 401 and retries",
  sanitizeResources: false,
  fn: async () => {
    let callCount = 0;

    const { url, server } = startMockTwitchServer((req) => {
      const reqUrl = new URL(req.url);

      // Handle token refresh endpoint
      if (reqUrl.pathname === "/oauth2/token") {
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          scope: ["moderation:read"],
          token_type: "bearer",
        });
      }

      callCount++;
      if (callCount === 1) {
        // First call: return 401
        return new Response("Unauthorized", { status: 401 });
      }

      // Second call (after refresh): verify new token and return success
      const authHeader = req.headers.get("Authorization");
      assertEquals(authHeader, "Bearer new-access-token");

      return Response.json({
        data: [{ id: "refreshed" }],
      }, {
        headers: { "Ratelimit-Remaining": "100" },
      });
    });
    const uninstall = installFetchMock(url);

    try {
      const creds = makeCreds();
      const result = await helixApi<{ id: string }>(creds, "/users");

      assertEquals(result.data[0].id, "refreshed");
      // Verify credentials were mutated with new tokens
      assertEquals(creds.accessToken, "new-access-token");
      assertEquals(creds.refreshToken, "new-refresh-token");
    } finally {
      clearTokenCache();
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "helixApi: throws on non-401 error",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockTwitchServer((_req) => {
      return new Response("Not Found", { status: 404 });
    });
    const uninstall = installFetchMock(url);

    try {
      const creds = makeCreds();
      await assertRejects(
        () => helixApi(creds, "/nonexistent"),
        Error,
        "404",
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "refreshAccessToken: exchanges refresh token for new access token",
  sanitizeResources: false,
  fn: async () => {
    let capturedBody = "";

    const { url, server } = startMockTwitchServer((req) => {
      return req.text().then((text) => {
        capturedBody = text;
        return Response.json({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 7200,
          scope: ["moderation:read", "channel:read:editors"],
          token_type: "bearer",
        });
      });
    });
    const uninstall = installFetchMock(url);

    try {
      const result = await refreshAccessToken(
        "my-client-id",
        "my-client-secret",
        "my-refresh-token",
      );

      // Verify form-urlencoded body
      const params = new URLSearchParams(capturedBody);
      assertEquals(params.get("grant_type"), "refresh_token");
      assertEquals(params.get("refresh_token"), "my-refresh-token");
      assertEquals(params.get("client_id"), "my-client-id");
      assertEquals(params.get("client_secret"), "my-client-secret");

      // Verify parsed response
      assertEquals(result.access_token, "fresh-token");
      assertEquals(result.refresh_token, "fresh-refresh");
      assertEquals(result.expires_in, 7200);
      assertEquals(result.scope.length, 2);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "helixApi: token cache shares refreshed tokens across separate creds copies",
  sanitizeResources: false,
  fn: async () => {
    clearTokenCache();
    let refreshCount = 0;

    const { url, server } = startMockTwitchServer((req) => {
      const reqUrl = new URL(req.url);

      if (reqUrl.pathname === "/oauth2/token") {
        refreshCount++;
        return Response.json({
          access_token: "cached-access-token",
          refresh_token: "cached-refresh-token",
          expires_in: 3600,
          scope: ["moderation:read"],
          token_type: "bearer",
        });
      }

      const auth = req.headers.get("Authorization") ?? "";
      if (auth === "Bearer expired-token") {
        return new Response("Unauthorized", { status: 401 });
      }

      return Response.json({
        data: [{ id: "ok" }],
      }, {
        headers: { "Ratelimit-Remaining": "100" },
      });
    });
    const uninstall = installFetchMock(url);

    try {
      // First call with expired token triggers refresh and caches
      const creds1 = makeCreds({ accessToken: "expired-token" });
      await helixApi<{ id: string }>(creds1, "/users");
      assertEquals(refreshCount, 1);

      // Second call with a fresh creds copy (same expired token) uses cache
      const creds2 = makeCreds({ accessToken: "expired-token" });
      await helixApi<{ id: string }>(creds2, "/users");
      assertEquals(refreshCount, 1); // Still 1 — no second refresh
      assertEquals(creds2.accessToken, "cached-access-token");

      // Third call with a manually rotated token bypasses the cache
      const creds3 = makeCreds({ accessToken: "manually-rotated-token" });
      await helixApi<{ id: string }>(creds3, "/users");
      assertEquals(refreshCount, 1); // Still 1 — rotated token works, no refresh
      assertEquals(creds3.accessToken, "manually-rotated-token"); // Unchanged
    } finally {
      clearTokenCache();
      uninstall();
      await server.shutdown();
    }
  },
});
