import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { extension } from "./triage.ts";

Deno.test("triage augmentation exposes only its scoped methods", () => {
  assertEquals(Object.keys(extension.methods[0]).sort(), [
    "add_issue_comment",
    "close_issue",
    "create_issue",
    "get_issue_context",
    "get_pull_request_context",
    "get_workflow_run",
    "merge_pull_request",
    "retry_workflow_run",
    "watch_pr_checks",
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
    await extension.methods[0].get_issue_context.execute(
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

Deno.test("get_pull_request_context bounds both comments and reviews", async () => {
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
          number: 5,
          title: "Example",
          comments: [{ id: 1 }, { id: 2 }, { id: 3 }],
          reviews: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
        })),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].get_pull_request_context.execute(
      { repo: "webframp/swamp-extensions", number: 5, maxComments: 2 },
      context as never,
    );
    const written = getWrittenResources();
    const contextData = written[0].data as {
      context: { comments: unknown[]; reviews: unknown[] };
    };
    assertEquals(contextData.context.comments.length, 2);
    assertEquals(contextData.context.reviews.length, 2);
    assertEquals(contextData.context.reviews[0], { id: "r2" });
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
Deno.test("create_issue parses the created issue number from gh's output URL", async () => {
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
        stdout: new TextEncoder().encode(
          "https://github.com/webframp/swamp-extensions/issues/42\n",
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].create_issue.execute(
      {
        repo: "webframp/swamp-extensions",
        title: "Example",
        body: "Body",
        idempotencyKey: "create-1",
      },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    const action = written[0].data as { target: number };
    assertEquals(action.target, 42);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("create_issue throws when gh's output does not contain a parseable issue URL", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode("not a url"),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await assertRejects(
      () =>
        extension.methods[0].create_issue.execute(
          {
            repo: "webframp/swamp-extensions",
            title: "Example",
            body: "Body",
            idempotencyKey: "create-2",
          },
          context as never,
        ),
      Error,
      "Could not parse issue number",
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("create_issue rejects an idempotency key that would close its HTML comment marker early", () => {
  assertEquals(
    extension.methods[0].create_issue.arguments.safeParse({
      repo: "webframp/swamp-extensions",
      title: "Example",
      body: "Body",
      idempotencyKey: "create-1--><script>evil</script>",
    }).success,
    false,
  );
});
Deno.test("create_issue redacts --body and --title from a gh failure message", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      return Promise.resolve({
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("permission denied"),
      });
    }
  };
  try {
    await assertRejects(
      () =>
        extension.methods[0].create_issue.execute(
          {
            repo: "webframp/swamp-extensions",
            title: "Sensitive title",
            body: "Sensitive body contents",
            idempotencyKey: "create-fail-1",
          },
          context as never,
        ),
      Error,
      "[redacted]",
    );
    let message = "";
    try {
      await extension.methods[0].create_issue.execute(
        {
          repo: "webframp/swamp-extensions",
          title: "Sensitive title",
          body: "Sensitive body contents",
          idempotencyKey: "create-fail-2",
        },
        context as never,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message.includes("Sensitive"), false);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
Deno.test("get_issue_context uses collision-resistant resource names across repos", async () => {
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
          number: 1,
          title: "Example",
          comments: [],
        })),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].get_issue_context.execute(
      { repo: "a-b/c", number: 1, maxComments: 10 },
      context as never,
    );
    await extension.methods[0].get_issue_context.execute(
      { repo: "a/b-c", number: 1, maxComments: 10 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written[0].name === written[1].name, false);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("create_issue does not call gh twice for the same idempotency key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      callCount++;
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          "https://github.com/webframp/swamp-extensions/issues/42\n",
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const args = {
      repo: "webframp/swamp-extensions",
      title: "Example",
      body: "Body",
      idempotencyKey: "create-1",
    };
    await extension.methods[0].create_issue.execute(args, context as never);
    await extension.methods[0].create_issue.execute(args, context as never);
    assertEquals(callCount, 1);
    assertEquals(getWrittenResources().length, 1);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("add_issue_comment does not call gh twice for the same idempotency key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      callCount++;
      return Promise.resolve({
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const args = {
      repo: "webframp/swamp-extensions",
      number: 7,
      body: "Comment",
      idempotencyKey: "comment-1",
    };
    await extension.methods[0].add_issue_comment.execute(
      args,
      context as never,
    );
    await extension.methods[0].add_issue_comment.execute(
      args,
      context as never,
    );
    assertEquals(callCount, 1);
    assertEquals(getWrittenResources().length, 1);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

/** Mock `gh pr checks --json ...` returning a queued sequence of check-list responses. */
function mockPrChecksSequence(
  responses: Array<{ name: string; bucket: string; link: string }[]>,
) {
  let callIndex = 0;
  return class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      const checks = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(JSON.stringify(checks)),
        stderr: new Uint8Array(),
      });
    }
  };
}

Deno.test("watch_pr_checks succeeds once no check is pending and all pass", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = mockPrChecksSequence([
    [{ name: "check-a", bucket: "pending", link: "" }],
    [{ name: "check-a", bucket: "pass", link: "" }],
  ]);
  try {
    await extension.methods[0].watch_pr_checks.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        timeoutSeconds: 2,
        pollIntervalSeconds: 1,
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("watch_pr_checks keeps polling when gh reports no checks yet (empty list), rather than failing immediately", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = mockPrChecksSequence([
    [],
    [{ name: "check-a", bucket: "pass", link: "" }],
  ]);
  try {
    await extension.methods[0].watch_pr_checks.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        timeoutSeconds: 2,
        pollIntervalSeconds: 1,
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("watch_pr_checks fails when a check's bucket is fail", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = mockPrChecksSequence([
    [
      { name: "check-a", bucket: "pass", link: "" },
      { name: "check-b", bucket: "fail", link: "" },
    ],
  ]);
  try {
    await extension.methods[0].watch_pr_checks.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        timeoutSeconds: 1,
        pollIntervalSeconds: 1,
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "failed");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("watch_pr_checks fails (timed out) when checks stay pending past timeoutSeconds", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = mockPrChecksSequence([
    [{ name: "check-a", bucket: "pending", link: "" }],
  ]);
  try {
    await extension.methods[0].watch_pr_checks.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        timeoutSeconds: 1,
        pollIntervalSeconds: 1,
      },
      context as never,
    );
    const written = getWrittenResources();
    const data = written[written.length - 1].data as {
      result: { status: string; timedOut: boolean };
    };
    assertEquals(data.result.status, "failed");
    assertEquals(data.result.timedOut, true);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("merge_pull_request posts the approval comment and reports succeeded once merged", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  const calls: string[][] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.args = options.args;
    }
    output() {
      calls.push(this.args);
      if (this.args[0] === "pr" && this.args[1] === "comment") {
        return Promise.resolve({
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify({ state: "MERGED", mergedAt: "2026-09-17T00:00:00Z" }),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].merge_pull_request.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        approvalComment: "/shipit",
        timeoutSeconds: 1,
        pollIntervalSeconds: 1,
        idempotencyKey: "merge-1",
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
    assertEquals(
      calls.filter((a) => a[0] === "pr" && a[1] === "comment").length,
      1,
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("merge_pull_request reports failed when the PR closes without merging", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.args = options.args;
    }
    output() {
      if (this.args[0] === "pr" && this.args[1] === "comment") {
        return Promise.resolve({
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify({ state: "CLOSED", mergedAt: null }),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].merge_pull_request.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        approvalComment: "/shipit",
        timeoutSeconds: 1,
        pollIntervalSeconds: 1,
        idempotencyKey: "merge-2",
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "failed");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("merge_pull_request does not repost the comment for the same idempotency key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.args = options.args;
    }
    output() {
      callCount++;
      if (this.args[0] === "pr" && this.args[1] === "comment") {
        return Promise.resolve({
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify({ state: "MERGED", mergedAt: "2026-09-17T00:00:00Z" }),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const args = {
      repo: "webframp/swamp-extensions",
      number: 423,
      approvalComment: "/shipit",
      timeoutSeconds: 1,
      pollIntervalSeconds: 1,
      idempotencyKey: "merge-3",
    };
    await extension.methods[0].merge_pull_request.execute(
      args,
      context as never,
    );
    const callCountAfterFirst = callCount;
    const writtenAfterFirst = getWrittenResources().length;
    await extension.methods[0].merge_pull_request.execute(
      args,
      context as never,
    );
    assertEquals(callCount, callCountAfterFirst);
    assertEquals(getWrittenResources().length, writtenAfterFirst);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("watch_pr_checks recovers from a transient gh failure mid-poll", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callIndex = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("network blip"),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify([{ name: "check-a", bucket: "pass", link: "" }]),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].watch_pr_checks.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        timeoutSeconds: 2,
        pollIntervalSeconds: 1,
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
    assertEquals(callIndex, 2);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("merge_pull_request recovers from a transient gh failure mid-poll", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let viewCalls = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.args = options.args;
    }
    output() {
      if (this.args[0] === "pr" && this.args[1] === "comment") {
        return Promise.resolve({
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      viewCalls++;
      if (viewCalls === 1) {
        return Promise.resolve({
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("network blip"),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify({ state: "MERGED", mergedAt: "2026-09-17T00:00:00Z" }),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].merge_pull_request.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        approvalComment: "/shipit",
        timeoutSeconds: 2,
        pollIntervalSeconds: 1,
        idempotencyKey: "merge-5",
      },
      context as never,
    );
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
    assertEquals(viewCalls, 2);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("merge_pull_request resumes polling without reposting after an interrupted attempt left a 'posted' marker", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  // Simulate a prior interrupted attempt: comment already posted, marker
  // recorded, but the process crashed before polling completed.
  await context.writeResource(
    "triageAction",
    `${encodeURIComponent("webframp/swamp-extensions")}-merge-merge-4`,
    {
      repo: "webframp/swamp-extensions",
      action: "merge_pull_request",
      target: 423,
      idempotencyKey: "merge-4",
      result: { status: "posted" },
      recordedAt: new Date(0).toISOString(),
    },
  );
  let commentCalls = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.args = options.args;
    }
    output() {
      if (this.args[0] === "pr" && this.args[1] === "comment") {
        commentCalls++;
        return Promise.resolve({
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify({ state: "MERGED", mergedAt: "2026-09-17T00:00:00Z" }),
        ),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await extension.methods[0].merge_pull_request.execute(
      {
        repo: "webframp/swamp-extensions",
        number: 423,
        approvalComment: "/shipit",
        timeoutSeconds: 1,
        pollIntervalSeconds: 1,
        idempotencyKey: "merge-4",
      },
      context as never,
    );
    assertEquals(commentCalls, 0);
    const written = getWrittenResources();
    const result =
      (written[written.length - 1].data as { result: { status: string } })
        .result;
    assertEquals(result.status, "succeeded");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

Deno.test("retry_workflow_run does not call gh twice for the same idempotency key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      callCount++;
      return Promise.resolve({
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const args = {
      repo: "webframp/swamp-extensions",
      runId: 99,
      failedOnly: false,
      idempotencyKey: "retry-1",
    };
    await extension.methods[0].retry_workflow_run.execute(
      args,
      context as never,
    );
    await extension.methods[0].retry_workflow_run.execute(
      args,
      context as never,
    );
    assertEquals(callCount, 1);
    assertEquals(getWrittenResources().length, 1);
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
    await extension.methods[0].close_issue.execute(
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

Deno.test("close_issue does not call gh twice for the same idempotency key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const originalCommand = Deno.Command;
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_command: string, _options: unknown) {}
    output() {
      callCount++;
      return Promise.resolve({
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const args = {
      repo: "webframp/swamp-extensions",
      number: 7,
      idempotencyKey: "close-7",
    };
    await extension.methods[0].close_issue.execute(args, context as never);
    await extension.methods[0].close_issue.execute(args, context as never);
    assertEquals(callCount, 1);
    assertEquals(getWrittenResources().length, 1);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
