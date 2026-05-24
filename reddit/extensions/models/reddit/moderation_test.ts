// Reddit Moderation Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./moderation.ts";

// =============================================================================
// Structural Tests (no HTTP)
// =============================================================================

Deno.test("moderation model: has correct type", () => {
  assertEquals(model.type, "@webframp/reddit/moderation");
});

Deno.test("moderation model: has correct version", () => {
  assertEquals(model.version, "2026.05.24.1");
});

Deno.test("moderation model: globalArguments schema has all 6 fields", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.subreddit);
  assertExists(shape.clientId);
  assertExists(shape.clientSecret);
  assertExists(shape.username);
  assertExists(shape.password);
  assertExists(shape.userAgent);
});

Deno.test("moderation model: has all 7 resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.modqueue);
  assertExists(model.resources.reports);
  assertExists(model.resources.modlog);
  assertExists(model.resources.comments);
  assertExists(model.resources.posts);
  assertExists(model.resources.user_info);
  assertExists(model.resources.action);
});

Deno.test("moderation model: has all 11 methods with execute functions", () => {
  assertExists(model.methods);
  assertExists(model.methods.get_modqueue);
  assertExists(model.methods.get_modqueue.arguments);
  assertExists(model.methods.get_modqueue.execute);
  assertExists(model.methods.get_reports);
  assertExists(model.methods.get_reports.arguments);
  assertExists(model.methods.get_reports.execute);
  assertExists(model.methods.get_modlog);
  assertExists(model.methods.get_modlog.arguments);
  assertExists(model.methods.get_modlog.execute);
  assertExists(model.methods.list_comments);
  assertExists(model.methods.list_comments.arguments);
  assertExists(model.methods.list_comments.execute);
  assertExists(model.methods.list_posts);
  assertExists(model.methods.list_posts.arguments);
  assertExists(model.methods.list_posts.execute);
  assertExists(model.methods.get_user_info);
  assertExists(model.methods.get_user_info.arguments);
  assertExists(model.methods.get_user_info.execute);
  assertExists(model.methods.approve);
  assertExists(model.methods.approve.arguments);
  assertExists(model.methods.approve.execute);
  assertExists(model.methods.remove);
  assertExists(model.methods.remove.arguments);
  assertExists(model.methods.remove.execute);
  assertExists(model.methods.ban_user);
  assertExists(model.methods.ban_user.arguments);
  assertExists(model.methods.ban_user.execute);
  assertExists(model.methods.send_modmail);
  assertExists(model.methods.send_modmail.arguments);
  assertExists(model.methods.send_modmail.execute);
  assertExists(model.methods.flair_post);
  assertExists(model.methods.flair_post.arguments);
  assertExists(model.methods.flair_post.execute);
});

Deno.test("moderation model: globalArguments schema parses valid input", () => {
  const result = model.globalArguments.safeParse({
    subreddit: "testsubreddit",
    clientId: "abc123",
    clientSecret: "secret",
    username: "bot",
    password: "pass",
    userAgent: "swamp:test:v1.0",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// Mock Reddit API Server Helpers
// =============================================================================

const DEFAULT_GLOBAL_ARGS = {
  subreddit: "testsubreddit",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  username: "test-bot",
  password: "test-password",
  userAgent: "swamp:test:v1.0",
};

interface MockServerOptions {
  handler: (req: Request) => Response | Promise<Response>;
}

function startMockRedditServer(
  opts: MockServerOptions,
): Deno.HttpServer {
  return Deno.serve({ port: 0, onListen() {} }, opts.handler);
}

function tokenResponse(): Response {
  return Response.json({
    access_token: "mock-token",
    token_type: "bearer",
    expires_in: 3600,
    scope: "read",
  });
}

function installFetchMock(mockBase: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : (input instanceof Request ? input.url : input.toString());
    const rewritten = reqUrl
      .replace("https://oauth.reddit.com", mockBase)
      .replace("https://www.reddit.com", mockBase);
    return originalFetch(rewritten, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// =============================================================================
// Mock API Tests
// =============================================================================

Deno.test({
  name: "moderation model: get_modqueue fetches and writes resource",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/about/modqueue")) {
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: "abc123",
                    name: "t3_abc123",
                    kind: "link",
                    title: "Test Post",
                    author: "testuser",
                    subreddit: "testsubreddit",
                    created_utc: 1700000000,
                    permalink: "/r/test/abc123",
                    num_reports: 1,
                    mod_reports: [],
                    user_reports: [["spam", 1]],
                  },
                },
              ],
              after: null,
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.get_modqueue.execute(
        { type: "all", limit: 25 },
        context as unknown as Parameters<
          typeof model.methods.get_modqueue.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "modqueue");
      assertEquals(resources[0].name, "modqueue-all");
      const data = resources[0].data as {
        items: unknown[];
        truncated: boolean;
      };
      assertEquals(data.items.length, 1);
      assertEquals(data.truncated, false);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: get_reports fetches and writes resource",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/about/reports")) {
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: "rpt001",
                    name: "t3_rpt001",
                    kind: "link",
                    title: "Reported Post",
                    author: "baduser",
                    subreddit: "testsubreddit",
                    created_utc: 1700000001,
                    permalink: "/r/test/rpt001",
                    num_reports: 3,
                    mod_reports: [["Rule 1", "automod"]],
                    user_reports: [["spam", 2]],
                  },
                },
              ],
              after: null,
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.get_reports.execute(
        { limit: 25 },
        context as unknown as Parameters<
          typeof model.methods.get_reports.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "reports");
      assertEquals(resources[0].name, "reports-latest");
      const data = resources[0].data as {
        items: unknown[];
        truncated: boolean;
      };
      assertEquals(data.items.length, 1);
      assertEquals(data.truncated, false);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: get_modlog fetches with action filter",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedUrl = "";
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/about/log")) {
          capturedUrl = url.toString();
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: "log001",
                    action: "removecomment",
                    mod: "moduser",
                    target_fullname: "t1_xyz",
                    target_author: "spammer",
                    target_permalink: "/r/test/comments/abc/xyz",
                    details: "spam",
                    description: null,
                    created_utc: 1700000002,
                  },
                },
              ],
              after: null,
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.get_modlog.execute(
        { action: "removecomment", limit: 25 },
        context as unknown as Parameters<
          typeof model.methods.get_modlog.execute
        >[1],
      );

      // Verify the action filter is passed as 'type' query parameter
      assertEquals(capturedUrl.includes("type=removecomment"), true);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "modlog");
      assertEquals(resources[0].name, "modlog-removecomment-all");
      const data = resources[0].data as {
        items: unknown[];
        truncated: boolean;
      };
      assertEquals(data.items.length, 1);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: list_comments uses sort param",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedUrl = "";
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/comments")) {
          capturedUrl = url.toString();
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: "com001",
                    name: "t1_com001",
                    body: "Great post!",
                    author: "commenter",
                    subreddit: "testsubreddit",
                    created_utc: 1700000003,
                    permalink: "/r/test/comments/abc/com001",
                    score: 5,
                    parent_id: "t3_abc",
                    link_id: "t3_abc",
                    is_submitter: false,
                    edited: false,
                  },
                },
              ],
              after: null,
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.list_comments.execute(
        { sort: "hot", limit: 25 },
        context as unknown as Parameters<
          typeof model.methods.list_comments.execute
        >[1],
      );

      // Verify the sort parameter is included in the request
      assertEquals(capturedUrl.includes("sort=hot"), true);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "comments");
      assertEquals(resources[0].name, "comments-hot");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: list_posts uses sort-based URL path",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedPathname = "";
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/testsubreddit/")) {
          capturedPathname = url.pathname;
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: "post001",
                    name: "t3_post001",
                    title: "Hot Post",
                    selftext: "Content here",
                    author: "poster",
                    subreddit: "testsubreddit",
                    created_utc: 1700000004,
                    permalink: "/r/test/post001",
                    score: 100,
                    num_comments: 10,
                    url: "https://reddit.com/r/test/post001",
                    is_self: true,
                    over_18: false,
                    spoiler: false,
                    locked: false,
                    stickied: false,
                  },
                },
              ],
              after: null,
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.list_posts.execute(
        { sort: "rising", limit: 25 },
        context as unknown as Parameters<
          typeof model.methods.list_posts.execute
        >[1],
      );

      // Verify the sort determines the URL path: /r/{subreddit}/{sort}
      assertEquals(capturedPathname, "/r/testsubreddit/rising");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "posts");
      assertEquals(resources[0].name, "posts-rising");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: get_user_info fetches user about",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedPathname = "";
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (
          url.pathname.includes("/user/") && url.pathname.includes("/about")
        ) {
          capturedPathname = url.pathname;
          return Response.json({
            data: {
              id: "user123",
              name: "targetuser",
              created_utc: 1600000000,
              link_karma: 1000,
              comment_karma: 5000,
              is_suspended: false,
              is_mod: true,
              has_verified_email: true,
              icon_img: "https://reddit.com/avatar.png",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.get_user_info.execute(
        { username: "targetuser" },
        context as unknown as Parameters<
          typeof model.methods.get_user_info.execute
        >[1],
      );

      // Verify the correct URL path was called
      assertEquals(capturedPathname, "/user/targetuser/about");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "user_info");
      assertEquals(resources[0].name, "user-targetuser");
      const data = resources[0].data as { name: string; is_mod: boolean };
      assertEquals(data.name, "targetuser");
      assertEquals(data.is_mod, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// Action Method Tests
// =============================================================================

Deno.test({
  name: "moderation model: approve posts to /api/approve with correct body",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedMethod = "";
    let capturedPath = "";
    let capturedBody = "";
    const server = startMockRedditServer({
      handler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname === "/api/approve") {
          capturedMethod = req.method;
          capturedPath = url.pathname;
          capturedBody = await req.text();
          return Response.json({});
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.approve.execute(
        { thingId: "t3_abc123" },
        context as unknown as Parameters<
          typeof model.methods.approve.execute
        >[1],
      );

      assertEquals(capturedMethod, "POST");
      assertEquals(capturedPath, "/api/approve");
      assertEquals(capturedBody, "id=t3_abc123");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "action");
      assertEquals(resources[0].name, "approve-t3_abc123");
      const data = resources[0].data as {
        action: string;
        thingId: string;
        success: boolean;
      };
      assertEquals(data.action, "approve");
      assertEquals(data.thingId, "t3_abc123");
      assertEquals(data.success, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: remove posts to /api/remove with reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedBody = "";
    const server = startMockRedditServer({
      handler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname === "/api/remove") {
          capturedBody = await req.text();
          return Response.json({});
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.remove.execute(
        { thingId: "t1_xyz789", spam: false, modNote: "Rule 3 violation" },
        context as unknown as Parameters<
          typeof model.methods.remove.execute
        >[1],
      );

      const params = new URLSearchParams(capturedBody);
      assertEquals(params.get("id"), "t1_xyz789");
      assertEquals(params.get("spam"), "false");
      assertEquals(params.get("mod_note"), "Rule 3 violation");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "action");
      assertEquals(resources[0].name, "remove-t1_xyz789");
      const data = resources[0].data as { action: string; success: boolean };
      assertEquals(data.action, "remove");
      assertEquals(data.success, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: ban_user posts to /r/{sub}/api/friend",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedPath = "";
    let capturedBody = "";
    const server = startMockRedditServer({
      handler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname.includes("/api/friend")) {
          capturedPath = url.pathname;
          capturedBody = await req.text();
          return Response.json({ json: { errors: [] } });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.ban_user.execute(
        {
          username: "baduser",
          duration: 7,
          banReason: "Spam",
          modNote: "Repeat offender",
        },
        context as unknown as Parameters<
          typeof model.methods.ban_user.execute
        >[1],
      );

      assertEquals(capturedPath, "/r/testsubreddit/api/friend");
      const params = new URLSearchParams(capturedBody);
      assertEquals(params.get("type"), "banned");
      assertEquals(params.get("name"), "baduser");
      assertEquals(params.get("duration"), "7");
      assertEquals(params.get("ban_reason"), "Spam");
      assertEquals(params.get("note"), "Repeat offender");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "action");
      assertEquals(resources[0].name, "ban_user-baduser");
      const data = resources[0].data as { action: string; thingId: string };
      assertEquals(data.action, "ban_user");
      assertEquals(data.thingId, "baduser");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: send_modmail posts JSON to /api/mod/conversations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedPath = "";
    let capturedBody = "";
    let capturedContentType = "";
    const server = startMockRedditServer({
      handler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname === "/api/mod/conversations") {
          capturedPath = url.pathname;
          capturedBody = await req.text();
          capturedContentType = req.headers.get("content-type") ?? "";
          return Response.json({
            conversation: { id: "conv_abc" },
            messages: {},
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.send_modmail.execute(
        { to: "targetuser", subject: "Warning", body: "Please follow rules" },
        context as unknown as Parameters<
          typeof model.methods.send_modmail.execute
        >[1],
      );

      assertEquals(capturedPath, "/api/mod/conversations");
      assertEquals(capturedContentType, "application/json");
      const parsed = JSON.parse(capturedBody);
      assertEquals(parsed.to, "targetuser");
      assertEquals(parsed.subject, "Warning");
      assertEquals(parsed.body, "Please follow rules");
      assertEquals(parsed.srName, "testsubreddit");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "action");
      assertEquals(resources[0].name, "send_modmail-targetuser");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: flair_post posts to /r/{sub}/api/flair",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedPath = "";
    let capturedBody = "";
    const server = startMockRedditServer({
      handler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname.includes("/api/flair")) {
          capturedPath = url.pathname;
          capturedBody = await req.text();
          return Response.json({});
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      await model.methods.flair_post.execute(
        { thingId: "t3_post001", flairTemplateId: "tmpl_xyz" },
        context as unknown as Parameters<
          typeof model.methods.flair_post.execute
        >[1],
      );

      assertEquals(capturedPath, "/r/testsubreddit/api/flair");
      const params = new URLSearchParams(capturedBody);
      assertEquals(params.get("link"), "t3_post001");
      assertEquals(params.get("flair_template_id"), "tmpl_xyz");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "action");
      assertEquals(resources[0].name, "flair_post-t3_post001");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "moderation model: action methods throw on Reddit API errors",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") return tokenResponse();
        if (url.pathname === "/api/approve") {
          return Response.json({
            json: {
              errors: [["id", "that item does not exist", "NOT_FOUND"]],
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      let threw = false;
      try {
        await model.methods.approve.execute(
          { thingId: "t3_invalid" },
          context as unknown as Parameters<
            typeof model.methods.approve.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals((e as Error).message.includes("NOT_FOUND"), true);
      }
      assertEquals(threw, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// Pagination Tests
// =============================================================================

Deno.test({
  name:
    "moderation model: pagination sets truncated true when after cursor exists",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let requestCount = 0;
    const server = startMockRedditServer({
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/access_token") {
          return tokenResponse();
        }
        if (url.pathname.includes("/about/modqueue")) {
          requestCount++;
          // Always return items with an 'after' cursor so pagination
          // thinks there is more data. We request limit=2, and we provide
          // 2 items on the first page so paginate will stop fetching.
          return Response.json({
            data: {
              children: [
                {
                  data: {
                    id: `item${requestCount}a`,
                    name: `t3_item${requestCount}a`,
                    kind: "link",
                    title: "Item A",
                    author: "user1",
                    subreddit: "testsubreddit",
                    created_utc: 1700000000,
                    permalink: "/r/test/itema",
                    num_reports: 1,
                    mod_reports: [],
                    user_reports: [],
                  },
                },
                {
                  data: {
                    id: `item${requestCount}b`,
                    name: `t3_item${requestCount}b`,
                    kind: "link",
                    title: "Item B",
                    author: "user2",
                    subreddit: "testsubreddit",
                    created_utc: 1700000001,
                    permalink: "/r/test/itemb",
                    num_reports: 2,
                    mod_reports: [],
                    user_reports: [],
                  },
                },
              ],
              after: "t3_nextpage",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const { port } = server.addr as Deno.NetAddr;
    const mockBase = `http://127.0.0.1:${port}`;
    const uninstall = installFetchMock(mockBase);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-reddit",
          version: 1,
          tags: {},
        },
      });

      // Request only 2 items — the server returns 2 with an after cursor
      await model.methods.get_modqueue.execute(
        { type: "all", limit: 2 },
        context as unknown as Parameters<
          typeof model.methods.get_modqueue.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        items: unknown[];
        truncated: boolean;
      };
      assertEquals(data.items.length, 2);
      assertEquals(data.truncated, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
