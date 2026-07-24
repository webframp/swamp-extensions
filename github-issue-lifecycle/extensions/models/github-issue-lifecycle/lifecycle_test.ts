import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertTransition,
  type MethodContext,
  model,
  type StoredResource,
  TRANSITIONS,
} from "./lifecycle.ts";

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

Deno.test("start arguments validates issue_number", () => {
  const valid = model.methods.start.arguments.safeParse({ issue_number: 42 });
  assertEquals(valid.success, true);
  const invalid = model.methods.start.arguments.safeParse({ issue_number: 0 });
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
    steps: ["step 1"],
  });
  assertEquals(valid.success, true);
  const missing = model.methods.plan.arguments.safeParse({
    issue_number: 1,
    summary: "Fix the thing",
  });
  assertEquals(missing.success, false);
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
  assertTransition("opened", "triaging");
  assertTransition("triaging", "classified");
  assertTransition("classified", "planned");
  assertTransition("planned", "approved");
  assertTransition("planned", "planned");
  assertTransition("approved", "implementing");
  assertTransition("implementing", "pr_open");
  assertTransition("implementing", "done");
  assertTransition("pr_open", "pr_failed");
  assertTransition("pr_open", "done");
  assertTransition("pr_failed", "pr_open");
  assertTransition("pr_failed", "implementing");
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
  ] as const;
  for (const phase of closeable) {
    assertTransition(phase, "closed");
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
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
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
  };
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

function makeContext(
  storedResources: StoredResource[] = [],
): { context: MethodContext; getWritten: () => StoredResource[] } {
  const written: StoredResource[] = [];
  return {
    context: {
      globalArgs: {
        repo: "webframp/swamp-extensions",
        postComments: false,
        syncLabels: false,
      },
      storedResources,
      writeResource: (spec: string, instance: string, data: unknown) => {
        written.push({
          specName: spec,
          instance,
          data: data as Record<string, unknown>,
        });
        return Promise.resolve({ name: instance });
      },
      logger: { info: () => {}, warn: () => {} },
    },
    getWritten: () => written,
  };
}

/** Helper to create a state resource for seeding storedResources. */
function stateResource(
  issueNumber: number,
  phase: string,
  startedAt = "2026-07-01T00:00:00Z",
  iteration = 0,
): StoredResource {
  return {
    specName: "state",
    instance: `issue-${issueNumber}`,
    data: {
      issueNumber,
      phase,
      previousPhase: null,
      transitionedAt: "2026-07-20T00:00:00Z",
      startedAt,
      iteration,
    },
  };
}

Deno.test("start: fetches issue and writes context + state", async () => {
  const issueJson = JSON.stringify({
    number: 42,
    title: "Fix pagination",
    body: "Off by one",
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
      if (args.includes("view")) return { stdout: issueJson, success: true };
      return { stdout: "", success: true };
    },
    async () => {
      const { context, getWritten } = makeContext();
      await model.methods.start.execute({ issue_number: 42 }, context);
      const written = getWritten();
      assertEquals(written.length, 2);
      assertEquals(written[0].specName, "context");
      assertEquals(written[0].data.title, "Fix pagination");
      assertEquals(written[1].specName, "state");
      assertEquals(written[1].data.phase, "triaging");
    },
  );
});

Deno.test("triage: enforces transition from triaging", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(10, "triaging"),
      ]);
      await model.methods.triage.execute(
        { issue_number: 10, kind: "feature", priority: "high" },
        context,
      );
      const written = getWritten();
      assertEquals(written[1].data.phase, "classified");
      assertEquals(written[1].data.previousPhase, "triaging");
    },
  );
});

Deno.test("triage: rejects invalid transition from approved", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context } = makeContext([stateResource(10, "approved")]);
      await assertRejects(
        () =>
          model.methods.triage.execute(
            { issue_number: 10, kind: "bug" },
            context,
          ),
        Error,
        "Invalid transition",
      );
    },
  );
});

Deno.test("plan: increments iteration from current state", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(5, "classified", "2026-07-01T00:00:00Z", 0),
      ]);
      await model.methods.plan.execute(
        { issue_number: 5, summary: "Add rate limiting", steps: ["step 1"] },
        context,
      );
      const written = getWritten();
      assertEquals(written[0].data.iteration, 1);
      assertEquals(written[1].data.iteration, 1);
      assertEquals(written[1].data.startedAt, "2026-07-01T00:00:00Z");
    },
  );
});

Deno.test("iterate: bumps iteration again", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(5, "planned", "2026-07-01T00:00:00Z", 1),
      ]);
      await model.methods.iterate.execute(
        {
          issue_number: 5,
          summary: "Revised",
          steps: ["new step"],
          feedback: "Changed approach",
        },
        context,
      );
      const written = getWritten();
      assertEquals(written[0].data.iteration, 2);
      assertEquals(written[1].data.iteration, 2);
    },
  );
});

Deno.test("approve: preserves iteration from planned state", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(5, "planned", "2026-07-01T00:00:00Z", 3),
      ]);
      await model.methods.approve.execute({ issue_number: 5 }, context);
      const written = getWritten();
      assertEquals(written[0].data.iteration, 3);
      assertEquals(written[0].data.startedAt, "2026-07-01T00:00:00Z");
    },
  );
});

Deno.test("link_pr: extracts PR number and transitions from implementing", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(7, "implementing"),
      ]);
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
      assertEquals(written[1].data.phase, "pr_open");
      assertEquals(written[1].data.previousPhase, "implementing");
    },
  );
});

Deno.test("link_pr: works from pr_failed (retry)", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(7, "pr_failed"),
      ]);
      await model.methods.link_pr.execute(
        {
          issue_number: 7,
          pr_url: "https://github.com/webframp/swamp-extensions/pull/265",
        },
        context,
      );
      assertEquals(getWritten()[1].data.previousPhase, "pr_failed");
    },
  );
});

Deno.test("pr_merged: writes pullRequest with status merged, preserves URL", async () => {
  let closeCalled = false;
  await withMockedCommand(
    (_cmd, args) => {
      if (args.includes("close")) closeCalled = true;
      return { stdout: "", success: true };
    },
    async () => {
      const prResource: StoredResource = {
        specName: "pullRequest",
        instance: "issue-7",
        data: {
          issueNumber: 7,
          prNumber: 261,
          prUrl: "https://github.com/webframp/swamp-extensions/pull/261",
          branch: "fix/thing",
          linkedAt: "2026-07-20T00:00:00Z",
          status: "open",
        },
      };
      const { context, getWritten } = makeContext([
        stateResource(7, "pr_open"),
        prResource,
      ]);
      await model.methods.pr_merged.execute({ issue_number: 7 }, context);
      const written = getWritten();
      assertEquals(written[0].specName, "pullRequest");
      assertEquals(written[0].data.status, "merged");
      assertEquals(written[0].data.prNumber, 261);
      assertEquals(
        written[0].data.prUrl,
        "https://github.com/webframp/swamp-extensions/pull/261",
      );
      assertEquals(written[1].data.phase, "done");
      assertEquals(closeCalled, true);
    },
  );
});

Deno.test("pr_failed: writes pullRequest with status failed and reason", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context, getWritten } = makeContext([
        stateResource(7, "pr_open"),
      ]);
      await model.methods.pr_failed.execute(
        { issue_number: 7, reason: "CI timeout" },
        context,
      );
      const written = getWritten();
      assertEquals(written[0].specName, "pullRequest");
      assertEquals(written[0].data.status, "failed");
      assertEquals(written[0].data.failureReason, "CI timeout");
      assertEquals(written[1].data.phase, "pr_failed");
    },
  );
});

Deno.test("close: rejects from terminal state", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context } = makeContext([stateResource(7, "done")]);
      await assertRejects(
        () => model.methods.close.execute({ issue_number: 7 }, context),
        Error,
        "terminal state",
      );
    },
  );
});

Deno.test("close: rejects when no lifecycle started", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const { context } = makeContext([]);
      await assertRejects(
        () => model.methods.close.execute({ issue_number: 99 }, context),
        Error,
        "No lifecycle state found",
      );
    },
  );
});

Deno.test("startedAt is preserved across transitions", async () => {
  await withMockedCommand(
    () => ({ stdout: "", success: true }),
    async () => {
      const originalStart = "2026-06-15T08:00:00Z";
      const { context, getWritten } = makeContext([
        stateResource(1, "implementing", originalStart, 2),
      ]);
      await model.methods.link_pr.execute(
        {
          issue_number: 1,
          pr_url: "https://github.com/webframp/swamp-extensions/pull/50",
        },
        context,
      );
      assertEquals(getWritten()[1].data.startedAt, originalStart);
    },
  );
});
