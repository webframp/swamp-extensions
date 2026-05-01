/**
 * Sprint summary report for Redmine issues.
 *
 * Summarizes current sprint status with breakdowns by status, tracker,
 * and assignee. Identifies blocked and completed items. Produces both
 * markdown and structured JSON output.
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

interface RedmineIssue {
  id: number;
  subject: string;
  tracker: { id: number; name: string };
  status: { id: number; name: string; isClosed: boolean };
  assignedTo: { id: number; name: string } | null;
  createdOn: string;
  closedOn: string | null;
  customFields?: Array<{
    id: number;
    name: string;
    value: string;
  }>;
}

interface AssigneeWorkload {
  name: string;
  total: number;
  inProgress: number;
  completed: number;
}

interface SprintSummaryJson {
  total: number;
  completed: number;
  blocked: number;
  byStatus: Record<string, number>;
  byTracker: Record<string, number>;
  byAssignee: AssigneeWorkload[];
  timestamp: string;
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

function isBlocked(subject: string): boolean {
  return subject.toLowerCase().startsWith("[blocked]");
}

/** Sprint summary report: status, tracker, and assignee breakdowns. */
export const report = {
  name: "@webframp/sprint-summary-report",
  description:
    "Summarizes current sprint status with breakdowns by status, tracker, and assignee",
  scope: "workflow" as const,
  labels: ["redmine", "sprint", "kanban", "status"],

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

    // Helper to find step data by method
    function findStepData(methodName: string): DataLocation | null {
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

    // Find issue list data
    const issueListLoc = findStepData("list_issues");
    if (!issueListLoc) {
      const markdown =
        `# Sprint Summary Report\n\n**Generated**: ${timestamp}\n\nNo issue data available.\n`;
      context.logger.info("No issue data found for sprint summary", {
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
        `# Sprint Summary Report\n\n**Generated**: ${timestamp}\n\nNo issue data available.\n`;
      context.logger.info("Could not read issue list data", {
        workflowName: context.workflowName,
      });
      return { markdown, json: { workflowName: context.workflowName } };
    }

    const issues = (issueListData as { issues: RedmineIssue[] }).issues || [];
    const total = issues.length;

    // By status
    const byStatus: Record<string, number> = {};
    for (const issue of issues) {
      const name = issue.status.name;
      byStatus[name] = (byStatus[name] || 0) + 1;
    }

    // By tracker
    const byTracker: Record<string, number> = {};
    for (const issue of issues) {
      const name = issue.tracker.name;
      byTracker[name] = (byTracker[name] || 0) + 1;
    }

    // By assignee
    const assigneeMap = new Map<
      string,
      { total: number; inProgress: number; completed: number }
    >();
    for (const issue of issues) {
      const name = issue.assignedTo?.name ?? "Unassigned";
      if (!assigneeMap.has(name)) {
        assigneeMap.set(name, { total: 0, inProgress: 0, completed: 0 });
      }
      const entry = assigneeMap.get(name)!;
      entry.total++;
      if (isInProgressStatus(issue.status.name)) {
        entry.inProgress++;
      }
      if (issue.status.isClosed) {
        entry.completed++;
      }
    }
    const byAssignee: AssigneeWorkload[] = [];
    for (const [name, counts] of assigneeMap) {
      byAssignee.push({ name, ...counts });
    }
    byAssignee.sort((a, b) => a.name.localeCompare(b.name));

    // Blocked items
    const blockedIssues = issues.filter((i) => isBlocked(i.subject));
    const blocked = blockedIssues.length;

    // Completed items
    const completedIssues = issues.filter((i) => i.status.isClosed === true);
    const completed = completedIssues.length;

    // In progress count
    const inProgress =
      issues.filter((i) => isInProgressStatus(i.status.name)).length;

    // Build markdown
    const lines: string[] = [];
    lines.push("# Sprint Summary Report");
    lines.push("");
    lines.push(`**Generated**: ${timestamp}`);
    lines.push("");

    lines.push("## Overview");
    lines.push("");
    lines.push(`- **Total issues**: ${total}`);
    lines.push(`- **Completed**: ${completed}`);
    lines.push(`- **In progress**: ${inProgress}`);
    lines.push(`- **Blocked**: ${blocked}`);
    lines.push("");

    lines.push("## By Status");
    lines.push("");
    lines.push("| Status | Count |");
    lines.push("|--------|-------|");
    for (const [status, count] of Object.entries(byStatus)) {
      lines.push(`| ${status} | ${count} |`);
    }
    lines.push("");

    lines.push("## By Tracker");
    lines.push("");
    lines.push("| Tracker | Count |");
    lines.push("|---------|-------|");
    for (const [tracker, count] of Object.entries(byTracker)) {
      lines.push(`| ${tracker} | ${count} |`);
    }
    lines.push("");

    lines.push("## Assignee Workload");
    lines.push("");
    lines.push("| Assignee | Total | In Progress | Completed |");
    lines.push("|----------|-------|-------------|-----------|");
    for (const a of byAssignee) {
      lines.push(
        `| ${a.name} | ${a.total} | ${a.inProgress} | ${a.completed} |`,
      );
    }
    lines.push("");

    lines.push("## Blocked Items");
    lines.push("");
    if (blockedIssues.length > 0) {
      lines.push("| Issue | Subject | Assignee |");
      lines.push("|-------|---------|----------|");
      for (const issue of blockedIssues) {
        const assignee = issue.assignedTo?.name ?? "Unassigned";
        lines.push(`| #${issue.id} | ${issue.subject} | ${assignee} |`);
      }
    } else {
      lines.push("No blocked items.");
    }
    lines.push("");

    lines.push("## Recently Completed");
    lines.push("");
    if (completedIssues.length > 0) {
      lines.push("| Issue | Subject | Assignee |");
      lines.push("|-------|---------|----------|");
      for (const issue of completedIssues) {
        const assignee = issue.assignedTo?.name ?? "Unassigned";
        lines.push(`| #${issue.id} | ${issue.subject} | ${assignee} |`);
      }
    } else {
      lines.push("No completed items in this sprint.");
    }
    lines.push("");

    const markdown = lines.join("\n");

    const json: SprintSummaryJson = {
      total,
      completed,
      blocked,
      byStatus,
      byTracker,
      byAssignee,
      timestamp,
    };

    context.logger.info("Generated sprint summary report", {
      workflowName: context.workflowName,
      total,
      completed,
      blocked,
    });

    return { markdown, json };
  },
};
