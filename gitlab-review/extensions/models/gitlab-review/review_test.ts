// GitLab Review Model - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./review.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/gitlab-review");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.sort(), [
    "analyze",
    "approve_mr",
    "edit_draft",
    "get_mr_diff",
    "post_review",
    "unapprove_mr",
    "update_review",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "mrDiff",
    "reviewDraft",
    "reviewPosted",
  ]);
});

// =============================================================================
// Argument Schema Tests
// =============================================================================

Deno.test("get_mr_diff requires project and iid", () => {
  const missing = model.methods.get_mr_diff.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.get_mr_diff.arguments.safeParse({
    project: "group/repo",
    iid: 42,
  });
  assertEquals(valid.success, true);
});

Deno.test("post_review action defaults to comment", () => {
  const valid = model.methods.post_review.arguments.safeParse({
    project: "group/repo",
    iid: 1,
  });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.action, "comment");
  }
});

Deno.test("post_review rejects invalid action", () => {
  const invalid = model.methods.post_review.arguments.safeParse({
    project: "group/repo",
    iid: 1,
    action: "invalid",
  });
  assertEquals(invalid.success, false);
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
    const method = _init?.method ?? "GET";
    const path = new URL(url).pathname;
    const search = new URL(url).search;
    const key = `${method} ${path}${search}`;
    const route = routes[key];
    if (route) {
      return Promise.resolve(
        new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("get_mr_diff fetches metadata via GraphQL and diffs via REST", async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";

    // First call: GraphQL for MR metadata
    if (method === "POST" && url.includes("/api/graphql")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  id: "gid://gitlab/MergeRequest/100",
                  iid: "42",
                  title: "Test MR",
                  state: "opened",
                  description: "A test",
                  sourceBranch: "feature",
                  targetBranch: "main",
                  author: { username: "testuser" },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Second call: REST for /changes
    if (method === "GET" && url.includes("/changes")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            changes: [{
              old_path: "file.ts",
              new_path: "file.ts",
              diff: "@@ -1 +1 @@\n-old\n+new",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
  });

  try {
    await model.methods.get_mr_diff.execute(
      { project: "group/repo", iid: 42 },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const data = resources[0].data as any;
    assertEquals(data.title, "Test MR");
    assertEquals(data.state, "opened");
    assertEquals(data.sourceBranch, "feature");
    assertEquals(data.diffs.length, 1);
    assertEquals(data.truncated, false);
    assertEquals(callCount, 2); // GraphQL + REST
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("get_mr_diff handles non-array changes gracefully", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/api/graphql")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  id: "gid://gitlab/MergeRequest/1",
                  iid: "1",
                  title: "MR",
                  state: "opened",
                  sourceBranch: "a",
                  targetBranch: "b",
                  author: { username: "dev" },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (method === "GET" && url.includes("/changes")) {
      return Promise.resolve(
        new Response(JSON.stringify({ changes: false, overflow: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
  });

  try {
    await model.methods.get_mr_diff.execute(
      { project: "group/repo", iid: 1 },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.diffs.length, 0);
    assertEquals(data.truncated, false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("get_mr_diff sets truncated when overflow is true", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/api/graphql")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  id: "gid://gitlab/MergeRequest/1",
                  iid: "1",
                  title: "MR",
                  state: "opened",
                  sourceBranch: "a",
                  targetBranch: "b",
                  author: { username: "dev" },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (method === "GET" && url.includes("/changes")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            changes: [{
              old_path: "a.ts",
              new_path: "a.ts",
              diff: "+x",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            }],
            overflow: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
  });

  try {
    await model.methods.get_mr_diff.execute(
      { project: "group/repo", iid: 1 },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.diffs.length, 1);
    assertEquals(data.truncated, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("post_review writes reviewPosted before approve — partial failure preserves noteId", async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";

    // GraphQL calls (MR metadata + createNote)
    if (method === "POST" && url.includes("/api/graphql")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes("mrMetadata")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                project: {
                  mergeRequest: {
                    id: "gid://gitlab/MergeRequest/100",
                    iid: "1",
                    title: "Test",
                    state: "opened",
                    sourceBranch: "a",
                    targetBranch: "b",
                    author: { username: "x" },
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // createNote
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              createNote: {
                note: { id: "gid://gitlab/Note/999", body: "Test review" },
                errors: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // REST: approve fails
    if (method === "POST" && url.includes("/approve")) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "403 Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
    storedResources: {
      [`mrDiff-${encodeURIComponent("group/repo")}-1`]: {
        project: "group/repo",
        iid: 1,
        title: "Test",
        state: "opened",
        description: null,
        sourceBranch: "a",
        targetBranch: "b",
        author: "x",
        diffs: [],
        fetchedAt: "2026-01-01T00:00:00Z",
        truncated: false,
      },
      [`reviewDraft-${encodeURIComponent("group/repo")}-1`]: {
        body: "Test review",
        project: "group/repo",
        iid: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
  });

  try {
    await assertRejects(
      () =>
        model.methods.post_review.execute(
          { project: "group/repo", iid: 1, action: "approve" },
          context as any,
        ),
      Error,
      "403",
    );

    // The noteId was recorded despite the approve failure
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const posted = resources[0].data as any;
    assertEquals(posted.noteId, 999);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("analyze stores review draft", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "localhost", token: "x" },
  });

  await model.methods.analyze.execute(
    { project: "org/app", iid: 5, body: "Review text here" },
    context as any,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  const data = resources[0].data as { body: string; project: string };
  assertEquals(data.body, "Review text here");
  assertEquals(data.project, "org/app");
});

Deno.test("edit_draft creates new version of draft", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "localhost", token: "x" },
  });

  await model.methods.edit_draft.execute(
    { project: "org/app", iid: 5, body: "Revised review" },
    context as any,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  const data = resources[0].data as { body: string };
  assertEquals(data.body, "Revised review");
});

Deno.test("post_review rejects merged MR", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/group%2Frepo/merge_requests/99/notes": {
      status: 201,
      body: { id: 1 },
    },
  });

  const { context } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
    storedResources: {
      [`mrDiff-${encodeURIComponent("group/repo")}-99`]: {
        project: "group/repo",
        iid: 99,
        title: "Old MR",
        state: "merged",
        description: null,
        sourceBranch: "a",
        targetBranch: "b",
        author: "x",
        diffs: [],
        fetchedAt: "2026-01-01T00:00:00Z",
        truncated: false,
      },
      [`reviewDraft-${encodeURIComponent("group/repo")}-99`]: {
        body: "Review text",
        project: "group/repo",
        iid: 99,
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
  });

  try {
    await assertRejects(
      () =>
        model.methods.post_review.execute(
          { project: "group/repo", iid: 99, action: "comment" },
          context as any,
        ),
      Error,
      "is merged",
    );
  } finally {
    restore();
  }
});

Deno.test("approve_mr rejects closed MR", async () => {
  const restore = mockFetch({});

  const { context } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
    storedResources: {
      [`mrDiff-${encodeURIComponent("group/repo")}-50`]: {
        project: "group/repo",
        iid: 50,
        title: "Closed MR",
        state: "closed",
        description: null,
        sourceBranch: "a",
        targetBranch: "b",
        author: "x",
        diffs: [],
        fetchedAt: "2026-01-01T00:00:00Z",
        truncated: false,
      },
    },
  });

  try {
    await assertRejects(
      () =>
        model.methods.approve_mr.execute(
          { project: "group/repo", iid: 50 },
          context as any,
        ),
      Error,
      "is closed",
    );
  } finally {
    restore();
  }
});
