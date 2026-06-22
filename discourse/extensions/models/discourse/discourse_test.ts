// Discourse Model - Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./discourse.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/discourse");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.sort(), [
    "get_topic",
    "list_categories",
    "list_category_topics",
    "list_latest",
    "search",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "categories",
    "searchResults",
    "topicDetail",
    "topics",
  ]);
});

// =============================================================================
// Argument Schema Tests
// =============================================================================

Deno.test("list_latest page defaults to 0", () => {
  const valid = model.methods.list_latest.arguments.safeParse({});
  assertEquals(valid.success, true);
  if (valid.success) assertEquals(valid.data.page, 0);
});

Deno.test("list_category_topics requires slug and categoryId", () => {
  const missing = model.methods.list_category_topics.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.list_category_topics.arguments.safeParse({
    slug: "cyber-news",
    categoryId: 8,
  });
  assertEquals(valid.success, true);
});

Deno.test("search requires non-empty query", () => {
  const empty = model.methods.search.arguments.safeParse({ query: "" });
  assertEquals(empty.success, false);

  const valid = model.methods.search.arguments.safeParse({ query: "CVE" });
  assertEquals(valid.success, true);
});

Deno.test("get_topic requires topicId", () => {
  const missing = model.methods.get_topic.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.get_topic.arguments.safeParse({ topicId: 42 });
  assertEquals(valid.success, true);
});

// =============================================================================
// Execute Tests (with mocked fetch)
// =============================================================================

function mockFetch(
  routes: Record<string, { status: number; body: unknown }>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const path = new URL(url).pathname + new URL(url).search;
    for (const [key, route] of Object.entries(routes)) {
      if (
        path.startsWith(key.split("?")[0]) &&
        path.includes(key.split("?")[1] ?? "")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(route.body), {
            status: route.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("list_categories fetches and stores categories", async () => {
  const restore = mockFetch({
    "/categories.json": {
      status: 200,
      body: {
        category_list: {
          categories: [
            {
              id: 1,
              name: "General",
              slug: "general",
              topic_count: 50,
              description_text: "General discussion",
            },
            {
              id: 2,
              name: "Security",
              slug: "security",
              topic_count: 30,
              description_text: null,
            },
          ],
        },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({} as any, context as any);
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const data = resources[0].data as { categories: { name: string }[] };
    assertEquals(data.categories.length, 2);
    assertEquals(data.categories[0].name, "General");
  } finally {
    restore();
  }
});

Deno.test("list_latest stores topics with truncated flag", async () => {
  const restore = mockFetch({
    "/latest.json": {
      status: 200,
      body: {
        topic_list: {
          topics: [
            {
              id: 1,
              title: "Test",
              category_id: 1,
              created_at: "2026-01-01T00:00:00Z",
              posts_count: 3,
              views: 10,
              reply_count: 2,
              last_posted_at: null,
              pinned: false,
            },
          ],
          more_topics_url: "/latest?page=1",
        },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_latest.execute({ page: 0 }, context as any);
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const data = resources[0].data as { topics: unknown[]; truncated: boolean };
    assertEquals(data.topics.length, 1);
    assertEquals(data.truncated, true);
  } finally {
    restore();
  }
});

Deno.test("list_category_topics fetches and stores topics for a category", async () => {
  const restore = mockFetch({
    "/c/cyber-news/8.json": {
      status: 200,
      body: {
        topic_list: {
          topics: [
            {
              id: 50,
              title: "New CVE",
              category_id: 8,
              created_at: "2026-01-01T00:00:00Z",
              posts_count: 5,
              views: 200,
              reply_count: 4,
              last_posted_at: "2026-01-02T00:00:00Z",
              pinned: false,
            },
          ],
          more_topics_url: null,
        },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    await model.methods.list_category_topics.execute(
      { slug: "cyber-news", categoryId: 8, page: 0 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "category-cyber-news-8-page-0");
    const data = resources[0].data as {
      topics: { title: string }[];
      truncated: boolean;
    };
    assertEquals(data.topics[0].title, "New CVE");
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("discourseFetch throws on non-200 response", async () => {
  const restore = mockFetch({
    "/t/999.json": { status: 404, body: { errors: ["Not Found"] } },
  });

  const { context } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.get_topic.execute({ topicId: 999 }, context as any),
      Error,
      "Discourse API 404",
    );
  } finally {
    restore();
  }
});

Deno.test("get_topic stores posts from topic", async () => {
  const restore = mockFetch({
    "/t/42.json": {
      status: 200,
      body: {
        id: 42,
        title: "Security Alert",
        category_id: 5,
        created_at: "2026-01-01T00:00:00Z",
        posts_count: 2,
        views: 100,
        post_stream: {
          posts: [
            {
              id: 1,
              username: "admin",
              created_at: "2026-01-01T00:00:00Z",
              cooked: "<p>Alert content</p>",
            },
            {
              id: 2,
              username: "user1",
              created_at: "2026-01-02T00:00:00Z",
              cooked: "<p>Reply</p>",
            },
          ],
        },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.get_topic.execute({ topicId: 42 }, context as any);
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const data = resources[0].data as {
      title: string;
      posts: { username: string }[];
    };
    assertEquals(data.title, "Security Alert");
    assertEquals(data.posts.length, 2);
    assertEquals(data.posts[0].username, "admin");
  } finally {
    restore();
  }
});

Deno.test("search stores results with hashed instance name for long queries", async () => {
  const restore = mockFetch({
    "/search.json": {
      status: 200,
      body: {
        topics: [
          {
            id: 99,
            title: "CVE Result",
            category_id: 5,
            created_at: "2026-01-01T00:00:00Z",
            posts_count: 1,
            views: 5,
            reply_count: 0,
            last_posted_at: null,
            pinned: false,
          },
        ],
        grouped_search_result: { more_full_page_results: false },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    const longQuery = "A".repeat(60);
    await model.methods.search.execute(
      { query: longQuery, page: 1 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    // Instance name should be hashed (not contain the full 60-char query)
    assertEquals(resources[0].name.length < 40, true);
    const data = resources[0].data as {
      query: string;
      topics: unknown[];
      truncated: boolean;
    };
    assertEquals(data.query, longQuery);
    assertEquals(data.topics.length, 1);
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("search with short query uses encoded query in instance name", async () => {
  const restore = mockFetch({
    "/search.json": {
      status: 200,
      body: {
        topics: [],
        grouped_search_result: { more_full_page_results: false },
      },
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "forum.example.com" },
  });

  try {
    await model.methods.search.execute(
      { query: "CVE", page: 1 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name.includes("CVE"), true);
  } finally {
    restore();
  }
});

Deno.test("apiKey without apiUsername throws configuration error", async () => {
  const restore = mockFetch({});

  const { context } = createModelTestContext({
    globalArgs: { host: "forum.example.com", apiKey: "secret-key" },
  });

  try {
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.list_categories.execute({} as any, context as any),
      Error,
      "apiUsername is required",
    );
  } finally {
    restore();
  }
});
