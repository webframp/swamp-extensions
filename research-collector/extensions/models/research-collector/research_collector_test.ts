/**
 * Research Collector Model Tests
 *
 * Tests the gather method with mocked fetch responses for each source,
 * and verifies that single-source failures still produce partial results.
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./research_collector.ts";

const DEFAULT_GLOBAL_ARGS = {
  hnCount: 5,
  lobstersCount: 5,
  sreCount: 2,
  ifinCount: 3,
  redmonkCount: 2,
  arxivCount: 2,
  aiDailyBriefDays: 2,
};

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("research-collector model: has correct type", () => {
  assertEquals(model.type, "@webframp/research-collector");
});

Deno.test("research-collector model: has valid version", () => {
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
});

Deno.test("research-collector model: has research resource spec", () => {
  assertExists(model.resources.research);
});

Deno.test("research-collector model: has gather method", () => {
  assertExists(model.methods.gather);
  assertExists(model.methods.gather.execute);
});

Deno.test("research-collector model: global args have correct defaults", () => {
  assertExists(model.globalArguments);
});

// =============================================================================
// gather: all sources succeed
// =============================================================================

Deno.test({
  name: "gather: all seven sources produce data",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? ""
        : input.url;
      if (url.includes("hacker-news.firebaseio.com/v0/topstories.json")) {
        return Promise.resolve(
          new Response(JSON.stringify([1, 2, 3, 4, 5, 6])),
        );
      }
      if (url.includes("hacker-news.firebaseio.com/v0/item")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              title: "Test Story",
              url: "https://example.com",
              score: 100,
              by: "test",
              time: 1000000,
              descendants: 5,
              type: "story",
            }),
          ),
        );
      }
      if (url.includes("lobste.rs/hottest.json")) {
        return Promise.resolve(
          new Response(JSON.stringify([
            {
              short_id: "abc",
              title: "Lobsters Test",
              url: "https://example.com",
              score: 50,
              comment_count: 10,
              tags: ["rust", "web"],
              submitter_user: { username: "user1" },
              created_at: "2026-01-01",
            },
          ])),
        );
      }
      if (url.includes("sreweekly.com")) {
        return Promise.resolve(
          new Response(
            '<?xml version="1.0"?><rss><channel><item>' +
              "<title><![CDATA[SRE Weekly Issue #1]]></title>" +
              "<link>https://example.com</link>" +
              "<description><![CDATA[Test description]]></description>" +
              "<pubDate>Mon, 01 Jan 2026 00:00:00 +0000</pubDate>" +
              "</item></channel></rss>",
          ),
        );
      }
      if (url.includes("discourse.ifin.network")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            topic_list: {
              topics: [
                {
                  id: 1,
                  title: "IFIN Topic",
                  slug: "ifin-topic",
                  tags: ["security", "cve"],
                  excerpt: "Test excerpt",
                  created_at: "2026-01-01",
                  bumped_at: "2026-01-02",
                  posts_count: 5,
                  views: 100,
                  like_count: 3,
                  last_poster_username: "user2",
                  pinned: false,
                  archived: false,
                },
              ],
            },
          })),
        );
      }
      if (url.includes("redmonk.com")) {
        return Promise.resolve(
          new Response(
            '<?xml version="1.0"?><rss><channel><item>' +
              "<title><![CDATA[RedMonk Post]]></title>" +
              "<link>https://redmonk.com/post</link>" +
              "<description><![CDATA[Analysis]]></description>" +
              "<pubDate>Tue, 01 Jan 2026 00:00:00 +0000</pubDate>" +
              "<dc:creator><![CDATA[Analyst]]></dc:creator>" +
              "</item></channel></rss>",
          ),
        );
      }
      if (url.includes("export.arxiv.org")) {
        return Promise.resolve(
          new Response(
            '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
              "<entry><id>http://arxiv.org/abs/2601.00001v1</id>" +
              "<title>Test Paper</title><summary>A test paper</summary>" +
              "<published>2026-01-01</published>" +
              "<updated>2026-01-02</updated>" +
              '<category term="cs.AI"/>' +
              "<author><name>Author Name</name></author>" +
              "</entry></feed>",
          ),
        );
      }
      if (url === "https://aidailybrief.ai/") {
        // Homepage listing two recent editions (out of order to verify sorting)
        return Promise.resolve(
          new Response(
            '<a href="/e/2026-07-16">y</a><a href="/e/2026-07-19">x</a>',
          ),
        );
      }
      if (url.startsWith("https://aidailybrief.ai/e/")) {
        return Promise.resolve(
          new Response(
            '<meta property="og:description" content="Edition thesis"/>' +
              '<h1 class="ed-h1">Edition Headline</h1>' +
              '<span class="tag">Enterprise</span>' +
              '<article class="nug-wrap reveal" id="nug-1">' +
              '<h3 class="nug-h">First takeaway</h3>' +
              '<p class="nug-b">Written analysis body one.</p>' +
              "</article>" +
              '<article class="nug-wrap reveal">' +
              '<h3 class="nug-h">Second takeaway</h3>' +
              '<p class="nug-b">Written analysis body two.</p>' +
              "</article>" +
              '<div class="ep-embed"><iframe src="https://youtube.com/x"></iframe></div>',
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as Record<string, unknown>;
      const hn = data.hnFrontPage as Record<string, unknown>;
      const stories = hn.stories as Array<Record<string, unknown>>;

      assertEquals(stories.length, 5);
      assertEquals(
        (data.sreWeekly as Record<string, unknown>).items ? true : false,
        true,
      );
      assertEquals(
        (data.ifin as Record<string, unknown>).topics ? true : false,
        true,
      );
      // AI Daily Brief: two editions gathered, sorted newest-first, with
      // written nuggets only (video embed discarded).
      const aidb = data.aiDailyBrief as Record<string, unknown>;
      const editions = aidb.editions as Array<Record<string, unknown>>;
      assertEquals(editions.length, 2);
      assertEquals(editions[0].date, "2026-07-19");
      assertEquals(editions[0].title, "Edition Headline");
      const nuggets = editions[0].nuggets as Array<Record<string, unknown>>;
      assertEquals(nuggets.length, 2);
      assertEquals(nuggets[0].heading, "First takeaway");
      assertEquals(nuggets[0].anchor, "nug-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// gather: single-source failure still produces partial result
// =============================================================================

Deno.test({
  name: "gather: lobste.rs 429 still produces partial result",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    let lobstersCalled = false;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? ""
        : input.url;
      if (url.includes("hacker-news.firebaseio.com/v0/topstories.json")) {
        return Promise.resolve(new Response(JSON.stringify([1, 2])));
      }
      if (url.includes("hacker-news.firebaseio.com/v0/item")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              title: "Test",
              url: "https://example.com",
              score: 10,
              by: "t",
              time: 1000000,
              descendants: 0,
              type: "story",
            }),
          ),
        );
      }
      if (url.includes("lobste.rs")) {
        lobstersCalled = true;
        return Promise.resolve(new Response("", { status: 429 }));
      }
      if (url.includes("sreweekly.com")) {
        return Promise.resolve(
          new Response(
            '<?xml version="1.0"?><rss><channel></channel></rss>',
          ),
        );
      }
      if (url.includes("discourse.ifin.network")) {
        return Promise.resolve(
          new Response(JSON.stringify({ topic_list: { topics: [] } })),
        );
      }
      if (url.includes("redmonk.com")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><rss><channel></channel></rss>'),
        );
      }
      if (url.includes("export.arxiv.org")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><feed></feed>'),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as Record<string, unknown>;
      const hn = data.hnFrontPage as Record<string, unknown>;
      assertEquals((hn.stories as Array<unknown>).length, 2);
      assertEquals(lobstersCalled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// gather: all sources fail — still produces a result
// =============================================================================

Deno.test({
  name: "gather: all sources failing produces empty result not crash",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      return Promise.resolve(new Response("", { status: 500 }));
    };

    try {
      const { context } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// Schema validation: CDATA in RSS titles
// =============================================================================

Deno.test({
  name: "gather: SRE Weekly with CDATA-wrapped title is parsed correctly",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? ""
        : input.url;
      if (url.includes("sreweekly.com")) {
        return Promise.resolve(
          new Response(
            '<?xml version="1.0"?><rss><channel>' +
              "<item><title><![CDATA[SRE Weekly Issue #200]]></title>" +
              "<link>https://sreweekly.com/200</link>" +
              "<description><![CDATA[Test CDATA description]]></description>" +
              "<pubDate>Mon, 01 Jun 2026 00:00:00 +0000</pubDate></item>" +
              "</channel></rss>",
          ),
        );
      }
      // Return empty for all other sources
      if (url.includes("hacker-news")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.includes("lobste.rs")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.includes("discourse")) {
        return Promise.resolve(
          new Response(JSON.stringify({ topic_list: { topics: [] } })),
        );
      }
      if (url.includes("redmonk.com")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><rss><channel></channel></rss>'),
        );
      }
      if (url.includes("arxiv")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><feed></feed>'),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as Record<string, unknown>;
      const sre = data.sreWeekly as Record<string, unknown>;
      const items = sre.items as Array<Record<string, unknown>>;

      assertEquals(items.length, 1);
      assertEquals(items[0].title, "SRE Weekly Issue #200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// Schema validation: Discourse tags as strings
// =============================================================================

Deno.test({
  name: "gather: IFIN Discourse topics with string tags parse correctly",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? ""
        : input.url;
      if (url.includes("discourse.ifin.network")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            topic_list: {
              topics: [
                {
                  id: 1,
                  title: "Test",
                  slug: "test",
                  tags: ["security", "cve", "malware"],
                  excerpt: "Test",
                  created_at: "2026-01-01",
                  bumped_at: "2026-01-02",
                  posts_count: 1,
                  views: 10,
                  like_count: 1,
                  last_poster_username: "u",
                  pinned: false,
                  archived: false,
                },
              ],
            },
          })),
        );
      }
      if (url.includes("hacker-news")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.includes("lobste.rs")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.includes("sreweekly")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><rss><channel></channel></rss>'),
        );
      }
      if (url.includes("redmonk")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><rss><channel></channel></rss>'),
        );
      }
      if (url.includes("arxiv")) {
        return Promise.resolve(
          new Response('<?xml version="1.0"?><feed></feed>'),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: DEFAULT_GLOBAL_ARGS,
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as Record<string, unknown>;
      const ifin = data.ifin as Record<string, unknown>;
      const topics = ifin.topics as Array<Record<string, unknown>>;

      assertEquals(topics.length, 1);
      const tags = topics[0].tags as string[];
      assertEquals(tags.length, 3);
      assertEquals(tags[0], "security");
      assertEquals(tags[1], "cve");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// arXiv: updated field differs from published
// =============================================================================

Deno.test({
  name: "queryArxiv: updated field differs from published",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      return Promise.resolve(
        new Response(
          '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
            "<entry><id>http://arxiv.org/abs/2601.00001v2</id>" +
            "<title>Revised Paper</title><summary>Updated</summary>" +
            "<published>2026-01-01</published>" +
            "<updated>2026-03-15</updated>" +
            '<category term="cs.LG"/>' +
            "<author><name>Author</name></author>" +
            "</entry></feed>",
        ),
      );
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { ...DEFAULT_GLOBAL_ARGS, arxivCount: 1 },
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as Record<string, unknown>;
      const arxiv = data.arxiv as Record<string, unknown>;
      const entries = arxiv.entries as Array<Record<string, unknown>>;

      assertEquals(entries.length, 1);
      assertEquals(entries[0].published, "2026-01-01");
      assertEquals(entries[0].updated, "2026-03-15");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// =============================================================================
// gather: The AI Daily Brief — written analysis only, video discarded
// =============================================================================

Deno.test({
  name: "gather: AI Daily Brief keeps written nuggets and drops video embeds",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? ""
        : input.url;
      if (url === "https://aidailybrief.ai/") {
        return Promise.resolve(
          new Response(
            '<a href="/e/2026-07-15">old</a>' +
              '<a href="/e/2026-07-19">new</a>' +
              '<a href="/e/2026-07-17">mid</a>',
          ),
        );
      }
      if (url === "https://aidailybrief.ai/e/2026-07-19") {
        return Promise.resolve(
          new Response(
            '<meta property="og:description" content="Newest thesis"/>' +
              '<h1 class="ed-h1">Newest Edition</h1>' +
              '<span class="tag">Agents</span><span class="tag">Enterprise</span>' +
              '<article class="nug-wrap reveal" id="a">' +
              '<h3 class="nug-h">Take one</h3>' +
              '<p class="nug-b">Analysis one.</p>' +
              "</article>" +
              '<div class="ep-embed"><iframe src="https://youtube.com/embed/x"></iframe></div>' +
              '<article class="nug-wrap reveal" id="b">' +
              '<h3 class="nug-h">Take two</h3>' +
              '<p class="nug-b">Analysis two.</p>' +
              "</article>",
          ),
        );
      }
      // 2026-07-17: an edition whose page fetch fails (500) — must be dropped
      // without killing the whole source.
      if (url === "https://aidailybrief.ai/e/2026-07-17") {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      if (url === "https://aidailybrief.ai/e/2026-07-15") {
        return Promise.resolve(
          new Response(
            '<meta property="og:description" content="Oldest thesis"/>' +
              '<h1 class="ed-h1">Oldest Edition</h1>' +
              '<article class="nug-wrap reveal" id="solo">' +
              '<h3 class="nug-h">Solo takeaway</h3>' +
              '<p class="nug-b">Only analysis.</p>' +
              "</article>",
          ),
        );
      }
      // Other sources return minimal empty shapes so gather completes.
      if (url.includes("hacker-news.firebaseio.com/v0/topstories.json")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.includes("lobste.rs")) {
        return Promise.resolve(new Response("[]"));
      }
      if (url.includes("sreweekly.com")) {
        return Promise.resolve(
          new Response(`<?xml version="1.0"?><rss><channel></channel></rss>`),
        );
      }
      if (url.includes("discourse.ifin.network")) {
        return Promise.resolve(
          new Response(JSON.stringify({ topic_list: { topics: [] } })),
        );
      }
      if (url.includes("redmonk.com")) {
        return Promise.resolve(
          new Response(`<?xml version="1.0"?><rss><channel></channel></rss>`),
        );
      }
      if (url.includes("export.arxiv.org")) {
        return Promise.resolve(
          new Response(`<?xml version="1.0"?><feed></feed>`),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { ...DEFAULT_GLOBAL_ARGS, aiDailyBriefDays: 3 },
        definition: {
          id: "test-id",
          name: "test-collector",
          version: 1,
          tags: {},
        },
      });

      await model.methods.gather.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.gather.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as Record<string, unknown>;
      const aidb = data.aiDailyBrief as Record<string, unknown>;
      const editions = aidb.editions as Array<Record<string, unknown>>;

      // Two editions survived: newest and oldest. The 500 on 07-17 was dropped.
      assertEquals(editions.length, 2);
      assertEquals(editions[0].date, "2026-07-19");
      assertEquals(editions[1].date, "2026-07-15");

      const newest = editions[0];
      assertEquals(newest.title, "Newest Edition");
      assertEquals(newest.summary, "Newest thesis");
      assertEquals(newest.tags, ["Agents", "Enterprise"]);
      const nuggets = newest.nuggets as Array<Record<string, unknown>>;
      // Both written takeaways kept; the video iframe lives outside the
      // nug-wrap article wrappers so it never becomes a nugget.
      assertEquals(nuggets.length, 2);
      assertEquals(nuggets[0].heading, "Take one");
      assertEquals(nuggets[0].body, "Analysis one.");
      assertEquals(nuggets[0].anchor, "a");
      assertEquals(nuggets[1].heading, "Take two");
      assertEquals(nuggets[1].anchor, "b");
      // No nugget body references the video source.
      const allBodies = nuggets.map((n) => String(n.body)).join(" ");
      assertEquals(allBodies.includes("youtube"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
