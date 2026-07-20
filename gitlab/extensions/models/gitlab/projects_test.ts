// GitLab Project Operations Model - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
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
    "delete_mr_note",
    "get_job_log",
    "get_merge_request",
    "get_pipeline_jobs",
    "get_project_info",
    "list_branches",
    "list_issue_notes",
    "list_issues",
    "list_labels",
    "list_members",
    "list_merge_requests",
    "list_mr_discussions",
    "list_mr_notes",
    "list_my_merge_requests",
    "list_pipelines",
    "list_projects",
    "list_releases",
    "list_todos",
    "mark_todo_done",
    "mark_todos_done",
    "merge",
    "rebase_merge_request",
    "remove_mr_reviewers",
    "resolve_mr_discussion",
    "retry_job",
    "retry_pipeline",
    "set_mr_assignees",
    "set_mr_reviewers",
    "unassign_from_mrs",
    "update_issue",
    "update_merge_request",
    "update_mr_note",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "branches",
    "bulkTodoResult",
    "dashboard",
    "discussionResolution",
    "discussions",
    "issueDetail",
    "issues",
    "jobLog",
    "labels",
    "members",
    "mergeRequests",
    "mergeStatus",
    "mrAssignees",
    "mrReviewers",
    "noteDeleted",
    "notes",
    "pipelineJobs",
    "pipelines",
    "projectInfo",
    "projects",
    "rebaseResult",
    "releases",
    "retryResult",
    "reviewerRemovalResult",
    "todoList",
    "unassignResult",
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

Deno.test("update_issue writes issueDetail resource via REST", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    // Expect a PUT to /api/v4/projects/.../issues/5
    if (init?.method === "PUT" && url.includes("/issues/5")) {
      const body = {
        iid: 5,
        title: "Updated",
        description: "",
        state: "opened",
        web_url: "https://git.example.org/org/repo/-/issues/5",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
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

Deno.test("list_mr_notes writes notes resource via GraphQL", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          notes: {
            nodes: [
              {
                id: "gid://gitlab/Note/10",
                body: "lgtm",
                author: { username: "a" },
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "gid://gitlab/Note/11",
                body: "one nit",
                author: { username: "b" },
                createdAt: "2026-01-02T00:00:00Z",
              },
            ],
            pageInfo: { hasPreviousPage: false },
          },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.list_mr_notes.execute(
      { project: "org/repo", iid: 7 },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].name, "org~repo-mr-7");
    const data = resources[0].data as any;
    assertEquals(data.count, 2);
    assertEquals(data.noteableType, "merge_request");
    assertEquals(data.notes[0].id, 10);
  } finally {
    restore();
  }
});

Deno.test("mark_todo_done succeeds and writes no resources", async () => {
  const restore = mockGraphqlFetch({
    data: {
      todoMarkDone: {
        todo: { id: "gid://gitlab/Todo/5", state: "done" },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    const res = await model.methods.mark_todo_done.execute(
      { todoId: "gid://gitlab/Todo/5" },
      context as any,
    );
    assertEquals(res.dataHandles.length, 0);
    assertEquals(getWrittenResources().length, 0);
  } finally {
    restore();
  }
});

Deno.test("mark_todo_done normalizes a numeric id to a Todo gid", async () => {
  let sentId = "";
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    if ((init?.method ?? "GET") === "POST" && url.includes("/api/graphql")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sentId = body.variables?.id ?? "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              todoMarkDone: { todo: { id: sentId, state: "done" }, errors: [] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.mark_todo_done.execute(
      { todoId: "2949150" },
      context as any,
    );
    assertEquals(sentId, "gid://gitlab/Todo/2949150");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("mark_todo_done throws on mutation errors", async () => {
  const restore = mockGraphqlFetch({
    data: { todoMarkDone: { todo: null, errors: ["Todo not found"] } },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.mark_todo_done.execute(
          { todoId: "gid://gitlab/Todo/9" },
          context as any,
        ),
      Error,
      "Todo not found",
    );
  } finally {
    restore();
  }
});

Deno.test("get_merge_request summarizes a non-mergeable MR", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          iid: 2127,
          title: "Update ruby",
          state: "opened",
          draft: false,
          detailedMergeStatus: "NEED_REBASE",
          mergeable: false,
          conflicts: false,
          headPipeline: { status: "SUCCESS" },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_merge_request.execute(
      { project: "group/proj", iid: 2127 },
      context as any,
    );
    const r = getWrittenResources().find((x) => x.specName === "mergeStatus");
    assertExists(r);
    const d = r.data as any;
    assertEquals(d.mergeable, false);
    assertEquals(d.detailedMergeStatus, "NEED_REBASE");
    assertEquals(d.blockers.length, 1);
    assertEquals(d.blockers[0].includes("rebased"), true);
    assertEquals(d.summary.includes("cannot merge"), true);
  } finally {
    restore();
  }
});

Deno.test("get_merge_request reports a mergeable MR with no blockers", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          iid: 5,
          title: "x",
          state: "opened",
          draft: false,
          detailedMergeStatus: "MERGEABLE",
          mergeable: true,
          conflicts: false,
          headPipeline: { status: "SUCCESS" },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_merge_request.execute(
      { project: "g/p", iid: 5 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "mergeStatus")!
      .data as any;
    assertEquals(d.mergeable, true);
    assertEquals(d.blockers.length, 0);
    assertEquals(d.summary.includes("is mergeable"), true);
  } finally {
    restore();
  }
});

Deno.test("get_merge_request throws when the MR is not found", async () => {
  const restore = mockGraphqlFetch({
    data: { project: { mergeRequest: null } },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.get_merge_request.execute(
          { project: "g/p", iid: 9 },
          context as any,
        ),
      Error,
      "not found",
    );
  } finally {
    restore();
  }
});

// Stateful mock for rebase polling: PUT → 202; successive GET polls return the
// queued statuses (clamping to the last). Poll interval is forced to 1ms.
function rebaseFetchMock(opts: {
  polls: Array<{ rebase_in_progress: boolean; merge_error?: string | null }>;
  onPut?: (url: string) => void;
}): () => void {
  const original = globalThis.fetch;
  let idx = 0;
  const json = (body: unknown, status: number) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const method = init?.method ?? "GET";
    if (method === "PUT" && url.includes("/rebase")) {
      opts.onPut?.(url);
      return json({ rebase_in_progress: true }, 202);
    }
    if (method === "GET" && url.includes("/merge_requests/")) {
      const step = opts.polls[Math.min(idx, opts.polls.length - 1)];
      idx++;
      return json(
        {
          rebase_in_progress: step.rebase_in_progress,
          merge_error: step.merge_error ?? null,
        },
        200,
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
  return () => {
    globalThis.fetch = original;
  };
}

function withFastRebasePolls(): () => void {
  const prev = Deno.env.get("SWAMP_GITLAB_REBASE_POLL_MS");
  Deno.env.set("SWAMP_GITLAB_REBASE_POLL_MS", "1");
  return () => {
    if (prev === undefined) Deno.env.delete("SWAMP_GITLAB_REBASE_POLL_MS");
    else Deno.env.set("SWAMP_GITLAB_REBASE_POLL_MS", prev);
  };
}

Deno.test("rebase_merge_request reports rebased after polling through in_progress", async () => {
  const restoreEnv = withFastRebasePolls();
  const restore = rebaseFetchMock({
    polls: [
      { rebase_in_progress: true },
      { rebase_in_progress: true },
      { rebase_in_progress: false, merge_error: null },
    ],
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.rebase_merge_request.execute(
      { project: "group/proj", iid: 2127, skipCi: false },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "rebaseResult")!
      .data as any;
    assertEquals(d.status, "rebased");
    assertEquals(d.mergeError, null);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("rebase_merge_request surfaces merge_error as an error status", async () => {
  const restoreEnv = withFastRebasePolls();
  const restore = rebaseFetchMock({
    polls: [
      { rebase_in_progress: true },
      { rebase_in_progress: false, merge_error: "conflict" },
    ],
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.rebase_merge_request.execute(
      { project: "group/proj", iid: 2223, skipCi: false },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "rebaseResult")!
      .data as any;
    assertEquals(d.status, "error");
    assertEquals(d.mergeError, "conflict");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("rebase_merge_request reports in_progress when it never completes", async () => {
  const restoreEnv = withFastRebasePolls();
  // Always in progress → loop exhausts REBASE_MAX_POLLS and reports in_progress.
  const restore = rebaseFetchMock({ polls: [{ rebase_in_progress: true }] });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.rebase_merge_request.execute(
      { project: "group/proj", iid: 2127, skipCi: false },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "rebaseResult")!
      .data as any;
    assertEquals(d.status, "in_progress");
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("rebase_merge_request appends skip_ci=true when requested", async () => {
  const restoreEnv = withFastRebasePolls();
  let putUrl = "";
  const restore = rebaseFetchMock({
    polls: [{ rebase_in_progress: false, merge_error: null }],
    onPut: (u) => (putUrl = u),
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.rebase_merge_request.execute(
      { project: "group/proj", iid: 2127, skipCi: true },
      context as any,
    );
    assertEquals(putUrl.includes("skip_ci=true"), true, `PUT url: ${putUrl}`);
  } finally {
    restore();
    restoreEnv();
  }
});

Deno.test("get_merge_request extracts the head pipeline id", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          iid: 7,
          title: "x",
          state: "opened",
          draft: false,
          detailedMergeStatus: "CI_MUST_PASS",
          mergeable: false,
          conflicts: false,
          headPipeline: {
            id: "gid://gitlab/Ci::Pipeline/12345",
            status: "FAILED",
          },
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_merge_request.execute(
      { project: "g/p", iid: 7 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "mergeStatus")!
      .data as any;
    assertEquals(d.headPipelineId, 12345);
    assertEquals(d.headPipelineStatus, "FAILED");
  } finally {
    restore();
  }
});

Deno.test("get_pipeline_jobs lists failed jobs with failure_reason", async () => {
  const pid = encodeURIComponent("group/proj");
  const restore = mockFetch({
    [`GET /api/v4/projects/${pid}/pipelines/999/jobs?per_page=100&scope=failed`]:
      {
        status: 200,
        body: [
          {
            id: 1,
            name: "lint",
            stage: "test",
            status: "failed",
            failure_reason: "script_failure",
            allow_failure: false,
            web_url: "https://x/1",
          },
          {
            id: 2,
            name: "flaky",
            stage: "test",
            status: "failed",
            failure_reason: "runner_system_failure",
            allow_failure: false,
            web_url: "https://x/2",
          },
          {
            // A success job in the response must be dropped by the scope filter.
            id: 3,
            name: "build",
            stage: "build",
            status: "success",
            failure_reason: null,
            allow_failure: false,
            web_url: "https://x/3",
          },
        ],
      },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_pipeline_jobs.execute(
      { project: "group/proj", pipelineId: 999, scope: "failed" },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "pipelineJobs")!
      .data as any;
    assertEquals(d.count, 2); // success job filtered out
    assertEquals(d.jobs.map((j: any) => j.id), [1, 2]);
    assertEquals(d.jobs[0].failureReason, "script_failure");
    assertEquals(d.jobs[1].failureReason, "runner_system_failure");
    assertEquals(d.truncated, false);
  } finally {
    restore();
  }
});

Deno.test("get_job_log returns the redacted tail of the trace", async () => {
  const original = globalThis.fetch;
  // 500 lines, one carries a token, ending with a newline (as real traces do)
  // — the trailing "" must not inflate the line count.
  const trace = Array.from(
    { length: 500 },
    (_, i) =>
      i === 479
        ? "Using PAT glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
        : `line ${i + 1}`,
  ).join("\n") + "\n";
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    if ((init?.method ?? "GET") === "GET" && url.includes("/jobs/77/trace")) {
      return Promise.resolve(
        new Response(trace, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_job_log.execute(
      { project: "group/proj", jobId: 77, tailLines: 50 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "jobLog")!
      .data as any;
    // trailing newline stripped → exactly 500 lines, tail is the last 50
    assertEquals(d.totalLines, 500);
    assertEquals(d.returnedLines, 50);
    assertEquals(d.truncated, true);
    assertEquals(d.log.split("\n").length, 50);
    assertEquals(d.log.endsWith("line 500"), true);
    // the token (which is inside the tail) is redacted
    assertEquals(d.log.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
    assertEquals(d.log.includes("[REDACTED]"), true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("get_merge_request handles an MR with no head pipeline", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          iid: 8,
          title: "x",
          state: "opened",
          draft: false,
          detailedMergeStatus: "MERGEABLE",
          mergeable: true,
          conflicts: false,
          headPipeline: null,
        },
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.get_merge_request.execute(
      { project: "g/p", iid: 8 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "mergeStatus")!
      .data as any;
    assertEquals(d.headPipelineId, null);
    assertEquals(d.headPipelineStatus, null);
  } finally {
    restore();
  }
});

Deno.test("retry_job surfaces a non-retryable job error", async () => {
  const pid = encodeURIComponent("group/proj");
  const restore = mockFetch({
    [`POST /api/v4/projects/${pid}/jobs/5/retry`]: {
      status: 403,
      body: { message: "403 Forbidden" },
    },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.retry_job.execute(
          { project: "group/proj", jobId: 5 },
          context as any,
        ),
      Error,
      "403",
    );
  } finally {
    restore();
  }
});

Deno.test("retry_job returns the new job id and status", async () => {
  const pid = encodeURIComponent("group/proj");
  const restore = mockFetch({
    [`POST /api/v4/projects/${pid}/jobs/1/retry`]: {
      status: 201,
      body: { id: 42, status: "pending" },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.retry_job.execute(
      { project: "group/proj", jobId: 1 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "retryResult")!
      .data as any;
    assertEquals(d.kind, "job");
    assertEquals(d.id, 1);
    assertEquals(d.newJobId, 42);
    assertEquals(d.status, "pending");
  } finally {
    restore();
  }
});

Deno.test("retry_pipeline records the pipeline retry", async () => {
  const pid = encodeURIComponent("group/proj");
  const restore = mockFetch({
    [`POST /api/v4/projects/${pid}/pipelines/999/retry`]: {
      status: 201,
      body: { id: 999, status: "running" },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.retry_pipeline.execute(
      { project: "group/proj", pipelineId: 999 },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "retryResult")!
      .data as any;
    assertEquals(d.kind, "pipeline");
    assertEquals(d.id, 999);
    assertEquals(d.status, "running");
  } finally {
    restore();
  }
});

Deno.test("update_mr_note sends the note gid and edits the note", async () => {
  const m = mockGraphqlCapture({
    data: {
      updateNote: {
        note: {
          id: "gid://gitlab/Note/5",
          body: "edited body",
          createdAt: "2026-01-01T00:00:00Z",
          author: { username: "operator" },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.update_mr_note.execute(
      { project: "group/proj", iid: 2156, noteId: 5, body: "edited body" },
      context as any,
    );
    assertEquals(m.vars().id, "gid://gitlab/Note/5");
    assertEquals(m.vars().body, "edited body");
    const d = getWrittenResources().find((x) => x.specName === "notes")!
      .data as any;
    assertEquals(d.notes[0].id, 5);
    assertEquals(d.notes[0].body, "edited body");
    assertEquals(d.noteableType, "merge_request");
  } finally {
    m.restore();
  }
});

Deno.test("delete_mr_note sends the note gid and records deletion", async () => {
  const m = mockGraphqlCapture({
    data: { destroyNote: { note: { id: "gid://gitlab/Note/5" }, errors: [] } },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.delete_mr_note.execute(
      { project: "group/proj", iid: 2156, noteId: 5 },
      context as any,
    );
    assertEquals(m.vars().id, "gid://gitlab/Note/5");
    const d = getWrittenResources().find((x) => x.specName === "noteDeleted")!
      .data as any;
    assertEquals(d.deleted, true);
    assertEquals(d.noteId, 5);
  } finally {
    m.restore();
  }
});

Deno.test("set_mr_assignees sends usernames with REPLACE and records result", async () => {
  const m = mockGraphqlCapture({
    data: {
      mergeRequestSetAssignees: {
        mergeRequest: {
          iid: "2156",
          assignees: { nodes: [{ username: "operator" }] },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.set_mr_assignees.execute(
      { project: "group/proj", iid: 2156, usernames: ["operator"] },
      context as any,
    );
    assertEquals(m.vars().usernames, ["operator"]);
    assertEquals(m.vars().projectPath, "group/proj");
    const d = getWrittenResources().find((x) => x.specName === "mrAssignees")!
      .data as any;
    assertEquals(d.assignees, ["operator"]);
  } finally {
    m.restore();
  }
});

Deno.test("set_mr_assignees with an empty list sends [] to unassign", async () => {
  const m = mockGraphqlCapture({
    data: {
      mergeRequestSetAssignees: {
        mergeRequest: { iid: "2156", assignees: { nodes: [] } },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.set_mr_assignees.execute(
      { project: "group/proj", iid: 2156, usernames: [] },
      context as any,
    );
    assertEquals(m.vars().usernames, []);
    const d = getWrittenResources().find((x) => x.specName === "mrAssignees")!
      .data as any;
    assertEquals(d.assignees, []);
  } finally {
    m.restore();
  }
});

Deno.test("set_mr_assignees throws when a requested user was not assigned", async () => {
  // GitLab silently omits an unknown user (no error) — the method must catch it.
  const m = mockGraphqlCapture({
    data: {
      mergeRequestSetAssignees: {
        mergeRequest: { iid: "2156", assignees: { nodes: [] } },
        errors: [],
      },
    },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.set_mr_assignees.execute(
          { project: "group/proj", iid: 2156, usernames: ["ghost"] },
          context as any,
        ),
      Error,
      "did not assign ghost",
    );
  } finally {
    m.restore();
  }
});

Deno.test("delete_mr_note throws on a null payload (permission denied)", async () => {
  // GitLab returns { destroyNote: null } when the caller can't delete the note.
  const restore = mockGraphqlFetch({ data: { destroyNote: null } });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.delete_mr_note.execute(
          { project: "group/proj", iid: 2156, noteId: 9999 },
          context as any,
        ),
      Error,
      "not found or permission denied",
    );
  } finally {
    restore();
  }
});

Deno.test("update_mr_note throws on a null payload (permission denied)", async () => {
  const restore = mockGraphqlFetch({ data: { updateNote: null } });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.update_mr_note.execute(
          { project: "group/proj", iid: 2156, noteId: 9999, body: "x" },
          context as any,
        ),
      Error,
      "not found or permission denied",
    );
  } finally {
    restore();
  }
});

Deno.test("set_mr_assignees matches usernames case-insensitively", async () => {
  // Request "DevUser"; GitLab returns lowercase "devuser" — must NOT throw.
  const restore = mockGraphqlFetch({
    data: {
      mergeRequestSetAssignees: {
        mergeRequest: {
          iid: "2156",
          assignees: { nodes: [{ username: "devuser" }] },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.set_mr_assignees.execute(
      { project: "group/proj", iid: 2156, usernames: ["DevUser"] },
      context as any,
    );
    const d = getWrittenResources().find((x) => x.specName === "mrAssignees")!
      .data as any;
    assertEquals(d.assignees, ["devuser"]);
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
            approvedBy: { nodes: [{ username: "testuser" }] },
            reviewers: {
              nodes: [
                {
                  username: "testuser",
                  mergeRequestInteraction: { reviewState: "APPROVED" },
                },
              ],
            },
            notes: { nodes: [{ author: { username: "testuser" } }] },
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
            project: {
              fullPath: "group/proj",
              nameWithNamespace: "Group / Proj",
            },
          },
        ],
      },
    },
  },
};

// Like mockGraphqlFetch but records the variables sent on the last GraphQL call
// so tests can assert what the method actually requested (not just echo output).
function mockGraphqlCapture(
  responseBody: unknown,
): { restore: () => void; vars: () => any } {
  const original = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    if ((init?.method ?? "GET") === "POST" && url.includes("/api/graphql")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sent = body.variables ?? null;
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    vars: () => sent,
  };
}

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
    // GitLab-flavored reference for the MR.
    assertEquals(data.reviewing[0].reference, "group/proj!101");
    assertEquals(data.reviewing[0].author, "alice");
    assertEquals(data.reviewing[0].labels, ["security"]);
    assertEquals(data.reviewing[0].approvedByMe, true);
    assertEquals(data.reviewing[0].myReviewState, "approved");
    assertEquals(data.reviewing[0].commented, true);
    // Verify assigned draft detection
    assertEquals(data.assigned[0].draft, true);
    // Verify todo mapping
    assertEquals(data.todos[0].action, "mentioned");
    assertEquals(data.todos[0].targetType, "MERGEREQUEST");
    assertEquals(data.todos[0].author, "alice");
    assertEquals(data.todos[0].project, "Group / Proj");
    // Reference + iid parsed from the todo's targetUrl (path is the slug, not
    // the display-name `project` field).
    assertEquals(data.todos[0].iid, 101);
    assertEquals(data.todos[0].reference, "group/proj!101");
  } finally {
    restore();
  }
});

Deno.test(
  "list_my_merge_requests derives issue (#) references and null for unparseable todos",
  async () => {
    const restore = mockGraphqlFetch({
      data: {
        currentUser: {
          username: "testuser",
          reviewRequestedMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          assignedMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          authoredMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          todos: {
            nodes: [
              {
                id: "gid://gitlab/Todo/9",
                action: "directly_addressed",
                body: "?",
                targetType: "ISSUE",
                targetUrl: "https://git.example.org/group/beta/-/issues/7",
                createdAt: "2026-06-11T12:00:00Z",
                author: { username: "as" },
                project: {
                  fullPath: "group/beta",
                  nameWithNamespace: "Appsvc / Planning",
                },
              },
              {
                id: "gid://gitlab/Todo/10",
                action: "mentioned",
                body: "?",
                // A target with no MR/issue path (e.g. an epic or design) —
                // reference and iid should be null, not a bad guess.
                targetType: "EPIC",
                targetUrl: "https://git.example.org/groups/beta/-/epics/3",
                createdAt: "2026-06-11T12:00:00Z",
                author: { username: "bh" },
                project: null,
              },
              {
                id: "gid://gitlab/Todo/11",
                action: "review_requested",
                body: "?",
                targetType: "MERGEREQUEST",
                // Nested subgroup + trailing URL segment: path comes from
                // fullPath (not the URL), iid from the /-/…/<n> tail.
                targetUrl:
                  "https://git.example.org/group/sub/proj/-/merge_requests/88/diffs",
                createdAt: "2026-06-11T12:00:00Z",
                author: { username: "wi" },
                project: {
                  fullPath: "group/sub/proj",
                  nameWithNamespace: "Group / Sub / Proj",
                },
              },
            ],
          },
        },
      },
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: TEST_GLOBAL_ARGS,
      });
      await model.methods.list_my_merge_requests.execute(
        { role: "all", state: "opened", includeArchived: false },
        context as any,
      );
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.todos[0].reference, "group/beta#7");
      assertEquals(data.todos[0].iid, 7);
      // Non MR/issue target: no fabricated reference.
      assertEquals(data.todos[1].reference, null);
      assertEquals(data.todos[1].iid, null);
      // Nested subgroup path + trailing /diffs segment.
      assertEquals(data.todos[2].reference, "group/sub/proj!88");
      assertEquals(data.todos[2].iid, 88);
    } finally {
      restore();
    }
  },
);

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

Deno.test(
  "list_my_merge_requests maps UNREVIEWED to pending",
  async () => {
    const response = {
      data: {
        currentUser: {
          username: "testuser",
          reviewRequestedMergeRequests: {
            nodes: [
              {
                iid: 501,
                title: "New feature",
                webUrl: "https://git.example.org/g/p/-/merge_requests/501",
                updatedAt: "2026-06-26T00:00:00Z",
                draft: false,
                project: { fullPath: "g/p" },
                author: { username: "dev" },
                labels: { nodes: [] },
                approvedBy: { nodes: [] },
                reviewers: {
                  nodes: [
                    {
                      username: "testuser",
                      mergeRequestInteraction: { reviewState: "UNREVIEWED" },
                    },
                  ],
                },
                notes: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          assignedMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          authoredMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
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
      await model.methods.list_my_merge_requests.execute(
        { role: "reviewer", state: "opened", includeArchived: false },
        context as any,
      );
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.reviewing[0].myReviewState, "pending");
      assertEquals(data.reviewing[0].approvedByMe, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_my_merge_requests maps REQUESTED_CHANGES to unapproved",
  async () => {
    const response = {
      data: {
        currentUser: {
          username: "testuser",
          reviewRequestedMergeRequests: {
            nodes: [
              {
                iid: 502,
                title: "Needs fixes",
                webUrl: "https://git.example.org/g/p/-/merge_requests/502",
                updatedAt: "2026-06-26T00:00:00Z",
                draft: false,
                project: { fullPath: "g/p" },
                author: { username: "dev" },
                labels: { nodes: [] },
                approvedBy: { nodes: [] },
                reviewers: {
                  nodes: [
                    {
                      username: "testuser",
                      mergeRequestInteraction: {
                        reviewState: "REQUESTED_CHANGES",
                      },
                    },
                  ],
                },
                notes: { nodes: [{ author: { username: "testuser" } }] },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          assignedMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          authoredMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
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
      await model.methods.list_my_merge_requests.execute(
        { role: "reviewer", state: "opened", includeArchived: false },
        context as any,
      );
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.reviewing[0].myReviewState, "unapproved");
      assertEquals(data.reviewing[0].commented, true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_my_merge_requests populates new fields on assigned MRs",
  async () => {
    const response = {
      data: {
        currentUser: {
          username: "testuser",
          reviewRequestedMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          assignedMergeRequests: {
            nodes: [
              {
                iid: 601,
                title: "Assigned to me",
                webUrl: "https://git.example.org/g/p/-/merge_requests/601",
                updatedAt: "2026-06-26T00:00:00Z",
                draft: false,
                project: { fullPath: "g/p" },
                author: { username: "other" },
                labels: { nodes: [] },
                approvedBy: { nodes: [{ username: "testuser" }] },
                reviewers: { nodes: [] },
                notes: { nodes: [{ author: { username: "testuser" } }] },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          authoredMergeRequests: {
            nodes: [],
            pageInfo: { hasNextPage: false },
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
      await model.methods.list_my_merge_requests.execute(
        { role: "assignee", state: "opened", includeArchived: false },
        context as any,
      );
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.assigned[0].approvedByMe, true);
      assertEquals(data.assigned[0].commented, true);
      assertEquals(data.assigned[0].myReviewState, null);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// unassign_from_mrs Tests
// =============================================================================

Deno.test(
  "unassign_from_mrs resolves the authenticated user and removes them across MRs via REMOVE",
  async () => {
    const requests: Array<{ query: string; variables: any }> = [];
    const original = globalThis.fetch;
    // Capturing mock. Combined body: the currentUser query reads `.currentUser`;
    // each remove mutation reads `.mergeRequestSetAssignees` from the same payload.
    globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse((init?.body as string) ?? "{}"));
      const body = {
        data: {
          currentUser: { username: "operator" },
          mergeRequestSetAssignees: {
            mergeRequest: {
              iid: 1,
              assignees: { nodes: [{ username: "otheruser" }] },
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
      await model.methods.unassign_from_mrs.execute(
        { project: "group/proj", iids: [2115, 2223] },
        context as unknown as Parameters<
          typeof model.methods.unassign_from_mrs.execute
        >[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "unassignResult");
      const data = resources[0].data as {
        username: string;
        results: Array<{ iid: number; remainingAssignees: string[] }>;
        failed: Array<{ iid: number; error: string }>;
      };
      assertEquals(data.username, "operator");
      assertEquals(data.results.map((r) => r.iid), [2115, 2223]);
      // Co-assignee preserved by REMOVE mode.
      assertEquals(data.results[0].remainingAssignees, ["otheruser"]);
      assertEquals(data.failed.length, 0);
      // The mutations must be REMOVE for the resolved user. A regression to
      // REPLACE (which would clobber co-assignees) fails here.
      const mutations = requests.filter((r) =>
        r.query.includes("mergeRequestSetAssignees")
      );
      assertEquals(mutations.length, 2);
      for (const m of mutations) {
        assertEquals(m.query.includes("operationMode: REMOVE"), true);
        assertEquals(m.variables.usernames, ["operator"]);
      }
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "unassign_from_mrs routes a still-assigned result (no GraphQL error) to failed",
  async () => {
    // GitLab returns success but the user is STILL present — the silent
    // non-removal case. Must not be reported as a success.
    const restore = mockGraphqlFetch({
      data: {
        currentUser: { username: "operator" },
        mergeRequestSetAssignees: {
          mergeRequest: {
            iid: 1,
            assignees: {
              nodes: [{ username: "operator" }, { username: "otheruser" }],
            },
          },
          errors: [],
        },
      },
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: TEST_GLOBAL_ARGS,
      });
      await model.methods.unassign_from_mrs.execute(
        { project: "group/proj", iids: [42] },
        context as unknown as Parameters<
          typeof model.methods.unassign_from_mrs.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        results: unknown[];
        failed: Array<{ iid: number; error: string }>;
      };
      assertEquals(data.results.length, 0);
      assertEquals(data.failed.map((f) => f.iid), [42]);
      assertEquals(data.failed[0].error.includes("still assigned"), true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "unassign_from_mrs throws when the authenticated user cannot be resolved",
  async () => {
    const restore = mockGraphqlFetch({ data: { currentUser: null } });
    try {
      const { context } = createModelTestContext({
        globalArgs: TEST_GLOBAL_ARGS,
      });
      await assertRejects(
        () =>
          model.methods.unassign_from_mrs.execute(
            { project: "group/proj", iids: [1] },
            context as unknown as Parameters<
              typeof model.methods.unassign_from_mrs.execute
            >[1],
          ),
        Error,
        "could not resolve the authenticated user",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "unassign_from_mrs records per-MR failures and still writes a result",
  async () => {
    const original = globalThis.fetch;
    // Body-inspecting mock: iid 20 returns a null payload (permission denied /
    // MR not found); iid 10 succeeds with a preserved co-assignee.
    globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse((init?.body as string) ?? "{}");
      const iid = parsed?.variables?.iid;
      const payload = iid === "20"
        ? { data: { mergeRequestSetAssignees: null } }
        : {
          data: {
            mergeRequestSetAssignees: {
              mergeRequest: {
                iid: 10,
                assignees: { nodes: [{ username: "keeper" }] },
              },
              errors: [],
            },
          },
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: TEST_GLOBAL_ARGS,
      });
      await model.methods.unassign_from_mrs.execute(
        { project: "group/proj", iids: [10, 20], username: "operator" },
        context as unknown as Parameters<
          typeof model.methods.unassign_from_mrs.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        results: Array<{ iid: number; remainingAssignees: string[] }>;
        failed: Array<{ iid: number; error: string }>;
      };
      assertEquals(data.results.map((r) => r.iid), [10]);
      assertEquals(data.results[0].remainingAssignees, ["keeper"]);
      assertEquals(data.failed.map((f) => f.iid), [20]);
      assertEquals(data.failed[0].error.length > 0, true);
    } finally {
      globalThis.fetch = original;
    }
  },
);

// =============================================================================
// list_mr_discussions / resolve_mr_discussion / add_mr_note reply
// =============================================================================

Deno.test("list_mr_discussions hoists fields, drops system-only threads", async () => {
  const restore = mockGraphqlFetch({
    data: {
      project: {
        mergeRequest: {
          discussions: {
            nodes: [
              {
                id: "gid://gitlab/Discussion/aaa",
                resolvable: true,
                resolved: false,
                resolvedBy: null,
                notes: {
                  nodes: [
                    {
                      id: "gid://gitlab/DiscussionNote/101",
                      system: false,
                      body: "needs a guard here",
                      createdAt: "2026-07-10T00:00:00Z",
                      author: { username: "operator" },
                      position: {
                        filePath: "src/app.ts",
                        oldLine: null,
                        newLine: 42,
                      },
                    },
                  ],
                },
              },
              {
                id: "gid://gitlab/Discussion/bbb",
                resolvable: false,
                resolved: false,
                resolvedBy: null,
                notes: {
                  nodes: [
                    {
                      id: "gid://gitlab/Note/9",
                      system: true,
                      body: "changed the description",
                      createdAt: "2026-07-10T00:00:00Z",
                      author: { username: "someone" },
                      position: null,
                    },
                  ],
                },
              },
              {
                id: "gid://gitlab/Discussion/ccc",
                resolvable: false,
                resolved: false,
                resolvedBy: null,
                notes: {
                  nodes: [
                    {
                      id: "gid://gitlab/Note/12",
                      system: false,
                      body: "general comment",
                      createdAt: "2026-07-10T00:00:00Z",
                      author: { username: "reviewer" },
                      position: null,
                    },
                  ],
                },
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
    await model.methods.list_mr_discussions.execute(
      { project: "group/proj", iid: 5 },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "discussions");
    const data = resources[0].data as {
      discussions: Array<
        {
          id: string;
          resolvable: boolean;
          resolved: boolean;
          file: string | null;
          line: number | null;
          author: string | null;
          notes: Array<{ id: number }>;
        }
      >;
      truncated: boolean;
    };
    // System-only thread bbb is dropped; aaa and ccc remain.
    assertEquals(data.discussions.map((d) => d.id), [
      "gid://gitlab/Discussion/aaa",
      "gid://gitlab/Discussion/ccc",
    ]);
    const a = data.discussions[0];
    assertEquals(a.resolvable, true);
    assertEquals(a.resolved, false);
    assertEquals(a.file, "src/app.ts");
    assertEquals(a.line, 42);
    assertEquals(a.author, "operator");
    assertEquals(a.notes[0].id, 101); // gid mapped to number
    // General comment ccc has no diff position.
    assertEquals(data.discussions[1].file, null);
    assertEquals(data.discussions[1].line, null);
    assertEquals(data.truncated, false);
    // Unresolved count is a CEL filter away — verify the data supports it.
    assertEquals(
      data.discussions.filter((d) => d.resolvable && !d.resolved).length,
      1,
    );
  } finally {
    restore();
  }
});

Deno.test("add_mr_note replies into a thread when discussionId is given", async () => {
  const cap = mockGraphqlCapture({
    data: {
      project: { mergeRequest: { id: "gid://gitlab/MergeRequest/999" } },
      createNote: {
        note: {
          id: "gid://gitlab/Note/1",
          body: "ack",
          createdAt: "2026-07-10T00:00:00Z",
          author: { username: "operator" },
        },
        errors: [],
      },
    },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.add_mr_note.execute(
      {
        project: "group/proj",
        iid: 5,
        body: "ack",
        discussionId: "gid://gitlab/Discussion/aaa",
      },
      context as any,
    );
    // The reply mutation carried the discussionId — a top-level createNote would not.
    assertEquals(cap.vars().discussionId, "gid://gitlab/Discussion/aaa");
    // ...and still targets the resolved MR gid.
    assertEquals(cap.vars().noteableId, "gid://gitlab/MergeRequest/999");
  } finally {
    cap.restore();
  }
});

Deno.test("resolve_mr_discussion records the new resolved state", async () => {
  const restore = mockGraphqlFetch({
    data: {
      discussionToggleResolve: {
        discussion: {
          id: "gid://gitlab/Discussion/aaa",
          resolved: true,
          resolvedBy: { username: "operator" },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.resolve_mr_discussion.execute(
      {
        project: "group/proj",
        iid: 5,
        discussionId: "gid://gitlab/Discussion/aaa",
        resolved: true,
      },
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      discussionId: string;
      resolved: boolean;
      resolvedBy: string | null;
    };
    assertEquals(getWrittenResources()[0].specName, "discussionResolution");
    assertEquals(data.resolved, true);
    assertEquals(data.resolvedBy, "operator");
  } finally {
    restore();
  }
});

Deno.test("resolve_mr_discussion throws on a null payload (permission denied)", async () => {
  const restore = mockGraphqlFetch({
    data: { discussionToggleResolve: null },
  });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.resolve_mr_discussion.execute(
          {
            project: "group/proj",
            iid: 5,
            discussionId: "gid://gitlab/Discussion/aaa",
            resolved: true,
          },
          context as any,
        ),
      Error,
      "null",
    );
  } finally {
    restore();
  }
});

// =============================================================================
// remove_mr_reviewers Tests
// =============================================================================

Deno.test("remove_mr_reviewers resolves self, removes via REMOVE, preserves co-reviewers", async () => {
  const cap = mockGraphqlCapture({
    data: {
      currentUser: { username: "operator" },
      mergeRequestSetReviewers: {
        mergeRequest: {
          iid: 334,
          reviewers: { nodes: [{ username: "other" }] },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.remove_mr_reviewers.execute(
      { project: "group/proj", iids: [334] },
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources[0].specName, "reviewerRemovalResult");
    const data = resources[0].data as {
      username: string;
      results: Array<{ iid: number; remainingReviewers: string[] }>;
      failed: Array<{ iid: number; error: string }>;
    };
    assertEquals(data.username, "operator");
    assertEquals(data.results.map((r) => r.iid), [334]);
    assertEquals(data.results[0].remainingReviewers, ["other"]);
    assertEquals(data.failed.length, 0);
    // The mutation targeted the resolved user's reviewer entry.
    assertEquals(cap.vars().usernames, ["operator"]);
  } finally {
    cap.restore();
  }
});

Deno.test("remove_mr_reviewers routes a still-a-reviewer result to failed", async () => {
  const restore = mockGraphqlFetch({
    data: {
      currentUser: { username: "operator" },
      mergeRequestSetReviewers: {
        mergeRequest: {
          iid: 1,
          reviewers: {
            nodes: [{ username: "operator" }, { username: "other" }],
          },
        },
        errors: [],
      },
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.remove_mr_reviewers.execute(
      { project: "group/proj", iids: [1] },
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      results: unknown[];
      failed: Array<{ iid: number; error: string }>;
    };
    assertEquals(data.results.length, 0);
    assertEquals(data.failed.map((f) => f.iid), [1]);
    assertEquals(data.failed[0].error.includes("still a reviewer"), true);
  } finally {
    restore();
  }
});

Deno.test("remove_mr_reviewers records a null payload as a per-MR failure", async () => {
  const restore = mockGraphqlFetch({
    data: {
      currentUser: { username: "operator" },
      mergeRequestSetReviewers: null,
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.remove_mr_reviewers.execute(
      { project: "group/proj", iids: [7] },
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      results: unknown[];
      failed: Array<{ iid: number; error: string }>;
    };
    assertEquals(data.results.length, 0);
    assertEquals(data.failed.map((f) => f.iid), [7]);
    assertEquals(data.failed[0].error.includes("null"), true);
  } finally {
    restore();
  }
});

Deno.test("remove_mr_reviewers throws when the authenticated user cannot be resolved", async () => {
  const restore = mockGraphqlFetch({ data: { currentUser: null } });
  try {
    const { context } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await assertRejects(
      () =>
        model.methods.remove_mr_reviewers.execute(
          { project: "group/proj", iids: [1] },
          context as any,
        ),
      Error,
      "could not resolve the authenticated user",
    );
  } finally {
    restore();
  }
});

Deno.test("remove_mr_reviewers isolates a per-MR failure and still writes a result", async () => {
  const original = globalThis.fetch;
  // iid 20 fails (null payload); iid 10 succeeds. username passed, so no currentUser call.
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse((init?.body as string) ?? "{}");
    const iid = parsed?.variables?.iid;
    const payload = iid === "20"
      ? { data: { mergeRequestSetReviewers: null } }
      : {
        data: {
          mergeRequestSetReviewers: {
            mergeRequest: {
              iid: 10,
              reviewers: { nodes: [{ username: "other" }] },
            },
            errors: [],
          },
        },
      };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_GLOBAL_ARGS,
    });
    await model.methods.remove_mr_reviewers.execute(
      { project: "group/proj", iids: [10, 20], username: "operator" },
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      results: Array<{ iid: number }>;
      failed: Array<{ iid: number }>;
    };
    assertEquals(data.results.map((r) => r.iid), [10]);
    assertEquals(data.failed.map((f) => f.iid), [20]);
  } finally {
    globalThis.fetch = original;
  }
});

// =============================================================================
// list_todos / mark_todos_done Tests
// =============================================================================

Deno.test("list_todos paginates across pages and hoists targetState", async () => {
  const original = globalThis.fetch;
  // Keyed by the `after` cursor so we return page 1 then page 2.
  const pages: Record<string, unknown> = {
    "null": {
      data: {
        currentUser: {
          username: "operator",
          todos: {
            nodes: [
              {
                id: "gid://gitlab/Todo/1",
                action: "review_requested",
                body: "b1",
                targetType: "MERGEREQUEST",
                targetUrl: "https://git.example.org/g/p/-/merge_requests/5",
                createdAt: "t",
                author: { username: "a" },
                project: { fullPath: "g/p", nameWithNamespace: "G / P" },
                target: { __typename: "MergeRequest", state: "merged" },
              },
              {
                id: "gid://gitlab/Todo/2",
                action: "mentioned",
                body: "b2",
                targetType: "ISSUE",
                targetUrl: "https://git.example.org/g/p/-/issues/7",
                createdAt: "t",
                author: { username: "a" },
                project: { fullPath: "g/p", nameWithNamespace: "G / P" },
                target: { __typename: "Issue", state: "opened" },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cur1" },
          },
        },
      },
    },
    "cur1": {
      data: {
        currentUser: {
          username: "operator",
          todos: {
            nodes: [
              {
                id: "gid://gitlab/Todo/3",
                action: "mentioned",
                body: "b3",
                targetType: "COMMIT",
                targetUrl: "https://git.example.org/g/p/-/commit/abc",
                createdAt: "t",
                author: { username: "a" },
                project: { fullPath: "g/p", nameWithNamespace: "G / P" },
                target: { __typename: "Commit" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const vars = JSON.parse((init?.body as string) ?? "{}").variables ?? {};
    const body = pages[String(vars.after)];
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
    await model.methods.list_todos.execute(
      { state: "pending", maxTodos: 2000 },
      context as any,
    );
    const res = getWrittenResources();
    assertEquals(res.length, 1);
    assertEquals(res[0].specName, "todoList");
    const data = res[0].data as {
      todos: Array<{ reference: string | null; targetState: string | null }>;
      count: number;
      truncated: boolean;
    };
    assertEquals(data.count, 3);
    assertEquals(data.truncated, false);
    // MR -> merged, Issue -> opened, non-stateful target (Commit) -> null.
    assertEquals(data.todos.map((t) => t.targetState), [
      "merged",
      "opened",
      null,
    ]);
    // reference is derived from fullPath + iid (MR uses !, issue uses #).
    assertEquals(data.todos[0].reference, "g/p!5");
    assertEquals(data.todos[1].reference, "g/p#7");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("list_todos respects the maxTodos cap and flags truncated", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, _init?: RequestInit) => {
    const body = {
      data: {
        currentUser: {
          username: "operator",
          todos: {
            nodes: [
              {
                id: "gid://gitlab/Todo/1",
                action: "x",
                body: "",
                targetType: "MERGEREQUEST",
                targetUrl: "https://git.example.org/g/p/-/merge_requests/1",
                createdAt: "t",
                author: { username: "a" },
                project: { fullPath: "g/p", nameWithNamespace: "G/P" },
                target: { __typename: "MergeRequest", state: "opened" },
              },
              {
                id: "gid://gitlab/Todo/2",
                action: "x",
                body: "",
                targetType: "MERGEREQUEST",
                targetUrl: "https://git.example.org/g/p/-/merge_requests/2",
                createdAt: "t",
                author: { username: "a" },
                project: { fullPath: "g/p", nameWithNamespace: "G/P" },
                target: { __typename: "MergeRequest", state: "opened" },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cur1" },
          },
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
    await model.methods.list_todos.execute(
      { state: "pending", maxTodos: 1 },
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      count: number;
      truncated: boolean;
    };
    assertEquals(data.count, 1);
    assertEquals(data.truncated, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("list_todos argument defaults to pending state and a 2000 cap", () => {
  const parsed = model.methods.list_todos.arguments.parse({});
  assertEquals(parsed.state, "pending");
  assertEquals(parsed.maxTodos, 2000);
});

Deno.test(
  "mark_todos_done fans out; null payloads and errors go to failed",
  async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
      const vars = JSON.parse((init?.body as string) ?? "{}").variables ?? {};
      seen.push(vars.id);
      let todoMarkDone: unknown;
      if (vars.id === "gid://gitlab/Todo/111") {
        todoMarkDone = { todo: { id: vars.id, state: "done" }, errors: [] };
      } else if (vars.id === "gid://gitlab/Todo/222") {
        todoMarkDone = null; // permission denied / not found
      } else {
        todoMarkDone = { todo: null, errors: ["Todo not found"] };
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { todoMarkDone } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: TEST_GLOBAL_ARGS,
      });
      await model.methods.mark_todos_done.execute(
        { todoIds: ["111", "gid://gitlab/Todo/222", "333"] },
        context as any,
      );
      const res = getWrittenResources();
      assertEquals(res[0].specName, "bulkTodoResult");
      const data = res[0].data as {
        results: Array<{ id: string; state: string }>;
        failed: Array<{ id: string; error: string }>;
        count: number;
      };
      assertEquals(data.count, 3);
      assertEquals(data.results.map((r) => r.id), ["gid://gitlab/Todo/111"]);
      assertEquals(data.failed.map((f) => f.id).sort(), [
        "gid://gitlab/Todo/222",
        "gid://gitlab/Todo/333",
      ]);
      // numeric ids are normalized to Todo gids before the mutation.
      assertEquals(seen.includes("gid://gitlab/Todo/111"), true);
      assertEquals(seen.includes("gid://gitlab/Todo/333"), true);
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "list_todos does not flag truncated when the cap equals the total on the final page",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const body = {
        data: {
          currentUser: {
            username: "operator",
            todos: {
              nodes: [
                {
                  id: "gid://gitlab/Todo/1",
                  action: "x",
                  body: "",
                  targetType: "MERGEREQUEST",
                  targetUrl: "https://git.example.org/g/p/-/merge_requests/1",
                  createdAt: "t",
                  author: { username: "a" },
                  project: { fullPath: "g/p", nameWithNamespace: "G/P" },
                  target: { __typename: "MergeRequest", state: "opened" },
                },
                {
                  id: "gid://gitlab/Todo/2",
                  action: "x",
                  body: "",
                  targetType: "MERGEREQUEST",
                  targetUrl: "https://git.example.org/g/p/-/merge_requests/2",
                  createdAt: "t",
                  author: { username: "a" },
                  project: { fullPath: "g/p", nameWithNamespace: "G/P" },
                  target: { __typename: "MergeRequest", state: "closed" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
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
      await model.methods.list_todos.execute(
        { state: "pending", maxTodos: 2 },
        context as any,
      );
      const data = getWrittenResources()[0].data as {
        count: number;
        truncated: boolean;
      };
      assertEquals(data.count, 2);
      // cap === total, but this was the last page (hasNextPage false), so the
      // backlog was fully read — truncated must be false.
      assertEquals(data.truncated, false);
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "mark_todos_done routes a null todo with empty errors to failed (unconfirmed)",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      // Non-null payload, no errors, but no echoed todo — unconfirmable.
      const body = { data: { todoMarkDone: { todo: null, errors: [] } } };
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
      await model.methods.mark_todos_done.execute(
        { todoIds: ["gid://gitlab/Todo/9"] },
        context as any,
      );
      const data = getWrittenResources()[0].data as {
        results: unknown[];
        failed: Array<{ id: string; error: string }>;
      };
      assertEquals(data.results.length, 0);
      assertEquals(data.failed.length, 1);
      assertEquals(data.failed[0].id, "gid://gitlab/Todo/9");
    } finally {
      globalThis.fetch = original;
    }
  },
);
