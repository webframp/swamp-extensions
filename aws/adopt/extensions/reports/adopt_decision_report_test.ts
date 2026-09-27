// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { renderDecision, report } from "./adopt_decision_report.ts";

function decision(over: Record<string, unknown> = {}) {
  return {
    scope: "sweep",
    planName: "sweep-us-east-1",
    region: "us-east-1",
    stackName: null,
    judgement: {
      status: "used",
      model: "jev-latest",
      requested: 3,
      answered: 3,
      failed: 0,
      overflow: 1,
    },
    options: { minConfidence: 0.7 },
    decisions: [
      {
        id: "AWS::EC2::VPC/vpc-1",
        cfnType: "AWS::EC2::VPC",
        disposition: "manage",
        decidedBy: "jev",
        reason: "jev: manage at confidence 0.90",
        jev: { disposition: "manage", confidence: 0.9 },
      },
      {
        id: "AWS::S3::Bucket/logs",
        cfnType: "AWS::S3::Bucket",
        disposition: "needs-human",
        decidedBy: "rule",
        reason: "jev suggested manage at confidence 0.40, below 0.7",
        jev: { disposition: "manage", confidence: 0.4 },
      },
      {
        id: "AWS::S3::Bucket/data",
        cfnType: "AWS::S3::Bucket",
        disposition: "needs-human",
        decidedBy: "rule",
        reason: "jev suggested exclude at confidence 0.30, below 0.7",
        jev: { disposition: "exclude", confidence: 0.3 },
      },
    ],
    waves: [{ wave: 0, candidates: ["AWS::EC2::VPC/vpc-1"] }],
    findings: [{
      id: "AWS::S3::Bucket/data",
      cfnType: "AWS::S3::Bucket",
      disposition: "needs-human",
      risk: 1,
      riskLevel: "Critical: public access",
    }],
    warnings: [],
    summary: {
      total: 4,
      alreadyManaged: 1,
      byDisposition: { manage: 1, "needs-human": 2 },
      byDecidedBy: { jev: 1, rule: 2 },
    },
    ...over,
  };
}

const PLAN = {
  truncated: false,
  coverage: {
    typesRequested: ["AWS::EC2::VPC", "AWS::S3::Bucket", "AWS::RDS::DBCluster"],
    typesSwept: ["AWS::EC2::VPC", "AWS::S3::Bucket"],
    gaps: [{
      cfnType: "AWS::RDS::DBCluster",
      reason: "no-list-handler",
      detail: "does not support LIST",
    }],
    truncatedTypes: [],
    readFailures: 0,
    warnings: [],
  },
};

function context(stored: Record<string, unknown>, handles: string[]) {
  return {
    modelType: "@webframp/aws/adopt",
    modelId: "m-1",
    methodName: "decide",
    dataHandles: handles.map((name) => ({ name, version: 1 })),
    dataRepository: {
      getContent: (_t: unknown, _m: string, name: string) =>
        Promise.resolve(
          name in stored
            ? new TextEncoder().encode(JSON.stringify(stored[name]))
            : null,
        ),
    },
  };
}

Deno.test("report metadata is method scope", () => {
  assertEquals(report.name, "@webframp/adopt-decision-report");
  assertEquals(report.scope, "method");
});

Deno.test("renders judgement, gaps, findings, waves, and human reasons", () => {
  const md = renderDecision(decision(), PLAN);
  assertStringIncludes(md, "# Adoption decision: region us-east-1");
  assertStringIncludes(md, "| Already swamp-managed | 1 |");
  assertStringIncludes(md, "over the cap 1");
  assertStringIncludes(md, "2 jev answers fell below the 0.7 confidence gate");
  assertStringIncludes(md, "| AWS::RDS::DBCluster | no-list-handler |");
  assertStringIncludes(md, "Critical: public access");
  assertStringIncludes(md, "| 0 | AWS::EC2::VPC/vpc-1 |");
  assertStringIncludes(
    md,
    "| jev suggested manage at confidence n, below n | 1 |",
  );
});

Deno.test("says risk was not assessed when jev did not judge", () => {
  const md = renderDecision(
    decision({
      findings: [],
      judgement: {
        status: "disabled",
        model: null,
        requested: 3,
        answered: 0,
        failed: 0,
        overflow: 0,
      },
    }),
    PLAN,
  );
  assertStringIncludes(md, "Not assessed: jev did not judge this plan.");
  assertStringIncludes(md, "judge input off");
});

Deno.test("execute reads the decision handle and its plan", async () => {
  const result = await report.execute(
    context(
      {
        "decision-sweep-us-east-1": decision(),
        "sweep-us-east-1": PLAN,
      },
      ["decision-sweep-us-east-1"],
    ),
  );
  assertEquals(result.json.available, true);
  assertEquals((result.json.gaps as unknown[]).length, 1);
  assertStringIncludes(result.markdown, "## Coverage");
});

Deno.test("execute degrades when no decision was written", async () => {
  const result = await report.execute(context({}, ["judge-sweep-us-east-1"]));
  assertEquals(result.json.available, false);
});

Deno.test("execute renders coverage after a sweep", async () => {
  const result = await report.execute(
    context(
      { "sweep-us-east-1": { ...PLAN, candidates: [] } },
      ["sweep-us-east-1"],
    ),
  );
  assertEquals(result.json.kind, "plan");
  assertStringIncludes(result.markdown, "# Adoption plan: sweep-us-east-1");
  assertStringIncludes(
    result.markdown,
    "| AWS::RDS::DBCluster | no-list-handler |",
  );
});

Deno.test("execute renders without the plan", async () => {
  const result = await report.execute(
    context(
      { "decision-sweep-us-east-1": decision() },
      ["decision-sweep-us-east-1"],
    ),
  );
  assertStringIncludes(result.markdown, "The plan could not be read.");
});

Deno.test("execute degrades on a malformed decision instead of throwing", async () => {
  const result = await report.execute(
    context(
      {
        "decision-sweep-us-east-1": { decisions: [], judgement: {}, waves: [] },
      },
      ["decision-sweep-us-east-1"],
    ),
  );
  assertEquals(result.json.available, false);
  assertStringIncludes(result.markdown, "could not render");
});

Deno.test("explains a zero judge cap", () => {
  const md = renderDecision(
    decision({
      findings: [],
      judgement: {
        status: "capped",
        model: null,
        requested: 0,
        answered: 0,
        failed: 0,
        overflow: 3,
      },
    }),
    PLAN,
  );
  assertStringIncludes(md, "the judge cap is 0");
  assertStringIncludes(md, "Not assessed");
});
