// GitLab Project Operations Model - Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./projects.ts";

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
    "get_project_info",
    "list_issues",
    "list_merge_requests",
    "list_pipelines",
    "list_projects",
    "list_releases",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "issues",
    "mergeRequests",
    "pipelines",
    "projectInfo",
    "projects",
    "releases",
  ]);
});

Deno.test("all methods have descriptions", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assertExists(
      method.description,
      `Method ${name} should have a description`,
    );
  }
});

// =============================================================================
// Method Argument Schema Tests
// =============================================================================

Deno.test("list_projects takes no arguments", () => {
  const result = model.methods.list_projects.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("get_project_info requires project argument", () => {
  const missing = model.methods.get_project_info.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.get_project_info.arguments.safeParse({
    project: "mygroup/myproject",
  });
  assertEquals(valid.success, true);
});

Deno.test("list_merge_requests requires project, state defaults to opened", () => {
  const valid = model.methods.list_merge_requests.arguments.safeParse({
    project: "mygroup/myproject",
  });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.state, "opened");
  }
});

Deno.test("list_merge_requests accepts all state values", () => {
  for (const state of ["opened", "closed", "merged", "all"]) {
    const result = model.methods.list_merge_requests.arguments.safeParse({
      project: "g/p",
      state,
    });
    assertEquals(result.success, true, `state '${state}' should be valid`);
  }
});

Deno.test("list_issues requires project, state defaults to opened", () => {
  const valid = model.methods.list_issues.arguments.safeParse({
    project: "mygroup/myproject",
  });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.state, "opened");
  }
});

Deno.test("list_issues accepts all state values", () => {
  for (const state of ["opened", "closed", "all"]) {
    const result = model.methods.list_issues.arguments.safeParse({
      project: "g/p",
      state,
    });
    assertEquals(result.success, true, `state '${state}' should be valid`);
  }
});

Deno.test("list_releases requires project argument", () => {
  const missing = model.methods.list_releases.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.list_releases.arguments.safeParse({
    project: "mygroup/myproject",
  });
  assertEquals(valid.success, true);
});

Deno.test("list_pipelines requires project argument", () => {
  const missing = model.methods.list_pipelines.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.list_pipelines.arguments.safeParse({
    project: "mygroup/myproject",
  });
  assertEquals(valid.success, true);
});

// =============================================================================
// Global Arguments Schema Tests
// =============================================================================

Deno.test("globalArguments host defaults to empty string", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.host, "");
  }
});

Deno.test("globalArguments accepts custom host", () => {
  const result = model.globalArguments.safeParse({
    host: "git.example.org",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.host, "git.example.org");
  }
});

// =============================================================================
// Resource Schema Tests
// =============================================================================

Deno.test("projects resource schema validates correctly", () => {
  const schema = model.resources.projects.schema;
  const result = schema.safeParse({
    projects: [{
      name: "test",
      pathWithNamespace: "group/test",
      description: "A test project",
      visibility: "internal",
      starCount: 5,
      forksCount: 2,
      lastActivityAt: "2026-01-01T00:00:00Z",
      defaultBranch: "main",
      archived: false,
      topics: ["ci"],
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("mergeRequests resource schema validates correctly", () => {
  const schema = model.resources.mergeRequests.schema;
  const result = schema.safeParse({
    project: "group/test",
    mergeRequests: [{
      iid: 1,
      title: "Fix bug",
      state: "opened",
      author: { username: "dev" },
      sourceBranch: "fix-bug",
      targetBranch: "main",
      draft: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      labels: ["bugfix"],
    }],
    count: 1,
    state: "opened",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("pipelines resource schema validates correctly", () => {
  const schema = model.resources.pipelines.schema;
  const result = schema.safeParse({
    project: "group/test",
    pipelines: [{
      iid: 42,
      name: "Build",
      status: "success",
      source: "push",
      ref: "main",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// Execute Tests (with mocked glab)
// =============================================================================

Deno.test("list_projects writes projects resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify([
          {
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
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    // Cast needed because model defines inline context type
    // deno-lint-ignore no-explicit-any
    await model.methods.list_projects.execute({} as any, context as any);

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "projects");
    assertEquals(resources[0].name, "all");

    const data = resources[0].data as {
      count: number;
      projects: { name: string; pathWithNamespace: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.projects[0].name, "TestProject");
    assertEquals(data.projects[0].pathWithNamespace, "group/test-project");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_merge_requests writes mergeRequests resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "git.example.org" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify([
          {
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
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_merge_requests.execute(
      { project: "group/repo", state: "opened" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "mergeRequests");
    assertEquals(resources[0].name, "group~repo-opened");

    const data = resources[0].data as {
      count: number;
      mergeRequests: { iid: number; sourceBranch: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.mergeRequests[0].iid, 42);
    assertEquals(data.mergeRequests[0].sourceBranch, "feature");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_pipelines writes pipelines resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify([
          {
            iid: 100,
            name: "Build",
            status: "success",
            source: "push",
            ref: "main",
            created_at: "2026-04-13T00:00:00Z",
            updated_at: "2026-04-13T00:00:00Z",
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_pipelines.execute(
      { project: "group/repo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "pipelines");
    assertEquals(resources[0].name, "group~repo");

    const data = resources[0].data as {
      pipelines: { status: string }[];
    };
    assertEquals(data.pipelines[0].status, "success");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("get_project_info writes projectInfo resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify({
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
          web_url: "https://gitlab.com/org/myrepo",
          created_at: "2025-01-01T00:00:00Z",
          last_activity_at: "2026-04-01T00:00:00Z",
        })),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.get_project_info.execute(
      { project: "org/myrepo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "projectInfo");
    assertEquals(resources[0].name, "org~myrepo");

    const data = resources[0].data as { name: string; webUrl: string };
    assertEquals(data.name, "MyRepo");
    assertEquals(data.webUrl, "https://gitlab.com/org/myrepo");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_issues writes issues resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify([
          {
            iid: 7,
            title: "Bug report",
            state: "opened",
            author: { username: "tester" },
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-02T00:00:00Z",
            labels: ["bug"],
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_issues.execute(
      { project: "org/repo", state: "opened" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "issues");
    assertEquals(resources[0].name, "org~repo-opened");

    const data = resources[0].data as {
      count: number;
      issues: { iid: number; title: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.issues[0].iid, 7);
    assertEquals(data.issues[0].title, "Bug report");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_releases writes releases resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify([
          {
            tag_name: "v1.0.0",
            name: "First Release",
            created_at: "2026-03-01T00:00:00Z",
            released_at: "2026-03-01T00:00:00Z",
            upcoming_release: false,
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_releases.execute(
      { project: "org/repo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "releases");
    assertEquals(resources[0].name, "org~repo");

    const data = resources[0].data as {
      count: number;
      releases: { tagName: string; name: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.releases[0].tagName, "v1.0.0");
    assertEquals(data.releases[0].name, "First Release");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("glab command failure throws error", async () => {
  const { context } = createModelTestContext({
    globalArgs: { host: "" },
  });

  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, _opts: unknown) {}
    async output() {
      await Promise.resolve();
      return {
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("auth required"),
      };
    }
  };

  try {
    let threw = false;
    try {
      // deno-lint-ignore no-explicit-any
      await model.methods.list_projects.execute({} as any, context as any);
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("glab command failed"), true);
    }
    assertEquals(threw, true);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
