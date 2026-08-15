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

/** Metadata for one stored data artifact, as returned by findAllForModel. */
interface DataEntry {
  name: string;
  version: number;
  tags?: Record<string, string>;
}

/** Low-level data API shared by all report contexts. */
interface DataRepository {
  findAllForModel(type: string, modelId: string): Promise<DataEntry[]>;
  getContent(
    type: string,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/** Context provided by the swamp runtime for model-scoped reports. */
interface ModelReportContext {
  modelType: string;
  modelId: string;
  definition: { id: string; name: string; version: number };
  dataRepository: DataRepository;
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
  retryCount: number;
  cycleTimeHours: number | null;
  staleHours: number;
}

/**
 * Fetch and parse every stored resource for the given spec. Each issue has
 * exactly one instance per spec (e.g. `state-issue-42`), so the returned data
 * is already at its latest version — no cross-version comparison needed.
 */
async function readSpec<T>(
  dataRepository: DataRepository,
  modelType: string,
  modelId: string,
  entries: DataEntry[],
  specName: string,
): Promise<T[]> {
  const results: T[] = [];
  for (const entry of entries) {
    if (entry.tags?.specName !== specName) continue;
    const bytes = await dataRepository.getContent(
      modelType,
      modelId,
      entry.name,
      entry.version,
    );
    if (!bytes) continue;
    results.push(JSON.parse(new TextDecoder().decode(bytes)) as T);
  }
  return results;
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

  execute: async (context: ModelReportContext) => {
    const now = new Date().toISOString();
    const { modelType, modelId, dataRepository } = context;
    const entries = await dataRepository.findAllForModel(modelType, modelId);

    const states = await readSpec<Record<string, unknown>>(
      dataRepository,
      modelType,
      modelId,
      entries,
      "state",
    );
    const classifications = await readSpec<Record<string, unknown>>(
      dataRepository,
      modelType,
      modelId,
      entries,
      "classification",
    );
    const pullRequests = await readSpec<Record<string, unknown>>(
      dataRepository,
      modelType,
      modelId,
      entries,
      "pullRequest",
    );

    const classMap = new Map<number, Record<string, unknown>>();
    for (const c of classifications) {
      classMap.set(c.issueNumber as number, c);
    }
    const prMap = new Map<number, Record<string, unknown>>();
    for (const pr of pullRequests) {
      prMap.set(pr.issueNumber as number, pr);
    }

    // Build summaries
    const summaries: IssueSummary[] = [];
    for (const state of states) {
      const issueNum = state.issueNumber as number;
      const classification = classMap.get(issueNum);
      const pr = prMap.get(issueNum);

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
        retryCount: (pr?.retryCount as number) ?? 0,
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
    const totalRetries = summaries.reduce((a, s) => a + s.retryCount, 0);

    // Build markdown
    const lines: string[] = [];
    lines.push("# Issue Lifecycle Metrics");
    lines.push("");
    lines.push(`**Model:** ${context.definition.name}`);
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
        lines.push(
          `| #${s.issueNumber} | ${s.phase} | ${
            formatDuration(s.staleHours)
          } | ${s.priority ?? "-"} | ${s.retryCount} |`,
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
        lines.push(
          `| #${s.issueNumber} | ${
            formatDuration(s.cycleTimeHours ?? 0)
          } | ${s.iteration} | ${s.retryCount} |`,
        );
      }
      lines.push("");
    }

    const jsonData = {
      generatedAt: now,
      model: context.definition.name,
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
