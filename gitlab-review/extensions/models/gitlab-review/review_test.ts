// GitLab Review Model - Tests
// SPDX-License-Identifier: Apache-2.0

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
    const key = `${method} ${path}`;
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

Deno.test("get_mr_diff fetches and stores MR diff data", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/group%2Frepo/merge_requests/42": {
      status: 200,
      body: {
        title: "Test MR",
        description: "A test",
        source_branch: "feature",
        target_branch: "main",
        author: { username: "testuser" },
      },
    },
    "GET /api/v4/projects/group%2Frepo/merge_requests/42/diffs": {
      status: 200,
      body: [
        {
          old_path: "file.ts",
          new_path: "file.ts",
          diff: "@@ -1 +1 @@\n-old\n+new",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
    },
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
  });

  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.get_mr_diff.execute(
      { project: "group/repo", iid: 42 },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    const data = resources[0].data as {
      title: string;
      diffs: unknown[];
      truncated: boolean;
    };
    assertEquals(data.title, "Test MR");
    assertEquals(data.diffs.length, 1);
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("get_mr_diff throws on non-array diffs response", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/group%2Frepo/merge_requests/1": {
      status: 200,
      body: { title: "MR", source_branch: "a", target_branch: "b" },
    },
    "GET /api/v4/projects/group%2Frepo/merge_requests/1/diffs": {
      status: 200,
      body: { error: "something went wrong" },
    },
  });

  const { context } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
  });

  try {
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () =>
        model.methods.get_mr_diff.execute(
          { project: "group/repo", iid: 1 },
          context as any,
        ),
      Error,
      "expected array of diffs",
    );
  } finally {
    restore();
  }
});

Deno.test("post_review writes reviewPosted before approve — partial failure preserves noteId", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/group%2Frepo/merge_requests/1/notes": {
      status: 201,
      body: { id: 999 },
    },
    "POST /api/v4/projects/group%2Frepo/merge_requests/1/approve": {
      status: 403,
      body: { message: "403 Forbidden" },
    },
  });

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
    // post_review with action=approve should throw on 403 from /approve
    // but writeResource should have been called BEFORE the approve attempt
    await assertRejects(
      // deno-lint-ignore no-explicit-any
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
    const posted = resources[0].data as { noteId: number };
    assertEquals(posted.noteId, 999);
  } finally {
    restore();
  }
});

Deno.test("analyze stores review draft", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "localhost", token: "x" },
  });

  // deno-lint-ignore no-explicit-any
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

  // deno-lint-ignore no-explicit-any
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
      // deno-lint-ignore no-explicit-any
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
      // deno-lint-ignore no-explicit-any
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
