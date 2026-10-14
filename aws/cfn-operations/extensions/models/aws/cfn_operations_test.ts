// AWS CloudFormation Operations Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { CloudFormationClient } from "npm:@aws-sdk/client-cloudformation@3.1139.0";
import { model } from "./cfn_operations.ts";

type Handler = (commandName: string, input: Record<string, unknown>) => unknown;

function mockClient(handler: Handler): () => void {
  const orig = CloudFormationClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  const fake = function (command: any) {
    try {
      return Promise.resolve(
        handler(command.constructor.name, command.input ?? {}),
      );
    } catch (err) {
      return Promise.reject(err);
    }
  };
  CloudFormationClient.prototype.send = fake as typeof orig;
  return () => {
    CloudFormationClient.prototype.send = orig;
  };
}

function ctx() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: { id: "test-id", name: "cfn-ops", version: 1, tags: {} },
  });
}

// deno-lint-ignore no-explicit-any
const asCtx = (c: any) => c as any;

const stack = (status: string, reason?: string) => ({
  Stacks: [{
    StackId: "arn:aws:cloudformation:us-east-1:1:stack/s/abc",
    StackName: "s",
    StackStatus: status,
    StackStatusReason: reason,
  }],
});

const run = (
  context: ReturnType<typeof ctx>["context"],
  args: Record<string, unknown>,
) =>
  model.methods.continue_update_rollback.execute(
    model.methods.continue_update_rollback.arguments.parse(args),
    asCtx(context),
  );

Deno.test("refuses any status but UPDATE_ROLLBACK_FAILED and sends nothing", async () => {
  const calls: string[] = [];
  const restore = mockClient((name) => {
    calls.push(name);
    return stack("UPDATE_COMPLETE");
  });
  try {
    const { context } = ctx();
    await assertRejects(
      () => run(context, { stackName: "s" }),
      Error,
      "UPDATE_COMPLETE",
    );
    assertEquals(calls, ["DescribeStacksCommand"]);
  } finally {
    restore();
  }
});

Deno.test("submits with ResourcesToSkip and records a settled success", async () => {
  let sent: Record<string, unknown> | undefined;
  let describes = 0;
  const restore = mockClient((name, input) => {
    if (name === "ContinueUpdateRollbackCommand") {
      sent = input;
      return {};
    }
    describes++;
    // 1: precheck, 2: right after submit, 3+: settled
    return stack(
      describes === 1 ? "UPDATE_ROLLBACK_FAILED" : "UPDATE_ROLLBACK_COMPLETE",
    );
  });
  try {
    const { context, getWrittenResources } = ctx();
    await run(context, { stackName: "s", resourcesToSkip: ["Db"] });
    assertEquals(sent?.ResourcesToSkip, ["Db"]);
    const out = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(out.statusBefore, "UPDATE_ROLLBACK_FAILED");
    assertEquals(out.succeeded, true);
    assertEquals(out.settled, true);
  } finally {
    restore();
  }
});

Deno.test("waitSeconds=0 submits and returns without polling", async () => {
  let describes = 0;
  const restore = mockClient((name) => {
    if (name === "ContinueUpdateRollbackCommand") return {};
    describes++;
    return stack(
      describes === 1
        ? "UPDATE_ROLLBACK_FAILED"
        : "UPDATE_ROLLBACK_IN_PROGRESS",
    );
  });
  try {
    const { context, getWrittenResources } = ctx();
    await run(context, { stackName: "s", waitSeconds: 0 });
    assertEquals(describes, 2);
    const out = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(out.settled, false);
    assertEquals(out.succeeded, false);
  } finally {
    restore();
  }
});

Deno.test("a rollback that fails again is recorded, not reported as success", async () => {
  let describes = 0;
  const restore = mockClient((name) => {
    if (name === "ContinueUpdateRollbackCommand") return {};
    describes++;
    return stack("UPDATE_ROLLBACK_FAILED", "denied");
  });
  try {
    const { context, getWrittenResources } = ctx();
    await run(context, { stackName: "s", waitSeconds: 0 });
    const out = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(out.succeeded, false);
    assertEquals(out.statusReason, "denied");
    assertEquals(describes, 2);
  } finally {
    restore();
  }
});

Deno.test("wraps API errors with stack and region", async () => {
  const restore = mockClient((name) => {
    if (name === "ContinueUpdateRollbackCommand") throw new Error("boom");
    return stack("UPDATE_ROLLBACK_FAILED");
  });
  try {
    const { context } = ctx();
    const err = await assertRejects(() => run(context, { stackName: "s" }));
    assertMatch((err as Error).message, /region=us-east-1.*boom/);
  } finally {
    restore();
  }
});

Deno.test("rejects the reserved instance name 'latest'", () => {
  const r = model.methods.continue_update_rollback.arguments.safeParse({
    stackName: "s",
    instanceName: "latest",
  });
  assertEquals(r.success, false);
});
