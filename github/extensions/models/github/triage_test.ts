import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { extension } from "./triage.ts";

Deno.test("triage augmentation exposes only its scoped methods", () => {
  assertEquals(Object.keys(extension.methods).sort(), [
    "add_issue_comment",
    "close_issue",
    "create_issue",
    "get_issue_context",
    "get_pull_request_context",
    "get_workflow_run",
    "retry_workflow_run",
  ]);
});

Deno.test("get_issue_context bounds stored comments", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify({
          number: 7,
          title: "Example",
          comments: [{ id: 1 }, { id: 2 }, { id: 3 }],
        })),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods.get_issue_context.execute(
      { repo: "webframp/swamp-extensions", number: 7, maxComments: 2 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    const contextData = written[0].data as { context: { comments: unknown[] } };
    assertEquals(contextData.context.comments.length, 2);
    assertEquals(contextData.context.comments[0], { id: 2 });
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("close_issue uses the approved target and records evidence", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let argumentsSeen: string[] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, options: { args: string[] }) {
      argumentsSeen = options.args;
    }
    output() {
      return Promise.resolve({
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods.close_issue.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 7,
        idempotencyKey: "close-7",
      },
      context as never,
    );
    assertEquals(argumentsSeen, [
      "issue",
      "close",
      "7",
      "--repo",
      "webframp/swamp-extensions",
    ]);
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name.endsWith("-close-close-7"), true);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
