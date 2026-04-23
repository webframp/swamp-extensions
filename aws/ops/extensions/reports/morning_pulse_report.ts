/**
 * Morning Pulse Report.
 *
 * Aggregates findings from the morning-pulse workflow into a concise daily
 * briefing covering alarm state across regions, alarm health verdicts,
 * cost trend, and open pull requests.
 *
 * @module
 */

// SPDX-License-Identifier: Apache-2.0

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

/** Read a data artifact from the filesystem. */
async function readData(
  repoDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
): Promise<Record<string, unknown> | null> {
  try {
    const path =
      `${repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

/** Find the first non-report data handle for a given model+method. */
function findStep(
  steps: StepExecution[],
  modelName: string,
  methodName: string,
):
  | { modelType: string; modelId: string; name: string; version: number }
  | null {
  for (const s of steps) {
    if (s.modelName === modelName && s.methodName === methodName) {
      const h = s.dataHandles.find((d) => !d.name.startsWith("report-"));
      if (h) {
        return {
          modelType: s.modelType,
          modelId: s.modelId,
          name: h.name,
          version: h.version,
        };
      }
    }
  }
  return null;
}

/** Find all non-report data handles for a model+method. */
function findAllSteps(
  steps: StepExecution[],
  modelName: string,
  methodName: string,
): Array<
  { modelType: string; modelId: string; name: string; version: number }
> {
  const results: Array<
    { modelType: string; modelId: string; name: string; version: number }
  > = [];
  for (const s of steps) {
    if (s.modelName === modelName && s.methodName === methodName) {
      for (const h of s.dataHandles) {
        if (!h.name.startsWith("report-")) {
          results.push({
            modelType: s.modelType,
            modelId: s.modelId,
            name: h.name,
            version: h.version,
          });
        }
      }
    }
  }
  return results;
}

export const report = {
  name: "@webframp/morning-pulse-report",
  description:
    "Daily infrastructure pulse: alarms, alarm health, costs, and open PRs",
  scope: "workflow" as const,
  labels: ["ops", "daily", "aws"],

  execute: async (ctx: WorkflowReportContext) => {
    const md: string[] = [];
    const json: Record<string, unknown> = {
      workflowName: ctx.workflowName,
      timestamp: new Date().toISOString(),
    };

    // Helper to get step data
    async function get(
      modelName: string,
      methodName: string,
    ): Promise<Record<string, unknown> | null> {
      const loc = findStep(ctx.stepExecutions, modelName, methodName);
      if (!loc) return null;
      return await readData(
        ctx.repoDir,
        loc.modelType,
        loc.modelId,
        loc.name,
        loc.version,
      );
    }

    // === ALARMS ===
    md.push("## Alarm Status\n");

    interface AlarmSummary {
      total: number;
      inAlarm: number;
      ok: number;
      insufficientData: number;
      recentStateChanges: Array<{
        alarmName: string;
        previousState: string;
        currentState: string;
        timestamp: string;
      }>;
    }

    const regions: Array<{ label: string; model: string }> = [
      { label: "us-east-1", model: "aws-alarms" },
      { label: "us-west-2", model: "aws-alarms-west" },
    ];

    let totalInAlarm = 0;
    let totalAlarms = 0;
    const allChanges: Array<{
      region: string;
      alarmName: string;
      from: string;
      to: string;
      time: string;
    }> = [];

    for (const r of regions) {
      const summary = (await get(r.model, "get_summary")) as
        | AlarmSummary
        | null;
      if (!summary) {
        md.push(`**${r.label}**: _no data_\n`);
        continue;
      }
      totalInAlarm += summary.inAlarm;
      totalAlarms += summary.total;
      const status = summary.inAlarm > 0
        ? `🔴 ${summary.inAlarm} in ALARM`
        : `🟢 all clear`;
      md.push(
        `**${r.label}**: ${status} (${summary.total} total, ${summary.ok} OK, ${summary.insufficientData} insufficient data)`,
      );
      for (const c of (summary.recentStateChanges ?? []).slice(0, 5)) {
        allChanges.push({
          region: r.label,
          alarmName: c.alarmName,
          from: c.previousState,
          to: c.currentState,
          time: c.timestamp,
        });
      }
    }

    if (allChanges.length > 0) {
      md.push("\n### Recent State Changes (last 24h)\n");
      md.push("| Region | Alarm | From | To | Time |");
      md.push("| ------ | ----- | ---- | -- | ---- |");
      for (const c of allChanges.slice(0, 10)) {
        md.push(
          `| ${c.region} | ${c.alarmName} | ${c.from} | ${c.to} | ${c.time} |`,
        );
      }
    }
    md.push("");

    json.alarms = { totalAlarms, totalInAlarm, recentChanges: allChanges };

    // === ALARM TRIAGE ===
    // Find triage_summary data handle specifically
    const triageHandles = findAllSteps(
      ctx.stepExecutions,
      "alarm-investigation",
      "triage",
    );
    let triageSummary: {
      total: number;
      byVerdict: Record<string, number>;
      byState: Record<string, number>;
    } | null = null;

    for (const h of triageHandles) {
      const data = await readData(
        ctx.repoDir,
        h.modelType,
        h.modelId,
        h.name,
        h.version,
      );
      if (data && "byVerdict" in data) {
        triageSummary = data as unknown as {
          total: number;
          byVerdict: Record<string, number>;
          byState: Record<string, number>;
        };
        break;
      }
    }

    if (triageSummary) {
      md.push("## Alarm Health Verdicts\n");
      const v = triageSummary.byVerdict;
      const verdictOrder = [
        "healthy",
        "noisy",
        "silent",
        "stale",
        "orphaned",
        "unknown",
      ];
      const emoji: Record<string, string> = {
        healthy: "✅",
        noisy: "⚠️",
        silent: "🔇",
        stale: "🕰️",
        orphaned: "👻",
        unknown: "❓",
      };
      const parts: string[] = [];
      for (const verdict of verdictOrder) {
        const count = v[verdict] ?? 0;
        if (count > 0) {
          parts.push(`${emoji[verdict] ?? ""} ${verdict}: ${count}`);
        }
      }
      md.push(parts.join(" · ") + "\n");
      json.alarmTriage = triageSummary;
    }

    // === COSTS ===
    md.push("## Cost Trend\n");

    const costTrend = await get("aws-costs", "get_cost_trend");
    const costByService = await get("aws-costs", "get_cost_by_service");

    if (costTrend) {
      const d = costTrend.data as {
        trend?: string;
        dailyCosts?: Array<{ date: string; amount: number }>;
        totalCost?: number;
        averageDailyCost?: number;
      } | undefined;
      if (d) {
        const trendEmoji: Record<string, string> = {
          increasing: "📈",
          decreasing: "📉",
          stable: "➡️",
        };
        const trend = d.trend ?? "unknown";
        md.push(
          `**Trend**: ${trendEmoji[trend] ?? ""} ${trend}`,
        );
        if (d.totalCost !== undefined) {
          md.push(`**Total (period)**: $${d.totalCost.toFixed(2)}`);
        }
        if (d.averageDailyCost !== undefined) {
          md.push(`**Daily average**: $${d.averageDailyCost.toFixed(2)}`);
        }
        json.costs = {
          trend,
          total: d.totalCost,
          dailyAvg: d.averageDailyCost,
        };
      }
    }

    if (costByService) {
      const d = costByService.data as {
        services?: Array<{ service: string; amount: number }>;
      } | undefined;
      if (d?.services && d.services.length > 0) {
        md.push("\n### Top Services\n");
        md.push("| Service | Cost |");
        md.push("| ------- | ---- |");
        const sorted = [...d.services].sort((a, b) => b.amount - a.amount);
        for (const s of sorted.slice(0, 5)) {
          md.push(`| ${s.service} | $${s.amount.toFixed(2)} |`);
        }
        (json.costs as Record<string, unknown>).topServices = sorted.slice(
          0,
          5,
        );
      }
    }

    if (!costTrend && !costByService) {
      md.push("_No cost data available._\n");
    }
    md.push("");

    // === GITHUB PRs ===
    md.push("## Open Pull Requests\n");

    const prData = await get("github", "list_prs");
    if (prData) {
      const prs = (prData as { data?: Array<Record<string, unknown>> }).data ??
        (prData as { pullRequests?: Array<Record<string, unknown>> })
          .pullRequests ??
        [];
      if (prs.length === 0) {
        md.push("No open PRs. 🎉\n");
      } else {
        md.push(`**${prs.length}** open PR(s):\n`);
        for (
          const pr of prs.slice(0, 10) as Array<{
            title?: string;
            number?: number;
            user?: string;
            author?: string;
            createdAt?: string;
            created_at?: string;
          }>
        ) {
          const author = pr.user ?? pr.author ?? "unknown";
          const created = pr.createdAt ?? pr.created_at ?? "";
          md.push(`- **#${pr.number}** ${pr.title} _(${author}, ${created})_`);
        }
      }
      json.pullRequests = { count: prs.length };
    } else {
      md.push("_No PR data available._\n");
    }
    md.push("");

    // === BUILD REPORT ===
    const markdown = `# ☀️ Morning Pulse

**Generated**: ${new Date().toISOString()}

---

${md.join("\n")}

---

*Report generated by @webframp/morning-pulse-report*
`;

    ctx.logger.info("Generated morning pulse report", {
      totalAlarms,
      totalInAlarm,
    });

    return { markdown, json };
  },
};
