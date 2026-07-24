import { assertEquals, assertThrows } from "@std/assert";
import { assertTransition, model, TRANSITIONS } from "./lifecycle.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/github-issue-lifecycle");
  assertEquals(model.version, "2026.07.24.1");
});

Deno.test("model has all expected methods", () => {
  const expected = [
    "start",
    "triage",
    "plan",
    "iterate",
    "approve",
    "implement",
    "link_pr",
    "pr_merged",
    "pr_failed",
    "complete",
    "close",
    "status",
  ];
  const actual = Object.keys(model.methods);
  for (const m of expected) {
    assertEquals(actual.includes(m), true, `Missing method: ${m}`);
  }
});

Deno.test("model has all expected resources", () => {
  const expected = [
    "state",
    "context",
    "classification",
    "plan",
    "pullRequest",
  ];
  const actual = Object.keys(model.resources);
  for (const r of expected) {
    assertEquals(actual.includes(r), true, `Missing resource: ${r}`);
  }
});

// =============================================================================
// Schema Validation Tests
// =============================================================================

Deno.test("globalArguments requires repo", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArguments accepts repo with defaults", () => {
  const result = model.globalArguments.safeParse({
    repo: "webframp/swamp-extensions",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.postComments, true);
    assertEquals(result.data.syncLabels, true);
  }
});

Deno.test("globalArguments allows disabling comments and labels", () => {
  const result = model.globalArguments.parse({
    repo: "webframp/swamp-extensions",
    postComments: false,
    syncLabels: false,
  });
  assertEquals(result.postComments, false);
  assertEquals(result.syncLabels, false);
});

Deno.test("start arguments validates issue_number", () => {
  const valid = model.methods.start.arguments.safeParse({
    issue_number: 42,
  });
  assertEquals(valid.success, true);

  const invalid = model.methods.start.arguments.safeParse({
    issue_number: 0,
  });
  assertEquals(invalid.success, false);
});

Deno.test("triage arguments validates kind enum", () => {
  const valid = model.methods.triage.arguments.safeParse({
    issue_number: 1,
    kind: "bug",
  });
  assertEquals(valid.success, true);

  const invalid = model.methods.triage.arguments.safeParse({
    issue_number: 1,
    kind: "unknown",
  });
  assertEquals(invalid.success, false);
});

Deno.test("plan arguments requires summary and steps", () => {
  const valid = model.methods.plan.arguments.safeParse({
    issue_number: 1,
    summary: "Fix the thing",
    steps: ["step 1", "step 2"],
  });
  assertEquals(valid.success, true);

  const missing = model.methods.plan.arguments.safeParse({
    issue_number: 1,
    summary: "Fix the thing",
  });
  assertEquals(missing.success, false);
});

Deno.test("iterate arguments requires iteration >= 2", () => {
  const valid = model.methods.iterate.arguments.safeParse({
    issue_number: 1,
    summary: "Revised",
    steps: ["new step"],
    feedback: "Changed approach",
    iteration: 2,
  });
  assertEquals(valid.success, true);

  const tooLow = model.methods.iterate.arguments.safeParse({
    issue_number: 1,
    summary: "Revised",
    steps: ["new step"],
    feedback: "Changed approach",
    iteration: 1,
  });
  assertEquals(tooLow.success, false);
});

Deno.test("link_pr arguments validates URL", () => {
  const valid = model.methods.link_pr.arguments.safeParse({
    issue_number: 1,
    pr_url: "https://github.com/webframp/swamp-extensions/pull/100",
  });
  assertEquals(valid.success, true);

  const invalid = model.methods.link_pr.arguments.safeParse({
    issue_number: 1,
    pr_url: "not-a-url",
  });
  assertEquals(invalid.success, false);
});

// =============================================================================
// State Machine Transition Tests
// =============================================================================

Deno.test("assertTransition allows valid transitions", () => {
  // Should not throw
  assertTransition("opened", "triaging");
  assertTransition("triaging", "classified");
  assertTransition("classified", "planned");
  assertTransition("planned", "approved");
  assertTransition("planned", "planned"); // iterate loop
  assertTransition("approved", "implementing");
  assertTransition("implementing", "pr_open");
  assertTransition("implementing", "done"); // complete
  assertTransition("pr_open", "pr_failed");
  assertTransition("pr_open", "done"); // pr_merged or complete
  assertTransition("pr_failed", "pr_open"); // retry
  assertTransition("pr_failed", "implementing"); // restart
});

Deno.test("assertTransition rejects invalid transitions", () => {
  assertThrows(() => assertTransition("opened", "done"));
  assertThrows(() => assertTransition("triaging", "implementing"));
  assertThrows(() => assertTransition("classified", "pr_open"));
  assertThrows(() => assertTransition("approved", "planned"));
});

Deno.test("assertTransition allows close from all non-terminal states", () => {
  const closeable = [
    "triaging",
    "classified",
    "planned",
    "approved",
    "implementing",
    "pr_open",
    "pr_failed",
  ];
  for (const phase of closeable) {
    assertTransition(phase as Parameters<typeof assertTransition>[0], "closed");
  }
});

Deno.test("TRANSITIONS covers all expected source phases", () => {
  const expectedSources = [
    "opened",
    "triaging",
    "classified",
    "planned",
    "approved",
    "implementing",
    "pr_open",
    "pr_failed",
  ];
  for (const phase of expectedSources) {
    assertEquals(phase in TRANSITIONS, true, `Missing: ${phase}`);
  }
});

// =============================================================================
// Behavioral Tests with mocked Deno.Command
// =============================================================================

const OriginalCommand = Deno.Command;

type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  class MockCommand {
    #cmd: string;
    #args: string[];

    constructor(
      cmd: string,
      options: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = options?.args ?? [];
    }

    output(): Promise<{
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode(result.stdout),
      });
    }
  }

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

function makeContext(repo = "webframp/swamp-extensions") {
  const written: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    context: {
      globalArgs: { repo, postComments: false, syncLabels: false },
      writeResource: (
        specName: string,
        name: string,
        data: unknown,
      ) => {
        written.push({
          specName,
          name,
          data: data as Record<string, unknown>,
        });
        return Promise.resolve({ name });
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
    },
    getWritten: () => written,
  };
}

Deno.test("start: fetches issue and writes context + state", async () => {
  const issueJson = JSON.stringify({
    number: 42,
    title: "Fix pagination",
    body: "Off by one in list handler",
    author: { login: "sme" },
    labels: [{ name: "bug" }],
    assignees: [{ login: "sme" }],
    state: "OPEN",
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    url: "https://github.com/webframp/swamp-extensions/issues/42",
  });

  await withMockedCommand(
    (_cmd, args) => {
      if (args.includes("view")) {
        return { stdout: issueJson, success: true };
      }
      return { stdout: "", success: true };
    },
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.start.execute({ issue_number: 42 }, context);

      const written = getWritten();
      assertEquals(written.length, 2);

      // Context resource
      assertEquals(written[0].specName, "context");
      assertEquals(written[0].data.title, "Fix pagination");
      assertEquals(written[0].data.author, "sme");

      // State resource
      assertEquals(written[1].specName, "state");
      assertEquals(written[1].data.phase, "triaging");
      assertEquals(written[1].data.issueNumber, 42);
    },
  );
});

Deno.test("triage: writes classification and transitions to classified", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.triage.execute(
        {
          issue_number: 10,
          kind: "feature",
          priority: "high",
          component: "auth",
        },
        context,
      );

      const written = getWritten();
      assertEquals(written.length, 2);

      assertEquals(written[0].specName, "classification");
      assertEquals(written[0].data.kind, "feature");
      assertEquals(written[0].data.priority, "high");
      assertEquals(written[0].data.component, "auth");

      assertEquals(written[1].specName, "state");
      assertEquals(written[1].data.phase, "classified");
    },
  );
});

Deno.test("plan: writes plan and transitions to planned", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.plan.execute(
        {
          issue_number: 5,
          summary: "Add rate limiting",
          steps: ["Add middleware", "Configure limits", "Add tests"],
        },
        context,
      );

      const written = getWritten();
      assertEquals(written[0].specName, "plan");
      assertEquals(written[0].data.summary, "Add rate limiting");
      assertEquals((written[0].data.steps as string[]).length, 3);
      assertEquals(written[0].data.iteration, 1);

      assertEquals(written[1].specName, "state");
      assertEquals(written[1].data.phase, "planned");
    },
  );
});

Deno.test("link_pr: extracts PR number from URL", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.link_pr.execute(
        {
          issue_number: 7,
          pr_url: "https://github.com/webframp/swamp-extensions/pull/261",
        },
        context,
      );

      const written = getWritten();
      assertEquals(written[0].specName, "pullRequest");
      assertEquals(written[0].data.prNumber, 261);
      assertEquals(written[0].data.status, "open");

      assertEquals(written[1].specName, "state");
      assertEquals(written[1].data.phase, "pr_open");
    },
  );
});

Deno.test("pr_merged: transitions to done and closes issue", async () => {
  let closeCalled = false;
  await withMockedCommand(
    (_cmd, args) => {
      if (args.includes("close")) closeCalled = true;
      return { stdout: "", success: true };
    },
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.pr_merged.execute(
        { issue_number: 7 },
        context,
      );

      const written = getWritten();
      assertEquals(written[0].specName, "state");
      assertEquals(written[0].data.phase, "done");
      assertEquals(closeCalled, true);
    },
  );
});
