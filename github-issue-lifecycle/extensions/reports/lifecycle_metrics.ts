/**
 * Issue Lifecycle Metrics Report
 *
 * Reads versioned lifecycle data from a `@webframp/github-issue-lifecycle`
 * model instance and produces cycle-time metrics, stuck-issue detection,
 * and retry counts.
 *
 * Scoped to a model — run against the lifecycle tracker instance.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** A stored resource from the model's data. */
interface StoredResource {
  specName: string;
  instance: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
}

/** Context provided by the swamp runtime for model-scoped reports. */
interface ModelReportContext {
  modelName: string;
  modelType: string;
  modelId: string;
  storedResources: StoredResource[];
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/** Compute duration in hours between two ISO timestamps. */
function hoursBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
}

/** Format hours as a human-readable duration. */
function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24 * 10) / 10;
  return `${days}d`;
}

/** Issue lifecycle summary for reporting. */
interface IssueSummary {
  issueNumber: number;
  phase: string;
  startedAt: string;
  lastTransition: string;
  iteration: number;
  kind: string | null;
  priority: string | null;
  prStatus: string | null;
  prUrl: string | null;
  cycleTimeHours: number | null;
  staleHours: number;
}

/**
 * Model-scoped report that aggregates lifecycle data into metrics.
 */
export const report = {
  name: "@webframp/lifecycle-metrics",
  description:
    "Cycle-time metrics, stuck issues, and retry counts from lifecycle data",
  scope: "model" as const,
  labels: ["lifecycle", "metrics", "sdlc"],

  execute: (context: ModelReportContext) => {
    const now = new Date().toISOString();
    const resources = context.storedResources;

    // Group state resources by issue number (latest version wins)
    const stateMap = new Map<number, StoredResource>();
    for (const r of resources) {
      if (r.specName !== "state") continue;
      const issueNum = r.data.issueNumber as number;
      const existing = stateMap.get(issueNum);
      if (!existing || r.version > existing.version) {
        stateMap.set(issueNum, r);
      }
    }

    // Group classification by issue
    const classMap = new Map<number, StoredResource>();
    for (const r of resources) {
      if (r.specName !== "classification") continue;
      const issueNum = r.data.issueNumber as number;
      classMap.set(issueNum, r);
    }

    // Group pullRequest by issue (latest version)
    const prMap = new Map<number, StoredResource>();
    for (const r of resources) {
      if (r.specName !== "pullRequest") continue;
      const issueNum = r.data.issueNumber as number;
      const existing = prMap.get(issueNum);
      if (!existing || r.version > existing.version) {
        prMap.set(issueNum, r);
      }
    }

    // Count PR retries (pullRequest resources with status=failed per issue)
    const retryMap = new Map<number, number>();
    for (const r of resources) {
      if (r.specName !== "pullRequest") continue;
      if ((r.data.status as string) === "failed") {
        const issueNum = r.data.issueNumber as number;
        retryMap.set(issueNum, (retryMap.get(issueNum) ?? 0) + 1);
      }
    }

    // Build summaries
    const summaries: IssueSummary[] = [];
    for (const [issueNum, stateRes] of stateMap) {
      const state = stateRes.data;
      const classification = classMap.get(issueNum)?.data;
      const pr = prMap.get(issueNum)?.data;

      const startedAt = state.startedAt as string;
      const transitionedAt = state.transitionedAt as string;
      const phase = state.phase as string;

      // Cycle time: only for completed issues (done)
      const cycleTimeHours = phase === "done"
        ? hoursFrom(startedAt, transitionedAt)
        : null;

      // Stale: hours since last transition
      const staleHours = hoursFrom(transitionedAt, now);

      summaries.push({
        issueNumber: issueNum,
        phase,
        startedAt,
        lastTransition: transitionedAt,
        iteration: state.iteration as number,
        kind: (classification?.kind as string) ?? null,
        priority: (classification?.priority as string) ?? null,
        prStatus: (pr?.status as string) ?? null,
        prUrl: (pr?.prUrl as string) ?? null,
        cycleTimeHours,
        staleHours,
      });
    }

    // Metrics
    const totalIssues = summaries.length;
    const completed = summaries.filter((s) => s.phase === "done");
    const inProgress = summaries.filter((s) =>
      !["done", "closed"].includes(s.phase)
    );
    const stuck = inProgress.filter((s) => s.staleHours > 48);
    const failed = summaries.filter((s) => s.phase === "pr_failed");

    // Cycle time stats (completed issues only)
    const cycleTimes = completed
      .map((s) => s.cycleTimeHours)
      .filter((h): h is number => h !== null);
    const avgCycleTime = cycleTimes.length > 0
      ? Math.round(
        (cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 10,
      ) / 10
      : null;
    const medianCycleTime = cycleTimes.length > 0
      ? cycleTimes.sort((a, b) => a - b)[Math.floor(cycleTimes.length / 2)]
      : null;

    // Total retries across all issues
    const totalRetries = [...retryMap.values()].reduce((a, b) => a + b, 0);

    // Build markdown
    const lines: string[] = [];
    lines.push("# Issue Lifecycle Metrics");
    lines.push("");
    lines.push(`**Model:** ${context.modelName}`);
    lines.push(`**Generated:** ${now}`);
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total tracked issues | ${totalIssues} |`);
    lines.push(`| Completed | ${completed.length} |`);
    lines.push(`| In progress | ${inProgress.length} |`);
    lines.push(`| Stuck (>48h no transition) | ${stuck.length} |`);
    lines.push(`| PR failed (awaiting retry) | ${failed.length} |`);
    lines.push(`| Total PR retries | ${totalRetries} |`);
    if (avgCycleTime !== null) {
      lines.push(
        `| Avg cycle time (completed) | ${formatDuration(avgCycleTime)} |`,
      );
    }
    if (medianCycleTime !== null) {
      lines.push(
        `| Median cycle time | ${formatDuration(medianCycleTime)} |`,
      );
    }
    lines.push("");

    // Stuck issues detail
    if (stuck.length > 0) {
      lines.push("## Stuck Issues (>48h since last transition)");
      lines.push("");
      lines.push("| Issue | Phase | Stale | Priority | Retries |");
      lines.push("|-------|-------|-------|----------|---------|");
      for (const s of stuck.sort((a, b) => b.staleHours - a.staleHours)) {
        const retries = retryMap.get(s.issueNumber) ?? 0;
        lines.push(
          `| #${s.issueNumber} | ${s.phase} | ${
            formatDuration(s.staleHours)
          } | ${s.priority ?? "-"} | ${retries} |`,
        );
      }
      lines.push("");
    }

    // In-progress breakdown
    if (inProgress.length > 0) {
      lines.push("## In Progress");
      lines.push("");
      lines.push("| Issue | Phase | Age | Iteration | PR |");
      lines.push("|-------|-------|-----|-----------|-----|");
      for (const s of inProgress.sort((a, b) => b.staleHours - a.staleHours)) {
        const age = formatDuration(hoursFrom(s.startedAt, now));
        const prInfo = s.prUrl ? `[PR](${s.prUrl})` : "-";
        lines.push(
          `| #${s.issueNumber} | ${s.phase} | ${age} | ${s.iteration} | ${prInfo} |`,
        );
      }
      lines.push("");
    }

    // Completed issues
    if (completed.length > 0) {
      lines.push("## Completed");
      lines.push("");
      lines.push("| Issue | Cycle Time | Iterations | Retries |");
      lines.push("|-------|-----------|-----------|---------|");
      for (
        const s of completed.sort((a, b) =>
          (b.cycleTimeHours ?? 0) - (a.cycleTimeHours ?? 0)
        )
      ) {
        const retries = retryMap.get(s.issueNumber) ?? 0;
        lines.push(
          `| #${s.issueNumber} | ${
            formatDuration(s.cycleTimeHours ?? 0)
          } | ${s.iteration} | ${retries} |`,
        );
      }
      lines.push("");
    }

    const jsonData = {
      generatedAt: now,
      model: context.modelName,
      totalIssues,
      completed: completed.length,
      inProgress: inProgress.length,
      stuck: stuck.length,
      prFailed: failed.length,
      totalRetries,
      avgCycleTimeHours: avgCycleTime,
      medianCycleTimeHours: medianCycleTime,
      issues: summaries,
    };

    context.logger.info(
      "Lifecycle metrics: {total} issues, {completed} complete, {stuck} stuck",
      { total: totalIssues, completed: completed.length, stuck: stuck.length },
    );

    return {
      markdown: lines.join("\n"),
      json: jsonData,
    };
  },
};

/** Compute hours between two ISO timestamps (alias for readability). */
function hoursFrom(start: string, end: string): number {
  return hoursBetween(start, end);
}
