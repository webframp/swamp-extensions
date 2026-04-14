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

    // === SECTION 0: MONTH-OVER-MONTH COMPARISON ===
    const comparisonData = await getStepData(
      "aws-costs",
      "get_cost_comparison",
    );
    if (comparisonData) {
      const comp = comparisonData as {
        data: {
          currentPeriod: { start: string; end: string; total: number };
          previousPeriod: { start: string; end: string; total: number };
          totalDelta: number;
          totalDeltaPercent: number;
          services: Array<{
            service: string;
            currentAmount: number;
            previousAmount: number;
            delta: number;
            deltaPercent: number;
          }>;
        };
      };
      const d = comp.data;

      findings.push("## Month-over-Month Comparison\n");
      const direction = d.totalDelta >= 0 ? "increase" : "decrease";
      findings.push(
        `Total spend **${direction}d** by **$${
          Math.abs(d.totalDelta).toFixed(2)
        }** (${
          d.totalDeltaPercent.toFixed(1)
        }%) compared to previous period.\n`,
      );
      findings.push(
        `- Current period (${d.currentPeriod.start} → ${d.currentPeriod.end}): **$${
          d.currentPeriod.total.toFixed(2)
        }**`,
      );
      findings.push(
        `- Previous period (${d.previousPeriod.start} → ${d.previousPeriod.end}): **$${
          d.previousPeriod.total.toFixed(2)
        }**\n`,
      );

      // Top increases
      const increases = d.services.filter((s) => s.delta > 0.01).sort((
        a,
        b,
      ) => b.delta - a.delta).slice(0, 5);
      if (increases.length > 0) {
        findings.push("### Largest Increases\n");
        findings.push("| Service | Current | Previous | Change | % |");
        findings.push("| ------- | ------: | -------: | -----: | -: |");
        for (const s of increases) {
          findings.push(
            `| ${s.service} | $${s.currentAmount.toFixed(2)} | $${
              s.previousAmount.toFixed(2)
            } | +$${s.delta.toFixed(2)} | ${s.deltaPercent.toFixed(1)}% |`,
          );
        }
        findings.push("");
      }

      // Top decreases
      const decreases = d.services.filter((s) => s.delta < -0.01).sort((
        a,
        b,
      ) => a.delta - b.delta).slice(0, 5);
      if (decreases.length > 0) {
        findings.push("### Largest Decreases\n");
        findings.push("| Service | Current | Previous | Change | % |");
        findings.push("| ------- | ------: | -------: | -----: | -: |");
        for (const s of decreases) {
          findings.push(
            `| ${s.service} | $${s.currentAmount.toFixed(2)} | $${
              s.previousAmount.toFixed(2)
            } | -$${Math.abs(s.delta).toFixed(2)} | ${
              s.deltaPercent.toFixed(1)
            }% |`,
          );
        }
        findings.push("");
      }

      // Flag unusual increases (>25%)
      const unusual = d.services.filter((s) =>
        s.deltaPercent > 25 && s.currentAmount > 1
      );
      if (unusual.length > 0) {
        findings.push("### Unusual Spend (>25% increase)\n");
        for (const s of unusual) {
          findings.push(
            `- **${s.service}**: +${s.deltaPercent.toFixed(1)}% ($${
              s.previousAmount.toFixed(2)
            } → $${s.currentAmount.toFixed(2)})`,
          );
        }
        findings.push("");
      }

      jsonFindings.comparison = d;
    }

    // === SECTION 1: COST SUMMARY ===
    findings.push("## Cost Summary\n");

    const costByServiceData = await getStepData(
      "aws-costs",
      "get_cost_by_service",
    );
    if (costByServiceData) {
      // Model writes: { region, queryType, data: [{service, amount, unit, percentage}], fetchedAt }
      const raw = costByServiceData as {
        data: Array<{
          service: string;
          amount: number;
          unit: string;
          percentage: number;
        }>;
      };
      const services = raw.data || [];
      const total = services.reduce((sum, s) => sum + s.amount, 0);
      const currency = services[0]?.unit || "USD";

      findings.push(
        `Total spend over 30 days: **$${total.toFixed(2)} ${currency}**\n`,
      );
      findings.push("| Service | Amount | % of Total |");
      findings.push("| ------- | -----: | ---------: |");
      for (const svc of services) {
        findings.push(
          `| ${svc.service} | $${svc.amount.toFixed(2)} | ${
            svc.percentage.toFixed(1)
          }% |`,
        );
      }
      findings.push("");

      jsonFindings.costSummary = {
        total,
        currency,
        periodDays: 30,
        services,
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
      // Model writes: { region, queryType, data: [{service, usageType, amount, unit}], fetchedAt }
      const raw = topDriversData as {
        data: Array<{
          service: string;
          usageType: string;
          amount: number;
          unit: string;
        }>;
      };
      const drivers = raw.data || [];

      findings.push("| Service | Usage Type | Amount |");
      findings.push("| ------- | ---------- | -----: |");
      for (const driver of drivers) {
        findings.push(
          `| ${driver.service} | ${driver.usageType} | $${
            driver.amount.toFixed(2)
          } |`,
        );
      }
      findings.push("");

      jsonFindings.topCostDrivers = drivers;
    } else {
      findings.push("No top cost driver data available.\n");
    }

    // === SERVICE DEEP DIVE ===
    findings.push("\n## Service Deep Dive\n");

    const usageTypeSteps = findAllStepData(
      "aws-costs",
      "get_cost_by_usage_type",
    );
    const serviceBreakdowns: Array<{
      service: string;
      items: Array<{ usageType: string; amount: number }>;
    }> = [];

    for (const { stepName, loc } of usageTypeSteps) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;

      const raw = data as {
        data: Array<{ usageType: string; amount: number; unit: string }>;
      };
      const items = (raw.data || []).filter((i) => i.amount > 0.01);
      if (items.length === 0) continue;

      // Extract service name from step name (e.g., "get-cost-by-usage-type-ec2" -> "EC2")
      const serviceSuffix = stepName.replace("get-cost-by-usage-type-", "")
        .toUpperCase();
      const total = items.reduce((sum, i) => sum + i.amount, 0);

      findings.push(`### ${serviceSuffix} — $${total.toFixed(2)}\n`);
      findings.push("| Usage Type | Amount |");
      findings.push("| ---------- | -----: |");
      for (
        const item of items.sort((a, b) => b.amount - a.amount).slice(0, 10)
      ) {
        findings.push(`| ${item.usageType} | $${item.amount.toFixed(2)} |`);
      }
      findings.push("");

      serviceBreakdowns.push({ service: serviceSuffix, items });
    }

    if (usageTypeSteps.length === 0) {
      findings.push("No service usage type data available.\n");
    }

    jsonFindings.serviceBreakdowns = serviceBreakdowns;

    // === SECTION 3: NETWORKING WASTE ===
    findings.push("\n## Networking Waste Analysis\n");

    const networkingWaste: Array<{
      resource: string;
      type: string;
      issue: string;
      estimatedMonthlyCost: string;
    }> = [];

    // NAT Gateways
    // Model writes: { region, queryType, data: [{natGatewayId, state, vpcId, subnetId, ...}], fetchedAt }
    const natData = await getStepData("aws-networking", "list_nat_gateways");
    const transferMetrics = await getStepData(
      "aws-networking",
      "get_data_transfer_metrics",
    );

    if (natData) {
      const natRaw = natData as {
        data: Array<{
          natGatewayId: string;
          state: string;
          subnetId: string;
          vpcId: string;
        }>;
      };
      const natGateways = natRaw.data || [];

      // Transfer metrics: { region, queryType, data: { natGateways: [{id, totalBytes, ...}], ... }, fetchedAt }
      const metricsMap = new Map<string, number>();
      if (transferMetrics) {
        const metricsRaw = transferMetrics as {
          data: {
            natGateways?: Array<{
              id: string;
              totalBytes: number;
            }>;
          };
        };
        for (const m of metricsRaw.data?.natGateways || []) {
          metricsMap.set(m.id, m.totalBytes);
        }
      }

      if (natGateways.length > 0) {
        findings.push("### NAT Gateways\n");
        findings.push("| NAT Gateway | VPC | Bytes Processed (7d) | Status |");
        findings.push("| ----------- | --- | -------------------: | ------ |");

        for (const nat of natGateways) {
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
    // Model writes: { region, queryType, data: [{arn, name, type, scheme, vpcId, state, ...}], fetchedAt }
    const albData = await getStepData("aws-networking", "list_load_balancers");

    if (albData) {
      const albRaw = albData as {
        data: Array<{
          arn: string;
          name: string;
          type: string;
          state: string;
        }>;
      };
      const loadBalancers = albRaw.data || [];

      // Transfer metrics LB data: { data: { loadBalancers: [{name, requestCount, ...}] } }
      const albMetricsMap = new Map<string, number>();
      if (transferMetrics) {
        const metricsRaw = transferMetrics as {
          data: {
            loadBalancers?: Array<{
              name: string;
              requestCount: number;
            }>;
          };
        };
        for (const m of metricsRaw.data?.loadBalancers || []) {
          albMetricsMap.set(m.name, m.requestCount);
        }
      }

      if (loadBalancers.length > 0) {
        findings.push("### Load Balancers\n");
        findings.push("| Load Balancer | Type | Requests (7d) | Status |");
        findings.push("| ------------- | ---- | ------------: | ------ |");

        for (const alb of loadBalancers) {
          const requests = albMetricsMap.get(alb.name) ?? 0;
          // Less than 10000 requests in 7 days extrapolates to very low monthly usage
          const isLow = requests < 10000;
          const status = isLow ? "LOW TRAFFIC" : "OK";
          findings.push(
            `| ${alb.name} | ${alb.type} | ${requests.toLocaleString()} | ${status} |`,
          );

          if (isLow) {
            networkingWaste.push({
              resource: alb.name,
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
    // Model writes: { region, queryType, data: [{allocationId, publicIp, associationId, isAttached, ...}], fetchedAt }
    const eipData = await getStepData("aws-networking", "list_elastic_ips");

    if (eipData) {
      const eipRaw = eipData as {
        data: Array<{
          publicIp: string;
          allocationId: string;
          associationId: string | null;
          isAttached: boolean;
        }>;
      };
      const addresses = eipRaw.data || [];

      const unattached = addresses.filter((eip) => !eip.isAttached);

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

      if (addresses.length > 0 && unattached.length === 0) {
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

    // Inventory model writes: { region, resourceType, resources: { ec2: [...], rds: [...], ... }, fetchedAt }
    const inventoryData = await getStepData("aws-inventory", "inventory_all");
    if (inventoryData) {
      const inventory = inventoryData as {
        resources: Record<string, unknown[]>;
      };

      // Count resources by type
      const resourceCounts: Record<string, number> = {};
      let totalResources = 0;
      for (
        const [resourceType, items] of Object.entries(
          inventory.resources || {},
        )
      ) {
        const count = Array.isArray(items) ? items.length : 0;
        resourceCounts[resourceType] = count;
        totalResources += count;
      }

      findings.push(
        `Total resources discovered: **${totalResources}**\n`,
      );
      findings.push("| Resource Type | Count |");
      findings.push("| ------------- | ----: |");

      for (const [resourceType, count] of Object.entries(resourceCounts)) {
        findings.push(`| ${resourceType} | ${count} |`);
      }
      findings.push("");

      jsonFindings.inventory = {
        totalResources,
        resources: resourceCounts,
      };

      // Stopped EC2 instances
      const ec2Resources = inventory.resources.ec2 as
        | Array<{
          instanceId: string;
          instanceType: string;
          state: string;
          launchTime: string | null;
          tags: Record<string, string>;
        }>
        | undefined;

      if (ec2Resources) {
        const stoppedEc2 = ec2Resources.filter((i) => i.state === "stopped");
        if (stoppedEc2.length > 0) {
          findings.push("\n### Stopped EC2 Instances\n");
          findings.push("| Instance ID | Type | Launch Time | Name |");
          findings.push("| ----------- | ---- | ----------- | ---- |");
          for (const inst of stoppedEc2) {
            findings.push(
              `| ${inst.instanceId} | ${inst.instanceType} | ${
                inst.launchTime || "N/A"
              } | ${inst.tags?.Name || "—"} |`,
            );
          }
          findings.push("");
          findings.push(
            `> **${stoppedEc2.length} stopped instance(s)** — EBS storage costs continue while stopped.\n`,
          );
        }
      }

      // Unattached EBS volumes
      const ebsResources = inventory.resources.ebs as
        | Array<{
          volumeId: string;
          volumeType: string;
          size: number;
          state: string;
          isAttached: boolean;
          createTime: string | null;
        }>
        | undefined;

      if (ebsResources) {
        const unattached = ebsResources.filter((v) => !v.isAttached);
        if (unattached.length > 0) {
          const totalGB = unattached.reduce((sum, v) => sum + v.size, 0);
          const estimatedMonthlyCost = (totalGB * 0.08).toFixed(2);
          findings.push("\n### Unattached EBS Volumes\n");
          findings.push("| Volume ID | Type | Size (GB) | Created |");
          findings.push("| --------- | ---- | --------: | ------- |");
          for (const vol of unattached) {
            findings.push(
              `| ${vol.volumeId} | ${vol.volumeType} | ${vol.size} | ${
                vol.createTime || "N/A"
              } |`,
            );
          }
          findings.push("");
          findings.push(
            `> **${unattached.length} unattached volume(s)** totaling ${totalGB} GB — estimated ~$${estimatedMonthlyCost}/month (gp3 rate).\n`,
          );
        }
      }
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
    // Model writes: { region, queryType, data: { dataPoints: [...], trend: "..." }, fetchedAt }
    const costTrendData = await getStepData("aws-costs", "get_cost_trend");
    if (costTrendData) {
      const trendRaw = costTrendData as {
        data: {
          trend: string;
          dataPoints: Array<{ date: string; amount: number }>;
        };
      };

      if (trendRaw.data?.trend === "increasing") {
        recommendations.push({
          priority: 4,
          action:
            "Investigate increasing cost trend — spending is rising over the period",
          estimatedSavings: "Variable",
        });
      }
    }

    // Stopped EC2 instances
    if (inventoryData) {
      const ec2Res = (inventoryData as { resources: Record<string, unknown[]> })
        .resources
        .ec2 as Array<{ state: string }> | undefined;
      const stoppedCount = ec2Res?.filter((i) =>
        i.state === "stopped"
      ).length || 0;
      if (stoppedCount > 0) {
        recommendations.push({
          priority: 5,
          action:
            `Terminate or snapshot ${stoppedCount} stopped EC2 instance(s)`,
          estimatedSavings: "EBS storage costs while stopped",
        });
      }

      const ebsRes = (inventoryData as { resources: Record<string, unknown[]> })
        .resources
        .ebs as Array<{ isAttached: boolean; size: number }> | undefined;
      const unattachedEbs = ebsRes?.filter((v) => !v.isAttached) || [];
      if (unattachedEbs.length > 0) {
        const totalGB = unattachedEbs.reduce((sum, v) => sum + v.size, 0);
        recommendations.push({
          priority: 6,
          action:
            `Delete or snapshot ${unattachedEbs.length} unattached EBS volume(s) (${totalGB} GB)`,
          estimatedSavings: `~$${(totalGB * 0.08).toFixed(2)}/month`,
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
