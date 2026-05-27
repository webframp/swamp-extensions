/**
 * Security Hub Findings Triage Report
 *
 * Workflow-scope report that aggregates data from the securityhub-triage
 * workflow into a single actionable triage summary. Produces a severity
 * dashboard, new-since-last-run alerts, top finding types, and affected
 * accounts breakdown.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
  specName?: string;
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

interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  dataRepository: DataRepository;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  total: number;
  truncated: boolean;
  accountBreakdown: Array<{
    accountId: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
    informational: number;
  }>;
}

interface FindingsList {
  findings: Array<{
    severity: string;
    title: string;
    accountId: string;
    region: string;
    productName: string;
    type: string;
  }>;
  count: number;
  truncated: boolean;
}

interface DiffFindings {
  newFindings: Array<{
    severity: string;
    title: string;
    accountId: string;
    type: string;
  }>;
  resolvedFindings: Array<{
    severity: string;
    title: string;
    accountId: string;
  }>;
  newCount: number;
  resolvedCount: number;
}

interface FindingsByType {
  groups: Array<{
    type: string;
    count: number;
    severities: { critical: number; high: number; medium: number; low: number };
    accounts: string[];
  }>;
  totalTypes: number;
  totalFindings: number;
}

/** Read and parse JSON data from a step execution's data handle. */
async function readStepData<T>(
  step: StepExecution,
  repo: DataRepository,
): Promise<T | null> {
  const handle = step.dataHandles[0];
  if (!handle) return null;
  const raw = await repo.getContent(
    step.modelType,
    step.modelId,
    handle.name,
    handle.version,
  );
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

/** Security Hub Findings Triage Report. */
export const report = {
  name: "@webframp/securityhub-triage-report",
  description:
    "Aggregates Security Hub triage workflow data into an actionable summary",
  scope: "workflow",
  labels: ["security", "triage", "findings"],

  execute: async (context: WorkflowReportContext) => {
    context.logger.info("Generating triage report", {
      workflow: context.workflowName,
      steps: context.stepExecutions.length,
    });

    // Find step data by step name
    const findStep = (stepName: string) =>
      context.stepExecutions.find((s) => s.stepName === stepName);

    const summaryStep = findStep("severity_summary");
    const criticalStep = findStep("critical_findings");
    const highStep = findStep("high_findings");
    const diffStep = findStep("diff_findings");
    const byTypeStep = findStep("by_type");

    // Read data from each step
    const summary = summaryStep
      ? await readStepData<SeveritySummary>(summaryStep, context.dataRepository)
      : null;
    const criticalFindings = criticalStep
      ? await readStepData<FindingsList>(criticalStep, context.dataRepository)
      : null;
    const highFindings = highStep
      ? await readStepData<FindingsList>(highStep, context.dataRepository)
      : null;
    const diff = diffStep
      ? await readStepData<DiffFindings>(diffStep, context.dataRepository)
      : null;
    const byType = byTypeStep
      ? await readStepData<FindingsByType>(byTypeStep, context.dataRepository)
      : null;

    // Merge critical + high findings
    const criticalHigh: FindingsList = {
      findings: [
        ...(criticalFindings?.findings ?? []),
        ...(highFindings?.findings ?? []),
      ],
      count: (criticalFindings?.count ?? 0) + (highFindings?.count ?? 0),
      truncated: (criticalFindings?.truncated ?? false) ||
        (highFindings?.truncated ?? false),
    };

    // Build markdown
    const lines: string[] = [];
    lines.push("# Security Hub Triage Report");
    lines.push("");
    lines.push(
      `**Generated**: ${
        new Date().toISOString()
      } | **Workflow**: ${context.workflowName}`,
    );
    lines.push("");

    // Severity dashboard
    if (summary) {
      lines.push("## Severity Dashboard");
      lines.push("");
      lines.push(
        `| 🔴 CRITICAL | 🟠 HIGH | 🟡 MEDIUM | 🔵 LOW | Total |`,
      );
      lines.push(`|---|---|---|---|---|`);
      lines.push(
        `| ${summary.critical} | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.total} |`,
      );
      if (summary.truncated) {
        lines.push("");
        lines.push(
          "⚠️ *Results truncated — more findings exist beyond the query limit.*",
        );
      }
      lines.push("");

      // Top affected accounts
      if (summary.accountBreakdown.length > 0) {
        const top = [...summary.accountBreakdown]
          .sort(
            (a, b) => b.critical + b.high - (a.critical + a.high),
          )
          .slice(0, 10);
        lines.push("### Top Affected Accounts");
        lines.push("");
        lines.push("| Account | Critical | High | Medium | Low |");
        lines.push("|---|---|---|---|---|");
        for (const a of top) {
          lines.push(
            `| ${a.accountId} | ${a.critical} | ${a.high} | ${a.medium} | ${a.low} |`,
          );
        }
        lines.push("");
      }
    }

    // New findings since last run
    if (diff) {
      lines.push("## Changes Since Last Run");
      lines.push("");
      lines.push(
        `- **New findings**: ${diff.newCount}`,
      );
      lines.push(
        `- **Resolved findings**: ${diff.resolvedCount}`,
      );
      lines.push("");

      if (diff.newFindings.length > 0) {
        lines.push("### New Findings");
        lines.push("");
        lines.push("| Severity | Type | Title | Account |");
        lines.push("|---|---|---|---|");
        for (const f of diff.newFindings.slice(0, 20)) {
          const shortType = f.type.split("/").pop() ?? f.type;
          const shortTitle = f.title.length > 60
            ? f.title.slice(0, 57) + "..."
            : f.title;
          lines.push(
            `| ${f.severity} | ${shortType} | ${shortTitle} | ${f.accountId} |`,
          );
        }
        lines.push("");
      }
    }

    // Critical/High findings detail
    if (criticalHigh.findings.length > 0) {
      lines.push("## Critical & High Findings");
      lines.push("");
      lines.push("| Severity | Title | Account | Region | Product |");
      lines.push("|---|---|---|---|---|");
      for (const f of criticalHigh.findings.slice(0, 25)) {
        const shortTitle = f.title.length > 50
          ? f.title.slice(0, 47) + "..."
          : f.title;
        lines.push(
          `| ${f.severity} | ${shortTitle} | ${f.accountId} | ${f.region} | ${f.productName} |`,
        );
      }
      lines.push("");
    }

    // Top finding types
    if (byType && byType.groups.length > 0) {
      lines.push("## Top Finding Types");
      lines.push("");
      lines.push("| Type | Count | Critical | High | Medium | Accounts |");
      lines.push("|---|---|---|---|---|---|");
      for (const g of byType.groups.slice(0, 10)) {
        const shortType = g.type.split("/").pop() ?? g.type;
        lines.push(
          `| ${shortType} | ${g.count} | ${g.severities.critical} | ${g.severities.high} | ${g.severities.medium} | ${g.accounts.length} |`,
        );
      }
      lines.push("");
    }

    // No data fallback
    if (!summary && criticalHigh.count === 0 && !diff && !byType) {
      lines.push("## No Data");
      lines.push("");
      lines.push(
        "No findings data was produced by the workflow steps. Check that the model has valid AWS credentials.",
      );
    }

    const markdown = lines.join("\n");
    const json = {
      summary: summary
        ? {
          critical: summary.critical,
          high: summary.high,
          medium: summary.medium,
          low: summary.low,
          total: summary.total,
          truncated: summary.truncated,
          accountCount: summary.accountBreakdown.length,
        }
        : null,
      diff: diff
        ? {
          newCount: diff.newCount,
          resolvedCount: diff.resolvedCount,
        }
        : null,
      criticalHighCount: criticalHigh.count,
      topTypes: byType
        ? byType.groups.slice(0, 10).map((g) => ({
          type: g.type,
          count: g.count,
          severities: g.severities,
        }))
        : null,
      generatedAt: new Date().toISOString(),
    };

    return { markdown, json };
  },
};
