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
    const baseUrl = new URL(`file://${repoDir}/.swamp/data/`);
    const resolved = new URL(
      `${modelType}/${modelId}/${dataName}/${version}/raw`,
      baseUrl,
    ).pathname;
    if (!resolved.startsWith(baseUrl.pathname)) return null;
    return JSON.parse(await Deno.readTextFile(resolved));
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

    // Escape values for safe markdown table/list rendering
    function esc(val: unknown): string {
      const s = val == null ? "" : String(val);
      return s.replace(/\|/g, "\\|").replace(/[`*_~<>]/g, "\\$&")
        .replace(/\n/g, " ");
    }

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

    // Dynamically discover alarm models from step executions
    // Matches any model following the aws-alarms-{region} naming convention
    const alarmSteps = ctx.stepExecutions.filter(
      (s) =>
        s.modelName.startsWith("aws-alarms-") &&
        s.methodName === "get_summary",
    );

    let totalInAlarm = 0;
    let totalAlarms = 0;
    const allChanges: Array<{
      region: string;
      alarmName: string;
      from: string;
      to: string;
      time: string;
    }> = [];

    for (const step of alarmSteps) {
      const region = step.modelName.replace("aws-alarms-", "");
      const summary = (await get(step.modelName, "get_summary")) as
        | AlarmSummary
        | null;
      if (!summary) {
        md.push(`**${esc(region)}**: _no data_\n`);
        continue;
      }
      totalInAlarm += summary.inAlarm;
      totalAlarms += summary.total;
      const status = summary.inAlarm > 0
        ? `🔴 ${summary.inAlarm} in ALARM`
        : `🟢 all clear`;
      md.push(
        `**${
          esc(region)
        }**: ${status} (${summary.total} total, ${summary.ok} OK, ${summary.insufficientData} insufficient data)`,
      );
      for (const c of (summary.recentStateChanges ?? []).slice(0, 5)) {
        allChanges.push({
          region,
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
          `| ${esc(c.region)} | ${esc(c.alarmName)} | ${esc(c.from)} | ${
            esc(c.to)
          } | ${esc(c.time)} |`,
        );
      }
    }
    md.push("");

    json.alarms = { totalAlarms, totalInAlarm, recentChanges: allChanges };

    // === ALARM TRIAGE ===
    // Dynamically discover triage data from all alarm-investigation-{region} models
    const triageSteps = ctx.stepExecutions.filter(
      (s) =>
        s.modelName.startsWith("alarm-investigation-") &&
        s.methodName === "triage",
    );
    const triageHandles: Array<
      { modelType: string; modelId: string; name: string; version: number }
    > = [];
    for (const s of triageSteps) {
      for (const h of s.dataHandles) {
        if (!h.name.startsWith("report-")) {
          triageHandles.push({
            modelType: s.modelType,
            modelId: s.modelId,
            name: h.name,
            version: h.version,
          });
        }
      }
    }
    const aggregatedVerdict: Record<string, number> = {};
    let triageTotal = 0;

    for (const h of triageHandles) {
      const data = await readData(
        ctx.repoDir,
        h.modelType,
        h.modelId,
        h.name,
        h.version,
      );
      if (data && "byVerdict" in data) {
        const d = data as unknown as {
          total: number;
          byVerdict: Record<string, number>;
        };
        triageTotal += d.total ?? 0;
        for (const [k, v] of Object.entries(d.byVerdict)) {
          aggregatedVerdict[k] = (aggregatedVerdict[k] ?? 0) + v;
        }
      }
    }

    if (triageTotal > 0) {
      md.push("## Alarm Health Verdicts\n");
      const v = aggregatedVerdict;
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
      json.alarmTriage = {
        total: triageTotal,
        byVerdict: aggregatedVerdict,
      };
    }

    // === COSTS ===
    md.push("## Cost Trend\n");

    const costTrend = await get("aws-costs", "get_cost_trend");
    const costByService = await get("aws-costs", "get_cost_by_service");
    const costsJson: Record<string, unknown> = {};

    if (costTrend) {
      const d = costTrend.data as {
        trend?: string;
        dailyCosts?: Array<{ date: string; amount: number }>;
        totalCost?: number | null;
        averageDailyCost?: number | null;
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
        if (Number.isFinite(d.totalCost)) {
          md.push(`**Total (period)**: $${d.totalCost!.toFixed(2)}`);
        }
        if (Number.isFinite(d.averageDailyCost)) {
          md.push(`**Daily average**: $${d.averageDailyCost!.toFixed(2)}`);
        }
        costsJson.trend = trend;
        costsJson.total = d.totalCost;
        costsJson.dailyAvg = d.averageDailyCost;
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
          const amt = Number(s.amount);
          md.push(
            `| ${esc(s.service)} | $${
              Number.isFinite(amt) ? amt.toFixed(2) : "0.00"
            } |`,
          );
        }
        costsJson.topServices = sorted.slice(0, 5);
      }
    }

    if (Object.keys(costsJson).length > 0) {
      json.costs = costsJson;
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
          md.push(
            `- **#${pr.number}** ${esc(pr.title ?? "")} _(${esc(author)}, ${
              esc(created)
            })_`,
          );
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
