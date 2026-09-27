// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./adopt_report.ts";

function makeContext(
  stepExecutions: Array<{
    jobName: string;
    stepName: string;
    modelName: string;
    modelType: string;
    modelId: string;
    methodName: string;
    status: string;
    dataHandles?: Array<{ name: string; dataId: string; version: number }>;
    error?: string;
  }>,
) {
  return {
    workflowId: "wf-test-id",
    workflowRunId: "run-test-id",
    workflowName: "@webframp/adopt-stack",
    workflowStatus: "completed",
    stepExecutions: stepExecutions.map((s) => ({
      ...s,
      dataHandles: s.dataHandles ?? [],
    })),
    repoDir: "/tmp/test-repo",
    logger: { info: (_msg: string, _props: Record<string, unknown>) => {} },
  };
}

Deno.test("report metadata is correct", () => {
  assertEquals(report.name, "@webframp/adopt-report");
  assertEquals(report.scope, "workflow");
  assertEquals(report.labels, ["aws", "adoption", "brownfield", "import"]);
});

Deno.test("all successes", async () => {
  const ctx = makeContext([
    {
      jobName: "networking",
      stepName: "adopt-vpc",
      modelName: "vpc-main",
      modelType: "aws/vpc",
      modelId: "m-1",
      methodName: "adopt",
      status: "succeeded",
    },
    {
      jobName: "networking",
      stepName: "adopt-subnet",
      modelName: "subnet-a",
      modelType: "aws/subnet",
      modelId: "m-2",
      methodName: "adopt",
      status: "succeeded",
    },
    {
      jobName: "database",
      stepName: "adopt-rds",
      modelName: "rds-primary",
      modelType: "aws/rds",
      modelId: "m-3",
      methodName: "adopt",
      status: "succeeded",
    },
  ]);

  const result = await report.execute(ctx);

  assertEquals(result.json.summary.totalAttempted, 3);
  assertEquals(result.json.summary.succeeded, 3);
  assertEquals(result.json.summary.failed, 0);
  assertStringIncludes(result.markdown, "Succeeded | 3");
});

Deno.test("with failures includes remediation", async () => {
  const ctx = makeContext([
    {
      jobName: "networking",
      stepName: "adopt-vpc",
      modelName: "vpc-main",
      modelType: "aws/vpc",
      modelId: "m-1",
      methodName: "adopt",
      status: "succeeded",
    },
    {
      jobName: "networking",
      stepName: "adopt-subnet",
      modelName: "subnet-a",
      modelType: "aws/subnet",
      modelId: "m-2",
      methodName: "adopt",
      status: "failed",
      error: "Resource not found in AWS account",
    },
    {
      jobName: "database",
      stepName: "adopt-rds",
      modelName: "rds-primary",
      modelType: "aws/rds",
      modelId: "m-3",
      methodName: "adopt",
      status: "failed",
      error: "AccessDenied: User is not authorized",
    },
  ]);

  const result = await report.execute(ctx);

  assertEquals(result.json.summary.totalAttempted, 3);
  assertEquals(result.json.summary.succeeded, 1);
  assertEquals(result.json.summary.failed, 2);
  assertStringIncludes(result.markdown, "## Failures");
  assertStringIncludes(
    result.markdown,
    "Run the setup command from discover_all output.",
  );
  assertStringIncludes(
    result.markdown,
    "Check AWS credentials. Ensure AWS_PROFILE and AWS_REGION are exported.",
  );
});

Deno.test("byJob stats calculated correctly", async () => {
  const ctx = makeContext([
    {
      jobName: "networking",
      stepName: "adopt-vpc",
      modelName: "vpc-main",
      modelType: "aws/vpc",
      modelId: "m-1",
      methodName: "adopt",
      status: "succeeded",
    },
    {
      jobName: "networking",
      stepName: "adopt-subnet",
      modelName: "subnet-a",
      modelType: "aws/subnet",
      modelId: "m-2",
      methodName: "adopt",
      status: "failed",
      error: "timeout",
    },
    {
      jobName: "database",
      stepName: "adopt-rds",
      modelName: "rds-primary",
      modelType: "aws/rds",
      modelId: "m-3",
      methodName: "adopt",
      status: "succeeded",
    },
  ]);

  const result = await report.execute(ctx);

  assertEquals(result.json.summary.byJob["networking"], {
    attempted: 2,
    succeeded: 1,
    failed: 1,
    skipped: 0,
  });
  assertEquals(result.json.summary.byJob["database"], {
    attempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  });
});

Deno.test("empty step executions", async () => {
  const ctx = makeContext([]);

  const result = await report.execute(ctx);

  assertEquals(result.json.summary.totalAttempted, 0);
  assertEquals(result.json.summary.succeeded, 0);
  assertEquals(result.json.summary.failed, 0);
  assertStringIncludes(
    result.markdown,
    "No adoption steps were executed. Verify workflow configuration and inputs.",
  );
});

Deno.test("a guard-skipped step is counted as skipped, not failed", async () => {
  const ctx = makeContext([
    {
      jobName: "plan",
      stepName: "judge",
      modelName: "jev",
      modelType: "@swamp/typesafe-ai",
      modelId: "m-jev",
      methodName: "triage_batch",
      status: "skipped",
    },
    {
      jobName: "plan",
      stepName: "decide",
      modelName: "acct",
      modelType: "@webframp/aws/adopt",
      modelId: "m-acct",
      methodName: "decide",
      status: "succeeded",
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.json.summary.failed, 0);
  assertEquals(result.json.summary.skipped, 1);
  assertEquals(result.json.summary.totalAttempted, 1);
  assertEquals(result.json.summary.byJob.plan.skipped, 1);
  assertStringIncludes(result.markdown, "| Skipped | 1 |");
});

Deno.test("a failed step's errorMessage is shown", async () => {
  const ctx = makeContext([{
    jobName: "observe",
    stepName: "get-x",
    modelName: "adopt-x",
    modelType: "@swamp/aws/ec2/vpc",
    modelId: "m-x",
    methodName: "get",
    status: "failed",
  }]);
  // swamp supplies errorMessage, not error.
  (ctx.stepExecutions[0] as Record<string, unknown>).errorMessage =
    "AccessDenied: not authorized";
  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "AccessDenied: not authorized");
});
