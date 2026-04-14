// Tests for cost audit report
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./cost_audit_report.ts";

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
}

async function writeStepData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir =
    `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function makeStep(
  modelName: string,
  modelType: string,
  modelId: string,
  methodName: string,
  dataName: string,
  version: number = 1,
): StepExecution {
  return {
    jobName: "test-job",
    stepName: `${modelName}-${methodName}`,
    modelName,
    modelType,
    modelId,
    methodName,
    status: "completed",
    dataHandles: [{ name: dataName, dataId: `data-${dataName}`, version }],
  };
}

function makeContext(
  tmpDir: string,
  stepExecutions: StepExecution[] = [],
) {
  return {
    workflowId: "wf-test",
    workflowRunId: "run-test",
    workflowName: "cost-audit",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

Deno.test({
  name: "report structure has correct name, scope, and labels",
  fn() {
    assertEquals(report.name, "@webframp/cost-audit-report");
    assertEquals(report.scope, "workflow");
    assertStringIncludes(report.labels.join(","), "aws");
    assertStringIncludes(report.labels.join(","), "finops");
  },
});

Deno.test({
  name: "report with no step data returns markdown and json without errors",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = makeContext(tmpDir, []);
      const result = await report.execute(context);

      assertEquals(typeof result.markdown, "string");
      assertEquals(typeof result.json, "object");
      assertStringIncludes(result.markdown, "cost-audit");
      assertStringIncludes(
        result.markdown,
        "No cost-by-service data available.",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with cost summary shows total and service breakdown",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const costByService = {
        data: [
          {
            service: "Amazon EC2",
            amount: 500.00,
            unit: "USD",
            percentage: 50.0,
          },
          {
            service: "Amazon RDS",
            amount: 300.00,
            unit: "USD",
            percentage: 30.0,
          },
          {
            service: "Amazon S3",
            amount: 200.00,
            unit: "USD",
            percentage: 20.0,
          },
        ],
      };

      const modelType = "@webframp/aws/cost-explorer";
      const modelId = "aws-costs";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "cost-by-service",
        1,
        costByService,
      );

      const steps = [
        makeStep(
          "aws-costs",
          modelType,
          modelId,
          "get_cost_by_service",
          "cost-by-service",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "$1000.00 USD");
      assertStringIncludes(result.markdown, "Amazon EC2");
      assertStringIncludes(result.markdown, "Amazon RDS");
      assertStringIncludes(result.markdown, "Amazon S3");

      const json = result.json as Record<string, unknown>;
      const costSummary = json.costSummary as { total: number };
      assertEquals(costSummary.total, 1000);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "report with networking waste identifies low-traffic NAT and unattached EIP",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const natGatewayData = {
        region: "us-east-1",
        queryType: "nat_gateways",
        data: [{
          natGatewayId: "nat-abc",
          state: "available",
          vpcId: "vpc-123",
          subnetId: "subnet-123",
        }],
        fetchedAt: "2026-01-01",
      };

      const transferMetrics = {
        region: "us-east-1",
        queryType: "data_transfer_metrics",
        data: {
          natGateways: [{ id: "nat-abc", totalBytes: 100000 }],
          loadBalancers: [],
        },
        fetchedAt: "2026-01-01",
      };

      const eipData = {
        region: "us-east-1",
        queryType: "elastic_ips",
        data: [{
          publicIp: "54.1.2.3",
          allocationId: "eipalloc-123",
          associationId: null,
          isAttached: false,
        }],
        fetchedAt: "2026-01-01",
      };

      const modelType = "@webframp/aws/networking";
      const modelId = "aws-networking";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "nat-gateways",
        1,
        natGatewayData,
      );
      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "transfer-metrics",
        1,
        transferMetrics,
      );
      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "elastic-ips",
        1,
        eipData,
      );

      const steps = [
        makeStep(
          "aws-networking",
          modelType,
          modelId,
          "list_nat_gateways",
          "nat-gateways",
        ),
        makeStep(
          "aws-networking",
          modelType,
          modelId,
          "get_data_transfer_metrics",
          "transfer-metrics",
        ),
        makeStep(
          "aws-networking",
          modelType,
          modelId,
          "list_elastic_ips",
          "elastic-ips",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "LOW TRAFFIC");
      assertStringIncludes(result.markdown, "Unattached Elastic IPs");
      assertStringIncludes(result.markdown, "54.1.2.3");

      const json = result.json as Record<string, unknown>;
      const networkingWaste = json.networkingWaste as Array<{
        type: string;
      }>;
      assertEquals(networkingWaste.length, 2);

      const wasteTypes = networkingWaste.map((w) => w.type).sort();
      assertEquals(wasteTypes, ["Elastic IP", "NAT Gateway"]);

      // Check recommendations include NAT and EIP actions
      const recommendations = json.recommendations as Array<{
        action: string;
      }>;
      const recActions = recommendations.map((r) => r.action).join(" ");
      assertStringIncludes(recActions, "NAT Gateway");
      assertStringIncludes(recActions, "Elastic IP");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with inventory data identifies stopped EC2 and unattached EBS",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const inventoryData = {
        resources: {
          ec2: [
            {
              instanceId: "i-running",
              instanceType: "t3.medium",
              state: "running",
              launchTime: "2026-01-01",
              tags: { Name: "web" },
            },
            {
              instanceId: "i-stopped",
              instanceType: "t3.large",
              state: "stopped",
              launchTime: "2025-06-01",
              tags: { Name: "old-app" },
            },
          ],
          rds: [{ dbInstanceId: "mydb" }],
          ebs: [
            {
              volumeId: "vol-attached",
              volumeType: "gp3",
              size: 100,
              state: "in-use",
              isAttached: true,
              createTime: "2026-01-01",
            },
            {
              volumeId: "vol-orphan",
              volumeType: "gp3",
              size: 50,
              state: "available",
              isAttached: false,
              createTime: "2025-01-01",
            },
          ],
        },
      };

      const modelType = "@webframp/aws/inventory";
      const modelId = "aws-inventory";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "inventory-all",
        1,
        inventoryData,
      );

      const steps = [
        makeStep(
          "aws-inventory",
          modelType,
          modelId,
          "inventory_all",
          "inventory-all",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "Stopped EC2 Instances");
      assertStringIncludes(result.markdown, "i-stopped");
      assertStringIncludes(result.markdown, "Unattached EBS Volumes");
      assertStringIncludes(result.markdown, "vol-orphan");

      const json = result.json as Record<string, unknown>;
      const recommendations = json.recommendations as Array<{
        action: string;
      }>;
      const recActions = recommendations.map((r) => r.action).join(" ");
      assertStringIncludes(recActions, "stopped EC2");
      assertStringIncludes(recActions, "unattached EBS");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "report with month-over-month comparison shows increases, decreases, and unusual spend",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const comparisonData = {
        data: {
          currentPeriod: {
            start: "2026-03-01",
            end: "2026-04-01",
            total: 1200,
          },
          previousPeriod: {
            start: "2026-02-01",
            end: "2026-03-01",
            total: 1000,
          },
          totalDelta: 200,
          totalDeltaPercent: 20.0,
          services: [
            {
              service: "Amazon EC2",
              currentAmount: 600,
              previousAmount: 400,
              delta: 200,
              deltaPercent: 50.0,
            },
            {
              service: "Amazon S3",
              currentAmount: 100,
              previousAmount: 150,
              delta: -50,
              deltaPercent: -33.3,
            },
          ],
        },
      };

      const modelType = "@webframp/aws/cost-explorer";
      const modelId = "aws-costs";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "cost-comparison",
        1,
        comparisonData,
      );

      const steps = [
        makeStep(
          "aws-costs",
          modelType,
          modelId,
          "get_cost_comparison",
          "cost-comparison",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "increased");
      assertStringIncludes(result.markdown, "$200.00");
      assertStringIncludes(result.markdown, "Largest Increases");
      assertStringIncludes(result.markdown, "Largest Decreases");
      assertStringIncludes(result.markdown, "Unusual Spend");
      // EC2 has 50% increase which is >25%
      assertStringIncludes(result.markdown, "Amazon EC2");
      assertStringIncludes(result.markdown, "50.0%");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
