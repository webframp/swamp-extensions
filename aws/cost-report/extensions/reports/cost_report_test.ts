// AWS Cost Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { report } from "./cost_report.ts";

// --- Test helpers ---

function makeHandle(name: string, kind: "resource" | "file") {
  return {
    name,
    kind,
    specName: name,
    dataId: `data-${name}`,
    version: 1,
    size: 100,
    contentType: "application/json",
    createdAt: "2026-04-22T00:00:00Z",
    tags: {} as Record<string, string>,
    metadata: {} as Record<string, unknown>,
  };
}

function createContext(
  opts: {
    modelType?: string;
    methodName?: string;
    methodArgs?: Record<string, unknown>;
    dataHandles?: { name: string; kind: "resource" | "file" }[];
    executionStatus?: "succeeded" | "failed";
  } = {},
) {
  const handles = (opts.dataHandles ?? []).map((h) =>
    makeHandle(h.name, h.kind)
  );
  const { context } = createReportTestContext({
    scope: "method",
    modelType: opts.modelType ?? "@webframp/aws/cost-estimate",
    modelId: "cost-est-id",
    methodName: opts.methodName ?? "estimate_from_spec",
    executionStatus: opts.executionStatus ?? "succeeded",
    methodArgs: opts.methodArgs ?? {},
    globalArgs: {},
    // deno-lint-ignore no-explicit-any
    dataHandles: handles as any,
  });
  return context;
}

// ============================================================
// Export structure
// ============================================================

Deno.test("report has correct name", () => {
  assertEquals(report.name, "@webframp/aws/cost-report");
});

Deno.test("report has method scope", () => {
  assertEquals(report.scope, "method");
});

Deno.test("report has labels", () => {
  assertEquals(report.labels, ["cost", "finops", "aws"]);
});

// ============================================================
// Skip behavior: non-cost-estimate model
// ============================================================

Deno.test("skips report for non-cost-estimate model type", async () => {
  const context = createContext({ modelType: "@webframp/aws/ec2" });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "Report skipped");
  assertEquals(result.json.skipped, true);
  assertEquals(result.json.reason, "not-cost-estimate-model");
});

// ============================================================
// estimate_from_spec with EC2 instances
// ============================================================

Deno.test("estimate_from_spec: renders EC2 table from methodArgs", async () => {
  const context = createContext({
    methodName: "estimate_from_spec",
    methodArgs: {
      ec2Instances: [
        {
          name: "web-server",
          instanceType: "t3.medium",
          platform: "linux",
          count: 2,
        },
        {
          name: "api-server",
          instanceType: "m5.large",
          platform: "linux",
          count: 1,
        },
      ],
    },
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## EC2 Instances (from spec)");
  assertStringIncludes(result.markdown, "web-server");
  assertStringIncludes(result.markdown, "t3.medium");
  assertStringIncludes(result.markdown, "api-server");
  assertEquals(result.json.ec2InstanceCount, 2);
});

Deno.test("estimate_from_spec: renders RDS table from methodArgs", async () => {
  const context = createContext({
    methodName: "estimate_from_spec",
    methodArgs: {
      rdsInstances: [
        {
          name: "primary-db",
          dbInstanceClass: "db.r5.large",
          engine: "postgres",
        },
      ],
    },
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## RDS Instances (from spec)");
  assertStringIncludes(result.markdown, "primary-db");
  assertStringIncludes(result.markdown, "db.r5.large");
  assertStringIncludes(result.markdown, "postgres");
  assertEquals(result.json.rdsInstanceCount, 1);
});

Deno.test("estimate_from_spec: renders both EC2 and RDS when present", async () => {
  const context = createContext({
    methodName: "estimate_from_spec",
    methodArgs: {
      ec2Instances: [{ name: "app", instanceType: "t3.small", count: 1 }],
      rdsInstances: [
        { name: "db", dbInstanceClass: "db.t3.micro", engine: "mysql" },
      ],
    },
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## EC2 Instances");
  assertStringIncludes(result.markdown, "## RDS Instances");
  assertEquals(result.json.ec2InstanceCount, 1);
  assertEquals(result.json.rdsInstanceCount, 1);
});

Deno.test("estimate_from_spec: empty arrays produce no tables", async () => {
  const context = createContext({
    methodName: "estimate_from_spec",
    methodArgs: { ec2Instances: [], rdsInstances: [] },
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertEquals(result.markdown.includes("## EC2 Instances"), false);
  assertEquals(result.markdown.includes("## RDS Instances"), false);
});

// ============================================================
// Data handles
// ============================================================

Deno.test("resource data handles produce Data Produced section", async () => {
  const context = createContext({
    dataHandles: [
      { name: "estimate-output", kind: "resource" },
      { name: "summary", kind: "resource" },
    ],
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## Data Produced");
  assertStringIncludes(result.markdown, "estimate-output");
  assertStringIncludes(result.markdown, "summary");
  assertStringIncludes(result.markdown, "swamp data get test-instance");
  const artifacts = result.json.dataArtifacts as string[];
  assertEquals(artifacts.length, 2);
});

Deno.test("non-resource handles are excluded from Data Produced", async () => {
  const context = createContext({
    dataHandles: [
      { name: "estimate-output", kind: "resource" },
      { name: "log-entry", kind: "file" },
    ],
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "estimate-output");
  assertEquals(result.markdown.includes("log-entry"), false);
});

Deno.test("no data handles produces no Data Produced section", async () => {
  const context = createContext({ dataHandles: [] });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertEquals(result.markdown.includes("## Data Produced"), false);
});

// ============================================================
// Method-specific recommendations
// ============================================================

Deno.test("estimate_from_spec: recommendations mention Reserved Instances and Savings Plans", async () => {
  const context = createContext({ methodName: "estimate_from_spec" });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "Reserved Instances");
  assertStringIncludes(result.markdown, "Savings Plans");
});

Deno.test("estimate_ec2: recommendations mention tag-based review", async () => {
  const context = createContext({ methodName: "estimate_ec2" });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "tag");
  assertStringIncludes(result.markdown, "underutilized");
});

Deno.test("estimate_rds: recommendations mention Multi-AZ and Aurora", async () => {
  const context = createContext({ methodName: "estimate_rds" });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "Multi-AZ");
  assertStringIncludes(result.markdown, "Aurora Serverless");
});

Deno.test("unknown method: falls back to generic recommendation", async () => {
  const context = createContext({ methodName: "some_other_method" });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "No specific recommendations");
});

// ============================================================
// Header content
// ============================================================

Deno.test("report header includes model name, method, and status", async () => {
  const context = createContext({
    methodName: "estimate_ec2",
    executionStatus: "succeeded",
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "# AWS Cost Report");
  assertStringIncludes(result.markdown, "**Model**: test-instance");
  assertStringIncludes(result.markdown, "**Method**: estimate_ec2");
  assertStringIncludes(result.markdown, "**Status**: succeeded");
});

// ============================================================
// JSON output structure
// ============================================================

Deno.test("json output includes modelName, method, and status", async () => {
  const context = createContext({
    methodName: "estimate_from_spec",
    executionStatus: "succeeded",
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertEquals(result.json.modelName, "test-instance");
  assertEquals(result.json.method, "estimate_from_spec");
  assertEquals(result.json.status, "succeeded");
});
