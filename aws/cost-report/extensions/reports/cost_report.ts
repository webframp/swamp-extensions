/**
 * AWS Cost Report Extension
 *
 * Formats AWS cost estimates into readable markdown reports with resource
 * tables, tag-based cost breakdowns, and actionable optimization
 * recommendations. Produces both markdown and JSON output.
 *
 * @module
 * SPDX-License-Identifier: Apache-2.0
 */

/** Handle referencing a data artifact produced during method execution. */
interface DataHandle {
  name: string;
  kind: string;
}

/** Context provided by swamp when executing a method-scoped report. */
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

/** Format a numeric amount as a USD currency string (e.g. `$12.50`). */
function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Render a markdown table from headers, rows, and optional column alignments. */
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

/** A single line item in a cost estimate (EC2, RDS, or generic resource). */
interface CostItem {
  name?: string;
  type?: string;
  spec?: string;
  count?: number;
  hourlyRate?: number;
  monthlyPerUnit?: number;
  monthlyTotal?: number;
}

/** Generate a formatted markdown cost table from an array of cost items. */
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

/**
 * Cost report extension definition.
 *
 * Scoped to `method` -- executes after cost-estimate model methods and produces
 * a markdown summary with resource tables and optimization recommendations,
 * plus a structured JSON payload for programmatic consumption.
 */
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
