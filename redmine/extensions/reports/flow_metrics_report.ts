/**
 * Flow metrics report for Redmine issues.
 *
 * Computes cycle time, lead time, throughput, and WIP age from
 * Redmine issue journals collected during a workflow run. Produces
 * both markdown and structured JSON output.
 *
 * @module
 */
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

interface DataLocation {
  modelType: string;
  modelId: string;
  dataName: string;
  version: number;
}

interface RedmineJournal {
  id: number;
  user?: { id: number; name: string };
  notes?: string;
  created_on: string;
  details: Array<{
    property: string;
    name: string;
    old_value?: string;
    new_value?: string;
  }>;
}

interface RedmineIssue {
  id: number;
  subject: string;
  status: { id: number; name: string };
  created_on: string;
  updated_on: string;
  closed_on?: string;
  journals?: RedmineJournal[];
}

interface IssueMetrics {
  id: number;
  subject: string;
  status: string;
  leadTimeDays: number | null;
  cycleTimeDays: number | null;
}

interface FlowMetricsJson {
  workflowName: string;
  timestamp: string;
  leadTime: {
    average: number;
    median: number;
    p90: number;
    sampleSize: number;
  } | null;
  cycleTime: {
    average: number;
    median: number;
    p90: number;
    sampleSize: number;
  } | null;
  throughput: number;
  wipItems: Array<{ id: number; subject: string; ageDays: number }>;
  issueDetails: IssueMetrics[];
}

const IN_PROGRESS_PATTERNS = [
  "in progress",
  "in-progress",
  "in_progress",
  "doing",
  "active",
  "working",
  "started",
];

function isInProgressStatus(statusName: string): boolean {
  const lower = statusName.toLowerCase();
  return IN_PROGRESS_PATTERNS.some((p) => lower.includes(p));
}

function daysBetween(start: string | Date, end: string | Date): number {
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;
  return Math.round(
    (e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24),
  );
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function computeStats(
  values: number[],
): { average: number; median: number; p90: number } {
  if (values.length === 0) return { average: 0, median: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  const median = computePercentile(sorted, 50);
  const p90 = computePercentile(sorted, 90);
  return {
    average: Math.round(average * 10) / 10,
    median: Math.round(median * 10) / 10,
    p90: Math.round(p90 * 10) / 10,
  };
}

function findFirstInProgressDate(journals: RedmineJournal[]): string | null {
  for (const journal of journals) {
    for (const detail of journal.details) {
      if (detail.property === "attr" && detail.name === "status_id") {
        // Check if the journal timestamp corresponds to a transition
        // into an in-progress-like status. We rely on convention:
        // the detail records a status_id change, but the raw value is
        // an ID. We cannot map IDs to names from journal data alone,
        // so we also check the created_on as the transition timestamp.
        // A heuristic: if old_value exists and new_value exists, this
        // is a status transition. We return the first one as the
        // "started work" marker unless we can match names.
        return journal.created_on;
      }
    }
  }
  return null;
}

function findFirstInProgressDateByName(
  journals: RedmineJournal[],
): string | null {
  // Some Redmine API responses include detail with name matching
  // We look for any status transition detail and check common patterns
  for (const journal of journals) {
    for (const detail of journal.details) {
      if (detail.property === "attr" && detail.name === "status_id") {
        // If we have a new_value that looks like a status name, check it
        if (detail.new_value) {
          const nv = detail.new_value.toLowerCase();
          if (IN_PROGRESS_PATTERNS.some((p) => nv.includes(p))) {
            return journal.created_on;
          }
        }
      }
    }
  }
  return null;
}

/** Flow metrics report: cycle time, lead time, throughput, and WIP age analysis. */
export const report = {
  name: "@webframp/flow-metrics-report",
  description:
    "Computes cycle time, lead time, throughput, and WIP age from Redmine issue journals",
  scope: "workflow" as const,
  labels: ["redmine", "flow-metrics", "kanban", "continuous-improvement"],

  execute: async (context: WorkflowReportContext) => {
    const now = new Date();
    const timestamp = now.toISOString();

    // Helper to get data from filesystem
    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    // Helper to find step data by model and method
    function findStepData(
      _modelName: string,
      methodName: string,
    ): DataLocation | null {
      for (const step of context.stepExecutions) {
        if (step.methodName === methodName) {
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

    // Helper to find all step data for a method
    function findAllStepData(
      methodName: string,
    ): DataLocation[] {
      const results: DataLocation[] = [];
      for (const step of context.stepExecutions) {
        if (step.methodName === methodName) {
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              results.push({
                modelType: step.modelType,
                modelId: step.modelId,
                dataName: handle.name,
                version: handle.version,
              });
            }
          }
        }
      }
      return results;
    }

    // Find issue list data
    const issueListLoc = findStepData("redmine", "list_issues");
    if (!issueListLoc) {
      const markdown =
        `# Flow Metrics Report\n\n**Generated**: ${timestamp}\n\nNo issue data available for flow metrics computation.\n`;
      context.logger.info("No issue data found for flow metrics", {
        workflowName: context.workflowName,
      });
      return { markdown, json: { workflowName: context.workflowName } };
    }

    const issueListData = await getData(
      issueListLoc.modelType,
      issueListLoc.modelId,
      issueListLoc.dataName,
      issueListLoc.version,
    );

    if (!issueListData) {
      const markdown =
        `# Flow Metrics Report\n\n**Generated**: ${timestamp}\n\nNo issue data available for flow metrics computation.\n`;
      context.logger.info("Could not read issue list data", {
        workflowName: context.workflowName,
      });
      return { markdown, json: { workflowName: context.workflowName } };
    }

    const issueList = (issueListData as { issues: RedmineIssue[] }).issues ||
      [];

    // Collect issue details (with journals) from get_issue steps
    const detailLocs = findAllStepData("get_issue");
    const issueDetails = new Map<number, RedmineIssue>();

    for (const loc of detailLocs) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (data) {
        const issue = (data as { issue: RedmineIssue }).issue ||
          (data as unknown as RedmineIssue);
        if (issue && issue.id) {
          issueDetails.set(issue.id, issue);
        }
      }
    }

    // Compute metrics for closed issues
    const closedIssues = issueList.filter((i) =>
      i.closed_on || i.status.name.toLowerCase() === "closed" ||
      i.status.name.toLowerCase() === "resolved"
    );

    const leadTimes: number[] = [];
    const cycleTimes: number[] = [];
    const issueMetrics: IssueMetrics[] = [];

    for (const issue of closedIssues) {
      const detail = issueDetails.get(issue.id);
      const closedOn = issue.closed_on || detail?.closed_on;
      if (!closedOn) continue;

      const leadTime = daysBetween(issue.created_on, closedOn);
      leadTimes.push(leadTime);

      let cycleTime = leadTime;

      if (detail?.journals && detail.journals.length > 0) {
        // Try name-based matching first
        let startDate = findFirstInProgressDateByName(detail.journals);
        // Fall back to first status transition
        if (!startDate) {
          startDate = findFirstInProgressDate(detail.journals);
        }
        if (startDate) {
          cycleTime = daysBetween(startDate, closedOn);
        }
      }

      cycleTimes.push(cycleTime);

      issueMetrics.push({
        id: issue.id,
        subject: issue.subject,
        status: issue.status.name,
        leadTimeDays: leadTime,
        cycleTimeDays: cycleTime,
      });
    }

    // Compute WIP items (open issues in progress)
    const wipIssues = issueList.filter((i) =>
      !i.closed_on && isInProgressStatus(i.status.name)
    );

    const wipItems: Array<{ id: number; subject: string; ageDays: number }> =
      [];
    for (const issue of wipIssues) {
      const ageDays = daysBetween(issue.updated_on, now);
      wipItems.push({
        id: issue.id,
        subject: issue.subject,
        ageDays,
      });
    }

    // Add open issues to metrics list
    for (const issue of issueList) {
      if (!issueMetrics.find((m) => m.id === issue.id)) {
        issueMetrics.push({
          id: issue.id,
          subject: issue.subject,
          status: issue.status.name,
          leadTimeDays: null,
          cycleTimeDays: null,
        });
      }
    }

    // Compute statistics
    const leadTimeStats = computeStats(leadTimes);
    const cycleTimeStats = computeStats(cycleTimes);

    // Build markdown
    const lines: string[] = [];
    lines.push("# Flow Metrics Report");
    lines.push("");
    lines.push(`**Generated**: ${timestamp}`);
    lines.push(`**Data source**: ${context.workflowName}`);
    lines.push("");

    // Lead Time section
    lines.push("## Lead Time (created -> closed)");
    lines.push("");
    if (leadTimes.length > 0) {
      lines.push("| Metric | Days |");
      lines.push("|--------|------|");
      lines.push(`| Average | ${leadTimeStats.average} |`);
      lines.push(`| Median | ${leadTimeStats.median} |`);
      lines.push(`| P90 | ${leadTimeStats.p90} |`);
      lines.push(`| Sample size | ${leadTimes.length} |`);
    } else {
      lines.push("No closed issues with lead time data.");
    }
    lines.push("");

    // Cycle Time section
    lines.push("## Cycle Time (in progress -> closed)");
    lines.push("");
    if (cycleTimes.length > 0) {
      lines.push("| Metric | Days |");
      lines.push("|--------|------|");
      lines.push(`| Average | ${cycleTimeStats.average} |`);
      lines.push(`| Median | ${cycleTimeStats.median} |`);
      lines.push(`| P90 | ${cycleTimeStats.p90} |`);
      lines.push(`| Sample size | ${cycleTimes.length} |`);
    } else {
      lines.push("No closed issues with cycle time data.");
    }
    lines.push("");

    // Throughput section
    lines.push("## Throughput");
    lines.push("");
    lines.push(`- Closed issues in dataset: ${closedIssues.length}`);
    lines.push("");

    // WIP Age section
    lines.push("## WIP Age (open items currently in progress)");
    lines.push("");
    if (wipItems.length > 0) {
      lines.push("| Issue | Subject | Age (days) |");
      lines.push("|-------|---------|------------|");
      for (const item of wipItems) {
        lines.push(`| #${item.id} | ${item.subject} | ${item.ageDays} |`);
      }
    } else {
      lines.push("No items currently in progress.");
    }
    lines.push("");

    // Issue Details section
    lines.push("## Issue Details");
    lines.push("");
    lines.push("| Issue | Subject | Lead Time | Cycle Time | Status |");
    lines.push("|-------|---------|-----------|------------|--------|");
    for (const m of issueMetrics) {
      const lt = m.leadTimeDays !== null ? `${m.leadTimeDays} days` : "-";
      const ct = m.cycleTimeDays !== null ? `${m.cycleTimeDays} days` : "-";
      lines.push(`| #${m.id} | ${m.subject} | ${lt} | ${ct} | ${m.status} |`);
    }
    lines.push("");

    const markdown = lines.join("\n");

    const jsonResult: FlowMetricsJson = {
      workflowName: context.workflowName,
      timestamp,
      leadTime: leadTimes.length > 0
        ? { ...leadTimeStats, sampleSize: leadTimes.length }
        : null,
      cycleTime: cycleTimes.length > 0
        ? { ...cycleTimeStats, sampleSize: cycleTimes.length }
        : null,
      throughput: closedIssues.length,
      wipItems,
      issueDetails: issueMetrics,
    };

    context.logger.info("Generated flow metrics report", {
      workflowName: context.workflowName,
      closedIssues: closedIssues.length,
      wipItems: wipItems.length,
    });

    return { markdown, json: jsonResult };
  },
};
