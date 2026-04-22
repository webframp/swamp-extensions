// Twitch Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  channel: "testchannel",
  moderatorId: "mod-999",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
};

const DEFINITION = {
  id: "test-id",
  name: "test-twitch",
  version: 1,
  tags: {},
};

const BROADCASTER_ID = "12345";

/** Canned user lookup response used by most methods to resolve broadcaster ID */
const USERS_RESPONSE = {
  data: [
    {
      id: BROADCASTER_ID,
      login: "testchannel",
      display_name: "TestChannel",
      created_at: "2020-01-15T08:00:00Z",
      profile_image_url: "https://example.com/avatar.png",
      broadcaster_type: "affiliate",
    },
  ],
};

/**
 * Start a mock Helix server that dispatches on URL path patterns.
 * Routes is a map from path substring to response body.
 * The server wraps responses in the Twitch Helix envelope.
 */
function startMockHelixServer(
  routes: Record<string, (req: Request, url: URL) => unknown>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    for (const [pattern, handler] of Object.entries(routes)) {
      if (path.includes(pattern)) {
        const body = handler(req, url);
        return Response.json(body);
      }
    }

    return Response.json({ data: [], pagination: {} }, { status: 404 });
  });

  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

/** Install fetch mock that redirects Twitch Helix API calls to local server */
function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof Request
      ? input.url
      : input.toString();
    const newUrl = reqUrl.replace(
      "https://api.twitch.tv/helix",
      mockUrl,
    );
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Model Structure Tests
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

Deno.test("twitch model: has all 7 methods and required resources", () => {
  assertExists(model.methods);
  assertExists(model.methods.get_channel);
  assertExists(model.methods.get_chatters);
  assertExists(model.methods.get_user);
  assertExists(model.methods.get_banned_users);
  assertExists(model.methods.ban_user);
  assertExists(model.methods.unban_user);
  assertExists(model.methods.get_mod_events);

  assertExists(model.resources);
  assertExists(model.resources.channel);
  assertExists(model.resources.chatters);
  assertExists(model.resources.user);
  assertExists(model.resources["banned-users"]);
  assertExists(model.resources["ban-result"]);
  assertExists(model.resources["mod-events"]);
});

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "twitch model: get_channel resolves broadcaster and writes channel resource",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/channels": () => ({
        data: [
          {
            broadcaster_id: BROADCASTER_ID,
            broadcaster_login: "testchannel",
            broadcaster_name: "TestChannel",
            game_name: "Just Chatting",
            game_id: "509658",
            title: "Hello World",
            tags: ["English"],
          },
        ],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
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
      assertEquals(resources[0].name, "testchannel");

      const data = resources[0].data as {
        broadcasterId: string;
        broadcasterLogin: string;
        gameName: string;
        title: string;
      };
      assertEquals(data.broadcasterId, BROADCASTER_ID);
      assertEquals(data.broadcasterLogin, "testchannel");
      assertEquals(data.gameName, "Just Chatting");
      assertEquals(data.title, "Hello World");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_chatters paginates and writes chatters resource",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/chat/chatters": () => ({
        data: [
          { user_id: "u1", user_login: "alice", user_name: "Alice" },
          { user_id: "u2", user_login: "bob", user_name: "Bob" },
        ],
        pagination: {},
        total: 2,
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.get_chatters.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_chatters.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "chatters");

      const data = resources[0].data as {
        chatters: { userId: string; login: string }[];
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.chatters[0].login, "alice");
      assertEquals(data.chatters[1].login, "bob");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_user fetches user and computes account age",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { url, server } = startMockHelixServer({
      "/users": () => ({
        data: [
          {
            id: "u-lookup",
            login: "someuser",
            display_name: "SomeUser",
            created_at: threeDaysAgo,
            profile_image_url: "https://example.com/pic.png",
            broadcaster_type: "",
          },
        ],
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.get_user.execute(
        { login: "someuser" },
        context as unknown as Parameters<
          typeof model.methods.get_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "user");
      assertEquals(resources[0].name, "someuser");

      const data = resources[0].data as {
        userId: string;
        login: string;
        accountAgeDays: number;
      };
      assertEquals(data.userId, "u-lookup");
      assertEquals(data.login, "someuser");
      // Account created 3 days ago — allow some tolerance
      assertEquals(data.accountAgeDays >= 2, true);
      assertEquals(data.accountAgeDays <= 4, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_banned_users fetches bans and normalizes expiresAt",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/moderation/banned": () => ({
        data: [
          {
            user_id: "banned-1",
            user_login: "badactor",
            reason: "spam",
            moderator_login: "testchannel",
            created_at: "2025-01-01T00:00:00Z",
            expires_at: "",
          },
          {
            user_id: "banned-2",
            user_login: "timeout_user",
            reason: "language",
            moderator_login: "testchannel",
            created_at: "2025-01-02T00:00:00Z",
            expires_at: "2025-01-03T00:00:00Z",
          },
        ],
        pagination: {},
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.get_banned_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_banned_users.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "banned-users");

      const data = resources[0].data as {
        bans: {
          userId: string;
          login: string;
          reason: string;
          expiresAt: string | null;
        }[];
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.bans[0].login, "badactor");
      assertEquals(data.bans[0].expiresAt, null); // empty string -> null
      assertEquals(data.bans[1].expiresAt, "2025-01-03T00:00:00Z");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: ban_user posts ban and writes ban-result resource",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/moderation/bans": () => {
        return {
          data: [
            {
              broadcaster_id: BROADCASTER_ID,
              moderator_id: "mod-999",
              user_id: "target-user",
              created_at: "2025-06-01T00:00:00Z",
              end_time: "",
            },
          ],
        };
      },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.ban_user.execute(
        { userId: "target-user", reason: "test ban" },
        context as unknown as Parameters<
          typeof model.methods.ban_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "ban-result");

      const data = resources[0].data as {
        action: string;
        userId: string;
      };
      assertEquals(data.action, "ban");
      assertEquals(data.userId, "target-user");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: unban_user sends delete and writes ban-result resource",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/moderation/bans": (req) => {
        if (req.method === "DELETE") {
          return { data: [] };
        }
        return { data: [] };
      },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.unban_user.execute(
        { userId: "target-user" },
        context as unknown as Parameters<
          typeof model.methods.unban_user.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "ban-result");

      const data = resources[0].data as {
        action: string;
        userId: string;
      };
      assertEquals(data.action, "unban");
      assertEquals(data.userId, "target-user");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "twitch model: get_mod_events fetches and maps moderation events",
  sanitizeResources: false, // Deno.serve may hold resources briefly after shutdown
  fn: async () => {
    const { url, server } = startMockHelixServer({
      "/users": () => USERS_RESPONSE,
      "/moderation/moderators/events": () => ({
        data: [
          {
            event_type: "moderation.moderator.add",
            event_timestamp: "2025-03-01T00:00:00Z",
            event_data: {
              user_id: "newmod-1",
              user_login: "newmod",
              broadcaster_login: "testchannel",
            },
          },
        ],
        pagination: {},
      }),
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GLOBAL_ARGS,
        definition: DEFINITION,
      });

      const result = await model.methods.get_mod_events.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_mod_events.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "mod-events");

      const data = resources[0].data as {
        events: {
          eventType: string;
          userId: string;
          userLogin: string;
        }[];
        count: number;
      };
      assertEquals(data.count, 1);
      assertEquals(data.events[0].eventType, "moderation.moderator.add");
      assertEquals(data.events[0].userLogin, "newmod");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
