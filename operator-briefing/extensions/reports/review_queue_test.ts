// Review-queue (method-scope) report tests.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { report } from "./review_queue.ts";
import { report as workflowReport } from "./operator_briefing.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const GITLAB = "@webframp/gitlab";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

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

function makeHandle(name: string, version = 1) {
  return {
    name,
    specName: name,
    kind: "resource" as const,
    dataId: `${name}-${version}`,
    version,
  };
}

function makeArtifact(
  modelId: string,
  dataName: string,
  data: unknown,
  modelType = GITLAB,
) {
  const content = new TextEncoder().encode(JSON.stringify(data));
  return {
    modelType,
    modelId,
    data: {
      name: dataName,
      kind: "resource" as const,
      dataId: `${dataName}-1`,
      version: 1,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

function makeRawArtifact(
  modelId: string,
  dataName: string,
  bytes: Uint8Array,
  modelType = GITLAB,
) {
  return {
    modelType,
    modelId,
    data: {
      name: dataName,
      kind: "resource" as const,
      dataId: `${dataName}-1`,
      version: 1,
      size: bytes.length,
      contentType: "application/json",
    },
    content: bytes,
  };
}

function createMethodContext(
  handles: Any[] = [],
  artifacts: Any[] = [],
  modelId = "gitlab",
) {
  const { context } = createReportTestContext({
    scope: "method",
    modelType: GITLAB,
    modelId,
    methodName: "list_my_merge_requests",
    executionStatus: "succeeded",
    dataHandles: handles as Any,
    dataArtifacts: artifacts as Any,
  });
  return context;
}

// --- Export structure ---

Deno.test("review-queue: name / scope / labels", () => {
  assertEquals(report.name, "@webframp/operator-briefing/review-queue");
  assertEquals(report.scope, "method");
  assertEquals(Array.isArray(report.labels), true);
  // Must differ from the workflow report's name.
  assertEquals(report.name === workflowReport.name, false);
});

// --- Renders the tiers live from a dashboard handle ---

Deno.test("review-queue: renders the four tiers from a dashboard handle", async () => {
  const handles = [makeHandle("sescriva")];
  const artifacts = [
    makeArtifact(
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
        assigned: [{
          project: "renovate/dep",
          iid: 100,
          reference: "renovate/dep!100",
          title: "Bump lib",
          author: "renovate-bot",
          updatedAt: daysAgo(1),
          draft: false,
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
        todos: [{
          id: "t1",
          action: "mentioned",
          reference: "g/p#8",
          targetType: "ISSUE",
          author: "a",
          createdAt: daysAgo(2),
        }],
      }),
    ),
  ];
  const result = await report.execute(
    createMethodContext(handles, artifacts) as Any,
  );
  const json = result.json as Any;

  assertEquals(json.tiers.waitingOnYou.length, 1);
  assertEquals(json.tiers.waitingOnYou[0].reference, "grp/proj!10");
  assertEquals(json.tiers.waitingOnYou[0].effort, 4);
  assertEquals(json.tiers.awaitingMerge.length, 1);
  assertEquals(json.tiers.awaitingMerge[0].reference, "renovate/dep!100");
  assertEquals(json.tiers.mentions.length, 1);
  assertEquals(json.tiers.yourOpenMrs.length, 1);
  assertEquals(json.queue.length, 4);

  // Queue-only: NO ops section, ops is an empty array.
  assertEquals(json.ops, []);
  assertEquals(result.markdown.includes("## Ops"), false);
  assertStringIncludes(result.markdown, "# GitLab Review Queue");
  assertStringIncludes(result.markdown, "Waiting on You");
  assertEquals(json.degraded, false);
});

// --- JSON contract shape (restricted to queue tiers) ---

Deno.test("review-queue: json contract exposes the stable queue keys with ops:[]", async () => {
  const result = await report.execute(createMethodContext([], []) as Any);
  const json = result.json as Any;
  assertEquals(typeof json.generatedAt, "string");
  assertEquals(Object.keys(json.tiers).sort(), [
    "awaitingMerge",
    "mentions",
    "waitingOnYou",
    "yourOpenMrs",
  ]);
  assertEquals(Array.isArray(json.queue), true);
  assertEquals(json.ops, []);
  assertEquals(typeof json.degraded, "boolean");
  assertEquals(Array.isArray(json.notes), true);
  assertEquals(json.sourceErrors, { skippedSteps: 0, parseFailures: 0 });
});

// --- Matches the workflow report's GitLab tiering exactly ---

Deno.test("review-queue: tiering matches the workflow report's GitLab section", async () => {
  const dash = dashboard({
    reviewing: [
      {
        project: "g/p",
        iid: 1,
        reference: "g/p!1",
        title: "Review me",
        author: "carol",
        updatedAt: daysAgo(3),
        draft: false,
        labels: ["Review effort 2/5"],
        approvedByMe: false,
      },
      {
        project: "g/p",
        iid: 2,
        reference: "g/p!2",
        title: "Approved already",
        author: "dan",
        updatedAt: daysAgo(1),
        draft: false,
        approvedByMe: true,
      },
    ],
    assigned: [{
      project: "renovate/x",
      iid: 9,
      reference: "renovate/x!9",
      title: "Bump",
      author: "renovate-bot",
      updatedAt: daysAgo(1),
      draft: false,
    }],
    authored: [{
      project: "me/r",
      iid: 4,
      reference: "me/r!4",
      title: "Mine",
      author: "sescriva",
      updatedAt: daysAgo(1),
      draft: false,
    }],
    todos: [{
      id: "t1",
      action: "mentioned",
      reference: "g/p#8",
      targetType: "ISSUE",
      author: "a",
      createdAt: daysAgo(2),
    }],
  });

  // Method report.
  const methodResult = await report.execute(
    createMethodContext(
      [makeHandle("sescriva")],
      [makeArtifact("gitlab", "sescriva", dash)],
    ) as Any,
  );

  // Workflow report over the same dashboard as a single step.
  const step = {
    jobName: "fetch",
    stepName: "list_my_merge_requests",
    modelName: "gitlab",
    modelType: GITLAB,
    modelId: "gitlab",
    methodName: "list_my_merge_requests",
    status: "succeeded",
    dataHandles: [{
      name: "sescriva",
      dataId: "gitlab-sescriva-0",
      version: 1,
    }],
    methodArgs: {},
    globalArgs: {},
  };
  const { context: wfContext } = createReportTestContext({
    scope: "workflow",
    workflowName: "daily-briefing",
    workflowStatus: "succeeded",
    stepExecutions: [step] as Any,
    dataArtifacts: [makeArtifact("gitlab", "sescriva", dash)] as Any,
  });
  const wfResult = await workflowReport.execute(wfContext as Any);

  // The GitLab tiering (tiers + flat queue) must be identical between the two.
  assertEquals(
    (methodResult.json as Any).tiers,
    (wfResult.json as Any).tiers,
  );
  assertEquals(
    (methodResult.json as Any).queue,
    (wfResult.json as Any).queue,
  );
});

// --- Skips report-* handles ---

Deno.test("review-queue: report-* handles are skipped, dashboard still read", async () => {
  const handles = [
    makeHandle("report-@webframp/operator-briefing/review-queue-json"),
    makeHandle("sescriva"),
  ];
  const artifacts = [
    makeArtifact(
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
  const result = await report.execute(
    createMethodContext(handles, artifacts) as Any,
  );
  const json = result.json as Any;
  assertEquals(json.queue.length, 1);
  assertEquals(json.degraded, false);
});

// --- Degrade, don't throw ---

Deno.test("review-queue: malformed JSON handle is counted, still renders", async () => {
  const handles = [makeHandle("sescriva")];
  const artifacts = [
    makeRawArtifact(
      "gitlab",
      "sescriva",
      new TextEncoder().encode("{not valid json"),
    ),
  ];
  const result = await report.execute(
    createMethodContext(handles, artifacts) as Any,
  );
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertStringIncludes(json.notes.join(" "), "could not be read or parsed");
  assertStringIncludes(result.markdown, "# GitLab Review Queue");
  assertEquals(json.degraded, true);
  assertEquals(json.sourceErrors.parseFailures, 1);
});

Deno.test("review-queue: no dashboard handle -> valid empty queue, not degraded", async () => {
  const result = await report.execute(createMethodContext([], []) as Any);
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertEquals(json.degraded, false);
  assertStringIncludes(json.notes.join(" "), "No dashboard resource");
  assertStringIncludes(result.markdown, "# GitLab Review Queue");
});

Deno.test("review-queue: a non-dashboard handle is ignored (no throw)", async () => {
  const handles = [makeHandle("something-else")];
  const artifacts = [
    makeArtifact("gitlab", "something-else", { foo: "bar", baz: 1 }),
  ];
  const result = await report.execute(
    createMethodContext(handles, artifacts) as Any,
  );
  const json = result.json as Any;
  assertEquals(json.queue.length, 0);
  assertEquals(json.degraded, false);
  assertStringIncludes(json.notes.join(" "), "No dashboard resource");
});

Deno.test("review-queue: a throwing context yields a degraded result, not an exception", async () => {
  const badContext = {
    modelType: GITLAB,
    modelId: "gitlab",
    get dataHandles(): unknown[] {
      throw new Error("boom");
    },
    dataRepository: { getContent: () => Promise.resolve(null) },
  };
  const result = await report.execute(badContext as Any);
  const json = result.json as Any;
  assertEquals(json.degraded, true);
  assertStringIncludes(json.notes.join(" "), "Report degraded: boom");
  assertStringIncludes(result.markdown, "# GitLab Review Queue");
  assertEquals(json.ops, []);
});

// --- Polish fix 1: long-cell truncation ---

Deno.test("review-queue: a >80-char title is truncated in markdown but full in JSON", async () => {
  const longTitle = "A".repeat(120);
  const handles = [makeHandle("sescriva")];
  const artifacts = [
    makeArtifact(
      "gitlab",
      "sescriva",
      dashboard({
        reviewing: [{
          project: "g/p",
          iid: 1,
          reference: "g/p!1",
          title: longTitle,
          author: "a",
          updatedAt: daysAgo(1),
          draft: false,
          approvedByMe: false,
        }],
      }),
    ),
  ];
  const result = await report.execute(
    createMethodContext(handles, artifacts) as Any,
  );
  const json = result.json as Any;

  // Full text preserved in the JSON contract.
  assertEquals(json.queue[0].title, longTitle);
  // Markdown is truncated with an ellipsis; the full 120-char run is gone.
  assertEquals(result.markdown.includes(longTitle), false);
  assertStringIncludes(result.markdown, "…");
  // The truncated cell keeps the leading run of the title (79 chars + ellipsis).
  assertStringIncludes(result.markdown, "A".repeat(79) + "…");
});
