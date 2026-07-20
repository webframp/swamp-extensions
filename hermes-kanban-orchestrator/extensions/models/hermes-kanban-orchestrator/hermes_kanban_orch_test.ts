// Hermes Kanban Orchestrator - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./hermes_kanban_orch.ts";

// =============================================================================
// Command Mock
// =============================================================================

function mockDenoCommand(
  handler: (cmd: string[]) => { stdout: string; success: boolean },
): () => void {
  const original = Deno.Command;
  (Deno as any).Command = class {
    #cmd: string[];
    constructor(bin: string, opts: any) {
      this.#cmd = [bin, ...(opts.args ?? [])];
    }
    output() {
      const result = handler(this.#cmd);
      return Promise.resolve({
        stdout: new TextEncoder().encode(result.stdout),
        stderr: new TextEncoder().encode(""),
        success: result.success,
      });
    }
    spawn() {
      const result = handler(this.#cmd);
      return {
        output: () =>
          Promise.resolve({
            stdout: new TextEncoder().encode(result.stdout),
            stderr: new TextEncoder().encode(""),
            success: result.success,
          }),
        kill: () => {},
      };
    }
  };
  return () => {
    (Deno as any).Command = original;
  };
}

const TEST_ARGS = { hermesBin: "hermes", repoDir: "/tmp/test", board: "test" };

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/hermes-kanban-orchestrator");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has expected methods", () => {
  assertEquals(Object.keys(model.methods).sort(), ["list_recent", "new_task"]);
});

// =============================================================================
// Schema Tests
// =============================================================================

Deno.test("new_task requires type and title", () => {
  const r = model.methods.new_task.arguments.safeParse({});
  assertEquals(r.success, false);
  const valid = model.methods.new_task.arguments.safeParse({
    type: "daily-journal",
    title: "Test",
  });
  assertEquals(valid.success, true);
});

Deno.test("list_recent defaults limit to 10", () => {
  const r = model.methods.list_recent.arguments.safeParse({});
  assertEquals(r.success, true);
  if (r.success) assertEquals(r.data.limit, 10);
});

// =============================================================================
// Execute Tests
// =============================================================================

Deno.test("new_task creates task and writes resource", async () => {
  const restore = mockDenoCommand((cmd) => {
    if (cmd.includes("create")) {
      return { stdout: JSON.stringify({ id: "abc123def456" }), success: true };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.new_task.execute(
      {
        type: "daily-journal",
        title: "Test task",
        assignee: "researcher",
      } as any,
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "kanbanTask");
    const data = resources[0].data as any;
    assertEquals(data.kanbanId, "abc123def456");
    assertEquals(data.status, "created");
  } finally {
    restore();
  }
});

Deno.test("new_task handles idempotent duplicate", async () => {
  const restore = mockDenoCommand((cmd) => {
    if (cmd.includes("create")) {
      return {
        stdout: "Task abc123def456 already exists",
        success: false,
      };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.new_task.execute(
      {
        type: "daily-journal",
        title: "Dup task",
        assignee: "researcher",
      } as any,
      context as any,
    );
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.status, "exists");
    assertEquals(data.kanbanId, "abc123def456");
  } finally {
    restore();
  }
});

Deno.test("new_task throws on non-duplicate failure", async () => {
  const restore = mockDenoCommand(() => ({
    stdout: "Permission denied",
    success: false,
  }));
  try {
    const { context } = createModelTestContext({ globalArgs: TEST_ARGS });
    await assertRejects(
      () =>
        model.methods.new_task.execute(
          {
            type: "research-topic",
            title: "Fail",
            assignee: "researcher",
          } as any,
          context as any,
        ),
      Error,
      "Permission denied",
    );
  } finally {
    restore();
  }
});

Deno.test("new_task passes -- before title to prevent flag injection", async () => {
  let capturedCmd: string[] = [];
  const restore = mockDenoCommand((cmd) => {
    capturedCmd = cmd;
    return { stdout: JSON.stringify({ id: "aaa111bbb222" }), success: true };
  });
  try {
    const { context } = createModelTestContext({ globalArgs: TEST_ARGS });
    await model.methods.new_task.execute(
      {
        type: "daily-journal",
        title: "--malicious-flag",
        assignee: "researcher",
      } as any,
      context as any,
    );
    // Verify -- appears before the title
    const dashIdx = capturedCmd.indexOf("--");
    const titleIdx = capturedCmd.indexOf("--malicious-flag");
    assertEquals(dashIdx > -1, true);
    assertEquals(titleIdx > dashIdx, true);
  } finally {
    restore();
  }
});

Deno.test("list_recent parses array response", async () => {
  const restore = mockDenoCommand((cmd) => {
    if (cmd.includes("list")) {
      return {
        stdout: JSON.stringify([
          { id: "t1", title: "Task 1", status: "todo", type: "daily-journal" },
          { id: "t2", title: "Task 2", status: "done", type: "research-topic" },
        ]),
        success: true,
      };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.list_recent.execute(
      { limit: 10 } as any,
      context as any,
    );
    const resources = getWrittenResources();
    assertEquals(resources.length, 2);
    assertEquals((resources[0].data as any).kanbanId, "t1");
    assertEquals((resources[1].data as any).kanbanId, "t2");
  } finally {
    restore();
  }
});

Deno.test("list_recent parses {results: [...]} response", async () => {
  const restore = mockDenoCommand((cmd) => {
    if (cmd.includes("list")) {
      return {
        stdout: JSON.stringify({
          results: [{ id: "r1", title: "R1", status: "todo" }],
        }),
        success: true,
      };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.list_recent.execute(
      { limit: 10 } as any,
      context as any,
    );
    assertEquals(getWrittenResources().length, 1);
    assertEquals((getWrittenResources()[0].data as any).kanbanId, "r1");
  } finally {
    restore();
  }
});

Deno.test("list_recent returns empty on failure", async () => {
  const restore = mockDenoCommand(() => ({
    stdout: "error",
    success: false,
  }));
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.list_recent.execute(
      { limit: 10 } as any,
      context as any,
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    restore();
  }
});

Deno.test("list_recent respects limit", async () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    status: "todo",
  }));
  const restore = mockDenoCommand((cmd) => {
    if (cmd.includes("list")) {
      return { stdout: JSON.stringify(tasks), success: true };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.list_recent.execute(
      { limit: 3 } as any,
      context as any,
    );
    assertEquals(getWrittenResources().length, 3);
  } finally {
    restore();
  }
});

Deno.test("list_recent passes --type filter when type is set", async () => {
  let capturedCmd: string[] = [];
  const restore = mockDenoCommand((cmd) => {
    capturedCmd = cmd;
    return { stdout: "[]", success: true };
  });
  try {
    const { context } = createModelTestContext({ globalArgs: TEST_ARGS });
    await model.methods.list_recent.execute(
      { type: "daily-journal", limit: 10 } as any,
      context as any,
    );
    assertEquals(capturedCmd.includes("--type"), true);
    assertEquals(capturedCmd.includes("daily-journal"), true);
  } finally {
    restore();
  }
});
