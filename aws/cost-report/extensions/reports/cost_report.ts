// AWS Cost Report Extension
// SPDX-License-Identifier: Apache-2.0

interface DataHandle {
  name: string;
  kind: string;
}

interface MethodReportContext {
  modelType: string;
  modelId: string;
  definition: {
    name: string;
  };
  globalArgs: Record<string, unknown>;
  methodName: string;
  methodArgs: Record<string, unknown>;
  executionStatus: string;
  dataHandles: DataHandle[];
  repoDir: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatTable(
  headers: string[],
  rows: string[][],
  alignments?: ("left" | "right" | "center")[],
): string {
  const aligns = alignments || headers.map(() => "left");
  const separators = aligns.map((a) => {
    if (a === "right") return "---:";
    if (a === "center") return ":---:";
    return "---";
  });

  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${separators.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];

  return lines.join("\n");
}

interface CostItem {
  name?: string;
  type?: string;
  spec?: string;
  count?: number;
  hourlyRate?: number;
  monthlyPerUnit?: number;
  monthlyTotal?: number;
}

function generateCostTable(items: CostItem[]): string {
  const headers = ["Name", "Type", "Spec", "Count", "Per Unit", "Total"];
  const rows = items.map((item) => [
    item.name || "N/A",
    item.type || "N/A",
    item.spec || "N/A",
    String(item.count || 1),
    formatCurrency(item.monthlyPerUnit || 0),
    formatCurrency(item.monthlyTotal || 0),
  ]);

  return formatTable(headers, rows, [
    "left",
    "left",
    "left",
    "center",
    "right",
    "right",
  ]);
}

export const report = {
  name: "@webframp/aws/cost-report",
  description:
    "Format AWS cost estimates into readable reports with breakdowns and recommendations",
  scope: "method" as const,
  labels: ["cost", "finops", "aws"],

  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    await Promise.resolve();

    // Only run for cost-estimate model types
    const modelType = String(context.modelType || "");
    if (!modelType.includes("cost-estimate")) {
      return {
        markdown: `*Report skipped: Not a cost-estimate model (${modelType})*`,
        json: { skipped: true, reason: "not-cost-estimate-model" },
      };
    }

    const sections: string[] = [];
    const jsonData: Record<string, unknown> = {
      modelName: context.definition.name,
      method: context.methodName,
      status: context.executionStatus,
    };

    // Header
    sections.push(`# AWS Cost Report`);
    sections.push(``);
    sections.push(`**Model**: ${context.definition.name}`);
    sections.push(`**Method**: ${context.methodName}`);
    sections.push(`**Status**: ${context.executionStatus}`);
    sections.push(``);

    // Check method-specific context
    const methodArgs = context.methodArgs || {};

    if (context.methodName === "estimate_from_spec") {
      // We can generate a report from the input spec
      const ec2Instances = methodArgs.ec2Instances as CostItem[] | undefined;
      const rdsInstances = methodArgs.rdsInstances as CostItem[] | undefined;

      if (ec2Instances && ec2Instances.length > 0) {
        sections.push(`## EC2 Instances (from spec)`);
        sections.push(``);

        const items = ec2Instances.map((i) => ({
          name: i.name,
          type: "ec2",
          spec: `${(i as Record<string, unknown>).instanceType || "N/A"} (${
            (i as Record<string, unknown>).platform || "linux"
          })`,
          count: i.count || 1,
          monthlyPerUnit: 0,
          monthlyTotal: 0,
        }));

        sections.push(generateCostTable(items));
        sections.push(``);
        sections.push(
          `*Note: Actual costs calculated and stored in data artifact*`,
        );
        sections.push(``);

        jsonData.ec2InstanceCount = ec2Instances.length;
      }

      if (rdsInstances && rdsInstances.length > 0) {
        sections.push(`## RDS Instances (from spec)`);
        sections.push(``);

        const items = rdsInstances.map((i) => ({
          name: i.name,
          type: "rds",
          spec: `${(i as Record<string, unknown>).dbInstanceClass || "N/A"} (${
            (i as Record<string, unknown>).engine || "N/A"
          })`,
          count: 1,
          monthlyPerUnit: 0,
          monthlyTotal: 0,
        }));

        sections.push(generateCostTable(items));
        sections.push(``);

        jsonData.rdsInstanceCount = rdsInstances.length;
      }
    }

    // Data artifacts produced
    const resourceHandles = context.dataHandles.filter(
      (h) => h.kind === "resource",
    );

    if (resourceHandles.length > 0) {
      sections.push(`## Data Produced`);
      sections.push(``);
      sections.push(
        `The following cost estimate data was produced and can be retrieved:`,
      );
      sections.push(``);

      for (const handle of resourceHandles) {
        sections.push(
          `- **${handle.name}**: \`swamp data get ${context.definition.name} ${handle.name} --json\``,
        );
      }
      sections.push(``);

      jsonData.dataArtifacts = resourceHandles.map((h) => h.name);
    }

    // Recommendations section
    sections.push(`## Recommendations`);
    sections.push(``);

    const recommendations: string[] = [];

    // Check for method-specific recommendations
    if (context.methodName === "estimate_from_spec") {
      recommendations.push(
        `- Review the spec data artifact for detailed per-resource cost breakdown`,
      );
      recommendations.push(
        `- Compare On-Demand pricing with Reserved Instances for long-term workloads`,
      );
      recommendations.push(
        `- Consider Savings Plans for predictable, steady-state usage`,
      );
    } else if (context.methodName === "estimate_ec2") {
      recommendations.push(
        `- Review instances by tag to identify cost allocation opportunities`,
      );
      recommendations.push(
        `- Check for unused or underutilized instances`,
      );
    } else if (context.methodName === "estimate_rds") {
      recommendations.push(
        `- Evaluate Multi-AZ requirements for each database`,
      );
      recommendations.push(
        `- Consider Aurora Serverless for variable workloads`,
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(`- No specific recommendations for this method`);
    }

    sections.push(recommendations.join("\n"));
    sections.push(``);

    // Footer
    sections.push(`---`);
    sections.push(``);
    sections.push(
      `*Run \`swamp data get ${context.definition.name} <artifact>\` to view detailed cost data*`,
    );

    jsonData.recommendations = recommendations;

    return {
      markdown: sections.join("\n"),
      json: jsonData,
    };
  },
};
