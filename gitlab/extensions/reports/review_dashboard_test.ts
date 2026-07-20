// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { report } from "./review_dashboard.ts";

// deno-lint-ignore no-explicit-any
type AnyContext = any;
// deno-lint-ignore no-explicit-any
type AnyJson = any;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function makeDashboardData(overrides: Record<string, unknown> = {}) {
  return {
    username: "testuser",
    totalCount: 3,
    truncated: false,
    reviewing: [],
    assigned: [],
    authored: [],
    todos: [],
    ...overrides,
  };
}

function makeContext(data: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  return {
    modelType: "@webframp/gitlab",
    modelId: "test-id",
    dataHandles: [{ name: "dashboard", version: 1 }],
    dataRepository: {
      getContent: () => Promise.resolve(encoded),
    },
  } as AnyContext;
}

Deno.test("no-data fallback returns empty markdown", async () => {
  const ctx = {
    modelType: "@webframp/gitlab",
    modelId: "test-id",
    dataHandles: [],
    dataRepository: { getContent: () => Promise.resolve(null) },
  } as AnyContext;
  const result = await report.execute(ctx);
  assertEquals(result.markdown, "No dashboard data available.");
  assertEquals((result.json as AnyJson).items, []);
});

Deno.test("priority: reviewer >= 7 days is overdue", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "MR1",
        author: "bob",
        updatedAt: daysAgo(7),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🔴");
  assertEquals((result.json as AnyJson).items[0].reason, "overdue review");
});

Deno.test("priority: reviewer >= 3 days is aging", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "MR1",
        author: "bob",
        updatedAt: daysAgo(3),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🟡");
  assertEquals((result.json as AnyJson).items[0].reason, "aging review");
});

Deno.test("priority: reviewer < 3 days is active", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "MR1",
        author: "bob",
        updatedAt: daysAgo(1),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🟢");
  assertEquals((result.json as AnyJson).items[0].reason, "recent");
});

Deno.test("priority: assigned > 14 days is stale", async () => {
  const data = makeDashboardData({
    assigned: [
      {
        project: "g/p",
        title: "MR1",
        author: "bob",
        updatedAt: daysAgo(15),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🔴");
  assertEquals((result.json as AnyJson).items[0].reason, "stale assignment");
});

Deno.test("priority: authored > 30 days is consider closing", async () => {
  const data = makeDashboardData({
    authored: [
      {
        project: "g/p",
        title: "MR1",
        author: "me",
        updatedAt: daysAgo(31),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🔴");
  assertEquals((result.json as AnyJson).items[0].reason, "consider closing");
});

Deno.test("age returns 0 for empty or invalid dates", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "MR1",
        author: "bob",
        updatedAt: "",
        draft: false,
      },
      {
        project: "g/p",
        title: "MR2",
        author: "bob",
        updatedAt: "not-a-date",
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].days, 0);
  assertEquals((result.json as AnyJson).items[1].days, 0);
});

Deno.test("pipe characters in titles are escaped in markdown", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "Fix A | B issue",
        author: "bob",
        updatedAt: daysAgo(8),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals(result.markdown.includes("Fix A \\| B issue"), true);
});

Deno.test("items are sorted by severity then age", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "Recent",
        author: "a",
        updatedAt: daysAgo(1),
        draft: false,
      },
      {
        project: "g/p",
        title: "Overdue",
        author: "b",
        updatedAt: daysAgo(10),
        draft: false,
      },
      {
        project: "g/p",
        title: "Aging",
        author: "c",
        updatedAt: daysAgo(4),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].title, "Overdue");
  assertEquals((result.json as AnyJson).items[1].title, "Aging");
  assertEquals((result.json as AnyJson).items[2].title, "Recent");
});

Deno.test("draft MRs get draft flag in output", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "Draft MR",
        author: "bob",
        updatedAt: daysAgo(8),
        draft: true,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].draft, true);
  assertEquals(result.markdown.includes("🚧"), true);
});

Deno.test("json output includes summary counts", async () => {
  const data = makeDashboardData({
    totalCount: 5,
    reviewing: [
      {
        project: "g/p",
        title: "MR1",
        author: "a",
        updatedAt: daysAgo(8),
        draft: false,
      },
    ],
    assigned: [
      {
        project: "g/p",
        title: "MR2",
        author: "b",
        updatedAt: daysAgo(1),
        draft: false,
      },
    ],
    authored: [
      {
        project: "g/p",
        title: "MR3",
        author: "me",
        updatedAt: daysAgo(1),
        draft: false,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).username, "testuser");
  assertEquals((result.json as AnyJson).totalCount, 5);
  assertEquals((result.json as AnyJson).overdue, 1);
  assertEquals((result.json as AnyJson).active, 2);
});

Deno.test("priority: reviewer with commented=true is green/commented", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "Already reviewed",
        author: "bob",
        updatedAt: daysAgo(10),
        draft: false,
        commented: true,
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals((result.json as AnyJson).items[0].level, "🟢");
  assertEquals((result.json as AnyJson).items[0].reason, "commented");
});

Deno.test("renders full group/project references, unfenced for autolinking", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "group/proj",
        reference: "group/proj!5781",
        title: "Consolidate tags",
        author: "cerb",
        updatedAt: daysAgo(8),
        draft: false,
      },
    ],
    todos: [
      {
        action: "review_requested",
        targetType: "MERGEREQUEST",
        reference: "team/svc!42",
        author: "ds",
        createdAt: daysAgo(2),
      },
      {
        action: "mentioned",
        targetType: "ISSUE",
        reference: "group/beta#7",
        author: "as",
        createdAt: daysAgo(1),
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  // References appear in full, and unfenced (backticks would block GitLab
  // autolinking).
  assertEquals(result.markdown.includes("group/proj!5781"), true);
  assertEquals(result.markdown.includes("`group/proj!5781`"), false);
  assertEquals(result.markdown.includes("team/svc!42"), true);
  assertEquals(result.markdown.includes("group/beta#7"), true);
  // The item carries the reference in JSON too.
  assertEquals((result.json as AnyJson).items[0].reference, "group/proj!5781");
});

Deno.test("falls back to project / targetType when reference is absent", async () => {
  const data = makeDashboardData({
    reviewing: [
      {
        project: "g/p",
        title: "No ref (old data)",
        author: "bob",
        updatedAt: daysAgo(8),
        draft: false,
      },
    ],
    todos: [
      {
        action: "mentioned",
        targetType: "ISSUE",
        author: "bob",
        createdAt: daysAgo(1),
      },
    ],
  });
  const result = await report.execute(makeContext(data));
  assertEquals(result.markdown.includes("| g/p |"), true); // MR fallback
  assertEquals(result.markdown.includes("| ISSUE |"), true); // todo fallback
});
