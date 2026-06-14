// GitLab Project Operations Model - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./projects.ts";

// =============================================================================
// Fetch Mock
// =============================================================================

function mockFetch(
  routes: Record<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = _init?.method ?? "GET";
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const route = routes[key];
    if (!route) {
      return Promise.resolve(
        new Response(`Not found: ${key}`, { status: 404 }),
      );
    }
    const headers = new Headers(route.headers ?? {});
    headers.set("content-type", "application/json");
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status,
        headers,
      }),
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

const TEST_GLOBAL_ARGS = { host: "git.example.org", token: "test-token" };

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/gitlab");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.sort(), [
    "add_issue_note",
    "add_mr_note",
    "create_issue",
    "create_label",
    "create_merge_request",
    "get_project_info",
    "list_branches",
    "list_issue_notes",
    "list_issues",
    "list_labels",
    "list_members",
    "list_merge_requests",
    "list_my_merge_requests",
    "list_pipelines",
    "list_projects",
    "list_releases",
    "merge",
    "update_issue",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "branches",
    "dashboard",
    "issueDetail",
    "issues",
    "labels",
    "members",
    "mergeRequests",
    "notes",
    "pipelines",
    "projectInfo",
    "projects",
    "releases",
  ]);
});

// =============================================================================
// Argument Schema Tests
// =============================================================================

Deno.test("globalArguments requires host and token", () => {
  const missing = model.globalArguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.globalArguments.safeParse(TEST_GLOBAL_ARGS);
  assertEquals(valid.success, true);
});

Deno.test("globalArguments rejects empty host", () => {
  const result = model.globalArguments.safeParse({ host: "", token: "t" });
  assertEquals(result.success, false);
});

Deno.test("project argument rejects empty string", () => {
  const result = model.methods.list_issues.arguments.safeParse({
    project: "",
  });
  assertEquals(result.success, false);
});

Deno.test("list_merge_requests state defaults to opened", () => {
  const valid = model.methods.list_merge_requests.arguments.safeParse({
    project: "g/p",
  });
  assertEquals(valid.success, true);
  if (valid.success) assertEquals(valid.data.state, "opened");
});

Deno.test("list_issues accepts all state values", () => {
  for (const state of ["opened", "closed", "all"]) {
    const r = model.methods.list_issues.arguments.safeParse({
      project: "g/p",
      state,
    });
    assertEquals(r.success, true, `state '${state}' should be valid`);
  }
});

// =============================================================================
// Execute Tests (with mocked fetch)
// =============================================================================

Deno.test("list_projects writes projects resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      projects: {
        nodes: [{
          name: "TestProject",
          fullPath: "group/test-project",
          description: "A test",
          visibility: "internal",
          starCount: 3,
          forksCount: 1,
          lastActivityAt: "2026-04-13T00:00:00Z",
          archived: false,
          topics: [],
          repository: { rootRef: "main" },
        }],
        pageInfo: { hasNextPage: false },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_projects.execute({} as any, context as any);
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "projects");
    assertEquals(resources[0].name, "all");
    const data = resources[0].data as any;
    assertEquals(data.count, 1);
    assertEquals(data.truncated, false);
    assertEquals(data.projects[0].name, "TestProject");
    assertEquals(data.projects[0].defaultBranch, "main");
  } finally {
    restore();
  }
});

Deno.test("list_projects sets truncated=true when hasNextPage", async () => {
  const restore = mockGraphqlFetch({
    data: {
      projects: {
        nodes: [{
          name: "P",
          fullPath: "g/p",
          visibility: "private",
          starCount: 0,
          forksCount: 0,
          lastActivityAt: "",
          archived: false,
          topics: [],
          repository: { rootRef: "main" },
        }],
        pageInfo: { hasNextPage: true },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_projects.execute({} as any, context as any);
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.truncated, true);
  } finally {
    restore();
  }
});

Deno.test("get_project_info writes projectInfo resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        name: "MyRepo",
        fullPath: "org/myrepo",
        description: "Desc",
        visibility: "private",
        starCount: 1,
        forksCount: 0,
        openIssuesCount: 5,
        archived: false,
        topics: ["go"],
        webUrl: "https://git.example.org/org/myrepo",
        createdAt: "2025-01-01T00:00:00Z",
        lastActivityAt: "2026-04-01T00:00:00Z",
        repository: { rootRef: "main" },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_project_info.execute(
      { project: "org/myrepo" },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].specName, "projectInfo");
    assertEquals(resources[0].name, "org~myrepo");
    const data = resources[0].data as any;
    assertEquals(data.name, "MyRepo");
    assertEquals(data.webUrl, "https://git.example.org/org/myrepo");
    assertEquals(data.defaultBranch, "main");
  } finally {
    restore();
  }
});

Deno.test("get_project_info throws when project not found", async () => {
  const restore = mockGraphqlFetch({ data: { project: null } });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.get_project_info.execute(
          { project: "org/missing" },
          context as any,
        ),
      Error,
      "Project not found",
    );
  } finally {
    restore();
  }
});

Deno.test("list_merge_requests writes mergeRequests resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequests: {
          nodes: [{
            iid: 42,
            title: "Add feature",
            state: "opened",
            author: { username: "dev" },
            sourceBranch: "feature",
            targetBranch: "main",
            draft: false,
            createdAt: "2026-04-13T00:00:00Z",
            updatedAt: "2026-04-13T00:00:00Z",
            labels: { nodes: [{ title: "enhancement" }] },
          }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_merge_requests.execute(
      { project: "group/repo", state: "opened" },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].specName, "mergeRequests");
    assertEquals(resources[0].name, "group~repo-opened");
    const data = resources[0].data as any;
    assertEquals(data.count, 1);
    assertEquals(data.truncated, false);
    assertEquals(data.mergeRequests[0].sourceBranch, "feature");
    assertEquals(data.mergeRequests[0].labels, ["enhancement"]);
  } finally {
    restore();
  }
});

Deno.test("list_issues writes issues resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        issues: {
          nodes: [{
            iid: 7,
            title: "Bug report",
            state: "opened",
            author: { username: "tester" },
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-02T00:00:00Z",
            labels: { nodes: [{ title: "bug" }] },
          }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_issues.execute(
      { project: "org/repo", state: "opened" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.count, 1);
    assertEquals(data.issues[0].title, "Bug report");
    assertEquals(data.issues[0].labels, ["bug"]);
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("list_releases writes releases resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        releases: {
          nodes: [{
            tagName: "v1.0.0",
            name: "First Release",
            createdAt: "2026-03-01T00:00:00Z",
            releasedAt: "2026-03-01T00:00:00Z",
            upcomingRelease: false,
          }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_releases.execute(
      { project: "org/repo" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.releases[0].tagName, "v1.0.0");
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("list_pipelines writes pipelines resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        pipelines: {
          nodes: [{
            iid: "100",
            status: "SUCCESS",
            source: "PUSH",
            ref: "main",
            createdAt: "2026-04-13T00:00:00Z",
            updatedAt: "2026-04-13T00:00:00Z",
          }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_pipelines.execute(
      { project: "group/repo" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.pipelines[0].status, "success");
    assertEquals(data.pipelines[0].iid, 100);
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("create_issue writes issueDetail resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      createIssue: {
        issue: {
          iid: 99,
          title: "New issue",
          description: "body",
          state: "opened",
          webUrl: "https://git.example.org/org/repo/-/issues/99",
          labels: { nodes: [{ title: "todo" }] },
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:00Z",
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.create_issue.execute(
      {
        project: "org/repo",
        title: "New issue",
        description: "body",
        labels: ["todo"],
      },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].specName, "issueDetail");
    assertEquals(resources[0].name, "org~repo-99");
    assertEquals((resources[0].data as any).title, "New issue");
    assertEquals((resources[0].data as any).labels, ["todo"]);
  } finally {
    restore();
  }
});

Deno.test("create_issue throws on mutation errors", async () => {
  const restore = mockGraphqlFetch({
    data: {
      createIssue: { issue: null, errors: ["Title is too short"] },
    },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.create_issue.execute(
          { project: "org/repo", title: "x", description: "", labels: [] },
          context as any,
        ),
      Error,
      "createIssue failed",
    );
  } finally {
    restore();
  }
});

Deno.test("update_issue writes issueDetail resource via GraphQL", async () => {
  // Mock needs to handle two sequential GraphQL calls: first to get issue ID, then to update
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (_input: any, _init?: any) => {
    callCount++;
    const body = callCount === 1
      ? { data: { project: { issue: { id: "gid://gitlab/Issue/123" } } } }
      : {
        data: {
          updateIssue: {
            issue: {
              iid: 5,
              title: "Updated",
              description: "",
              state: "opened",
              webUrl: "https://git.example.org/org/repo/-/issues/5",
              labels: { nodes: [] },
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-06-10T00:00:00Z",
            },
            errors: [],
          },
        },
      };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.update_issue.execute(
      { project: "org/repo", iid: 5, title: "Updated" },
      context as any,
    );
    assertEquals((getWrittenResources()[0].data as any).title, "Updated");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("add_issue_note uses note-specific instance name via GraphQL", async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (_input: any, _init?: any) => {
    callCount++;
    const body = callCount === 1
      ? { data: { project: { issue: { id: "gid://gitlab/Issue/123" } } } }
      : {
        data: {
          createNote: {
            note: {
              id: "gid://gitlab/Note/777",
              body: "My comment",
              author: { username: "me" },
              createdAt: "2026-06-10T00:00:00Z",
            },
            errors: [],
          },
        },
      };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.add_issue_note.execute(
      { project: "org/repo", iid: 3, body: "My comment" },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-issue-3-note-777");
    assertEquals((resources[0].data as any).notes[0].id, 777);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("list_issue_notes writes notes resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        issue: {
          notes: {
            nodes: [
              {
                id: "gid://gitlab/Note/1",
                body: "first",
                author: { username: "a" },
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "gid://gitlab/Note/2",
                body: "second",
                author: { username: "b" },
                createdAt: "2026-01-02T00:00:00Z",
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_issue_notes.execute(
      { project: "org/repo", iid: 3 },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-issue-3");
    assertEquals((resources[0].data as any).count, 2);
  } finally {
    restore();
  }
});

Deno.test("create_merge_request writes mergeRequests resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      mergeRequestCreate: {
        mergeRequest: {
          iid: 10,
          title: "New MR",
          state: "opened",
          author: { username: "dev" },
          sourceBranch: "feature",
          targetBranch: "main",
          draft: false,
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:00Z",
          labels: { nodes: [] },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.create_merge_request.execute(
      {
        project: "org/repo",
        title: "New MR",
        sourceBranch: "feature",
        targetBranch: "main",
        description: "",
      },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-created-10");
    assertEquals((resources[0].data as any).mergeRequests[0].iid, 10);
  } finally {
    restore();
  }
});

Deno.test("merge writes MR state resource (REST)", async () => {
  const restore = mockFetch({
    "PUT /api/v4/projects/org%2Frepo/merge_requests/10/merge": {
      status: 200,
      body: {
        iid: 10,
        title: "Merged MR",
        state: "merged",
        author: { username: "dev" },
        source_branch: "feature",
        target_branch: "main",
        draft: false,
        created_at: "2026-06-10T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
        labels: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.merge.execute(
      { project: "org/repo", iid: 10, squash: false },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-merged-10");
    assertEquals((resources[0].data as any).state, "merged");
  } finally {
    restore();
  }
});

Deno.test("merge throws on error message in response body", async () => {
  const restore = mockFetch({
    "PUT /api/v4/projects/org%2Frepo/merge_requests/10/merge": {
      status: 200,
      body: { message: "Branch cannot be merged" },
    },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.merge.execute(
          { project: "org/repo", iid: 10, squash: false },
          context as any,
        ),
      Error,
      "Branch cannot be merged",
    );
  } finally {
    restore();
  }
});

Deno.test("add_mr_note uses note-specific instance name via GraphQL", async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (_input: any, _init?: any) => {
    callCount++;
    const body = callCount === 1
      ? {
        data: {
          project: { mergeRequest: { id: "gid://gitlab/MergeRequest/500" } },
        },
      }
      : {
        data: {
          createNote: {
            note: {
              id: "gid://gitlab/Note/888",
              body: "LGTM",
              author: { username: "reviewer" },
              createdAt: "2026-06-10T00:00:00Z",
            },
            errors: [],
          },
        },
      };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.add_mr_note.execute(
      { project: "org/repo", iid: 5, body: "LGTM" },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-mr-5-note-888");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("list_labels writes labels resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        labels: {
          nodes: [
            { title: "bug", color: "#d9534f", description: "Something broken" },
            { title: "feature", color: "#5cb85c", description: null },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_labels.execute(
      { project: "org/repo" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.labels[0].description, "Something broken");
    assertEquals(data.labels[1].description, null);
    assertEquals(data.labels[0].name, "bug");
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("list_members writes members resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        projectMembers: {
          nodes: [{
            user: { username: "dev", name: "Developer" },
            accessLevel: { integerValue: 30 },
          }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_members.execute(
      { project: "org/repo" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.members[0].username, "dev");
    assertEquals(data.members[0].accessLevel, 30);
  } finally {
    restore();
  }
});

Deno.test("list_branches writes branches resource (REST)", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/repository/branches?per_page=50": {
      status: 200,
      body: [
        { name: "main", protected: true, default: true },
        { name: "feature", protected: false, default: false },
      ],
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_branches.execute(
      { project: "org/repo" },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.branches.length, 2);
    assertEquals(data.branches[0].default, true);
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("GraphQL error throws with message", async () => {
  const restore = mockGraphqlFetch({
    errors: [{ message: "Unauthorized" }],
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () => model.methods.list_projects.execute({} as any, context as any),
      Error,
      "GraphQL errors",
    );
  } finally {
    restore();
  }
});

Deno.test("GraphQL HTTP failure throws with status", async () => {
  const restore = mockGraphqlFetch({}, { status: 401 });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () => model.methods.list_projects.execute({} as any, context as any),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});

// =============================================================================
// GraphQL / Dashboard Tests
// =============================================================================

const MOCK_GRAPHQL_RESPONSE = {
  data: {
    currentUser: {
      username: "testuser",
      reviewRequestedMergeRequests: {
        nodes: [
          {
            iid: 101,
            title: "Fix auth bug",
            webUrl: "https://git.example.org/group/proj/-/merge_requests/101",
            updatedAt: "2026-06-10T10:00:00Z",
            draft: false,
            project: { fullPath: "group/proj" },
            author: { username: "alice" },
            labels: { nodes: [{ title: "security" }] },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      assignedMergeRequests: {
        nodes: [
          {
            iid: 202,
            title: "Draft: Refactor service",
            webUrl: "https://git.example.org/team/svc/-/merge_requests/202",
            updatedAt: "2026-05-01T00:00:00Z",
            draft: true,
            project: { fullPath: "team/svc" },
            author: { username: "bob" },
            labels: { nodes: [] },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      authoredMergeRequests: {
        nodes: [
          {
            iid: 303,
            title: "Add metrics",
            webUrl: "https://git.example.org/group/proj/-/merge_requests/303",
            updatedAt: "2026-06-11T00:00:00Z",
            draft: false,
            project: { fullPath: "group/proj" },
            author: { username: "testuser" },
            labels: { nodes: [{ title: "enhancement" }] },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      todos: {
        nodes: [
          {
            id: "gid://gitlab/Todo/1",
            action: "mentioned",
            body: "You were mentioned",
            targetType: "MERGEREQUEST",
            targetUrl:
              "https://git.example.org/group/proj/-/merge_requests/101",
            createdAt: "2026-06-11T12:00:00Z",
            author: { username: "alice" },
            project: { nameWithNamespace: "Group / Proj" },
          },
        ],
      },
    },
  },
};

function mockGraphqlFetch(
  responseBody: unknown,
  opts?: { status?: number },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";

    // Handle GraphQL calls
    if (method === "POST" && url.includes("/api/graphql")) {
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: opts?.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    // Fall through for non-GraphQL
    return Promise.resolve(
      new Response(`Not mocked: ${method} ${url}`, { status: 404 }),
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("list_my_merge_requests argument schema defaults", () => {
  const result = model.methods.list_my_merge_requests.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.role, "all");
    assertEquals(result.data.state, "opened");
    assertEquals(result.data.includeArchived, false);
  }
});

Deno.test("list_my_merge_requests accepts all role values", () => {
  for (const role of ["reviewer", "assignee", "author", "all"]) {
    const r = model.methods.list_my_merge_requests.arguments.safeParse({
      role,
    });
    assertEquals(r.success, true, `role '${role}' should be valid`);
  }
});

Deno.test("list_my_merge_requests writes dashboard resource with all roles", async () => {
  const restore = mockGraphqlFetch(MOCK_GRAPHQL_RESPONSE);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_my_merge_requests.execute(
      { role: "all", state: "opened", includeArchived: false },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "dashboard");
    assertEquals(resources[0].name, "testuser");
    const data = resources[0].data as any;
    assertEquals(data.username, "testuser");
    assertEquals(data.reviewing.length, 1);
    assertEquals(data.assigned.length, 1);
    assertEquals(data.authored.length, 1);
    assertEquals(data.todos.length, 1);
    assertEquals(data.totalCount, 3);
    assertEquals(data.truncated, false);
    // Verify MR mapping
    assertEquals(data.reviewing[0].iid, 101);
    assertEquals(data.reviewing[0].project, "group/proj");
    assertEquals(data.reviewing[0].author, "alice");
    assertEquals(data.reviewing[0].labels, ["security"]);
    // Verify assigned draft detection
    assertEquals(data.assigned[0].draft, true);
    // Verify todo mapping
    assertEquals(data.todos[0].action, "mentioned");
    assertEquals(data.todos[0].targetType, "MERGEREQUEST");
    assertEquals(data.todos[0].author, "alice");
    assertEquals(data.todos[0].project, "Group / Proj");
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests filters by role=reviewer", async () => {
  const restore = mockGraphqlFetch(MOCK_GRAPHQL_RESPONSE);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_my_merge_requests.execute(
      { role: "reviewer", state: "opened", includeArchived: false },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.reviewing.length, 1);
    assertEquals(data.assigned.length, 0);
    assertEquals(data.authored.length, 0);
    assertEquals(data.totalCount, 1);
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests detects truncation", async () => {
  const truncatedResponse = {
    data: {
      currentUser: {
        username: "testuser",
        reviewRequestedMergeRequests: {
          nodes: [],
          pageInfo: { hasNextPage: true },
        },
        assignedMergeRequests: { nodes: [], pageInfo: { hasNextPage: false } },
        authoredMergeRequests: { nodes: [], pageInfo: { hasNextPage: false } },
        todos: { nodes: [] },
      },
    },
  };
  const restore = mockGraphqlFetch(truncatedResponse);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_my_merge_requests.execute(
      { role: "all", state: "opened", includeArchived: false },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.truncated, true);
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests throws on GraphQL errors", async () => {
  const errorResponse = {
    errors: [{ message: "Field 'bad' doesn't exist" }],
  };
  const restore = mockGraphqlFetch(errorResponse);
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.list_my_merge_requests.execute(
          { role: "all", state: "opened", includeArchived: false },
          context as any,
        ),
      Error,
      "GraphQL errors",
    );
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests throws on HTTP failure", async () => {
  const restore = mockGraphqlFetch({}, { status: 401 });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.list_my_merge_requests.execute(
          { role: "all", state: "opened", includeArchived: false },
          context as any,
        ),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests throws on null currentUser", async () => {
  const nullUserResponse = { data: { currentUser: null } };
  const restore = mockGraphqlFetch(nullUserResponse);
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.list_my_merge_requests.execute(
          { role: "all", state: "opened", includeArchived: false },
          context as any,
        ),
      Error,
      "currentUser is null",
    );
  } finally {
    restore();
  }
});

Deno.test("list_my_merge_requests truncated respects role filter", async () => {
  const response = {
    data: {
      currentUser: {
        username: "testuser",
        reviewRequestedMergeRequests: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        assignedMergeRequests: {
          nodes: [],
          pageInfo: { hasNextPage: true },
        },
        authoredMergeRequests: {
          nodes: [],
          pageInfo: { hasNextPage: true },
        },
        todos: { nodes: [] },
      },
    },
  };
  const restore = mockGraphqlFetch(response);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    // When role=reviewer, truncated should be false even though assigned has next page
    await model.methods.list_my_merge_requests.execute(
      { role: "reviewer", state: "opened", includeArchived: false },
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});
