// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./adopt_drift_report.ts";

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
  dataStore?: Record<string, Record<string, unknown>>,
) {
  return {
    workflowId: "wf-test",
    workflowRunId: "run-test",
    workflowName: "@webframp/adopt-drift-check",
    workflowStatus: "completed",
    stepExecutions: stepExecutions.map((s) => ({
      ...s,
      dataHandles: s.dataHandles ?? [],
    })),
    repoDir: "/tmp/test",
    dataRepository: {
      getContent: (
        _type: unknown,
        _id: string,
        name: string,
        version?: number,
      ): Promise<Uint8Array | null> => {
        const key = version ? `${name}@${version}` : name;
        const data = dataStore?.[key];
        if (data) {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify(data)),
          );
        }
        return Promise.resolve(null);
      },
    },
    logger: { info: (_msg: string, _props: Record<string, unknown>) => {} },
  };
}

Deno.test("report metadata is correct", () => {
  assertEquals(report.name, "@webframp/adopt-drift-report");
  assertEquals(report.scope, "workflow");
});

Deno.test("no drift when stored and live are identical", async () => {
  const vpcData = {
    VpcId: "vpc-123",
    CidrBlock: "10.0.0.0/16",
    State: "available",
  };
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
      {
        jobName: "sync-all",
        stepName: "sync-TestVpc",
        modelName: "test-vpc-123",
        modelType: "@swamp/aws/ec2/vpc",
        modelId: "m-vpc",
        methodName: "sync",
        status: "succeeded",
        dataHandles: [{ name: "test-vpc-123", dataId: "d2", version: 2 }],
      },
    ],
    {
      "plan-my-stack@1": {
        stackName: "my-stack",
        mapped: [
          {
            logicalId: "TestVpc",
            modelName: "test-vpc-123",
            cfnType: "AWS::EC2::VPC",
            physicalId: "vpc-123",
          },
        ],
        orphans: [],
      },
      "test-vpc-123@2": vpcData,
      "test-vpc-123@1": vpcData,
    },
  );

  const result = await report.execute(ctx);
  assertEquals(result.json.summary.drifted, 0);
  assertEquals(result.json.summary.unchanged, 1);
  assertStringIncludes(result.markdown, "No drift detected");
});

Deno.test("detects drift when field changes", async () => {
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
      {
        jobName: "sync-all",
        stepName: "sync-TestVpc",
        modelName: "test-vpc-123",
        modelType: "@swamp/aws/ec2/vpc",
        modelId: "m-vpc",
        methodName: "sync",
        status: "succeeded",
        dataHandles: [{ name: "test-vpc-123", dataId: "d2", version: 3 }],
      },
    ],
    {
      "plan-my-stack@1": {
        stackName: "my-stack",
        mapped: [
          {
            logicalId: "TestVpc",
            modelName: "test-vpc-123",
            cfnType: "AWS::EC2::VPC",
            physicalId: "vpc-123",
          },
        ],
        orphans: [],
      },
      "test-vpc-123@3": {
        VpcId: "vpc-123",
        CidrBlock: "10.0.0.0/16",
        EnableDnsHostnames: true,
      },
      "test-vpc-123@2": {
        VpcId: "vpc-123",
        CidrBlock: "10.0.0.0/16",
        EnableDnsHostnames: false,
      },
    },
  );

  const result = await report.execute(ctx);
  assertEquals(result.json.summary.drifted, 1);
  assertEquals(result.json.resources[0].diffs.length, 1);
  assertEquals(result.json.resources[0].diffs[0].field, "EnableDnsHostnames");
  assertStringIncludes(result.markdown, "Drifted Resources");
});

Deno.test("marks resource as missing when sync fails with not found", async () => {
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
      {
        jobName: "sync-all",
        stepName: "sync-TestVpc",
        modelName: "test-vpc-123",
        modelType: "@swamp/aws/ec2/vpc",
        modelId: "m-vpc",
        methodName: "sync",
        status: "failed",
        error: "ResourceNotFoundException: vpc-123 not found",
      },
    ],
    {
      "plan-my-stack@1": {
        stackName: "my-stack",
        mapped: [
          {
            logicalId: "TestVpc",
            modelName: "test-vpc-123",
            cfnType: "AWS::EC2::VPC",
            physicalId: "vpc-123",
          },
        ],
        orphans: [],
      },
    },
  );

  const result = await report.execute(ctx);
  assertEquals(result.json.summary.missing, 1);
  assertStringIncludes(result.markdown, "Missing Resources");
});

Deno.test("shows orphans from plan", async () => {
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
    ],
    {
      "plan-my-stack@1": {
        stackName: "my-stack",
        mapped: [],
        orphans: [{ modelName: "adopt-vpc-old999" }],
      },
    },
  );

  const result = await report.execute(ctx);
  assertEquals(result.json.summary.orphans, 1);
  assertStringIncludes(result.markdown, "Orphaned Resources");
  assertStringIncludes(result.markdown, "adopt-vpc-old999");
});

Deno.test("handles failed plan step gracefully", async () => {
  const ctx = makeContext([
    {
      jobName: "plan",
      stepName: "plan-resources",
      modelName: "adopt-test",
      modelType: "@webframp/aws/adopt",
      modelId: "m-adopt",
      methodName: "plan_stack_adoption",
      status: "failed",
      error: "credentials expired",
    },
  ]);

  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "Plan step did not succeed");
  assertEquals(result.json.summary.total, 0);
});

Deno.test("no false drift from reordered object keys", async () => {
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
      {
        jobName: "sync-all",
        stepName: "sync-TestSg",
        modelName: "test-sg-abc",
        modelType: "@swamp/aws/ec2/security-group",
        modelId: "m-sg",
        methodName: "sync",
        status: "succeeded",
        dataHandles: [{ name: "test-sg-abc", dataId: "d2", version: 2 }],
      },
    ],
    {
      "plan-my-stack@1": {
        stackName: "my-stack",
        mapped: [
          {
            logicalId: "TestSg",
            modelName: "test-sg-abc",
            cfnType: "AWS::EC2::SecurityGroup",
            physicalId: "sg-1",
          },
        ],
        orphans: [],
      },
      // Keys in different order between versions — should NOT be flagged as drift
      "test-sg-abc@2": {
        GroupId: "sg-1",
        Tags: { app: "web", env: "prod" },
        VpcId: "vpc-1",
      },
      "test-sg-abc@1": {
        VpcId: "vpc-1",
        GroupId: "sg-1",
        Tags: { env: "prod", app: "web" },
      },
    },
  );

  const result = await report.execute(ctx);
  assertEquals(result.json.summary.drifted, 0);
  assertEquals(result.json.summary.unchanged, 1);
});

Deno.test("reports warning when plan data is unreadable", async () => {
  const ctx = makeContext(
    [
      {
        jobName: "plan",
        stepName: "plan-resources",
        modelName: "adopt-test",
        modelType: "@webframp/aws/adopt",
        modelId: "m-adopt",
        methodName: "plan_stack_adoption",
        status: "succeeded",
        dataHandles: [{ name: "plan-my-stack", dataId: "d1", version: 1 }],
      },
    ],
    {}, // No data in store — simulates GC or read failure
  );

  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "plan data is unreadable");
  assertEquals(result.json.summary.total, 0);
  // Must NOT say "No drift detected"
  assertEquals(result.markdown.includes("No drift detected"), false);
});
