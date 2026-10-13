// AWS CloudFormation Diagnostics Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { CloudFormationClient } from "npm:@aws-sdk/client-cloudformation@3.1139.0";
import { CloudTrailClient } from "npm:@aws-sdk/client-cloudtrail@3.1139.0";
import { model } from "./cfn_diagnostics.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

type Handler = (commandName: string, input: Record<string, unknown>) => unknown;

/**
 * Replace CloudFormationClient.send / CloudTrailClient.send with a handler
 * that sees the command name and its input. A handler may throw to simulate an
 * API error. Returns a restore function; always call it in `finally`.
 */
function mockClients(handler: Handler): () => void {
  const origCfn = CloudFormationClient.prototype.send;
  const origTrail = CloudTrailClient.prototype.send;
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
  CloudFormationClient.prototype.send = fake as typeof origCfn;
  CloudTrailClient.prototype.send = fake as typeof origTrail;
  return () => {
    CloudFormationClient.prototype.send = origCfn;
    CloudTrailClient.prototype.send = origTrail;
  };
}

function ctx() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: { id: "test-id", name: "cfn-diag", version: 1, tags: {} },
  });
}

type Ctx = ReturnType<typeof ctx>["context"];

// Each method's execute() takes a different args type; the tests pass
// schema-valid literals, so cast the context once here.
// deno-lint-ignore no-explicit-any
const asCtx = (c: Ctx) => c as any;

class AwsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

const ARN =
  "arn:aws:cloudformation:us-east-1:123456789012:stack/app/11111111-aaaa";
const NESTED_ARN =
  "arn:aws:cloudformation:us-east-1:123456789012:stack/app-nested/22222222-bbbb";
const DEEP_ARN =
  "arn:aws:cloudformation:us-east-1:123456789012:stack/app-nested-deep/33333333-cccc";

function ev(
  id: string,
  iso: string,
  logicalId: string,
  status: string,
  reason?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    EventId: id,
    Timestamp: new Date(iso),
    StackName: "app",
    LogicalResourceId: logicalId,
    PhysicalResourceId: logicalId,
    ResourceType: "AWS::RDS::DBInstance",
    ResourceStatus: status,
    ResourceStatusReason: reason,
    ...extra,
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/cfn-diagnostics");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments default region and optional profile", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.profile, undefined);
  assertEquals(
    model.globalArguments.parse({ profile: "p" }).profile,
    "p",
  );
});

Deno.test("model has required resources and methods", () => {
  for (
    const r of ["stack_list", "stack_detail", "stack_events", "trail_events"]
  ) {
    assertExists(model.resources[r as keyof typeof model.resources]);
  }
  for (
    const m of [
      "list_stacks",
      "describe_stack",
      "list_stack_events",
      "lookup_events",
    ]
  ) {
    assertExists(model.methods[m as keyof typeof model.methods]);
  }
});

Deno.test("list_stack_events rejects an empty stackName", () => {
  const schema = model.methods.list_stack_events.arguments;
  assertEquals(schema.safeParse({ stackName: "" }).success, false);
  const ok = schema.parse({ stackName: "app" });
  assertEquals(ok.since, "24h");
  assertEquals(ok.followNested, true);
});

Deno.test("lookup_events validates maxEvents bounds and defaults", () => {
  const schema = model.methods.lookup_events.arguments;
  assertEquals(schema.safeParse({ maxEvents: 0 }).success, false);
  assertEquals(schema.safeParse({ maxEvents: 5001 }).success, false);
  const ok = schema.parse({});
  assertEquals(ok.errorsOnly, true);
  assertEquals(ok.startTime, "6h");
});

// =============================================================================
// list_stacks
// =============================================================================

Deno.test(
  "list_stacks: filters by name substring, case-insensitively",
  { sanitizeResources: false }, // AWS SDK clients use connection pooling
  async () => {
    const restore = mockClients(() => ({
      StackSummaries: [
        { StackName: "Gitlab-Union", StackStatus: "UPDATE_ROLLBACK_FAILED" },
        { StackName: "other", StackStatus: "CREATE_COMPLETE" },
      ],
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_stacks.execute(
        { nameContains: "gitlab", includeDeleted: false, instanceName: "gl" },
        asCtx(context),
      );
      const [r] = getWrittenResources();
      assertEquals(r.name, "gl");
      const data = r.data as {
        count: number;
        truncated: boolean;
        stacks: { stackName: string; status: string }[];
      };
      assertEquals(data.count, 1);
      assertEquals(data.stacks[0].stackName, "Gitlab-Union");
      assertEquals(data.stacks[0].status, "UPDATE_ROLLBACK_FAILED");
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_stacks: reports truncated when pagination hits the page cap",
  { sanitizeResources: false },
  async () => {
    let calls = 0;
    const restore = mockClients(() => {
      calls++;
      return { StackSummaries: [], NextToken: "more" };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_stacks.execute(
        { includeDeleted: false, instanceName: "all" },
        asCtx(context),
      );
      assertEquals(
        (getWrittenResources()[0].data as { truncated: boolean }).truncated,
        true,
      );
      assertEquals(calls, 50); // bounded, never unbounded
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_stacks: wraps API errors with region context",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => {
      throw new Error("AccessDenied");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.list_stacks.execute(
            { includeDeleted: false, instanceName: "all" },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// describe_stack
// =============================================================================

Deno.test(
  "describe_stack: maps stack, parameters, tags and resources",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients((name) => {
      if (name === "DescribeStacksCommand") {
        return {
          Stacks: [{
            StackName: "app",
            StackId: ARN,
            StackStatus: "UPDATE_ROLLBACK_FAILED",
            CreationTime: new Date("2026-01-01T00:00:00Z"),
            Capabilities: ["CAPABILITY_IAM"],
            Parameters: [{ ParameterKey: "K", ParameterValue: "v" }],
            Tags: [{ Key: "Owner", Value: "me" }],
          }],
        };
      }
      return {
        StackResourceSummaries: [{
          LogicalResourceId: "Db",
          PhysicalResourceId: "db-1",
          ResourceType: "AWS::RDS::DBInstance",
          ResourceStatus: "UPDATE_FAILED",
          ResourceStatusReason: "denied",
          LastUpdatedTimestamp: new Date("2026-10-09T18:07:19Z"),
        }],
      };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_stack.execute(
        { stackName: "app" },
        asCtx(context),
      );
      const [r] = getWrittenResources();
      assertEquals(r.name, "detail-app");
      const d = r.data as {
        stack: {
          status: string;
          roleArn: string | null;
          capabilities: string[];
          parameters: { key: string; value: string }[];
          tags: { key: string; value: string }[];
        };
        resources: {
          logicalId: string;
          status: string;
          statusReason: string;
        }[];
        resourcesTruncated: boolean;
      };
      assertEquals(d.stack.status, "UPDATE_ROLLBACK_FAILED");
      assertEquals(d.stack.roleArn, null);
      assertEquals(d.stack.parameters[0], { key: "K", value: "v" });
      assertEquals(d.stack.tags[0], { key: "Owner", value: "me" });
      assertEquals(d.resources[0].status, "UPDATE_FAILED");
      assertEquals(d.resourcesTruncated, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_stack: throws when the stack is not found",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({ Stacks: [] }));
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.describe_stack.execute(
            { stackName: "missing" },
            asCtx(context),
          ),
        Error,
        'Stack "missing" not found',
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// list_stack_events
// =============================================================================

const STACK = "AWS::CloudFormation::Stack";
const own = { ResourceType: STACK, PhysicalResourceId: ARN };

// DescribeStackEvents returns newest first. Two operations on one stack: an
// earlier update (op1) whose rollback could not delete a certificate, and a
// later one (op2) that failed on an RDS permission and rolled back.
const FAILED_UPDATE_EVENTS = [
  ev(
    "10",
    "2026-10-09T18:08:07Z",
    "app",
    "UPDATE_ROLLBACK_FAILED",
    "The following resource(s) failed to update: [Db].",
    { ...own, ClientRequestToken: "op2" },
  ),
  ev(
    "9",
    "2026-10-09T18:08:06Z",
    "Db",
    "UPDATE_FAILED",
    "not authorized to perform: rds:RemoveTagsFromResource",
    { ClientRequestToken: "op2" },
  ),
  ev(
    "8",
    "2026-10-09T18:07:20Z",
    "app",
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "The following resource(s) failed to update: [Cert, Db].",
    { ...own, ClientRequestToken: "op2" },
  ),
  ev(
    "7",
    "2026-10-09T18:07:19Z",
    "Cert",
    "UPDATE_FAILED",
    "Resource creation cancelled",
    {
      ResourceType: "AWS::CertificateManager::Certificate",
      ClientRequestToken: "op2",
    },
  ),
  ev(
    "6",
    "2026-10-09T18:07:19Z",
    "Db",
    "UPDATE_FAILED",
    "not authorized to perform: rds:RemoveTagsFromResource",
    { ClientRequestToken: "op2" },
  ),
  ev(
    "5",
    "2026-10-07T19:08:52Z",
    "Cert",
    "DELETE_FAILED",
    "The security token included in the request is invalid",
    {
      ResourceType: "AWS::CertificateManager::Certificate",
      ClientRequestToken: "op1",
    },
  ),
  ev(
    "4",
    "2026-10-07T19:08:48Z",
    "app",
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "Internal Failure",
    { ...own, ClientRequestToken: "op1" },
  ),
  ev("3", "2026-10-01T00:00:00Z", "Old", "CREATE_COMPLETE"),
];

type EventsOut = {
  stackStatus: string | null;
  stackStatusError: string | null;
  eventCount: number;
  events: { eventId: string; stackName: string }[];
  failedEvents: { eventId: string }[];
  rootCauseCandidates: { eventId: string; logicalId: string }[];
  rollbackFailedEvents: { eventId: string }[];
  operations: {
    stackName: string;
    operationId: string | null;
    rolledBack: boolean;
    failedCount: number;
    rootCauseEventIds: string[];
  }[];
  nestedStacksFollowed: string[];
  nestedErrors: { stackId: string; error: string }[];
  truncated: boolean;
};

function describeStacksReply(status = "UPDATE_ROLLBACK_FAILED") {
  return { Stacks: [{ StackName: "app", StackId: ARN, StackStatus: status }] };
}

async function runEvents(
  handler: Handler,
  args: { stackName?: string; since?: string; followNested?: boolean } = {},
) {
  const restore = mockClients(handler);
  try {
    const { context, getWrittenResources } = ctx();
    await model.methods.list_stack_events.execute(
      {
        stackName: args.stackName ?? "app",
        since: args.since ?? "2026-10-05T00:00:00Z",
        followNested: args.followNested ?? true,
      },
      asCtx(context),
    );
    const [r] = getWrittenResources();
    return { name: r.name, data: r.data as EventsOut };
  } finally {
    restore();
  }
}

Deno.test(
  "list_stack_events: separates root causes, cascades and rollback blockers per operation",
  { sanitizeResources: false },
  async () => {
    const { name, data: d } = await runEvents((cmd) =>
      cmd === "DescribeStacksCommand"
        ? describeStacksReply()
        : { StackEvents: FAILED_UPDATE_EVENTS }
    );
    assertEquals(name, "events-app");
    assertEquals(d.stackStatus, "UPDATE_ROLLBACK_FAILED");
    // The 2026-10-01 event falls before the window; output is oldest first.
    assertEquals(d.events.map((e) => e.eventId), [
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    assertEquals(d.failedEvents.map((e) => e.eventId), [
      "5",
      "6",
      "7",
      "9",
      "10",
    ]);
    // Only the first RDS denial is a root cause. The cancelled cert is a
    // cascade, and everything after a rollback began is a cleanup blocker.
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["6"]);
    assertEquals(d.rollbackFailedEvents.map((e) => e.eventId), [
      "5",
      "9",
      "10",
    ]);
    // Failures are grouped per operation, so a retry is not mixed with the
    // earlier attempt.
    assertEquals(
      d.operations.map((
        o,
      ) => [o.operationId, o.rolledBack, o.failedCount, o.rootCauseEventIds]),
      [
        ["op1", true, 1, []],
        ["op2", true, 4, ["6"]],
      ],
    );
    // The stack's own resource row carries its own ARN: not a nested stack.
    assertEquals(d.nestedStacksFollowed, []);
    assertEquals(d.truncated, false);
  },
);

Deno.test(
  "list_stack_events: DELETE_FAILED on a plain stack delete is a root cause",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd) =>
      cmd === "DescribeStacksCommand" ? describeStacksReply("DELETE_FAILED") : {
        StackEvents: [
          ev(
            "3",
            "2026-10-09T18:00:03Z",
            "app",
            "DELETE_FAILED",
            "The following resource(s) failed to delete: [Bucket].",
            { ...own, ClientRequestToken: "d1" },
          ),
          ev(
            "2",
            "2026-10-09T18:00:02Z",
            "Bucket",
            "DELETE_FAILED",
            "The bucket you tried to delete is not empty",
            {
              ResourceType: "AWS::S3::Bucket",
              ClientRequestToken: "d1",
            },
          ),
          ev(
            "1",
            "2026-10-09T18:00:01Z",
            "app",
            "DELETE_IN_PROGRESS",
            "User Initiated",
            { ...own, ClientRequestToken: "d1" },
          ),
        ],
      }
    );
    // No rollback in this operation: the bucket is the cause, not a blocker.
    assertEquals(d.rootCauseCandidates.map((e) => e.logicalId), ["Bucket"]);
    assertEquals(d.rollbackFailedEvents, []);
    assertEquals(d.operations[0].rolledBack, false);
  },
);

Deno.test(
  "list_stack_events: a nested stack failing for its own reason is a root cause; wrapper rows are cascades",
  { sanitizeResources: false },
  async () => {
    const nestedRow = (id: string, reason: string) =>
      ev(id, `2026-10-09T18:00:0${id}Z`, "Nested", "CREATE_FAILED", reason, {
        ResourceType: STACK,
        PhysicalResourceId: NESTED_ARN,
        ClientRequestToken: "c1",
      });
    const { data: d } = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("CREATE_FAILED")
          : {
            StackEvents: [
              nestedRow(
                "2",
                "Embedded stack arn:aws:cloudformation:... was not successfully created: The following resource(s) failed to create: [Db].",
              ),
              nestedRow(
                "1",
                "TemplateURL must reference a valid S3 object to which you have access.",
              ),
            ],
          },
      { followNested: false },
    );
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["1"]);
    assertEquals(d.failedEvents.length, 2);
  },
);

Deno.test(
  "list_stack_events: cascade patterns are anchored, not substring matches",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("CREATE_FAILED")
          : {
            StackEvents: [
              ev(
                "1",
                "2026-10-09T18:00:01Z",
                "Custom",
                "CREATE_FAILED",
                "Custom resource failed: upstream said resource creation cancelled by admin",
                {
                  ResourceType: "Custom::Thing",
                  ClientRequestToken: "c1",
                },
              ),
            ],
          },
      { followNested: false },
    );
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["1"]);
  },
);

Deno.test(
  "list_stack_events: follows nested stacks at every level and dedupes by event id",
  { sanitizeResources: false },
  async () => {
    const calls: string[] = [];
    const row = (
      id: string,
      ts: string,
      name: string,
      physical: string,
      logical: string,
    ) =>
      ev(id, ts, logical, "UPDATE_IN_PROGRESS", undefined, {
        StackName: name,
        ResourceType: STACK,
        PhysicalResourceId: physical,
      });
    const { data: d } = await runEvents((cmd, input) => {
      if (cmd === "DescribeStacksCommand") {
        return describeStacksReply("UPDATE_FAILED");
      }
      calls.push(String(input.StackName));
      if (input.StackName === DEEP_ARN) {
        return {
          StackEvents: [
            ev(
              "g2",
              "2026-10-09T18:00:04Z",
              "Inner",
              "UPDATE_FAILED",
              "AccessDenied: nope",
              {
                StackName: "app-nested-deep",
                ClientRequestToken: "c1",
              },
            ),
          ],
        };
      }
      if (input.StackName === NESTED_ARN) {
        return {
          StackEvents: [
            // The grandchild's row lives only in the child's history.
            row("n2", "2026-10-09T18:00:03Z", "app-nested", DEEP_ARN, "Deep"),
            // Same event id also present on the parent: must appear once.
            row("p1", "2026-10-09T18:00:01Z", "app", NESTED_ARN, "Nested"),
          ],
        };
      }
      return {
        StackEvents: [
          row("p1", "2026-10-09T18:00:01Z", "app", NESTED_ARN, "Nested"),
          // The stack's own row; its ARN must not be re-fetched as nested.
          row("p0", "2026-10-09T18:00:00Z", "app", ARN, "app"),
        ],
      };
    });
    assertEquals(d.nestedStacksFollowed, [NESTED_ARN, DEEP_ARN]);
    assertEquals(d.events.map((e) => e.eventId), ["p0", "p1", "n2", "g2"]);
    // The real cause is two levels down; it must not be missed.
    assertEquals(d.rootCauseCandidates.map((e) => e.logicalId), ["Inner"]);
    assertEquals(calls.filter((c) => c === ARN || c === "app").length, 1);
    assertEquals(d.truncated, false);
  },
);

Deno.test(
  "list_stack_events: a failing nested fetch is recorded, not fatal",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd, input) => {
      if (cmd === "DescribeStacksCommand") {
        return describeStacksReply("UPDATE_FAILED");
      }
      if (input.StackName === NESTED_ARN) {
        throw new AwsError("AccessDenied", "not allowed in that account");
      }
      return {
        StackEvents: [
          ev(
            "p1",
            "2026-10-09T18:00:01Z",
            "Nested",
            "UPDATE_IN_PROGRESS",
            undefined,
            {
              ResourceType: STACK,
              PhysicalResourceId: NESTED_ARN,
            },
          ),
        ],
      };
    });
    assertEquals(d.eventCount, 1); // root events survive
    assertEquals(d.nestedStacksFollowed, []);
    assertEquals(d.nestedErrors.length, 1);
    assertEquals(d.nestedErrors[0].stackId, NESTED_ARN);
    assertEquals(d.truncated, true);
  },
);

Deno.test(
  "list_stack_events: the nested-stack cap is shared across levels and sets truncated",
  { sanitizeResources: false },
  async () => {
    const arn = (n: number) =>
      `arn:aws:cloudformation:us-east-1:123456789012:stack/child-${n}/${
        String(n).padStart(8, "0")
      }-aaaa`;
    const { data: d } = await runEvents((cmd, input) => {
      if (cmd === "DescribeStacksCommand") {
        return describeStacksReply("UPDATE_FAILED");
      }
      if (input.StackName === "app") {
        return {
          StackEvents: Array.from(
            { length: 30 },
            (_, i) =>
              ev(
                `r${i}`,
                "2026-10-09T18:00:01Z",
                `Child${i}`,
                "UPDATE_IN_PROGRESS",
                undefined,
                {
                  ResourceType: STACK,
                  PhysicalResourceId: arn(i),
                },
              ),
          ),
        };
      }
      return { StackEvents: [] };
    });
    assertEquals(d.nestedStacksFollowed.length, 25);
    assertEquals(d.truncated, true);
  },
);

Deno.test(
  "list_stack_events: followNested=false never fetches nested stacks",
  { sanitizeResources: false },
  async () => {
    const calls: string[] = [];
    const restore = mockClients((name, input) => {
      if (name === "DescribeStacksCommand") {
        return { Stacks: [{ StackName: "app", StackId: ARN }] };
      }
      calls.push(String(input.StackName));
      return {
        StackEvents: [
          ev(
            "p1",
            "2026-10-09T18:00:01Z",
            "Nested",
            "UPDATE_IN_PROGRESS",
            undefined,
            {
              ResourceType: "AWS::CloudFormation::Stack",
              PhysicalResourceId: NESTED_ARN,
            },
          ),
        ],
      };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_stack_events.execute(
        {
          stackName: "app",
          since: "2026-10-09T00:00:00Z",
          followNested: false,
        },
        asCtx(context),
      );
      assertEquals(
        (getWrittenResources()[0].data as { nestedStacksFollowed: string[] })
          .nestedStacksFollowed,
        [],
      );
      assertEquals(calls.includes(NESTED_ARN), false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_stack_events: a deleted stack (ValidationError) still yields events with a null status",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd) => {
      if (cmd === "DescribeStacksCommand") {
        throw new AwsError(
          "ValidationError",
          "Stack with id app does not exist",
        );
      }
      return {
        StackEvents: [
          ev("1", "2026-10-09T18:00:00Z", "Db", "DELETE_FAILED", "x"),
        ],
      };
    }, { since: "2026-10-09T00:00:00Z" });
    assertEquals(d.stackStatus, null);
    assertEquals(d.stackStatusError, null);
    assertEquals(d.eventCount, 1);
  },
);

Deno.test(
  "list_stack_events: other DescribeStacks failures are recorded, not swallowed",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd) => {
      if (cmd === "DescribeStacksCommand") {
        throw new AwsError(
          "AccessDenied",
          "cloudformation:DescribeStacks denied",
        );
      }
      return {
        StackEvents: [
          ev("1", "2026-10-09T18:00:00Z", "Db", "DELETE_FAILED", "x"),
        ],
      };
    }, { since: "2026-10-09T00:00:00Z" });
    assertEquals(d.stackStatus, null);
    assertEquals(d.stackStatusError, "cloudformation:DescribeStacks denied");
    assertEquals(d.eventCount, 1);
  },
);

Deno.test(
  "list_stack_events: a stack addressed by ARN and by name uses the same data name",
  { sanitizeResources: false },
  async () => {
    const handler: Handler = (cmd) =>
      cmd === "DescribeStacksCommand"
        ? describeStacksReply()
        : { StackEvents: [] };
    const byName = await runEvents(handler, { stackName: "app" });
    const byArn = await runEvents(handler, { stackName: ARN });
    assertEquals(byName.name, "events-app");
    assertEquals(byArn.name, "events-app");
  },
);

Deno.test(
  "list_stack_events: an over-long stack name gets a hash suffix instead of colliding",
  { sanitizeResources: false },
  async () => {
    const base = "x".repeat(120);
    const handler: Handler = (cmd) =>
      cmd === "DescribeStacksCommand" ? { Stacks: [] } : { StackEvents: [] };
    const a = await runEvents(handler, { stackName: `${base}a` });
    const b = await runEvents(handler, { stackName: `${base}b` });
    assertEquals(a.name.length <= 100, true);
    assertEquals(a.name === b.name, false);
  },
);

Deno.test(
  "list_stack_events: marks truncated when the page cap is hit inside the window",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients((name) => {
      if (name === "DescribeStacksCommand") return { Stacks: [] };
      return {
        StackEvents: [
          ev("1", "2026-10-09T18:00:00Z", "Db", "UPDATE_IN_PROGRESS"),
        ],
        NextToken: "more",
      };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_stack_events.execute(
        {
          stackName: "app",
          since: "2026-10-09T00:00:00Z",
          followNested: false,
        },
        asCtx(context),
      );
      assertEquals(
        (getWrittenResources()[0].data as { truncated: boolean }).truncated,
        true,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_stack_events: rejects an unparseable since value",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({}));
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.list_stack_events.execute(
            { stackName: "app", since: "yesterday-ish", followNested: false },
            asCtx(context),
          ),
        Error,
        "Invalid time",
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// lookup_events
// =============================================================================

function trailEvent(
  id: string,
  name: string,
  source: string,
  detail: Record<string, unknown>,
) {
  return {
    EventId: id,
    EventName: name,
    EventSource: source,
    EventTime: new Date("2026-10-09T18:08:06Z"),
    Username: "1050",
    ReadOnly: "false",
    Resources: [{ ResourceType: "AWS::RDS::DBInstance", ResourceName: "db-1" }],
    CloudTrailEvent: JSON.stringify(detail),
  };
}

const DENIED = {
  errorCode: "AccessDenied",
  errorMessage: "not authorized to perform: rds:RemoveTagsFromResource",
  sourceIPAddress: "cloudformation.amazonaws.com",
  userAgent: "cloudformation.amazonaws.com",
  userIdentity: {
    type: "AssumedRole",
    arn: "arn:aws:sts::123456789012:assumed-role/ci/1050",
    invokedBy: "cloudformation.amazonaws.com",
    sessionContext: {
      sessionIssuer: { arn: "arn:aws:iam::123456789012:role/ci" },
    },
  },
};

Deno.test(
  "lookup_events: extracts principal and rolls up errors, dropping successes",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({
      Events: [
        trailEvent("a", "RemoveTagsFromResource", "rds.amazonaws.com", DENIED),
        trailEvent("b", "RemoveTagsFromResource", "rds.amazonaws.com", DENIED),
        trailEvent("c", "DescribeDBInstances", "rds.amazonaws.com", {}),
      ],
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.lookup_events.execute(
        {
          startTime: "2026-10-09T18:00:00Z",
          endTime: "2026-10-09T18:15:00Z",
          lookupAttribute: "EventSource",
          lookupValue: "rds.amazonaws.com",
          errorsOnly: true,
          maxEvents: 500,
          instanceName: "rds",
        },
        asCtx(context),
      );
      const [r] = getWrittenResources();
      assertEquals(r.name, "rds");
      const d = r.data as {
        scanned: number;
        count: number;
        truncated: boolean;
        events: {
          principalArn: string;
          sessionIssuerArn: string;
          invokedBy: string;
          errorCode: string;
        }[];
        errorSummary: { errorCode: string; eventName: string; count: number }[];
        filter: { attribute: string; value: string };
      };
      assertEquals(d.scanned, 3);
      assertEquals(d.count, 2);
      assertEquals(d.events[0].principalArn, DENIED.userIdentity.arn);
      assertEquals(
        d.events[0].sessionIssuerArn,
        "arn:aws:iam::123456789012:role/ci",
      );
      assertEquals(d.events[0].invokedBy, "cloudformation.amazonaws.com");
      assertEquals(d.errorSummary, [
        {
          errorCode: "AccessDenied",
          eventName: "RemoveTagsFromResource",
          count: 2,
        },
      ]);
      assertEquals(d.filter.attribute, "EventSource");
      assertEquals(d.truncated, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: errorsOnly=false keeps successes; eventSource filters client-side",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({
      Events: [
        trailEvent("a", "RemoveTagsFromResource", "rds.amazonaws.com", DENIED),
        trailEvent("c", "DescribeStacks", "cloudformation.amazonaws.com", {}),
      ],
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.lookup_events.execute(
        {
          startTime: "1h",
          errorsOnly: false,
          eventSource: "rds.amazonaws.com",
          maxEvents: 10,
          instanceName: "x",
        },
        asCtx(context),
      );
      const d = getWrittenResources()[0].data as {
        count: number;
        scanned: number;
      };
      assertEquals(d.scanned, 2);
      assertEquals(d.count, 1);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: sets truncated when maxEvents is exceeded",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({
      Events: [
        trailEvent("a", "X", "rds.amazonaws.com", DENIED),
        trailEvent("b", "X", "rds.amazonaws.com", DENIED),
        trailEvent("c", "X", "rds.amazonaws.com", DENIED),
      ],
      NextToken: "more",
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.lookup_events.execute(
        {
          startTime: "1h",
          errorsOnly: true,
          maxEvents: 2,
          instanceName: "cap",
        },
        asCtx(context),
      );
      const d = getWrittenResources()[0].data as {
        count: number;
        truncated: boolean;
      };
      assertEquals(d.count, 2);
      assertEquals(d.truncated, true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: tolerates unparseable CloudTrailEvent JSON",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({
      Events: [{
        EventId: "z",
        EventName: "X",
        EventSource: "s",
        CloudTrailEvent: "{not json",
      }],
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.lookup_events.execute(
        {
          startTime: "1h",
          errorsOnly: false,
          maxEvents: 10,
          instanceName: "bad",
        },
        asCtx(context),
      );
      const d = getWrittenResources()[0].data as {
        count: number;
        events: { errorCode: string | null }[];
      };
      assertEquals(d.count, 1);
      assertEquals(d.events[0].errorCode, null);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: requires lookupAttribute and lookupValue together",
  async () => {
    const { context } = ctx();
    await assertRejects(
      () =>
        model.methods.lookup_events.execute(
          {
            startTime: "1h",
            errorsOnly: true,
            maxEvents: 10,
            instanceName: "x",
            lookupAttribute: "EventName",
          },
          asCtx(context),
        ),
      Error,
      "must be provided together",
    );
  },
);

Deno.test(
  "lookup_events: wraps API errors with region context",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => {
      throw new Error("ThrottlingException");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.lookup_events.execute(
            {
              startTime: "1h",
              errorsOnly: true,
              maxEvents: 10,
              instanceName: "x",
            },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// Review-driven additions
// =============================================================================

Deno.test(
  "list_stacks: excludes DELETE_COMPLETE by default, includes it on request, honors explicit statuses",
  { sanitizeResources: false },
  async () => {
    const seen: unknown[] = [];
    const restore = mockClients((_cmd, input) => {
      seen.push(input.StackStatusFilter);
      return { StackSummaries: [] };
    });
    try {
      for (
        const args of [
          { includeDeleted: false, instanceName: "a" },
          { includeDeleted: true, instanceName: "b" },
          {
            includeDeleted: false,
            statuses: ["DELETE_COMPLETE"],
            instanceName: "c",
          },
        ]
      ) {
        const { context } = ctx();
        await model.methods.list_stacks.execute(args as never, asCtx(context));
      }
      const first = seen[0] as string[];
      assertEquals(first.includes("DELETE_COMPLETE"), false);
      assertEquals(first.includes("UPDATE_ROLLBACK_FAILED"), true);
      assertEquals(seen[1], undefined);
      assertEquals(seen[2], ["DELETE_COMPLETE"]);
    } finally {
      restore();
    }
  },
);

Deno.test("list_stacks rejects unknown or empty statuses", () => {
  const schema = model.methods.list_stacks.arguments;
  assertEquals(schema.safeParse({ statuses: ["BOGUS"] }).success, false);
  assertEquals(schema.safeParse({ statuses: [] }).success, false);
  assertEquals(
    schema.safeParse({ statuses: ["UPDATE_ROLLBACK_FAILED"] }).success,
    true,
  );
});

Deno.test("user-chosen data names reject reserved and path-unsafe values", () => {
  const list = model.methods.list_stacks.arguments;
  const lookup = model.methods.lookup_events.arguments;
  for (
    const bad of [
      "latest",
      ".",
      "..",
      "a/b",
      "events-foo",
      "detail-foo",
      "",
      "x".repeat(101),
    ]
  ) {
    assertEquals(
      list.safeParse({ instanceName: bad }).success,
      false,
      `list_stacks accepted ${JSON.stringify(bad)}`,
    );
    assertEquals(
      lookup.safeParse({ instanceName: bad }).success,
      false,
      `lookup_events accepted ${JSON.stringify(bad)}`,
    );
  }
  assertEquals(list.parse({}).instanceName, "stack-list");
  assertEquals(lookup.parse({}).instanceName, "trail-lookup");
});

Deno.test(
  "time arguments: bare numbers and unknown units are rejected",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({}));
    try {
      for (const bad of ["10", "1w", "yesterday", "2026-13-45"]) {
        const { context } = ctx();
        await assertRejects(
          () =>
            model.methods.list_stack_events.execute(
              { stackName: "app", since: bad, followNested: false },
              asCtx(context),
            ),
          Error,
          "Invalid time",
        );
      }
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: rejects an end time that is not after the start",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => ({ Events: [] }));
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.lookup_events.execute(
            {
              startTime: "2026-10-09T18:15:00Z",
              endTime: "2026-10-09T18:00:00Z",
              errorsOnly: true,
              maxEvents: 10,
              instanceName: "x",
            },
            asCtx(context),
          ),
        Error,
        "must be after startTime",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: a later-page failure keeps earlier pages and sets partialError",
  { sanitizeResources: false },
  async () => {
    let calls = 0;
    const restore = mockClients(() => {
      calls++;
      if (calls === 1) {
        return {
          Events: [trailEvent("a", "X", "rds.amazonaws.com", DENIED)],
          NextToken: "more",
        };
      }
      throw new AwsError("ThrottlingException", "Rate exceeded");
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.lookup_events.execute(
        { startTime: "1h", errorsOnly: true, maxEvents: 10, instanceName: "p" },
        asCtx(context),
      );
      const d = getWrittenResources()[0].data as {
        count: number;
        truncated: boolean;
        partialError: string | null;
      };
      assertEquals(d.count, 1);
      assertEquals(d.truncated, true);
      assertEquals(d.partialError?.includes("Rate exceeded"), true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "lookup_events: a first-page failure still throws",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients(() => {
      throw new AwsError("ThrottlingException", "Rate exceeded");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.lookup_events.execute(
            {
              startTime: "1h",
              errorsOnly: true,
              maxEvents: 10,
              instanceName: "x",
            },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_stack and list_stack_events errors carry region context",
  { sanitizeResources: false },
  async () => {
    const restore = mockClients((cmd) => {
      if (cmd === "DescribeStacksCommand") {
        return { Stacks: [{ StackName: "app", StackId: ARN }] };
      }
      throw new AwsError("Throttling", "slow down");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.list_stack_events.execute(
            { stackName: "app", since: "1h", followNested: false },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore();
    }
    const restore2 = mockClients(() => {
      throw new AwsError("Throttling", "slow down");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.describe_stack.execute(
            { stackName: "app" },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore2();
    }
  },
);

Deno.test(
  "timestamps given as strings are normalized, not a TypeError",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd) =>
      cmd === "DescribeStacksCommand"
        ? {
          Stacks: [{
            StackName: "app",
            StackId: ARN,
            CreationTime: "2026-01-01T00:00:00.000Z",
          }],
        }
        : {
          StackEvents: [
            {
              ...ev("1", "2026-10-09T18:00:00Z", "Db", "UPDATE_IN_PROGRESS"),
              Timestamp: "2026-10-09T18:00:00.000Z",
            },
          ],
        }
    );
    assertEquals(d.events[0].eventId, "1");
  },
);

Deno.test(
  "list_stack_events: a resource that fails to delete inside a nested stack during the parent's rollback is a blocker, not a root cause",
  { sanitizeResources: false },
  async () => {
    const parent = (
      id: string,
      ts: string,
      logical: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) =>
      ev(id, ts, logical, status, undefined, {
        ClientRequestToken: "c1",
        ...extra,
      });
    const nestedRow = {
      ResourceType: STACK,
      PhysicalResourceId: NESTED_ARN,
    };
    const { data: d } = await runEvents((cmd, input) => {
      if (cmd === "DescribeStacksCommand") {
        return describeStacksReply("ROLLBACK_COMPLETE");
      }
      if (input.StackName === NESTED_ARN) {
        return {
          StackEvents: [
            ev(
              "n3",
              "2026-10-09T10:00:10Z",
              "app-nested",
              "DELETE_FAILED",
              "The following resource(s) failed to delete: [Bkt].",
              {
                StackName: "app-nested",
                ResourceType: STACK,
                ClientRequestToken: "del1",
              },
            ),
            ev(
              "n2",
              "2026-10-09T10:00:09Z",
              "Bkt",
              "DELETE_FAILED",
              "The bucket you tried to delete is not empty",
              {
                StackName: "app-nested",
                ResourceType: "AWS::S3::Bucket",
                ClientRequestToken: "del1",
              },
            ),
            ev(
              "n1",
              "2026-10-09T10:00:08Z",
              "app-nested",
              "DELETE_IN_PROGRESS",
              undefined,
              {
                StackName: "app-nested",
                ResourceType: STACK,
                ClientRequestToken: "del1",
              },
            ),
          ],
        };
      }
      return {
        StackEvents: [
          parent("p5", "2026-10-09T10:00:20Z", "app", "ROLLBACK_COMPLETE", own),
          parent(
            "p4",
            "2026-10-09T10:00:07Z",
            "Nested",
            "DELETE_IN_PROGRESS",
            nestedRow,
          ),
          parent(
            "p3",
            "2026-10-09T10:00:06Z",
            "app",
            "ROLLBACK_IN_PROGRESS",
            own,
          ),
          parent("p2", "2026-10-09T10:00:05Z", "Db", "CREATE_FAILED", {
            ...{},
          }),
          parent(
            "p1",
            "2026-10-09T10:00:00Z",
            "app",
            "CREATE_IN_PROGRESS",
            own,
          ),
        ],
      };
    });
    // Only the real failure is a root cause; the bucket that would not delete
    // during cleanup is a blocker even though its own operation is a plain DELETE.
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["p2"]);
    assertEquals(d.rollbackFailedEvents.map((e) => e.eventId), ["n2", "n3"]);
    assertEquals(d.nestedStacksFollowed, [NESTED_ARN]);
  },
);

Deno.test(
  "list_stack_events: events without an operation token are split into operations at each new top-level row",
  { sanitizeResources: false },
  async () => {
    // No ClientRequestToken anywhere. Oct 8 fails and rolls back; Oct 9 is a
    // retry that fails for a different reason. The retry must not be demoted
    // to rollback phase because the earlier attempt rolled back.
    const { data: d } = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("UPDATE_ROLLBACK_COMPLETE")
          : {
            StackEvents: [
              ev(
                "9",
                "2026-10-09T10:02:00Z",
                "app",
                "UPDATE_ROLLBACK_IN_PROGRESS",
                undefined,
                own,
              ),
              ev(
                "8",
                "2026-10-09T10:01:00Z",
                "B",
                "UPDATE_FAILED",
                "real second failure",
              ),
              ev(
                "7",
                "2026-10-09T10:00:00Z",
                "app",
                "UPDATE_IN_PROGRESS",
                undefined,
                own,
              ),
              ev(
                "6",
                "2026-10-08T10:03:00Z",
                "app",
                "UPDATE_ROLLBACK_COMPLETE",
                undefined,
                own,
              ),
              ev(
                "5",
                "2026-10-08T10:02:00Z",
                "app",
                "UPDATE_ROLLBACK_IN_PROGRESS",
                undefined,
                own,
              ),
              ev(
                "4",
                "2026-10-08T10:01:00Z",
                "A",
                "UPDATE_FAILED",
                "first failure",
              ),
              ev(
                "3",
                "2026-10-08T10:00:00Z",
                "app",
                "UPDATE_IN_PROGRESS",
                undefined,
                own,
              ),
            ],
          },
      { since: "2026-10-05T00:00:00Z" },
    );
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["4", "8"]);
    assertEquals(d.operations.length, 2);
    assertEquals(d.operations.map((o) => o.rolledBack), [true, true]);
    assertEquals(d.operations.map((o) => o.rootCauseEventIds), [["4"], ["8"]]);
  },
);

Deno.test(
  "list_stack_events: an over-long stack name has the same data name by name and by ARN",
  { sanitizeResources: false },
  async () => {
    const name = "y".repeat(110);
    const arn =
      `arn:aws:cloudformation:us-east-1:123456789012:stack/${name}/11111111-aaaa`;
    const handler: Handler = (cmd) =>
      cmd === "DescribeStacksCommand" ? { Stacks: [] } : { StackEvents: [] };
    const byName = await runEvents(handler, { stackName: name });
    const byArn = await runEvents(handler, { stackName: arn });
    assertEquals(byName.name, byArn.name);
    assertEquals(byName.name.length <= 100, true);
  },
);

Deno.test(
  "list_stack_events: a rollback still in progress has an open window, so late nested cleanup failures are blockers",
  { sanitizeResources: false },
  async () => {
    const { data: d } = await runEvents((cmd, input) => {
      if (cmd === "DescribeStacksCommand") {
        return describeStacksReply("ROLLBACK_IN_PROGRESS");
      }
      if (input.StackName === NESTED_ARN) {
        return {
          StackEvents: [
            // Stamped AFTER the parent's last fetched row.
            ev(
              "n2",
              "2026-10-09T10:00:30Z",
              "Bkt",
              "DELETE_FAILED",
              "not empty",
              {
                StackName: "app-nested",
                ResourceType: "AWS::S3::Bucket",
                ClientRequestToken: "del1",
              },
            ),
          ],
        };
      }
      return {
        StackEvents: [
          ev(
            "p3",
            "2026-10-09T10:00:07Z",
            "Nested",
            "DELETE_IN_PROGRESS",
            undefined,
            {
              ClientRequestToken: "c1",
              ResourceType: STACK,
              PhysicalResourceId: NESTED_ARN,
            },
          ),
          ev(
            "p2",
            "2026-10-09T10:00:06Z",
            "app",
            "ROLLBACK_IN_PROGRESS",
            undefined,
            {
              ...own,
              ClientRequestToken: "c1",
            },
          ),
          ev("p1", "2026-10-09T10:00:05Z", "Db", "CREATE_FAILED", "denied", {
            ClientRequestToken: "c1",
          }),
        ],
      };
    });
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["p1"]);
    assertEquals(d.rollbackFailedEvents.map((e) => e.eventId), ["n2"]);
  },
);

Deno.test(
  "list_stack_events: a nested-stack resource named like its parent is not the parent's own row",
  { sanitizeResources: false },
  async () => {
    // Without the physical-id check this row would start a new tokenless
    // operation mid-way and split the rollback from the failure it demotes.
    const { data: d } = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("UPDATE_ROLLBACK_COMPLETE")
          : {
            StackEvents: [
              ev(
                "5",
                "2026-10-09T10:03:00Z",
                "app",
                "UPDATE_ROLLBACK_COMPLETE",
                undefined,
                own,
              ),
              ev(
                "4",
                "2026-10-09T10:02:00Z",
                "app",
                "UPDATE_ROLLBACK_IN_PROGRESS",
                undefined,
                own,
              ),
              ev("3", "2026-10-09T10:01:30Z", "Db", "UPDATE_FAILED", "denied"),
              ev(
                "2",
                "2026-10-09T10:01:00Z",
                "app",
                "UPDATE_IN_PROGRESS",
                undefined,
                {
                  // Nested stack resource whose logical id equals the parent name.
                  ResourceType: STACK,
                  PhysicalResourceId: NESTED_ARN,
                },
              ),
              ev(
                "1",
                "2026-10-09T10:00:00Z",
                "app",
                "UPDATE_IN_PROGRESS",
                undefined,
                own,
              ),
            ],
          },
      { followNested: false },
    );
    assertEquals(d.operations.length, 1);
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["3"]);
  },
);

Deno.test(
  "list_stack_events: a failing nested-stack resource named like its parent is a root cause, not a cascade",
  { sanitizeResources: false },
  async () => {
    // Template logical id "app" inside stack "app": a nested stack resource. Its
    // physical id is the NESTED stack's ARN, so it is not the parent's own row.
    const { data: d } = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("CREATE_FAILED")
          : {
            StackEvents: [
              ev(
                "2",
                "2026-10-09T10:01:00Z",
                "app",
                "CREATE_FAILED",
                "AccessDenied: iam:PassRole",
                {
                  ResourceType: STACK,
                  PhysicalResourceId: NESTED_ARN,
                  ClientRequestToken: "c1",
                },
              ),
              ev(
                "1",
                "2026-10-09T10:00:00Z",
                "app",
                "CREATE_IN_PROGRESS",
                undefined,
                {
                  ...own,
                  ClientRequestToken: "c1",
                },
              ),
            ],
          },
      { followNested: false },
    );
    assertEquals(d.rootCauseCandidates.map((e) => e.eventId), ["2"]);
    // The parent's own failing row (physical id is its own ARN) is still a cascade.
    const own2 = await runEvents(
      (cmd) =>
        cmd === "DescribeStacksCommand"
          ? describeStacksReply("CREATE_FAILED")
          : {
            StackEvents: [
              ev(
                "3",
                "2026-10-09T10:02:00Z",
                "app",
                "CREATE_FAILED",
                "The following resource(s) failed to create: [Db].",
                {
                  ...own,
                  ClientRequestToken: "c1",
                },
              ),
            ],
          },
      { followNested: false },
    );
    assertEquals(own2.data.rootCauseCandidates, []);
  },
);
