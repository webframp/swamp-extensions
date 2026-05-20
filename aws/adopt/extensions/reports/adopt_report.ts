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
  error?: string;
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

// =============================================================================
// Types
// =============================================================================

interface AdoptionSummary {
  timestamp: string;
  workflowName: string;
  totalAttempted: number;
  succeeded: number;
  failed: number;
  byJob: Record<
    string,
    { attempted: number; succeeded: number; failed: number }
  >;
}

interface AdoptionResult {
  modelName: string;
  modelType: string;
  method: string;
  status: "succeeded" | "failed";
  error?: string;
  job: string;
}

interface ReportResult {
  markdown: string;
  json: { summary: AdoptionSummary; results: AdoptionResult[] };
}

// =============================================================================
// Helpers
// =============================================================================

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

// =============================================================================
// Remediation logic
// =============================================================================

function getRemediation(error: string): string {
  if (/not found|NotFound/i.test(error)) {
    return "Model not created. Run the setup command from discover_all output.";
  }
  if (/credential|AccessDenied/i.test(error)) {
    return "Check AWS credentials. Ensure AWS_PROFILE and AWS_REGION are exported.";
  }
  if (/ResourceNotFoundException|does not exist/i.test(error)) {
    return "Resource may have been deleted from AWS. Verify it still exists.";
  }
  return "Review the error details and retry after resolving the issue.";
}

// =============================================================================
// Report
// =============================================================================

export const report = {
  name: "@webframp/adopt-report",
  description:
    "Summarizes adoption workflow results with success/failure counts, per-job breakdown, and remediation guidance",
  scope: "workflow" as const,
  labels: ["aws", "adoption", "brownfield", "import"],

  execute: (
    context: WorkflowReportContext,
  ): Promise<ReportResult> => {
    const sections: string[] = [];
    const results: AdoptionResult[] = [];
    const timestamp = new Date().toISOString();

    const byJob: Record<
      string,
      { attempted: number; succeeded: number; failed: number }
    > = {};

    // =========================================================================
    // Process step executions
    // =========================================================================

    for (const step of context.stepExecutions) {
      const job = step.jobName;
      if (!byJob[job]) {
        byJob[job] = { attempted: 0, succeeded: 0, failed: 0 };
      }
      byJob[job].attempted++;

      const stepSucceeded = step.status === "succeeded";
      if (stepSucceeded) {
        byJob[job].succeeded++;
      } else {
        byJob[job].failed++;
      }

      results.push({
        modelName: step.modelName,
        modelType: step.modelType,
        method: step.methodName,
        status: stepSucceeded ? "succeeded" : "failed",
        error: step.error,
        job,
      });
    }

    const totalAttempted = context.stepExecutions.length;
    const succeeded = results.filter((r) => r.status === "succeeded").length;
    const failed = results.filter((r) => r.status === "failed").length;

    const summary: AdoptionSummary = {
      timestamp,
      workflowName: context.workflowName,
      totalAttempted,
      succeeded,
      failed,
      byJob,
    };

    // =========================================================================
    // 1. Header
    // =========================================================================

    sections.push("# Adoption Report\n");
    sections.push(`**Workflow:** ${context.workflowName}`);
    sections.push(`**Run ID:** ${context.workflowRunId}`);
    sections.push(`**Status:** ${context.workflowStatus}`);
    sections.push(`**Generated:** ${timestamp}\n`);

    // =========================================================================
    // 2. Summary
    // =========================================================================

    sections.push("## Summary\n");
    sections.push("| Metric | Count |");
    sections.push("|--------|-------|");
    sections.push(`| Total attempted | ${totalAttempted} |`);
    sections.push(`| Succeeded | ${succeeded} |`);
    sections.push(`| Failed | ${failed} |\n`);

    // =========================================================================
    // 3. Results by Job
    // =========================================================================

    sections.push("## Results by Job\n");

    for (const [jobName, counts] of Object.entries(byJob)) {
      const icon = counts.failed === 0 ? "✅" : "❌";
      sections.push(
        `### ${icon} ${jobName} (${counts.succeeded}/${counts.attempted} succeeded)\n`,
      );

      const jobResults = results.filter((r) => r.job === jobName);
      sections.push("| Model | Type | Method | Status |");
      sections.push("|-------|------|--------|--------|");
      for (const r of jobResults) {
        const statusIcon = r.status === "succeeded" ? "✅" : "❌";
        sections.push(
          `| ${escapeCell(r.modelName)} | ${escapeCell(r.modelType)} | ${
            escapeCell(r.method)
          } | ${statusIcon} ${r.status} |`,
        );
      }
      sections.push("");
    }

    // =========================================================================
    // 4. Failures
    // =========================================================================

    const failures = results.filter((r) => r.status === "failed");
    if (failures.length > 0) {
      sections.push("## Failures\n");

      for (const f of failures) {
        sections.push(`### ❌ ${escapeCell(f.modelName)}\n`);
        sections.push(`- **Type:** ${escapeCell(f.modelType)}`);
        sections.push(`- **Method:** ${escapeCell(f.method)}`);
        sections.push(
          `- **Error:** ${escapeCell(f.error ?? "No error message available")}`,
        );
        sections.push(
          `- **Remediation:** ${getRemediation(f.error ?? "")}\n`,
        );
      }
    }

    // =========================================================================
    // 5. Next Steps
    // =========================================================================

    sections.push("## Next Steps\n");
    if (failed === 0 && totalAttempted > 0) {
      sections.push(
        "All resources adopted successfully. Recommended follow-up:\n",
      );
    } else if (totalAttempted === 0) {
      sections.push(
        "No adoption steps were executed. Verify workflow configuration and inputs.\n",
      );
    } else {
      sections.push(
        `${failed} resource(s) failed adoption. After resolving failures:\n`,
      );
    }
    sections.push(
      "1. **Schedule sync** — Run periodic `sync` methods to keep model state current with AWS.",
    );
    sections.push(
      "2. **Enable drift detection** — Configure the drift workflow to alert on configuration changes.",
    );
    sections.push(
      "3. **Transfer ownership** — Assign adopted resources to the appropriate team models and workflows.",
    );
    sections.push("");

    context.logger.info("Adoption report complete", {
      total: totalAttempted,
      succeeded,
      failed,
    });

    return Promise.resolve({
      markdown: sections.join("\n"),
      json: { summary, results },
    });
  },
};
