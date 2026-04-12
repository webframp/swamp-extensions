// AWS Cost Audit Report
// SPDX-License-Identifier: Apache-2.0

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

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

export const report = {
  name: "@webframp/cost-audit-report",
  description:
    "Aggregates cost, inventory, and networking data from the cost-audit workflow into a savings report",
  scope: "workflow" as const,
  labels: ["aws", "cost", "finops", "audit"],

  execute: async (context: WorkflowReportContext) => {
    const findings: string[] = [];
    const jsonFindings: Record<string, unknown> = {
      workflowName: context.workflowName,
      workflowStatus: context.workflowStatus,
      timestamp: new Date().toISOString(),
    };

    // Helper to get data from filesystem
    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        // Data path: .swamp/data/{modelType}/{modelId}/{dataName}/{version}/raw
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    interface DataLocation {
      modelType: string;
      modelId: string;
      dataName: string;
      version: number;
    }

    // Helper to find step data by model and method
    function findStepData(
      modelName: string,
      methodName: string,
    ): DataLocation | null {
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName && step.methodName === methodName) {
          // Return first non-report data handle
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              return {
                modelType: step.modelType,
                modelId: step.modelId,
                dataName: handle.name,
                version: handle.version,
              };
            }
          }
        }
      }
      return null;
    }

    // Helper to find all data for a model/method
    function findAllStepData(
      modelName: string,
      methodName?: string,
    ): Array<{ stepName: string; loc: DataLocation }> {
      const results: Array<{ stepName: string; loc: DataLocation }> = [];
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName) {
          if (methodName && step.methodName !== methodName) continue;
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              results.push({
                stepName: step.stepName,
                loc: {
                  modelType: step.modelType,
                  modelId: step.modelId,
                  dataName: handle.name,
                  version: handle.version,
                },
              });
            }
          }
        }
      }
      return results;
    }

    // Convenience: get data for a model/method
    async function getStepData(
      modelName: string,
      methodName: string,
    ): Promise<Record<string, unknown> | null> {
      const loc = findStepData(modelName, methodName);
      if (!loc) return null;
      return await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
    }

    // Suppress unused variable warnings — these helpers are available
    // for future expansion but not all are called in every code path.
    void findAllStepData;

    // === SECTION 1: COST SUMMARY ===
    findings.push("## Cost Summary\n");

    const costByServiceData = await getStepData(
      "aws-costs",
      "get_cost_by_service",
    );
    if (costByServiceData) {
      const costData = costByServiceData as {
        services: Array<{
          service: string;
          amount: number;
          percentage: number;
        }>;
        total: number;
        currency: string;
        periodDays: number;
      };

      findings.push(
        `Total spend over ${costData.periodDays || 30} days: **$${
          costData.total.toFixed(2)
        } ${costData.currency || "USD"}**\n`,
      );
      findings.push("| Service | Amount | % of Total |");
      findings.push("| ------- | -----: | ---------: |");
      for (const svc of costData.services || []) {
        findings.push(
          `| ${svc.service} | $${svc.amount.toFixed(2)} | ${
            svc.percentage.toFixed(1)
          }% |`,
        );
      }
      findings.push("");

      jsonFindings.costSummary = {
        total: costData.total,
        currency: costData.currency || "USD",
        periodDays: costData.periodDays || 30,
        services: costData.services,
      };
    } else {
      findings.push("No cost-by-service data available.\n");
    }

    // === SECTION 2: TOP COST DRIVERS ===
    findings.push("\n## Top Cost Drivers\n");

    const topDriversData = await getStepData(
      "aws-costs",
      "get_top_cost_drivers",
    );
    if (topDriversData) {
      const drivers = topDriversData as {
        drivers: Array<{
          service: string;
          usageType: string;
          amount: number;
        }>;
      };

      findings.push("| Service | Usage Type | Amount |");
      findings.push("| ------- | ---------- | -----: |");
      for (const driver of drivers.drivers || []) {
        findings.push(
          `| ${driver.service} | ${driver.usageType} | $${
            driver.amount.toFixed(2)
          } |`,
        );
      }
      findings.push("");

      jsonFindings.topCostDrivers = drivers.drivers;
    } else {
      findings.push("No top cost driver data available.\n");
    }

    // === SECTION 3: NETWORKING WASTE ===
    findings.push("\n## Networking Waste Analysis\n");

    const networkingWaste: Array<{
      resource: string;
      type: string;
      issue: string;
      estimatedMonthlyCost: string;
    }> = [];

    // NAT Gateways
    const natData = await getStepData("aws-networking", "list_nat_gateways");
    const transferMetrics = await getStepData(
      "aws-networking",
      "get_data_transfer_metrics",
    );

    if (natData) {
      const nats = natData as {
        natGateways: Array<{
          natGatewayId: string;
          state: string;
          subnetId: string;
          vpcId: string;
        }>;
        count: number;
      };

      const metricsMap = new Map<string, number>();
      if (transferMetrics) {
        const metrics = transferMetrics as {
          natGatewayMetrics?: Array<{
            natGatewayId: string;
            bytesProcessed: number;
          }>;
        };
        for (const m of metrics.natGatewayMetrics || []) {
          metricsMap.set(m.natGatewayId, m.bytesProcessed);
        }
      }

      if (nats.count > 0) {
        findings.push("### NAT Gateways\n");
        findings.push("| NAT Gateway | VPC | Bytes Processed (7d) | Status |");
        findings.push("| ----------- | --- | -------------------: | ------ |");

        for (const nat of nats.natGateways || []) {
          const bytes = metricsMap.get(nat.natGatewayId) ?? 0;
          const bytesGB = (bytes / 1024 / 1024 / 1024).toFixed(2);
          // Less than 1GB in 7 days extrapolates to < ~4.3GB/month
          const isLow = bytes < 1 * 1024 * 1024 * 1024;
          const status = isLow ? "LOW TRAFFIC" : "OK";
          findings.push(
            `| ${nat.natGatewayId} | ${nat.vpcId} | ${bytesGB} GB | ${status} |`,
          );

          if (isLow) {
            networkingWaste.push({
              resource: nat.natGatewayId,
              type: "NAT Gateway",
              issue: "Low traffic — baseline cost wasted",
              estimatedMonthlyCost: "$32+",
            });
          }
        }
        findings.push("");
      }
    }

    // Load Balancers
    const albData = await getStepData("aws-networking", "list_load_balancers");

    if (albData) {
      const albs = albData as {
        loadBalancers: Array<{
          loadBalancerArn: string;
          loadBalancerName: string;
          type: string;
          state: string;
        }>;
        count: number;
      };

      const albMetricsMap = new Map<string, number>();
      if (transferMetrics) {
        const metrics = transferMetrics as {
          loadBalancerMetrics?: Array<{
            loadBalancerName: string;
            requestCount: number;
          }>;
        };
        for (const m of metrics.loadBalancerMetrics || []) {
          albMetricsMap.set(m.loadBalancerName, m.requestCount);
        }
      }

      if (albs.count > 0) {
        findings.push("### Load Balancers\n");
        findings.push("| Load Balancer | Type | Requests (7d) | Status |");
        findings.push("| ------------- | ---- | ------------: | ------ |");

        for (const alb of albs.loadBalancers || []) {
          const requests = albMetricsMap.get(alb.loadBalancerName) ?? 0;
          // Less than 10000 requests in 7 days extrapolates to very low monthly usage
          const isLow = requests < 10000;
          const status = isLow ? "LOW TRAFFIC" : "OK";
          findings.push(
            `| ${alb.loadBalancerName} | ${alb.type} | ${requests.toLocaleString()} | ${status} |`,
          );

          if (isLow) {
            networkingWaste.push({
              resource: alb.loadBalancerName,
              type: "Load Balancer",
              issue: "Low traffic — baseline cost wasted",
              estimatedMonthlyCost: "$16+",
            });
          }
        }
        findings.push("");
      }
    }

    // Elastic IPs
    const eipData = await getStepData("aws-networking", "list_elastic_ips");

    if (eipData) {
      const eips = eipData as {
        addresses: Array<{
          publicIp: string;
          allocationId: string;
          associationId?: string;
          instanceId?: string;
          networkInterfaceId?: string;
        }>;
        count: number;
      };

      const unattached = (eips.addresses || []).filter(
        (eip) => !eip.associationId,
      );

      if (unattached.length > 0) {
        findings.push("### Unattached Elastic IPs\n");
        findings.push("| Public IP | Allocation ID | Monthly Cost |");
        findings.push("| --------- | ------------- | -----------: |");

        for (const eip of unattached) {
          findings.push(
            `| ${eip.publicIp} | ${eip.allocationId} | $3.65 |`,
          );
          networkingWaste.push({
            resource: eip.publicIp,
            type: "Elastic IP",
            issue: "Unattached — charged while idle",
            estimatedMonthlyCost: "$3.65",
          });
        }
        findings.push("");
      }

      if (eips.count > 0 && unattached.length === 0) {
        findings.push("All Elastic IPs are attached.\n");
      }
    }

    if (networkingWaste.length === 0 && !natData && !albData && !eipData) {
      findings.push("No networking data available.\n");
    } else if (networkingWaste.length === 0) {
      findings.push("No networking waste detected.\n");
    }

    jsonFindings.networkingWaste = networkingWaste;

    // === SECTION 4: INFRASTRUCTURE INVENTORY ===
    findings.push("\n## Infrastructure Inventory\n");

    const inventoryData = await getStepData("aws-inventory", "inventory_all");
    if (inventoryData) {
      const inventory = inventoryData as {
        resources: Record<string, number>;
        totalResources: number;
      };

      findings.push(
        `Total resources discovered: **${inventory.totalResources}**\n`,
      );
      findings.push("| Resource Type | Count |");
      findings.push("| ------------- | ----: |");

      for (
        const [resourceType, count] of Object.entries(
          inventory.resources || {},
        )
      ) {
        findings.push(`| ${resourceType} | ${count} |`);
      }
      findings.push("");

      jsonFindings.inventory = {
        totalResources: inventory.totalResources,
        resources: inventory.resources,
      };
    } else {
      findings.push("No inventory data available.\n");
    }

    // === SECTION 5: RECOMMENDATIONS ===
    findings.push("\n## Recommendations\n");

    const recommendations: Array<{
      priority: number;
      action: string;
      estimatedSavings: string;
    }> = [];

    // Low-traffic NAT Gateways
    const lowTrafficNats = networkingWaste.filter(
      (w) => w.type === "NAT Gateway",
    );
    if (lowTrafficNats.length > 0) {
      recommendations.push({
        priority: 1,
        action:
          `Remove or consolidate ${lowTrafficNats.length} low-traffic NAT Gateway(s)`,
        estimatedSavings: "$32+/month savings per gateway",
      });
    }

    // Low-traffic ALBs
    const lowTrafficAlbs = networkingWaste.filter(
      (w) => w.type === "Load Balancer",
    );
    if (lowTrafficAlbs.length > 0) {
      recommendations.push({
        priority: 2,
        action:
          `Remove or consolidate ${lowTrafficAlbs.length} low-traffic load balancer(s)`,
        estimatedSavings: "$16+/month savings per ALB",
      });
    }

    // Unattached EIPs
    const unattachedEips = networkingWaste.filter(
      (w) => w.type === "Elastic IP",
    );
    if (unattachedEips.length > 0) {
      recommendations.push({
        priority: 3,
        action: `Release ${unattachedEips.length} unattached Elastic IP(s)`,
        estimatedSavings: "$3.65/month per EIP",
      });
    }

    // Cost trend warning
    const costTrendData = await getStepData("aws-costs", "get_cost_trend");
    if (costTrendData) {
      const trend = costTrendData as {
        trend: string;
        dailyCosts: Array<{ date: string; amount: number }>;
      };

      if (trend.trend === "increasing") {
        recommendations.push({
          priority: 4,
          action:
            "Investigate increasing cost trend — spending is rising over the period",
          estimatedSavings: "Variable",
        });
      }
    }

    // Sort by priority
    recommendations.sort((a, b) => a.priority - b.priority);

    if (recommendations.length > 0) {
      findings.push(
        "| Priority | Action | Estimated Savings |",
      );
      findings.push(
        "| :------: | ------ | ----------------: |",
      );
      for (const rec of recommendations) {
        findings.push(
          `| ${rec.priority} | ${rec.action} | ${rec.estimatedSavings} |`,
        );
      }
      findings.push("");
    } else {
      findings.push(
        "No critical cost issues detected. Continue monitoring.\n",
      );
    }

    jsonFindings.recommendations = recommendations;

    // === BUILD FINAL REPORT ===
    const markdown = `# AWS Cost Audit Report

**Workflow**: ${context.workflowName}
**Status**: ${context.workflowStatus}
**Generated**: ${new Date().toISOString()}

---

${findings.join("\n")}

---

*Report generated by @webframp/cost-audit-report*
`;

    context.logger.info("Generated cost audit report", {
      workflowName: context.workflowName,
      findingsCount: findings.length,
      recommendationCount: recommendations.length,
    });

    return {
      markdown,
      json: jsonFindings,
    };
  },
};
