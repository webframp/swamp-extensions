# Twitch Moderation Extension Implementation Plan

**Goal:** Build a swamp extension (`@webframp/twitch`) that gives Twitch moderators cross-channel visibility into chat activity, user history, and moderation events via a model, workflow, and report.

**Architecture:** A single model type where each instance represents one Twitch channel. A `_lib/api.ts` handles Helix API calls with token refresh and rate limiting. A workflow fans out across channel instances, and a report correlates findings cross-channel (suspicious users, ban overlap).

**Tech Stack:** TypeScript/Deno, Twitch Helix REST API, OAuth2 user tokens, Zod schemas, `@systeminit/swamp-testing`

**Design doc:** `docs/plans/2026-04-22-twitch-moderation-design.md`

---

## Task 1: Scaffold Extension Directory

Set up the extension skeleton: repo init, deno.json, manifest.yaml, and directory structure.

**Files:**
- Create: `twitch/.swamp.yaml` (via `swamp repo init`)
- Create: `twitch/deno.json`
- Create: `twitch/manifest.yaml`
- Create: `twitch/.gitignore`
- Create: `twitch/extensions/models/twitch/_lib/` (directory)
- Create: `twitch/extensions/reports/` (directory)
- Create: `twitch/workflows/` (directory)

**Step 1: Initialize swamp repo**

```bash
cd twitch
swamp repo init
```

This creates `.swamp.yaml` and a local `CLAUDE.md` (gitignored).

**Step 2: Create `.gitignore`**

```gitignore
.swamp/
.claude/
CLAUDE.md
AGENTS.md
```

**Step 3: Create `deno.json`**

```json
{
  "tasks": {
    "check": "deno check extensions/models/twitch/*.ts extensions/models/twitch/_lib/*.ts extensions/reports/*.ts",
    "lint": "deno lint extensions/models/ extensions/reports/",
    "fmt": "deno fmt extensions/models/ extensions/reports/",
    "fmt:check": "deno fmt --check extensions/models/ extensions/reports/",
    "test": "deno test --allow-env --allow-net extensions/models/ extensions/reports/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "zod": "npm:zod@4.3.6",
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

**Step 4: Create `manifest.yaml`**

```yaml
manifestVersion: 1
name: "@webframp/twitch"
version: "2026.04.22.1"
description: |
  Twitch Moderation Toolkit — cross-channel moderation visibility for Twitch moderators.

  This extension provides a model for interacting with the Twitch Helix API
  (chatters, bans, mod events, user lookups), a workflow that audits all your
  moderated channels in parallel, and a report that correlates findings
  cross-channel to surface suspicious users and ban overlap.

  ## Quick Start

  ```bash
  swamp extension pull @webframp/twitch

  # Create one model instance per channel you moderate
  swamp model create @webframp/twitch mod-drongo \
    --global-arg channel=drongo \
    --global-arg moderatorId=YOUR_TWITCH_USER_ID

  # Run the cross-channel audit
  swamp workflow run @webframp/twitch-mod-audit
  ```

  ## Authentication

  Requires a Twitch application with OAuth2 user tokens. Store credentials in vault:

  ```bash
  swamp vault set twitch-client-id YOUR_CLIENT_ID
  swamp vault set twitch-client-secret YOUR_CLIENT_SECRET
  swamp vault set twitch-access-token YOUR_ACCESS_TOKEN
  swamp vault set twitch-refresh-token YOUR_REFRESH_TOKEN
  ```

  To obtain tokens, register an app at dev.twitch.tv/console/apps with
  redirect URL http://localhost:3000 and category "Chat Bot". Then authorize:

  ```bash
  # 1. Open in browser (replace YOUR_CLIENT_ID):
  # https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000&response_type=code&scope=moderator:read:chatters+moderation:read+moderator:manage:banned_users+channel:read:editors

  # 2. Copy the code from the redirect URL, then exchange for tokens:
  curl -X POST 'https://id.twitch.tv/oauth2/token' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&code=AUTH_CODE&grant_type=authorization_code&redirect_uri=http://localhost:3000'

  # 3. Get your moderator user ID:
  curl -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
    -H 'Client-Id: YOUR_CLIENT_ID' \
    'https://api.twitch.tv/helix/users'
  ```

  The model refreshes expired access tokens automatically using the refresh token.

  ## Required Scopes

  - moderator:read:chatters
  - moderation:read
  - moderator:manage:banned_users
  - channel:read:editors
repository: "https://github.com/webframp/swamp-extensions"
models:
  - twitch/mod.ts
workflows:
  - twitch-mod-audit.yaml
reports:
  - mod_report.ts
labels:
  - twitch
  - moderation
  - chat
  - streaming
platforms:
  - linux-x86_64
  - linux-aarch64
  - darwin-x86_64
  - darwin-aarch64
```

**Step 5: Create empty directories**

```bash
mkdir -p extensions/models/twitch/_lib extensions/reports workflows
```

**Step 6: Verify structure**

```bash
ls -R twitch/
```

Expected: `.gitignore`, `.swamp.yaml`, `deno.json`, `manifest.yaml`, `extensions/models/twitch/_lib/`, `extensions/reports/`, `workflows/`

**Step 7: Commit**

```bash
git add twitch/.gitignore twitch/.swamp.yaml twitch/deno.json twitch/manifest.yaml
git commit -m "feat(twitch): scaffold extension directory structure"
```

---

## Task 2: Helix API Client (`_lib/api.ts` + `_lib/types.ts`)

Build the shared Twitch Helix API client with token refresh on 401, rate-limit awareness, and cursor-based pagination (Twitch uses cursor, not page numbers).

**Files:**
- Create: `twitch/extensions/models/twitch/_lib/types.ts`
- Create: `twitch/extensions/models/twitch/_lib/api.ts`
- Test: `twitch/extensions/models/twitch/_lib/api_test.ts`

**Step 1: Write types**

Create `_lib/types.ts` with shared interfaces:

```typescript
// Twitch API shared types
// SPDX-License-Identifier: Apache-2.0

/** Credentials needed for all Helix API calls */
export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

/** Standard Twitch Helix paginated response envelope */
export interface HelixResponse<T> {
  data: T[];
  pagination?: { cursor?: string };
  total?: number;
}

/** Twitch OAuth2 token response */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}
```

**Step 2: Write the failing API client tests**

Create `_lib/api_test.ts`. Tests cover:
1. Successful GET request with auth headers
2. Cursor-based pagination fetches all pages
3. Token refresh on 401, then retries original request
4. Rate limit pause when `Ratelimit-Remaining` is low
5. Throws on non-401 errors

```typescript
// Twitch Helix API Client Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { helixApi, helixApiPaginated, refreshAccessToken } from "./api.ts";
import type { TwitchCredentials } from "./types.ts";

const HELIX_BASE = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

interface MockServer {
  url: string;
  server: Deno.HttpServer;
  requests: Array<{ method: string; path: string; headers: Headers }>;
}

function startMockServer(
  handler: (req: Request) => Response | Promise<Response>,
): MockServer {
  const requests: MockServer["requests"] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
    });
    return handler(req);
  });
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server, requests };
}

function installFetchMock(
  mockUrl: string,
  targets: string[],
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    let newUrl = reqUrl;
    for (const target of targets) {
      newUrl = newUrl.replace(target, mockUrl);
    }
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const testCreds: TwitchCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
};

Deno.test({
  name: "helixApi: makes GET request with correct auth headers",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, requests } = startMockServer(() =>
      Response.json({ data: [{ id: "123", login: "drongo" }] })
    );
    const uninstall = installFetchMock(url, [HELIX_BASE]);

    try {
      const result = await helixApi<{ id: string; login: string }>(
        testCreds,
        "/channels?broadcaster_id=123",
      );
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].login, "drongo");
      assertEquals(requests.length, 1);
      // Verify auth headers were sent
      assertEquals(
        requests[0].headers.get("Authorization"),
        "Bearer test-access-token",
      );
      assertEquals(requests[0].headers.get("Client-Id"), "test-client-id");
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
    const { url, server } = startMockServer(async (req) => {
      const body = await req.json();
      return Response.json({ data: [{ id: "ban-1", ...body }] });
    });
    const uninstall = installFetchMock(url, [HELIX_BASE]);

    try {
      const result = await helixApi<{ id: string }>(
        testCreds,
        "/moderation/bans?broadcaster_id=123&moderator_id=456",
        "POST",
        { data: { user_id: "789", reason: "spam" } },
      );
      assertEquals(result.data.length, 1);
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
    let callCount = 0;
    const { url, server } = startMockServer((req) => {
      callCount++;
      const reqUrl = new URL(req.url);
      const after = reqUrl.searchParams.get("after");

      if (!after) {
        return Response.json({
          data: [{ user_id: "1" }, { user_id: "2" }],
          pagination: { cursor: "page2cursor" },
        });
      } else {
        return Response.json({
          data: [{ user_id: "3" }],
          pagination: {},
        });
      }
    });
    const uninstall = installFetchMock(url, [HELIX_BASE]);

    try {
      const results = await helixApiPaginated<{ user_id: string }>(
        testCreds,
        "/chat/chatters?broadcaster_id=123&moderator_id=456",
      );
      assertEquals(results.length, 3);
      assertEquals(callCount, 2);
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
    const { url, server } = startMockServer((req) => {
      const reqUrl = new URL(req.url);
      // Token endpoint
      if (reqUrl.pathname === "/oauth2/token") {
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 14400,
          scope: ["moderation:read"],
          token_type: "bearer",
        });
      }

      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ data: [{ id: "123" }] });
    });
    const uninstall = installFetchMock(url, [HELIX_BASE, TOKEN_URL]);

    try {
      const creds = { ...testCreds };
      const result = await helixApi<{ id: string }>(
        creds,
        "/users?login=drongo",
      );
      assertEquals(result.data[0].id, "123");
      assertEquals(callCount, 2); // First 401, then retry
      assertEquals(creds.accessToken, "new-access-token");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "helixApi: throws on non-401 error",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer(() =>
      Response.json(
        { error: "Not Found", status: 404, message: "user not found" },
        { status: 404 },
      )
    );
    const uninstall = installFetchMock(url, [HELIX_BASE]);

    try {
      await assertRejects(
        () => helixApi(testCreds, "/users?login=nonexistent"),
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
    const { url, server } = startMockServer(() =>
      Response.json({
        access_token: "fresh-token",
        refresh_token: "fresh-refresh",
        expires_in: 14400,
        scope: ["moderation:read"],
        token_type: "bearer",
      })
    );
    const uninstall = installFetchMock(url, [TOKEN_URL]);

    try {
      const result = await refreshAccessToken(
        "test-client-id",
        "test-client-secret",
        "old-refresh-token",
      );
      assertEquals(result.access_token, "fresh-token");
      assertEquals(result.refresh_token, "fresh-refresh");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
```

**Step 3: Run tests to verify they fail**

```bash
cd twitch && deno task test
```

Expected: FAIL — `api.ts` does not exist yet.

**Step 4: Implement `_lib/api.ts`**

```typescript
// Twitch Helix API Client
// SPDX-License-Identifier: Apache-2.0

import type {
  HelixResponse,
  TokenResponse,
  TwitchCredentials,
} from "./types.ts";

const HELIX_BASE = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/** Exchange a refresh token for a new access token. */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token refresh failed (${response.status}): ${text}. ` +
        "If your refresh token has expired (unused for 30+ days), " +
        "re-authorize at https://id.twitch.tv/oauth2/authorize",
    );
  }

  return (await response.json()) as TokenResponse;
}

/** Make a single Helix API request. Refreshes token on 401 and retries once. */
export async function helixApi<T>(
  creds: TwitchCredentials,
  path: string,
  method: string = "GET",
  body?: unknown,
): Promise<HelixResponse<T>> {
  const doRequest = async (token: string): Promise<Response> => {
    const url = `${HELIX_BASE}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
      "Client-Id": creds.clientId,
    };
    if (body) headers["Content-Type"] = "application/json";

    return await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let response = await doRequest(creds.accessToken);

  // Token refresh on 401
  if (response.status === 401) {
    const tokens = await refreshAccessToken(
      creds.clientId,
      creds.clientSecret,
      creds.refreshToken,
    );
    creds.accessToken = tokens.access_token;
    creds.refreshToken = tokens.refresh_token;
    response = await doRequest(creds.accessToken);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitch API error (${response.status}): ${text}`);
  }

  // Check rate limit headers
  const remaining = response.headers.get("Ratelimit-Remaining");
  if (remaining !== null && parseInt(remaining) < 20) {
    const resetEpoch = response.headers.get("Ratelimit-Reset");
    if (resetEpoch) {
      const waitMs = parseInt(resetEpoch) * 1000 - Date.now();
      if (waitMs > 0 && waitMs < 60000) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  return (await response.json()) as HelixResponse<T>;
}

/** Paginate through all results using Twitch cursor-based pagination. */
export async function helixApiPaginated<T>(
  creds: TwitchCredentials,
  path: string,
): Promise<T[]> {
  const allResults: T[] = [];
  let cursor: string | undefined;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const paginatedPath = cursor
      ? `${path}${separator}first=100&after=${cursor}`
      : `${path}${separator}first=100`;

    const response = await helixApi<T>(creds, paginatedPath);
    allResults.push(...response.data);

    cursor = response.pagination?.cursor;
    if (!cursor) break;
  }

  return allResults;
}
```

**Step 5: Run tests to verify they pass**

```bash
cd twitch && deno task test
```

Expected: All 6 tests PASS.

**Step 6: Run check, lint, fmt**

```bash
cd twitch && deno task check && deno task lint && deno task fmt
```

**Step 7: Commit**

```bash
git add twitch/extensions/models/twitch/_lib/
git commit -m "feat(twitch): add Helix API client with token refresh and pagination"
```

---

## Task 3: Model Definition (`mod.ts`)

Build the `@webframp/twitch` model with all 7 methods: `get_channel`, `get_chatters`, `get_user`, `get_banned_users`, `ban_user`, `unban_user`, `get_mod_events`.

**Files:**
- Create: `twitch/extensions/models/twitch/mod.ts`
- Test: `twitch/extensions/models/twitch/mod_test.ts`

**Step 1: Write the failing model tests**

Create `mod_test.ts`. Tests cover:
1. Model export structure (type, version, globalArgs, resources, methods)
2. `get_channel` returns channel metadata
3. `get_chatters` returns chatter list with count
4. `get_user` returns user with pre-computed `accountAgeDays`
5. `get_banned_users` returns ban list
6. `ban_user` sends POST and writes result
7. `unban_user` sends DELETE and writes result
8. `get_mod_events` returns event list

```typescript
// Twitch Moderation Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("twitch model: has correct type", () => {
  assertEquals(model.type, "@webframp/twitch");
});

Deno.test("twitch model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("twitch model: has globalArguments with required fields", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.channel);
  assertExists(shape.moderatorId);
  assertExists(shape.clientId);
  assertExists(shape.clientSecret);
  assertExists(shape.accessToken);
  assertExists(shape.refreshToken);
});

Deno.test("twitch model: has all 7 methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.get_channel);
  assertExists(model.methods.get_chatters);
  assertExists(model.methods.get_user);
  assertExists(model.methods.get_banned_users);
  assertExists(model.methods.ban_user);
  assertExists(model.methods.unban_user);
  assertExists(model.methods.get_mod_events);
});

Deno.test("twitch model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.channel);
  assertExists(model.resources.chatters);
  assertExists(model.resources.user);
  assertExists(model.resources["banned-users"]);
  assertExists(model.resources["ban-result"]);
  assertExists(model.resources["mod-events"]);
});

// ---------------------------------------------------------------------------
// Mock Twitch API Server
// ---------------------------------------------------------------------------

const HELIX_BASE = "https://api.twitch.tv/helix";

function startMockHelixServer(
  routes: Record<string, (req: Request) => unknown>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.pathname.includes(pattern)) {
        const result = handler(req);
        return Response.json(result);
      }
    }
    return Response.json({ data: [] });
  });
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const newUrl = reqUrl.replace(HELIX_BASE, mockUrl);
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const testGlobalArgs = {
  channel: "drongo",
  moderatorId: "12345678",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
};

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "twitch model: get_channel returns channel metadata",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/channels": () => ({
        data: [{
          broadcaster_id: "99999",
          broadcaster_login: "drongo",
          broadcaster_name: "Drongo",
          game_name: "Dota 2",
          game_id: "29595",
          title: "Ranked grind",
          tags: ["English", "Competitive"],
        }],
      }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.get_channel.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_channel.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "channel");
      const data = resources[0].data as { broadcasterLogin: string };
      assertEquals(data.broadcasterLogin, "drongo");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_chatters returns chatter list with count",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/chat/chatters": () => ({
        data: [
          { user_id: "1", user_login: "alice", user_name: "Alice" },
          { user_id: "2", user_login: "bob", user_name: "Bob" },
        ],
        total: 2,
      }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.get_chatters.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_chatters.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as { chatters: unknown[]; count: number };
      assertEquals(data.count, 2);
      assertEquals(data.chatters.length, 2);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_user returns user with accountAgeDays",
  sanitizeResources: false,
  fn: async () => {
    const createdAt = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { url, server } = startMockHelixServer({
      "/users": () => ({
        data: [{
          id: "42",
          login: "suspicious_user",
          display_name: "Suspicious_User",
          created_at: createdAt,
          profile_image_url: "https://example.com/img.png",
          broadcaster_type: "",
        }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.get_user.execute(
        { login: "suspicious_user" },
        context as unknown as Parameters<
          typeof model.methods.get_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as {
        accountAgeDays: number;
        login: string;
      };
      assertEquals(data.login, "suspicious_user");
      // Account is ~3 days old
      assertEquals(data.accountAgeDays >= 2 && data.accountAgeDays <= 4, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_banned_users returns ban list",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/moderation/banned": () => ({
        data: [{
          user_id: "789",
          user_login: "bad_user",
          user_name: "Bad_User",
          reason: "spam",
          moderator_login: "drongo",
          created_at: "2026-01-01T00:00:00Z",
          expires_at: "",
        }],
      }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.get_banned_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_banned_users.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as {
        channel: string;
        bans: Array<{ login: string }>;
        count: number;
      };
      assertEquals(data.channel, "drongo");
      assertEquals(data.count, 1);
      assertEquals(data.bans[0].login, "bad_user");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: ban_user sends POST and writes result",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/moderation/bans": () => ({
        data: [{
          broadcaster_id: "99999",
          moderator_id: "12345678",
          user_id: "789",
          created_at: "2026-04-22T00:00:00Z",
          end_time: null,
        }],
      }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.ban_user.execute(
        { userId: "789", reason: "spam" },
        context as unknown as Parameters<
          typeof model.methods.ban_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "ban-result");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: unban_user sends DELETE and writes result",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/moderation/bans": () => ({ data: [] }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.unban_user.execute(
        { userId: "789" },
        context as unknown as Parameters<
          typeof model.methods.unban_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "ban-result");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_mod_events returns event list",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/moderation/moderators/events": () => ({
        data: [{
          id: "evt-1",
          event_type: "moderation.user.ban",
          event_timestamp: "2026-04-22T00:00:00Z",
          event_data: {
            broadcaster_id: "99999",
            user_id: "789",
            user_login: "bad_user",
            moderator_login: "drongo",
          },
        }],
      }),
      "/users": () => ({
        data: [{ id: "99999", login: "drongo" }],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: testGlobalArgs,
        definition: { id: "test-id", name: "mod-drongo", version: 1, tags: {} },
      });

      const result = await model.methods.get_mod_events.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_mod_events.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as {
        channel: string;
        events: Array<{ eventType: string }>;
        count: number;
      };
      assertEquals(data.channel, "drongo");
      assertEquals(data.count, 1);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd twitch && deno task test
```

Expected: FAIL — `mod.ts` does not exist yet.

**Step 3: Implement `mod.ts`**

The model needs to:
1. Define Zod schemas for global args (channel, moderatorId, 4 vault credentials)
2. Define resources for each data shape
3. Resolve the broadcaster ID from the channel login name via `/users` endpoint
4. Implement all 7 methods using `helixApi` and `helixApiPaginated`

```typescript
// Twitch Moderation Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { helixApi, helixApiPaginated } from "./_lib/api.ts";
import type { TwitchCredentials } from "./_lib/types.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  channel: z.string().describe("Broadcaster's login name"),
  moderatorId: z.string().describe("Your Twitch user ID (the authenticated moderator)"),
  clientId: z.string().meta({ sensitive: true }).describe(
    "Twitch application client ID",
  ),
  clientSecret: z.string().meta({ sensitive: true }).describe(
    "Twitch application client secret",
  ),
  accessToken: z.string().meta({ sensitive: true }).describe(
    "OAuth2 access token",
  ),
  refreshToken: z.string().meta({ sensitive: true }).describe(
    "OAuth2 refresh token",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// Shared context type used by all methods
interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

/** Build TwitchCredentials from global args. */
function credsFrom(globalArgs: GlobalArgs): TwitchCredentials {
  return {
    clientId: globalArgs.clientId,
    clientSecret: globalArgs.clientSecret,
    accessToken: globalArgs.accessToken,
    refreshToken: globalArgs.refreshToken,
  };
}

/** Resolve a channel login name to a broadcaster ID. */
async function getBroadcasterId(
  creds: TwitchCredentials,
  channel: string,
): Promise<string> {
  const resp = await helixApi<{ id: string }>(
    creds,
    `/users?login=${encodeURIComponent(channel)}`,
  );
  if (resp.data.length === 0) {
    throw new Error(`Channel "${channel}" not found`);
  }
  return resp.data[0].id;
}

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/twitch",
  version: "2026.04.22.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "channel": {
      description: "Channel metadata: title, game, tags",
      schema: z.object({
        broadcasterId: z.string(),
        broadcasterLogin: z.string(),
        broadcasterName: z.string(),
        gameName: z.string(),
        gameId: z.string(),
        title: z.string(),
        tags: z.array(z.string()),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "chatters": {
      description: "Current users in chat",
      schema: z.object({
        channel: z.string(),
        chatters: z.array(z.object({
          userId: z.string(),
          login: z.string(),
          displayName: z.string(),
        })),
        count: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "user": {
      description: "User account details with age computation",
      schema: z.object({
        userId: z.string(),
        login: z.string(),
        displayName: z.string(),
        accountCreatedAt: z.string(),
        accountAgeDays: z.number(),
        profileImageUrl: z.string(),
        broadcasterType: z.string(),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "banned-users": {
      description: "Current bans and timeouts for a channel",
      schema: z.object({
        channel: z.string(),
        bans: z.array(z.object({
          userId: z.string(),
          login: z.string(),
          reason: z.string(),
          moderatorLogin: z.string(),
          createdAt: z.string(),
          expiresAt: z.string().nullable(),
        })),
        count: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "ban-result": {
      description: "Result of a ban or unban action",
      schema: z.object({
        channel: z.string(),
        action: z.enum(["ban", "timeout", "unban"]),
        userId: z.string(),
        moderatorId: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "mod-events": {
      description: "Recent moderation actions log",
      schema: z.object({
        channel: z.string(),
        events: z.array(z.object({
          eventType: z.string(),
          eventTimestamp: z.string(),
          userId: z.string(),
          userLogin: z.string(),
          moderatorLogin: z.string(),
        })),
        count: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    get_channel: {
      description: "Get channel metadata: title, game, tags",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );
        const resp = await helixApi<{
          broadcaster_id: string;
          broadcaster_login: string;
          broadcaster_name: string;
          game_name: string;
          game_id: string;
          title: string;
          tags: string[];
        }>(creds, `/channels?broadcaster_id=${broadcasterId}`);

        const ch = resp.data[0];
        const data = {
          broadcasterId: ch.broadcaster_id,
          broadcasterLogin: ch.broadcaster_login,
          broadcasterName: ch.broadcaster_name,
          gameName: ch.game_name,
          gameId: ch.game_id,
          title: ch.title,
          tags: ch.tags ?? [],
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "channel",
          context.globalArgs.channel,
          data,
        );
        context.logger.info("Fetched channel {channel}", {
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },

    get_chatters: {
      description: "List current users in chat",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );

        const chatters = await helixApiPaginated<{
          user_id: string;
          user_login: string;
          user_name: string;
        }>(
          creds,
          `/chat/chatters?broadcaster_id=${broadcasterId}&moderator_id=${context.globalArgs.moderatorId}`,
        );

        const data = {
          channel: context.globalArgs.channel,
          chatters: chatters.map((c) => ({
            userId: c.user_id,
            login: c.user_login,
            displayName: c.user_name,
          })),
          count: chatters.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "chatters",
          context.globalArgs.channel,
          data,
        );
        context.logger.info("Found {count} chatters in {channel}", {
          count: chatters.length,
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },

    get_user: {
      description: "Get account details for a specific user",
      arguments: z.object({
        login: z.string().describe("Twitch login name to look up"),
      }),
      execute: async (args: { login: string }, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const resp = await helixApi<{
          id: string;
          login: string;
          display_name: string;
          created_at: string;
          profile_image_url: string;
          broadcaster_type: string;
        }>(creds, `/users?login=${encodeURIComponent(args.login)}`);

        if (resp.data.length === 0) {
          throw new Error(`User "${args.login}" not found`);
        }

        const u = resp.data[0];
        const createdDate = new Date(u.created_at);
        const ageDays = Math.floor(
          (Date.now() - createdDate.getTime()) / (24 * 60 * 60 * 1000),
        );

        const data = {
          userId: u.id,
          login: u.login,
          displayName: u.display_name,
          accountCreatedAt: u.created_at,
          accountAgeDays: ageDays,
          profileImageUrl: u.profile_image_url,
          broadcasterType: u.broadcaster_type,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("user", u.login, data);
        context.logger.info("Fetched user {login} (age: {days} days)", {
          login: u.login,
          days: ageDays,
        });
        return { dataHandles: [handle] };
      },
    },

    get_banned_users: {
      description: "List current bans and timeouts for this channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );

        const bans = await helixApiPaginated<{
          user_id: string;
          user_login: string;
          user_name: string;
          reason: string;
          moderator_login: string;
          created_at: string;
          expires_at: string;
        }>(
          creds,
          `/moderation/banned?broadcaster_id=${broadcasterId}`,
        );

        const data = {
          channel: context.globalArgs.channel,
          bans: bans.map((b) => ({
            userId: b.user_id,
            login: b.user_login,
            reason: b.reason ?? "",
            moderatorLogin: b.moderator_login,
            createdAt: b.created_at,
            expiresAt: b.expires_at || null,
          })),
          count: bans.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "banned-users",
          context.globalArgs.channel,
          data,
        );
        context.logger.info("Found {count} bans in {channel}", {
          count: bans.length,
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },

    ban_user: {
      description: "Ban or timeout a user in this channel",
      arguments: z.object({
        userId: z.string().describe("User ID to ban"),
        reason: z.string().optional().describe("Ban reason"),
        duration: z.number().optional().describe(
          "Timeout duration in seconds (omit for permanent ban)",
        ),
      }),
      execute: async (
        args: { userId: string; reason?: string; duration?: number },
        context: MethodContext,
      ) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );

        const body: Record<string, unknown> = { user_id: args.userId };
        if (args.reason) body.reason = args.reason;
        if (args.duration) body.duration = args.duration;

        await helixApi(
          creds,
          `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${context.globalArgs.moderatorId}`,
          "POST",
          { data: body },
        );

        const data = {
          channel: context.globalArgs.channel,
          action: args.duration ? "timeout" as const : "ban" as const,
          userId: args.userId,
          moderatorId: context.globalArgs.moderatorId,
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "ban-result",
          args.userId,
          data,
        );
        context.logger.info("Banned user {userId} in {channel}", {
          userId: args.userId,
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },

    unban_user: {
      description: "Remove a ban or timeout from a user",
      arguments: z.object({
        userId: z.string().describe("User ID to unban"),
      }),
      execute: async (args: { userId: string }, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );

        await helixApi(
          creds,
          `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${context.globalArgs.moderatorId}&user_id=${args.userId}`,
          "DELETE",
        );

        const data = {
          channel: context.globalArgs.channel,
          action: "unban" as const,
          userId: args.userId,
          moderatorId: context.globalArgs.moderatorId,
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "ban-result",
          args.userId,
          data,
        );
        context.logger.info("Unbanned user {userId} in {channel}", {
          userId: args.userId,
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },

    get_mod_events: {
      description: "Get recent moderation actions for this channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(
          creds,
          context.globalArgs.channel,
        );

        const events = await helixApiPaginated<{
          id: string;
          event_type: string;
          event_timestamp: string;
          event_data: {
            user_id: string;
            user_login: string;
            moderator_login: string;
          };
        }>(
          creds,
          `/moderation/moderators/events?broadcaster_id=${broadcasterId}`,
        );

        const data = {
          channel: context.globalArgs.channel,
          events: events.map((e) => ({
            eventType: e.event_type,
            eventTimestamp: e.event_timestamp,
            userId: e.event_data.user_id,
            userLogin: e.event_data.user_login,
            moderatorLogin: e.event_data.moderator_login,
          })),
          count: events.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "mod-events",
          context.globalArgs.channel,
          data,
        );
        context.logger.info("Found {count} mod events in {channel}", {
          count: events.length,
          channel: context.globalArgs.channel,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Step 4: Run tests to verify they pass**

```bash
cd twitch && deno task test
```

Expected: All tests PASS (6 API client + 4 structure + 7 method = 17 tests).

**Step 5: Run check, lint, fmt**

```bash
cd twitch && deno task check && deno task lint && deno task fmt
```

**Step 6: Commit**

```bash
git add twitch/extensions/models/twitch/mod.ts twitch/extensions/models/twitch/mod_test.ts
git commit -m "feat(twitch): add @webframp/twitch model with 7 methods"
```

---

## Task 4: Workflow (`twitch-mod-audit.yaml`)

Create the cross-channel moderation audit workflow.

**Files:**
- Create: `twitch/workflows/twitch-mod-audit.yaml`

**Step 1: Create the workflow using swamp CLI**

```bash
cd twitch && swamp workflow create "@webframp/twitch-mod-audit"
```

This creates a workflow YAML file in the `workflows/` directory. Note the generated filename (contains a UUID).

**Step 2: Edit the generated workflow YAML**

Replace the generated content with:

```yaml
id: <keep-the-generated-uuid>
name: "@webframp/twitch-mod-audit"
description: |
  Cross-channel Twitch moderation audit. Gathers chatters, bans, and channel
  info from all channel instances in parallel, then flags suspicious users
  (new accounts, cross-channel ban overlap, multi-channel presence).
tags:
  twitch: "true"
  moderation: "true"
reports:
  require:
    - "@webframp/twitch-mod-report"
inputs:
  properties:
    suspiciousAgeDays:
      type: number
      default: 7
      description: Flag accounts younger than this many days
  required: []
jobs:
  - name: gather-channel-data
    description: Collect chatters, bans, and channel info from each channel instance
    steps:
      - name: get-chatters
        description: Get current chatters in the channel
        task:
          type: model_method
          modelIdOrName: "*"
          methodName: get_chatters
        allowFailure: true

      - name: get-banned-users
        description: Get current bans and timeouts
        task:
          type: model_method
          modelIdOrName: "*"
          methodName: get_banned_users
        allowFailure: true

      - name: get-channel-info
        description: Get channel metadata (title, game, tags)
        task:
          type: model_method
          modelIdOrName: "*"
          methodName: get_channel
        allowFailure: true

      - name: get-mod-events
        description: Get recent moderation actions
        task:
          type: model_method
          modelIdOrName: "*"
          methodName: get_mod_events
        allowFailure: true

version: 1
```

> **Note on `modelIdOrName: "*"`**: This is a placeholder. The actual workflow
> will need one step per channel model instance, or the workflow runner will
> need to fan out across instances of the `@webframp/twitch` model type.
> Check `swamp workflow edit` after creation to see how multi-instance fan-out
> works. If the runner does not support wildcards, list model instances
> explicitly (e.g., `mod-drongo`, `mod-channel2`). The workflow can be edited
> later once model instances are created.

**Step 3: Update `manifest.yaml` with the workflow filename**

The workflow filename contains a UUID generated by `swamp workflow create`. Update the `workflows:` section in `manifest.yaml` to reference the actual filename.

**Step 4: Validate the workflow**

```bash
cd twitch && swamp workflow list
```

Expected: Shows the `@webframp/twitch-mod-audit` workflow.

**Step 5: Commit**

```bash
git add twitch/workflows/ twitch/manifest.yaml
git commit -m "feat(twitch): add twitch-mod-audit workflow"
```

---

## Task 5: Report (`mod_report.ts`)

Build the cross-channel moderation report with 4 sections: Channel Overview, Suspicious Users, Ban Overlap, Recent Moderation Activity.

**Files:**
- Create: `twitch/extensions/reports/mod_report.ts`
- Test: `twitch/extensions/reports/mod_report_test.ts`

**Step 1: Write the failing report tests**

Follow the `aws/ops/extensions/reports/incident_report_test.ts` pattern exactly: create temp dirs, write step data to `.swamp/data/` paths, build a context with `stepExecutions`, call `report.execute(context)`.

```typescript
// Twitch Moderation Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./mod_report.ts";

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
}

async function writeStepData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir =
    `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function makeStep(
  modelName: string,
  modelType: string,
  modelId: string,
  methodName: string,
  dataName: string,
  version: number = 1,
): StepExecution {
  return {
    jobName: "gather-channel-data",
    stepName: `${modelName}-${methodName}`,
    modelName,
    modelType,
    modelId,
    methodName,
    status: "completed",
    dataHandles: [{ name: dataName, dataId: `data-${dataName}`, version }],
  };
}

function makeContext(tmpDir: string, stepExecutions: StepExecution[] = []) {
  return {
    workflowId: "wf-test",
    workflowRunId: "run-test",
    workflowName: "@webframp/twitch-mod-audit",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

Deno.test({
  name: "report structure has correct name, scope, and labels",
  fn() {
    assertEquals(report.name, "@webframp/twitch-mod-report");
    assertEquals(report.scope, "workflow");
    assertStringIncludes(report.labels.join(","), "twitch");
    assertStringIncludes(report.labels.join(","), "moderation");
  },
});

Deno.test({
  name: "report with no step data returns markdown with empty sections",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = makeContext(tmpDir, []);
      const result = await report.execute(context);

      assertEquals(typeof result.markdown, "string");
      assertEquals(typeof result.json, "object");
      assertStringIncludes(result.markdown, "Channel Overview");
      assertStringIncludes(result.markdown, "No channel data available");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with channel data shows channel overview table",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/twitch";

      await writeStepData(tmpDir, modelType, "mod-drongo", "chatters", 1, {
        channel: "drongo",
        chatters: [
          { userId: "1", login: "alice", displayName: "Alice" },
          { userId: "2", login: "bob", displayName: "Bob" },
        ],
        count: 2,
        fetchedAt: "2026-04-22T00:00:00Z",
      });
      await writeStepData(tmpDir, modelType, "mod-drongo", "banned-users", 1, {
        channel: "drongo",
        bans: [{ userId: "99", login: "spammer", reason: "spam",
          moderatorLogin: "drongo", createdAt: "2026-04-21T00:00:00Z",
          expiresAt: null }],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      });
      await writeStepData(tmpDir, modelType, "mod-drongo", "channel", 1, {
        broadcasterId: "99999",
        broadcasterLogin: "drongo",
        broadcasterName: "Drongo",
        gameName: "Dota 2",
        gameId: "29595",
        title: "Ranked grind",
        tags: ["English"],
        fetchedAt: "2026-04-22T00:00:00Z",
      });

      const steps = [
        makeStep("mod-drongo", modelType, "mod-drongo", "get_chatters", "chatters"),
        makeStep("mod-drongo", modelType, "mod-drongo", "get_banned_users", "banned-users"),
        makeStep("mod-drongo", modelType, "mod-drongo", "get_channel", "channel"),
      ];

      const result = await report.execute(makeContext(tmpDir, steps));

      assertStringIncludes(result.markdown, "drongo");
      assertStringIncludes(result.markdown, "Dota 2");
      assertStringIncludes(result.markdown, "Ranked grind");

      const json = result.json as { channels: Array<{ channel: string }> };
      assertEquals(json.channels.length, 1);
      assertEquals(json.channels[0].channel, "drongo");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report detects ban overlap across channels",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/twitch";

      // Same user banned in two channels
      await writeStepData(tmpDir, modelType, "mod-ch1", "banned-users", 1, {
        channel: "channel1",
        bans: [{ userId: "789", login: "serial_offender", reason: "toxic",
          moderatorLogin: "mod1", createdAt: "2026-04-20T00:00:00Z",
          expiresAt: null }],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      });
      await writeStepData(tmpDir, modelType, "mod-ch2", "banned-users", 1, {
        channel: "channel2",
        bans: [{ userId: "789", login: "serial_offender", reason: "harassment",
          moderatorLogin: "mod2", createdAt: "2026-04-21T00:00:00Z",
          expiresAt: null }],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      });

      const steps = [
        makeStep("mod-ch1", modelType, "mod-ch1", "get_banned_users", "banned-users"),
        makeStep("mod-ch2", modelType, "mod-ch2", "get_banned_users", "banned-users"),
      ];

      const result = await report.execute(makeContext(tmpDir, steps));

      assertStringIncludes(result.markdown, "Ban Overlap");
      assertStringIncludes(result.markdown, "serial_offender");

      const json = result.json as {
        banOverlap: Array<{ login: string; channels: string[] }>;
      };
      assertEquals(json.banOverlap.length, 1);
      assertEquals(json.banOverlap[0].login, "serial_offender");
      assertEquals(json.banOverlap[0].channels.length, 2);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report flags user present in chat but banned on another channel",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/twitch";

      // User is chatting in channel1
      await writeStepData(tmpDir, modelType, "mod-ch1", "chatters", 1, {
        channel: "channel1",
        chatters: [{ userId: "789", login: "sneaky", displayName: "Sneaky" }],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      });
      // But banned in channel2
      await writeStepData(tmpDir, modelType, "mod-ch2", "banned-users", 1, {
        channel: "channel2",
        bans: [{ userId: "789", login: "sneaky", reason: "evading",
          moderatorLogin: "mod2", createdAt: "2026-04-20T00:00:00Z",
          expiresAt: null }],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      });

      const steps = [
        makeStep("mod-ch1", modelType, "mod-ch1", "get_chatters", "chatters"),
        makeStep("mod-ch2", modelType, "mod-ch2", "get_banned_users", "banned-users"),
      ];

      const result = await report.execute(makeContext(tmpDir, steps));

      assertStringIncludes(result.markdown, "Suspicious Users");
      assertStringIncludes(result.markdown, "sneaky");

      const json = result.json as {
        suspiciousUsers: Array<{ login: string; reasons: string[] }>;
      };
      const sneaky = json.suspiciousUsers.find((u) => u.login === "sneaky");
      assertEquals(sneaky !== undefined, true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report shows recent moderation activity timeline",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/twitch";

      await writeStepData(tmpDir, modelType, "mod-drongo", "mod-events", 1, {
        channel: "drongo",
        events: [{
          eventType: "moderation.user.ban",
          eventTimestamp: "2026-04-22T01:00:00Z",
          userId: "789",
          userLogin: "bad_user",
          moderatorLogin: "drongo_mod",
        }],
        count: 1,
        fetchedAt: "2026-04-22T02:00:00Z",
      });

      const steps = [
        makeStep("mod-drongo", modelType, "mod-drongo", "get_mod_events", "mod-events"),
      ];

      const result = await report.execute(makeContext(tmpDir, steps));

      assertStringIncludes(result.markdown, "Recent Moderation Activity");
      assertStringIncludes(result.markdown, "bad_user");
      assertStringIncludes(result.markdown, "moderation.user.ban");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd twitch && deno task test
```

Expected: FAIL — `mod_report.ts` does not exist.

**Step 3: Implement `mod_report.ts`**

Follow the incident report pattern: read data from `.swamp/data/` paths, build markdown and JSON output. The report aggregates data across channel instances.

```typescript
// Twitch Moderation Cross-Channel Report
// SPDX-License-Identifier: Apache-2.0

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
}

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
}

interface DataLocation {
  modelType: string;
  modelId: string;
  dataName: string;
  version: number;
}

// Data shape interfaces
interface ChatterData {
  channel: string;
  chatters: Array<{ userId: string; login: string; displayName: string }>;
  count: number;
  fetchedAt: string;
}

interface BanData {
  channel: string;
  bans: Array<{
    userId: string;
    login: string;
    reason: string;
    moderatorLogin: string;
    createdAt: string;
    expiresAt: string | null;
  }>;
  count: number;
  fetchedAt: string;
}

interface ChannelData {
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  gameName: string;
  gameId: string;
  title: string;
  tags: string[];
  fetchedAt: string;
}

interface ModEventData {
  channel: string;
  events: Array<{
    eventType: string;
    eventTimestamp: string;
    userId: string;
    userLogin: string;
    moderatorLogin: string;
  }>;
  count: number;
  fetchedAt: string;
}

function escMd(val: string): string {
  return val.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export const report = {
  name: "@webframp/twitch-mod-report",
  description:
    "Cross-channel moderation report: channel overview, suspicious users, ban overlap, and recent mod activity.",
  scope: "workflow" as const,
  labels: ["twitch", "moderation", "audit"],

  execute: async (context: WorkflowReportContext) => {
    const findings: string[] = [];
    const jsonFindings: Record<string, unknown> = {
      workflowName: context.workflowName,
      workflowStatus: context.workflowStatus,
      timestamp: new Date().toISOString(),
      channels: [],
      suspiciousUsers: [],
      banOverlap: [],
      modEvents: [],
    };

    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    function findAllStepData(methodName: string): DataLocation[] {
      const locations: DataLocation[] = [];
      for (const step of context.stepExecutions) {
        if (step.methodName === methodName) {
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              locations.push({
                modelType: step.modelType,
                modelId: step.modelId,
                dataName: handle.name,
                version: handle.version,
              });
            }
          }
        }
      }
      return locations;
    }

    // Collect all data per channel
    const allChatters: ChatterData[] = [];
    const allBans: BanData[] = [];
    const allChannels: ChannelData[] = [];
    const allModEvents: ModEventData[] = [];

    for (const loc of findAllStepData("get_chatters")) {
      const data = await getData(loc.modelType, loc.modelId, loc.dataName, loc.version);
      if (data) allChatters.push(data as unknown as ChatterData);
    }
    for (const loc of findAllStepData("get_banned_users")) {
      const data = await getData(loc.modelType, loc.modelId, loc.dataName, loc.version);
      if (data) allBans.push(data as unknown as BanData);
    }
    for (const loc of findAllStepData("get_channel")) {
      const data = await getData(loc.modelType, loc.modelId, loc.dataName, loc.version);
      if (data) allChannels.push(data as unknown as ChannelData);
    }
    for (const loc of findAllStepData("get_mod_events")) {
      const data = await getData(loc.modelType, loc.modelId, loc.dataName, loc.version);
      if (data) allModEvents.push(data as unknown as ModEventData);
    }

    // =========================================================================
    // Section 1: Channel Overview
    // =========================================================================
    findings.push("## Channel Overview\n");

    if (allChannels.length === 0 && allChatters.length === 0) {
      findings.push("No channel data available.\n");
    } else {
      findings.push("| Channel | Title | Game | Chatters | Bans |");
      findings.push("|---------|-------|------|----------|------|");

      // Build a merged view from whatever data we have
      const channelNames = new Set<string>();
      for (const ch of allChannels) channelNames.add(ch.broadcasterLogin);
      for (const ch of allChatters) channelNames.add(ch.channel);
      for (const b of allBans) channelNames.add(b.channel);

      const channelJsonList: Array<Record<string, unknown>> = [];

      for (const name of channelNames) {
        const ch = allChannels.find((c) => c.broadcasterLogin === name);
        const chatters = allChatters.find((c) => c.channel === name);
        const bans = allBans.find((b) => b.channel === name);

        const title = ch ? escMd(ch.title) : "—";
        const game = ch ? escMd(ch.gameName) : "—";
        const chatterCount = chatters ? chatters.count : "—";
        const banCount = bans ? bans.count : "—";

        findings.push(
          `| ${escMd(name)} | ${title} | ${game} | ${chatterCount} | ${banCount} |`,
        );

        channelJsonList.push({
          channel: name,
          title: ch?.title ?? null,
          game: ch?.gameName ?? null,
          chatterCount: chatters?.count ?? 0,
          banCount: bans?.count ?? 0,
        });
      }

      (jsonFindings.channels as unknown[]) = channelJsonList;
      findings.push("");
    }

    // =========================================================================
    // Section 2: Suspicious Users
    // =========================================================================
    findings.push("## Suspicious Users\n");

    // Build sets for cross-referencing
    const chattingUsers = new Map<string, Set<string>>(); // userId -> channels
    const bannedUsers = new Map<string, Set<string>>();    // userId -> channels
    const userLogins = new Map<string, string>();          // userId -> login

    for (const ch of allChatters) {
      for (const c of ch.chatters) {
        if (!chattingUsers.has(c.userId)) chattingUsers.set(c.userId, new Set());
        chattingUsers.get(c.userId)!.add(ch.channel);
        userLogins.set(c.userId, c.login);
      }
    }
    for (const b of allBans) {
      for (const ban of b.bans) {
        if (!bannedUsers.has(ban.userId)) bannedUsers.set(ban.userId, new Set());
        bannedUsers.get(ban.userId)!.add(b.channel);
        userLogins.set(ban.userId, ban.login);
      }
    }

    const suspiciousUsers: Array<{
      userId: string;
      login: string;
      reasons: string[];
      chattingIn: string[];
      bannedIn: string[];
    }> = [];

    // Flag: chatting in one channel but banned in another
    for (const [userId, chatChannels] of chattingUsers) {
      const banChannels = bannedUsers.get(userId);
      if (!banChannels) continue;

      const chatNotBanned = [...chatChannels].filter((c) => !banChannels.has(c));
      if (chatNotBanned.length > 0) {
        suspiciousUsers.push({
          userId,
          login: userLogins.get(userId) ?? userId,
          reasons: [
            `Chatting in ${chatNotBanned.join(", ")} but banned in ${[...banChannels].join(", ")}`,
          ],
          chattingIn: [...chatChannels],
          bannedIn: [...banChannels],
        });
      }
    }

    // Flag: present in multiple channels simultaneously
    for (const [userId, channels] of chattingUsers) {
      if (channels.size < 2) continue;
      const existing = suspiciousUsers.find((u) => u.userId === userId);
      const reason = `Present in ${channels.size} channels simultaneously: ${[...channels].join(", ")}`;
      if (existing) {
        existing.reasons.push(reason);
      } else {
        suspiciousUsers.push({
          userId,
          login: userLogins.get(userId) ?? userId,
          reasons: [reason],
          chattingIn: [...channels],
          bannedIn: [...(bannedUsers.get(userId) ?? [])],
        });
      }
    }

    if (suspiciousUsers.length === 0) {
      findings.push("No suspicious users detected.\n");
    } else {
      findings.push("| User | Reasons | Chatting In | Banned In |");
      findings.push("|------|---------|-------------|-----------|");
      for (const u of suspiciousUsers) {
        findings.push(
          `| ${escMd(u.login)} | ${escMd(u.reasons.join("; "))} | ${escMd(u.chattingIn.join(", "))} | ${escMd(u.bannedIn.join(", ") || "—")} |`,
        );
      }
      findings.push("");
    }
    (jsonFindings.suspiciousUsers as unknown[]) = suspiciousUsers;

    // =========================================================================
    // Section 3: Ban Overlap
    // =========================================================================
    findings.push("## Ban Overlap\n");

    const banOverlap: Array<{
      userId: string;
      login: string;
      channels: string[];
      reasons: Record<string, string>;
    }> = [];

    for (const [userId, channels] of bannedUsers) {
      if (channels.size < 2) continue;
      const reasons: Record<string, string> = {};
      for (const b of allBans) {
        const ban = b.bans.find((x) => x.userId === userId);
        if (ban) reasons[b.channel] = ban.reason;
      }
      banOverlap.push({
        userId,
        login: userLogins.get(userId) ?? userId,
        channels: [...channels],
        reasons,
      });
    }

    if (banOverlap.length === 0) {
      findings.push("No users banned across multiple channels.\n");
    } else {
      findings.push(
        `**${banOverlap.length} user(s)** banned across 2+ channels:\n`,
      );
      findings.push("| User | Channels | Reasons |");
      findings.push("|------|----------|---------|");
      for (const u of banOverlap) {
        const reasonStr = Object.entries(u.reasons)
          .map(([ch, r]) => `${ch}: ${r || "no reason"}`)
          .join("; ");
        findings.push(
          `| ${escMd(u.login)} | ${escMd(u.channels.join(", "))} | ${escMd(reasonStr)} |`,
        );
      }
      findings.push("");
    }
    (jsonFindings.banOverlap as unknown[]) = banOverlap;

    // =========================================================================
    // Section 4: Recent Moderation Activity
    // =========================================================================
    findings.push("## Recent Moderation Activity\n");

    if (allModEvents.length === 0) {
      findings.push("No moderation event data available.\n");
    } else {
      // Flatten and sort all events by timestamp
      const flatEvents: Array<{
        channel: string;
        eventType: string;
        eventTimestamp: string;
        userLogin: string;
        moderatorLogin: string;
      }> = [];
      for (const me of allModEvents) {
        for (const e of me.events) {
          flatEvents.push({ channel: me.channel, ...e });
        }
      }
      flatEvents.sort((a, b) =>
        b.eventTimestamp.localeCompare(a.eventTimestamp)
      );

      findings.push("| Time | Channel | Action | User | Moderator |");
      findings.push("|------|---------|--------|------|-----------|");
      for (const e of flatEvents.slice(0, 50)) {
        findings.push(
          `| ${escMd(e.eventTimestamp)} | ${escMd(e.channel)} | ${escMd(e.eventType)} | ${escMd(e.userLogin)} | ${escMd(e.moderatorLogin)} |`,
        );
      }
      if (flatEvents.length > 50) {
        findings.push(`\n*Showing 50 of ${flatEvents.length} events.*\n`);
      }
      findings.push("");
    }
    (jsonFindings.modEvents as unknown[]) = allModEvents;

    // =========================================================================
    // Assemble final output
    // =========================================================================
    const header =
      `# Twitch Moderation Audit: ${context.workflowName}\n\n` +
      `*Status: ${context.workflowStatus} | Generated: ${new Date().toISOString()}*\n\n`;

    return {
      markdown: header + findings.join("\n"),
      json: jsonFindings,
    };
  },
};
```

**Step 4: Run tests to verify they pass**

```bash
cd twitch && deno task test
```

Expected: All report tests PASS.

**Step 5: Run check, lint, fmt**

```bash
cd twitch && deno task check && deno task lint && deno task fmt
```

**Step 6: Commit**

```bash
git add twitch/extensions/reports/
git commit -m "feat(twitch): add cross-channel moderation report"
```

---

## Task 6: CI Matrix Entry + Final Validation

Add the twitch extension to the CI workflow matrix and do a final validation pass.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add twitch to the model-check matrix**

In the `model-check` job's `matrix.extension` list, add:

```yaml
- { dir: twitch, models: twitch }
```

**Step 2: Add twitch-test job**

After the existing `*-test` jobs, add:

```yaml
  twitch-test:
    name: twitch - test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: twitch
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: deno test
        run: deno test --allow-env --allow-net --allow-read --allow-write --allow-sys extensions/
```

> Note: `--allow-read --allow-write --allow-sys` needed for the report tests that create temp dirs and read `.swamp/data/` paths.

**Step 3: Run full local validation from the twitch directory**

```bash
cd twitch && deno task check && deno task lint && deno fmt --check extensions/ && deno task test
```

Expected: All checks pass, all tests pass.

**Step 4: Verify extension can be dry-run pushed**

```bash
cd twitch && swamp extension push manifest.yaml --dry-run
```

Expected: Build succeeds, archive is created but not uploaded.

**Step 5: Commit CI changes**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add twitch extension to test matrix"
```

**Step 6: Update README**

Add twitch to the extension list in the root `README.md`, following the existing format for other extensions.

```bash
git add README.md
git commit -m "docs: add twitch extension to README"
```
