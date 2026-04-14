// GitHub Repository Operations Model - Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./repos.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/github");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.sort(), [
    "get_repo_info",
    "list_issues",
    "list_prs",
    "list_releases",
    "list_repos",
    "list_workflows",
  ]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames.sort(), [
    "issues",
    "pull_requests",
    "releases",
    "repo_info",
    "repos",
    "workflow_runs",
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

Deno.test("list_repos takes no arguments", () => {
  const result = model.methods.list_repos.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("get_repo_info requires repo argument", () => {
  const missing = model.methods.get_repo_info.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.get_repo_info.arguments.safeParse({
    repo: "octocat/Hello-World",
  });
  assertEquals(valid.success, true);
});

Deno.test("list_prs requires repo, state defaults to open", () => {
  const valid = model.methods.list_prs.arguments.safeParse({
    repo: "owner/repo",
  });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.state, "open");
  }
});

Deno.test("list_prs accepts all state values", () => {
  for (const state of ["open", "closed", "merged", "all"]) {
    const result = model.methods.list_prs.arguments.safeParse({
      repo: "o/r",
      state,
    });
    assertEquals(result.success, true, `state '${state}' should be valid`);
  }
});

Deno.test("list_issues requires repo, state defaults to open", () => {
  const valid = model.methods.list_issues.arguments.safeParse({
    repo: "owner/repo",
  });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.state, "open");
  }
});

Deno.test("list_issues accepts all state values", () => {
  for (const state of ["open", "closed", "all"]) {
    const result = model.methods.list_issues.arguments.safeParse({
      repo: "o/r",
      state,
    });
    assertEquals(result.success, true, `state '${state}' should be valid`);
  }
});

Deno.test("list_releases requires repo argument", () => {
  const missing = model.methods.list_releases.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.list_releases.arguments.safeParse({
    repo: "owner/repo",
  });
  assertEquals(valid.success, true);
});

Deno.test("list_workflows requires repo argument", () => {
  const missing = model.methods.list_workflows.arguments.safeParse({});
  assertEquals(missing.success, false);

  const valid = model.methods.list_workflows.arguments.safeParse({
    repo: "owner/repo",
  });
  assertEquals(valid.success, true);
});

// =============================================================================
// Global Arguments Schema Tests
// =============================================================================

Deno.test("globalArguments accepts empty object", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, true);
});

// =============================================================================
// Resource Schema Tests
// =============================================================================

Deno.test("repos resource schema validates correctly", () => {
  const schema = model.resources.repos.schema;
  const result = schema.safeParse({
    repos: [{
      name: "test-repo",
      description: "A test repository",
      isPrivate: false,
      isFork: false,
      stargazerCount: 10,
      updatedAt: "2026-01-01T00:00:00Z",
      primaryLanguage: { name: "TypeScript" },
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("repos resource schema accepts null primaryLanguage", () => {
  const schema = model.resources.repos.schema;
  const result = schema.safeParse({
    repos: [{
      name: "empty-repo",
      description: null,
      isPrivate: true,
      isFork: false,
      stargazerCount: 0,
      updatedAt: "2026-01-01T00:00:00Z",
      primaryLanguage: null,
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("pull_requests resource schema validates correctly", () => {
  const schema = model.resources.pull_requests.schema;
  const result = schema.safeParse({
    repo: "owner/repo",
    pullRequests: [{
      number: 1,
      title: "Fix bug",
      state: "OPEN",
      author: { login: "dev" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      labels: [{ name: "bugfix" }],
    }],
    count: 1,
    state: "open",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("issues resource schema validates correctly", () => {
  const schema = model.resources.issues.schema;
  const result = schema.safeParse({
    repo: "owner/repo",
    issues: [{
      number: 42,
      title: "Feature request",
      state: "OPEN",
      author: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      labels: [],
    }],
    count: 1,
    state: "open",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("releases resource schema validates correctly", () => {
  const schema = model.resources.releases.schema;
  const result = schema.safeParse({
    repo: "owner/repo",
    releases: [{
      tagName: "v1.0.0",
      name: "First Release",
      publishedAt: "2026-01-01T00:00:00Z",
      isPrerelease: false,
      isDraft: false,
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("workflow_runs resource schema validates correctly", () => {
  const schema = model.resources.workflow_runs.schema;
  const result = schema.safeParse({
    repo: "owner/repo",
    workflowRuns: [{
      name: "CI",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      headBranch: "main",
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// Execute Tests (with mocked gh CLI)
// =============================================================================

Deno.test("list_repos writes repos resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
            name: "my-repo",
            description: "Test repo",
            isPrivate: false,
            isFork: false,
            stargazerCount: 5,
            updatedAt: "2026-04-13T00:00:00Z",
            primaryLanguage: { name: "TypeScript" },
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_repos.execute({} as any, context as any);

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "all");

    const data = resources[0].data as {
      count: number;
      repos: { name: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.repos[0].name, "my-repo");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("get_repo_info writes repo_info resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
          name: "my-repo",
          description: "A great repo",
          defaultBranchRef: { name: "main" },
          stargazerCount: 10,
          forkCount: 3,
          issues: { totalCount: 5 },
          pullRequests: { totalCount: 2 },
          watchers: { totalCount: 8 },
          licenseInfo: { name: "MIT License" },
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2026-04-13T00:00:00Z",
        })),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.get_repo_info.execute(
      { repo: "owner/my-repo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "owner-my-repo");

    const data = resources[0].data as { name: string; stargazerCount: number };
    assertEquals(data.name, "my-repo");
    assertEquals(data.stargazerCount, 10);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_prs writes pull_requests resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
            number: 42,
            title: "Add feature",
            state: "OPEN",
            author: { login: "dev" },
            createdAt: "2026-04-13T00:00:00Z",
            updatedAt: "2026-04-13T00:00:00Z",
            labels: [{ name: "enhancement" }],
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_prs.execute(
      { repo: "owner/repo", state: "open" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "owner-repo-open");

    const data = resources[0].data as {
      count: number;
      pullRequests: { number: number }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.pullRequests[0].number, 42);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_issues writes issues resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
            number: 10,
            title: "Bug report",
            state: "OPEN",
            author: { login: "user" },
            createdAt: "2026-04-13T00:00:00Z",
            updatedAt: "2026-04-13T00:00:00Z",
            labels: [{ name: "bug" }],
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_issues.execute(
      { repo: "owner/repo", state: "open" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "owner-repo-open");

    const data = resources[0].data as {
      count: number;
      issues: { number: number; title: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.issues[0].title, "Bug report");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_releases writes releases resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
            tagName: "v1.0.0",
            name: "First Release",
            publishedAt: "2026-01-01T00:00:00Z",
            isPrerelease: false,
            isDraft: false,
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_releases.execute(
      { repo: "owner/repo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "owner-repo");

    const data = resources[0].data as {
      count: number;
      releases: { tagName: string }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.releases[0].tagName, "v1.0.0");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("list_workflows writes workflow_runs resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
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
            name: "CI",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-04-13T00:00:00Z",
            updatedAt: "2026-04-13T00:00:00Z",
            headBranch: "main",
          },
        ])),
        stderr: new Uint8Array(),
      };
    }
  };

  try {
    await model.methods.list_workflows.execute(
      { repo: "owner/repo" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].name, "owner-repo");

    const data = resources[0].data as {
      count: number;
      workflowRuns: { name: string; conclusion: string | null }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.workflowRuns[0].name, "CI");
    assertEquals(data.workflowRuns[0].conclusion, "success");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("gh command failure throws error", async () => {
  const { context } = createModelTestContext({
    globalArgs: {},
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
      await model.methods.list_repos.execute({} as any, context as any);
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("gh command failed"), true);
    }
    assertEquals(threw, true);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
