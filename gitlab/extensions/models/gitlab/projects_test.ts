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

Deno.test("list_projects writes projects resource with truncated=false", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects?membership=true&per_page=30&order_by=last_activity_at&sort=desc":
      {
        status: 200,
        body: [{
          name: "TestProject",
          path_with_namespace: "group/test-project",
          description: "A test",
          visibility: "internal",
          star_count: 3,
          forks_count: 1,
          last_activity_at: "2026-04-13T00:00:00Z",
          default_branch: "main",
          archived: false,
          topics: [],
        }],
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
  } finally {
    restore();
  }
});

Deno.test("list_projects sets truncated=true when x-next-page present", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects?membership=true&per_page=30&order_by=last_activity_at&sort=desc":
      {
        status: 200,
        body: [{
          name: "P",
          path_with_namespace: "g/p",
          visibility: "private",
          star_count: 0,
          forks_count: 0,
          last_activity_at: "",
          default_branch: "main",
          archived: false,
          topics: [],
        }],
        headers: { "x-next-page": "2" },
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

Deno.test("get_project_info writes projectInfo resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Fmyrepo": {
      status: 200,
      body: {
        name: "MyRepo",
        path_with_namespace: "org/myrepo",
        description: "Desc",
        visibility: "private",
        default_branch: "main",
        star_count: 1,
        forks_count: 0,
        open_issues_count: 5,
        archived: false,
        topics: ["go"],
        web_url: "https://git.example.org/org/myrepo",
        created_at: "2025-01-01T00:00:00Z",
        last_activity_at: "2026-04-01T00:00:00Z",
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
  } finally {
    restore();
  }
});

Deno.test("list_merge_requests writes mergeRequests resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/group%2Frepo/merge_requests?state=opened&per_page=20":
      {
        status: 200,
        body: [{
          iid: 42,
          title: "Add feature",
          state: "opened",
          author: { username: "dev" },
          source_branch: "feature",
          target_branch: "main",
          draft: false,
          created_at: "2026-04-13T00:00:00Z",
          updated_at: "2026-04-13T00:00:00Z",
          labels: ["enhancement"],
        }],
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
  } finally {
    restore();
  }
});

Deno.test("list_issues writes issues resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/issues?state=opened&per_page=20": {
      status: 200,
      body: [{
        iid: 7,
        title: "Bug report",
        state: "opened",
        author: { username: "tester" },
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-02T00:00:00Z",
        labels: ["bug"],
      }],
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
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("list_releases writes releases resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/releases?per_page=10": {
      status: 200,
      body: [{
        tag_name: "v1.0.0",
        name: "First Release",
        created_at: "2026-03-01T00:00:00Z",
        released_at: "2026-03-01T00:00:00Z",
        upcoming_release: false,
      }],
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

Deno.test("list_pipelines writes pipelines resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/group%2Frepo/pipelines?per_page=10": {
      status: 200,
      body: [{
        iid: 100,
        name: "Build",
        status: "success",
        source: "push",
        ref: "main",
        created_at: "2026-04-13T00:00:00Z",
        updated_at: "2026-04-13T00:00:00Z",
      }],
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
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("create_issue writes issueDetail resource", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/org%2Frepo/issues": {
      status: 201,
      body: {
        iid: 99,
        title: "New issue",
        description: "body",
        state: "opened",
        web_url: "https://git.example.org/org/repo/-/issues/99",
        labels: ["todo"],
        created_at: "2026-06-10T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
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
  } finally {
    restore();
  }
});

Deno.test("update_issue writes issueDetail resource", async () => {
  const restore = mockFetch({
    "PUT /api/v4/projects/org%2Frepo/issues/5": {
      status: 200,
      body: {
        iid: 5,
        title: "Updated",
        description: "",
        state: "opened",
        web_url: "https://git.example.org/org/repo/-/issues/5",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
      },
    },
  });
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
    restore();
  }
});

Deno.test("add_issue_note uses note-specific instance name", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/org%2Frepo/issues/3/notes": {
      status: 201,
      body: {
        id: 777,
        body: "My comment",
        author: { username: "me" },
        created_at: "2026-06-10T00:00:00Z",
      },
    },
  });
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
    restore();
  }
});

Deno.test("list_issue_notes writes notes resource with list instance name", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/issues/3/notes?per_page=50&sort=asc": {
      status: 200,
      body: [
        {
          id: 1,
          body: "first",
          author: { username: "a" },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          body: "second",
          author: { username: "b" },
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
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

Deno.test("create_merge_request writes mergeRequests resource", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/org%2Frepo/merge_requests": {
      status: 201,
      body: {
        iid: 10,
        title: "New MR",
        state: "opened",
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

Deno.test("merge writes MR state resource", async () => {
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

Deno.test("add_mr_note uses note-specific instance name", async () => {
  const restore = mockFetch({
    "POST /api/v4/projects/org%2Frepo/merge_requests/5/notes": {
      status: 201,
      body: {
        id: 888,
        body: "LGTM",
        author: { username: "reviewer" },
        created_at: "2026-06-10T00:00:00Z",
      },
    },
  });
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
    restore();
  }
});

Deno.test("list_labels writes labels resource with nullable description", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/labels?per_page=100": {
      status: 200,
      body: [
        { name: "bug", color: "#d9534f", description: "Something broken" },
        { name: "feature", color: "#5cb85c", description: null },
      ],
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
    assertEquals(data.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("list_members writes members resource", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects/org%2Frepo/members/all?per_page=100": {
      status: 200,
      body: [{ username: "dev", name: "Developer", access_level: 30 }],
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

Deno.test("list_branches writes branches resource", async () => {
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

Deno.test("API error throws with status and body", async () => {
  const restore = mockFetch({
    "GET /api/v4/projects?membership=true&per_page=30&order_by=last_activity_at&sort=desc":
      {
        status: 401,
        body: { error: "Unauthorized" },
      },
  });
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
