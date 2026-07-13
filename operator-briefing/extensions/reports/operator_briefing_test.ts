// Operator Briefing report tests.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { report } from "./operator_briefing.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: { name: string; dataId: string; version: number }[];
  methodArgs: Record<string, unknown>;
  globalArgs: Record<string, unknown>;
}

function makeStep(
  modelType: string,
  modelId: string,
  methodName: string,
  dataNames: string[],
): StepExecution {
  return {
    jobName: "fetch",
    stepName: methodName,
    modelName: modelId,
    modelType,
    modelId,
    methodName,
    status: "succeeded",
    dataHandles: dataNames.map((name, i) => ({
      name,
      dataId: `${modelId}-${name}-${i}`,
      version: 1,
    })),
    methodArgs: {},
    globalArgs: {},
  };
}

function makeArtifact(
  modelType: string,
  modelId: string,
  dataName: string,
  data: unknown,
) {
  const content = new TextEncoder().encode(JSON.stringify(data));
  return {
    modelType,
    modelId,
    data: {
      name: dataName,
      kind: "resource" as const,
      dataId: `${modelId}-${dataName}`,
      version: 1,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

/** Seed a data artifact with raw (possibly invalid) bytes. */
function makeRawArtifact(
  modelType: string,
  modelId: string,
  dataName: string,
  bytes: Uint8Array,
) {
  return {
    modelType,
    modelId,
    data: {
      name: dataName,
      kind: "resource" as const,
      dataId: `${modelId}-${dataName}`,
      version: 1,
      size: bytes.length,
      contentType: "application/json",
    },
    content: bytes,
  };
}

function createContext(
  steps: Any[] = [],
  artifacts: Any[] = [],
) {
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "daily-briefing",
    workflowStatus: "succeeded",
    stepExecutions: steps as Any,
    dataArtifacts: artifacts as Any,
  });
  return context;
}

// --- Realistic source shapes (from live data 2026-07-11) ---

const GITLAB = "@webframp/gitlab";
const ANALYTICS = "@webframp/anthropic/analytics";
const COMPLIANCE = "@webframp/anthropic/compliance";
const AWS = "@webframp/aws/service-quotas";

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    username: "sescriva",
    reviewing: [],
    assigned: [],
    authored: [],
    todos: [],
    totalCount: 0,
    truncated: false,
    fetchedAt: hoursAgo(1),
    ...overrides,
  };
}

// --- Export structure ---

Deno.test("report name / scope / labels", () => {
  assertEquals(report.name, "@webframp/operator-briefing");
  assertEquals(report.scope, "workflow");
  assertEquals(Array.isArray(report.labels), true);
});

// --- Multi-source aggregation ---

Deno.test("aggregates GitLab tiers + ops signals across sources", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
    makeStep(ANALYTICS, "claude-analytics", "collect_analytics", [
      "current",
      "adoption",
      "window",
    ]),
    makeStep(COMPLIANCE, "claude-compliance", "sync_effective_settings", [
      "settings",
    ]),
    makeStep(AWS, "aws-quotas-all", "check_utilization", ["ec2-0.8"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "grp/proj",
          iid: 10,
          reference: "grp/proj!10",
          title: "Fix thing",
          author: "bob",
          updatedAt: daysAgo(2),
          draft: false,
          labels: ["Review effort 4/5"],
          approvedByMe: false,
          myReviewState: "pending",
        }],
        authored: [{
          project: "me/repo",
          iid: 3,
          reference: "me/repo!3",
          title: "My MR",
          author: "sescriva",
          updatedAt: daysAgo(1),
          draft: false,
        }],
        totalCount: 2,
      }),
    ),
    makeArtifact(ANALYTICS, "claude-analytics", "current", {
      total: 586,
      active: 143,
      dau: 143,
      wau: 285,
      mau: 437,
      fetchedAt: hoursAgo(2),
    }),
    makeArtifact(ANALYTICS, "claude-analytics", "adoption", {
      projects: 10,
      skills: 15,
      connectors: 4,
      collected: true,
      fetchedAt: hoursAgo(2),
    }),
    makeArtifact(ANALYTICS, "claude-analytics", "window", {
      total_usd: 1456.33,
      startingAt: "2026-07-04T00:00:00Z",
      collected: true,
      fetchedAt: hoursAgo(2),
    }),
    makeArtifact(COMPLIANCE, "claude-compliance", "settings", {
      orgId: "org-1",
      settings: [{ name: "x" }],
      count: 47,
      fetchedAt: hoursAgo(2),
    }),
    makeArtifact(AWS, "aws-quotas-all", "ec2-0.8", {
      serviceCode: "ec2",
      threshold: 0.8,
      entries: [{
        profile: "acct-a/ReadOnlyPlus",
        quotaName: "Spot Instances",
        utilizationPct: 87.5,
      }],
      truncated: false,
      failedProfiles: [],
      fetchedAt: hoursAgo(2),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;

  assertEquals(json.tiers.waitingOnYou.length, 1);
  assertEquals(json.tiers.waitingOnYou[0].reference, "grp/proj!10");
  assertEquals(json.tiers.waitingOnYou[0].effort, 4);
  assertEquals(json.tiers.yourOpenMrs.length, 1);
  assertEquals(json.queue.length, 2);

  const labels = (json.ops as Any[]).map((o) => o.label).sort();
  assertEquals(labels, [
    "adoption",
    "cost",
    "seats",
    "settings",
    "utilization:ec2",
  ]);
  assertEquals(json.degraded, false);
  assertStringIncludes(result.markdown, "# Operator Briefing");
  assertStringIncludes(result.markdown, "Waiting on You");
});

// --- GitLab dedup ---

Deno.test("GitLab dedup: MR in reviewing + review_requested todo = one item", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "grp/proj",
          iid: 42,
          reference: "grp/proj!42",
          title: "Shared MR",
          author: "carol",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
        todos: [{
          id: "gid://gitlab/Todo/1",
          action: "review_requested",
          targetType: "MERGEREQUEST",
          reference: "grp/proj!42",
          author: "carol",
          createdAt: daysAgo(1),
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  // The todo is folded into the MR — only one queue item.
  assertEquals(json.queue.length, 1);
  assertEquals(json.tiers.waitingOnYou.length, 1);
});

// --- Approved suppression ---

Deno.test("GitLab suppresses approvedByMe and myReviewState=approved", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [
          {
            project: "g/p",
            iid: 1,
            reference: "g/p!1",
            title: "Approved by flag",
            author: "a",
            updatedAt: daysAgo(1),
            draft: false,
            approvedByMe: true,
          },
          {
            project: "g/p",
            iid: 2,
            reference: "g/p!2",
            title: "Approved by state",
            author: "b",
            updatedAt: daysAgo(1),
            draft: false,
            approvedByMe: false,
            myReviewState: "approved",
          },
          {
            project: "g/p",
            iid: 3,
            reference: "g/p!3",
            title: "Still open",
            author: "c",
            updatedAt: daysAgo(1),
            draft: false,
            approvedByMe: false,
            myReviewState: "pending",
          },
        ],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.waitingOnYou.length, 1);
  assertEquals(json.tiers.waitingOnYou[0].reference, "g/p!3");
});

Deno.test("GitLab: approved MR also suppresses its review_requested todo", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 9,
          reference: "g/p!9",
          title: "Already approved",
          author: "a",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: true,
        }],
        todos: [{
          id: "gid://gitlab/Todo/2",
          action: "review_requested",
          reference: "g/p!9",
          author: "a",
          createdAt: daysAgo(1),
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
});

// --- Assigned / authored fold ---

Deno.test("GitLab: assigned-not-authored -> tier 2; self-authored assigned -> tier 4", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        assigned: [
          {
            project: "renovate/dep",
            iid: 100,
            reference: "renovate/dep!100",
            title: "Bump lib",
            author: "renovate-bot",
            updatedAt: daysAgo(1),
            draft: false,
          },
          {
            project: "me/repo",
            iid: 5,
            reference: "me/repo!5",
            title: "My assigned",
            author: "sescriva",
            updatedAt: daysAgo(1),
            draft: false,
          },
        ],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.awaitingMerge.length, 1);
  assertEquals(json.tiers.awaitingMerge[0].reference, "renovate/dep!100");
  assertEquals(json.tiers.yourOpenMrs.length, 1);
  assertEquals(json.tiers.yourOpenMrs[0].reference, "me/repo!5");
});

Deno.test("GitLab: draft reviewing MR held out with a note", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 7,
          reference: "g/p!7",
          title: "Draft: WIP",
          author: "a",
          updatedAt: daysAgo(1),
          draft: true,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertStringIncludes(json.notes.join(" "), "draft MR(s)");
});

Deno.test("GitLab: mentioned todo -> tier 3, other todos dropped with note", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        todos: [
          {
            id: "t1",
            action: "mentioned",
            reference: "g/p#8",
            targetType: "ISSUE",
            author: "a",
            createdAt: daysAgo(2),
          },
          {
            id: "t2",
            action: "member_access_requested",
            targetType: "PROJECT",
            targetUrl: "https://example/x",
            author: "b",
            createdAt: daysAgo(3),
          },
        ],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.mentions.length, 1);
  assertEquals(json.tiers.mentions[0].reference, "g/p#8");
  assertStringIncludes(json.notes.join(" "), "other todo(s)");
});

// --- Staleness ---

Deno.test("staleness: queue item > 7d and ops fetchedAt > 24h flagged stale", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
    makeStep(COMPLIANCE, "claude-compliance", "sync_effective_settings", [
      "settings",
    ]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: "Old",
          author: "a",
          updatedAt: daysAgo(10),
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
    makeArtifact(COMPLIANCE, "claude-compliance", "settings", {
      settings: [],
      count: 47,
      fetchedAt: hoursAgo(30),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.waitingOnYou[0].stale, true);
  const settings = (json.ops as Any[]).find((o) => o.label === "settings");
  assertEquals(settings.stale, true);
});

// --- collected:false ---

Deno.test("analytics collected:false renders unavailable + degraded, not zero", async () => {
  const steps = [
    makeStep(ANALYTICS, "claude-analytics", "collect_analytics", [
      "adoption",
      "window",
    ]),
  ];
  const artifacts = [
    makeArtifact(ANALYTICS, "claude-analytics", "adoption", {
      projects: 0,
      skills: 0,
      connectors: 0,
      collected: false,
      fetchedAt: hoursAgo(1),
    }),
    makeArtifact(ANALYTICS, "claude-analytics", "window", {
      total_usd: 0,
      collected: false,
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const adoption = (json.ops as Any[]).find((o) => o.label === "adoption");
  const cost = (json.ops as Any[]).find((o) => o.label === "cost");
  assertEquals(adoption.degraded, true);
  assertStringIncludes(adoption.detail, "unavailable");
  assertEquals(cost.degraded, true);
  assertStringIncludes(cost.detail, "unavailable");
  assertEquals(json.degraded, true);
});

// --- AWS failedProfiles ---

Deno.test("AWS failedProfiles (non-sso) -> 'N accounts unreachable'", async () => {
  const steps = [
    makeStep(AWS, "aws-quotas-all", "check_utilization", ["vpc-0.8"]),
  ];
  const artifacts = [
    makeArtifact(AWS, "aws-quotas-all", "vpc-0.8", {
      serviceCode: "vpc",
      threshold: 0.8,
      entries: [],
      truncated: false,
      failedProfiles: ["acct-a/ReadOnlyPlus", "acct-b/ReadOnlyPlus"],
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const sig = (json.ops as Any[]).find((o) => o.label === "utilization:vpc");
  assertEquals(sig.degraded, true);
  assertEquals(sig.degradedReason, "2 accounts unreachable");
});

Deno.test("AWS failedProfiles with sso-login-required -> re-run granted sso login", async () => {
  const steps = [
    makeStep(AWS, "aws-quotas-all", "list_pending_requests", [
      "pending-us-east-1",
    ]),
  ];
  const artifacts = [
    makeArtifact(AWS, "aws-quotas-all", "pending-us-east-1", {
      region: "us-east-1",
      statuses: ["PENDING", "CASE_OPENED"],
      entries: [{
        profile: "acct-x/ReadOnlyPlus",
        serviceCode: "medialive",
        quotaName: "Channels",
        requestId: "r1",
        status: "CASE_OPENED",
      }],
      profilesChecked: 55,
      truncated: false,
      failedProfiles: ["sso-login-required", "sso-login-required"],
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const sig = (json.ops as Any[]).find((o) => o.label === "pending");
  assertEquals(sig.degraded, true);
  assertStringIncludes(sig.degradedReason, "re-run granted sso login");
  assertStringIncludes(sig.detail, "1 pending increase");
});

// --- truncated ---

Deno.test("truncated flag on an AWS resource surfaces on signal and notes", async () => {
  const steps = [
    makeStep(AWS, "aws-quotas-all", "check_utilization", ["ec2-0.8"]),
  ];
  const artifacts = [
    makeArtifact(AWS, "aws-quotas-all", "ec2-0.8", {
      serviceCode: "ec2",
      threshold: 0.8,
      entries: [{
        profile: "a/ReadOnlyPlus",
        quotaName: "Spot",
        utilizationPct: 90,
      }],
      truncated: true,
      failedProfiles: [],
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const sig = (json.ops as Any[]).find((o) => o.label === "utilization:ec2");
  assertEquals(sig.truncated, true);
  assertStringIncludes(json.notes.join(" "), "truncated");
});

// --- Degrade, don't throw ---

Deno.test("unknown modelType is skipped and counted, not thrown", async () => {
  const steps = [
    makeStep("@acme/unknown", "mystery", "do_thing", ["out"]),
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact("@acme/unknown", "mystery", "out", { foo: "bar" }),
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: "T",
          author: "a",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 1);
  assertStringIncludes(json.notes.join(" "), "No normalizer for @acme/unknown");
  // H1: a skipped step marks the report degraded and is counted.
  assertEquals(json.degraded, true);
  assertEquals(json.sourceErrors.skippedSteps, 1);
});

Deno.test("malformed JSON handle is skipped, report still renders", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeRawArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      new TextEncoder().encode("{not valid json"),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertStringIncludes(json.notes.join(" "), "could not be read or parsed");
  assertStringIncludes(result.markdown, "# Operator Briefing");
  // H1: a parse failure marks the whole report degraded and is counted.
  assertEquals(json.degraded, true);
  assertEquals(json.sourceErrors.parseFailures, 1);
  assertEquals(json.sourceErrors.skippedSteps, 0);
});

Deno.test("a normalizer that throws is caught, other sources survive", async () => {
  const steps = [
    // A null element in `reviewing` makes isApproved() dereference null and
    // throw inside the normalizer (a non-array `reviewing` is now guarded).
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
    makeStep(COMPLIANCE, "claude-compliance", "sync_effective_settings", [
      "settings",
    ]),
  ];
  const artifacts = [
    makeArtifact(GITLAB, "gitlab", "sescriva", {
      username: "sescriva",
      reviewing: [null],
      fetchedAt: hoursAgo(1),
    }),
    makeArtifact(COMPLIANCE, "claude-compliance", "settings", {
      settings: [],
      count: 47,
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  // Compliance ops still present; gitlab contributed nothing but did not crash.
  assertEquals((json.ops as Any[]).some((o) => o.label === "settings"), true);
  assertStringIncludes(json.notes.join(" "), "Normalizer for @webframp/gitlab");
  // H1: a normalizer throw marks the report degraded and is counted.
  assertEquals(json.degraded, true);
  assertEquals(json.sourceErrors.skippedSteps, 1);
  assertEquals(json.sourceErrors.parseFailures, 0);
});

Deno.test("no steps -> valid empty briefing, not degraded", async () => {
  const result = await report.execute(createContext([], []) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertEquals(json.ops.length, 0);
  assertEquals(json.degraded, false);
  assertStringIncludes(result.markdown, "# Operator Briefing");
});

Deno.test("outer catch: a throwing context yields degraded result, not an exception", async () => {
  const badContext = {
    get stepExecutions(): StepExecution[] {
      throw new Error("boom");
    },
    dataRepository: { getContent: () => Promise.resolve(null) },
  };
  const result = await report.execute(badContext as Any);
  const json = result.json as Any;
  assertEquals(json.degraded, true);
  assertStringIncludes(json.notes.join(" "), "Report degraded: boom");
  assertStringIncludes(result.markdown, "# Operator Briefing");
});

// --- JSON contract shape ---

Deno.test("json contract exposes the stable keys", async () => {
  const result = await report.execute(createContext([], []) as Any);
  const json = result.json as Any;
  assertEquals(typeof json.generatedAt, "string");
  assertEquals(Object.keys(json.tiers).sort(), [
    "awaitingMerge",
    "mentions",
    "waitingOnYou",
    "yourOpenMrs",
  ]);
  assertEquals(Array.isArray(json.queue), true);
  assertEquals(Array.isArray(json.ops), true);
  assertEquals(typeof json.degraded, "boolean");
  assertEquals(Array.isArray(json.notes), true);
  assertEquals(json.sourceErrors, { skippedSteps: 0, parseFailures: 0 });
});

// --- Adversarial-review regression tests ---

Deno.test("H1: a clean run is not degraded and reports zero sourceErrors", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: "T",
          author: "a",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.degraded, false);
  assertEquals(json.sourceErrors, { skippedSteps: 0, parseFailures: 0 });
});

Deno.test("M2: a non-array `reviewing` yields zero queue items, no throw", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(GITLAB, "gitlab", "sescriva", dashboard({ reviewing: "abc" })),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertEquals(json.degraded, false);
  assertEquals(json.sourceErrors.skippedSteps, 0);
});

Deno.test("M3: a numeric AWS account id is redacted, digits never surface", async () => {
  const steps = [
    makeStep(AWS, "aws-quotas-all", "check_utilization", ["ec2-0.8"]),
  ];
  const artifacts = [
    makeArtifact(AWS, "aws-quotas-all", "ec2-0.8", {
      serviceCode: "ec2",
      threshold: 0.8,
      entries: [{
        profile: "123456789012/ReadOnlyPlus",
        quotaName: "Spot",
        utilizationPct: 91,
      }],
      truncated: false,
      failedProfiles: [],
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const sig = (json.ops as Any[]).find((o) => o.label === "utilization:ec2");
  assertEquals(sig.detail.includes("123456789012"), false);
  assertStringIncludes(sig.detail, "account ****");
  // Nowhere in the rendered markdown or the whole JSON contract either.
  assertEquals(result.markdown.includes("123456789012"), false);
  assertEquals(JSON.stringify(json).includes("123456789012"), false);
});

Deno.test("M4: unrecognized AWS shape with failedProfiles still emits a degraded signal", async () => {
  const steps = [
    makeStep(AWS, "aws-quotas-all", "check_utilization", ["weird"]),
  ];
  const artifacts = [
    makeArtifact(AWS, "aws-quotas-all", "weird", {
      // Neither a pending shape nor a utilization shape.
      region: "us-west-2",
      failedProfiles: ["sso-login-required"],
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals((json.ops as Any[]).length, 1);
  assertEquals(json.ops[0].degraded, true);
  assertStringIncludes(json.ops[0].degradedReason, "re-run granted sso login");
  assertEquals(json.degraded, true);
});

Deno.test("M5: a newline in a cell cannot inject a markdown table row", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const evil = "Legit title\n| fake | row | x | y | z | w |";
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: evil,
          author: "a",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  // No physical line may start with the injected "| fake |" row.
  const injected = result.markdown
    .split("\n")
    .some((l) => l.startsWith("| fake |"));
  assertEquals(injected, false);
  // The title is flattened onto a single line (newline -> space) with its
  // pipes escaped, so it stays inside one cell.
  assertStringIncludes(result.markdown, "Legit title \\| fake");
});

Deno.test("M7: a review_requested todo with only targetUrl dedups against its MR", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 5,
          reference: "g/p!5",
          title: "Shared MR",
          author: "carol",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
        todos: [{
          id: "gid://gitlab/Todo/9",
          action: "review_requested",
          targetType: "MERGEREQUEST",
          // No `reference` — only a targetUrl to derive it from.
          targetUrl: "https://gitlab.example.com/g/p/-/merge_requests/5",
          author: "carol",
          createdAt: daysAgo(1),
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 1);
  assertEquals(json.tiers.waitingOnYou.length, 1);
});

Deno.test("L8: invalid JSON counts one parseFailure with a single fetch; null is not counted", async () => {
  // (a) Invalid JSON -> exactly one parseFailure, getContent called ONCE
  //     (a parse error must not re-fetch the alternate modelType arg).
  let calls = 0;
  const badCtx = {
    workflowName: "daily-briefing",
    stepExecutions: [{
      modelType: GITLAB,
      modelId: "gitlab",
      stepName: "s",
      dataHandles: [{ name: "sescriva", version: 1 }],
    }],
    dataRepository: {
      getContent: () => {
        calls++;
        return Promise.resolve(new TextEncoder().encode("{not json"));
      },
    },
  };
  const bad = await report.execute(badCtx as Any);
  assertEquals((bad.json as Any).sourceErrors.parseFailures, 1);
  assertEquals(calls, 1);

  // (b) A genuine null (absent/empty resource) is NOT a parse failure.
  const nullCtx = {
    workflowName: "daily-briefing",
    stepExecutions: [{
      modelType: GITLAB,
      modelId: "gitlab",
      stepName: "s",
      dataHandles: [{ name: "sescriva", version: 1 }],
    }],
    dataRepository: { getContent: () => Promise.resolve(null) },
  };
  const nul = await report.execute(nullCtx as Any);
  assertEquals((nul.json as Any).sourceErrors.parseFailures, 0);
  assertEquals((nul.json as Any).degraded, false);
});

Deno.test("L9: two unidentifiable MRs both appear (no '?' collision)", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        // No reference / project / iid on either.
        authored: [
          { title: "Anon one", author: "sescriva", updatedAt: daysAgo(1) },
          { title: "Anon two", author: "sescriva", updatedAt: daysAgo(2) },
        ],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.yourOpenMrs.length, 2);
});

Deno.test("L10: self-authored MR in authored+assigned appears once in tier 4 without username", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const mr = {
    project: "me/repo",
    iid: 7,
    reference: "me/repo!7",
    title: "Mine",
    author: "sescriva",
    updatedAt: daysAgo(1),
    draft: false,
  };
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        username: "", // no username to rely on
        authored: [mr],
        assigned: [mr],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 1);
  assertEquals(json.tiers.yourOpenMrs.length, 1);
  assertEquals(json.tiers.awaitingMerge.length, 0);
});

Deno.test("L11: numeric fetchedAt coerces to null; non-numeric cost is not $NaN", async () => {
  const steps = [
    makeStep(ANALYTICS, "claude-analytics", "collect_analytics", [
      "current",
      "window",
    ]),
  ];
  const artifacts = [
    makeArtifact(ANALYTICS, "claude-analytics", "current", {
      total: 10,
      active: 5,
      dau: 5,
      wau: 8,
      mau: 9,
      fetchedAt: 1720000000000, // numeric epoch violates string | null
    }),
    makeArtifact(ANALYTICS, "claude-analytics", "window", {
      total_usd: "not-a-number",
      collected: true,
      fetchedAt: hoursAgo(1),
    }),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  const seats = (json.ops as Any[]).find((o) => o.label === "seats");
  assertEquals(seats.fetchedAt, null);
  const cost = (json.ops as Any[]).find((o) => o.label === "cost");
  assertEquals(cost.detail.includes("NaN"), false);
  assertStringIncludes(cost.detail, "unavailable");
});

Deno.test("L12: a future updatedAt renders a non-negative age", async () => {
  const steps = [
    makeStep(GITLAB, "gitlab", "list_my_merge_requests", ["sescriva"]),
  ];
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const artifacts = [
    makeArtifact(
      GITLAB,
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: "Future",
          author: "a",
          updatedAt: future,
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(createContext(steps, artifacts) as Any);
  const json = result.json as Any;
  assertEquals(json.tiers.waitingOnYou[0].ageDays >= 0, true);
  assertEquals(json.tiers.waitingOnYou[0].ageDays, 0);
});
