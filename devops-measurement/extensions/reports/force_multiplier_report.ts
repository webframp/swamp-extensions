/**
 * Report: @webframp/devops-measurement force-multiplier report (workflow scope).
 *
 * The Presentation context. Joins the scoring model's per-member scores with
 * the interaction-graph model's centrality (DR-4 join), re-classifies tiers now
 * that centrality is known, and renders the tier table + force-multiplier
 * summary — the headline the Go API's /api/scores served, as a versioned,
 * queryable artifact per workflow run.
 *
 * Workflow scope: it loops the workflow's step executions, finds the scoring
 * and interaction-graph steps by modelType, reads their data, and joins.
 *
 * Contract: degrade, never throw. Missing/parse-failed data -> a valid
 * { markdown, json } with degraded=true and a reason.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */
// deno-lint-ignore-file no-explicit-any

import { type DataRepository, readJson } from "./_lib/read.ts";
import {
  type Centrality,
  DEFAULT_TIERS,
  joinAndClassify,
  type Score,
} from "./_lib/join.ts";

const SCORING_TYPE = "@webframp/devops-measurement/scoring";
const GRAPH_TYPE = "@webframp/devops-measurement/interaction-graph";

interface DataHandle {
  name: string;
  version?: number;
}
interface StepExecution {
  modelType: string;
  modelId: string;
  dataHandles?: DataHandle[];
}
interface WorkflowReportContext {
  workflowName?: string;
  stepExecutions?: StepExecution[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Render the markdown report from enriched scores. */
type GraphStats = {
  hubs: string[];
  bridges: string[];
  systemContributors?: {
    projectId: string;
    ownerCrew: string;
    externalContributors: string[];
  }[];
};

export function renderMarkdown(
  scores: Score[],
  stats: GraphStats | null,
  degradedReason: string | null,
): string {
  const lines: string[] = [];
  lines.push("# DevOps Force-Multiplier Report");
  lines.push("");
  if (degradedReason) {
    lines.push(`> ⚠️ Degraded: ${degradedReason}`);
    lines.push("");
  }
  if (scores.length === 0) {
    lines.push("No scored members.");
    return lines.join("\n");
  }

  const tierOrder = ["Tier 1", "Tier 2", "Tier 3", "Watch"];
  const counts: Record<string, number> = {};
  for (const s of scores) counts[s.tier] = (counts[s.tier] ?? 0) + 1;
  lines.push("## Tier summary");
  lines.push("");
  for (const t of tierOrder) {
    if (counts[t]) lines.push(`- **${t}**: ${counts[t]}`);
  }
  lines.push("");

  lines.push("## Members");
  lines.push("");
  lines.push(
    "| Member | Crew | Tier | X-ratio | Reach | Depth | Unblock | Resp(h) | Centrality | Rank |",
  );
  lines.push(
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const s of scores) {
    lines.push(
      `| ${esc(s.username)} | ${esc(s.crewId)} | ${s.tier} | ${
        pct(s.crossBoundaryRatio)
      } | ${s.crewReach} | ${s.depth} | ${pct(s.unblockRate)} | ${
        s.avgResponseTimeHours.toFixed(1)
      } | ${pct(s.networkCentrality)} | ${s.centralityRank || "—"} |`,
    );
  }
  lines.push("");

  if (stats && (stats.hubs.length || stats.bridges.length)) {
    lines.push("## Network");
    lines.push("");
    if (stats.hubs.length) lines.push(`- **Hubs**: ${stats.hubs.join(", ")}`);
    if (stats.bridges.length) {
      lines.push(`- **Bridges**: ${stats.bridges.join(", ")}`);
    }
    lines.push("");
  }

  // Inverse bus factor: which systems have backup knowledge outside the owning
  // crew, and which lean on a single external contributor (a resilience risk).
  const systems = stats?.systemContributors ?? [];
  if (systems.length) {
    lines.push("## Resilience — backup knowledge per system");
    lines.push("");
    lines.push("| System | Owner crew | External contributors |");
    lines.push("| --- | --- | ---: |");
    for (const s of systems) {
      const flag = s.externalContributors.length <= 1 ? " ⚠️" : "";
      lines.push(
        `| ${esc(s.projectId)} | ${
          esc(s.ownerCrew)
        } | ${s.externalContributors.length}${flag} |`,
      );
    }
    lines.push("");
    lines.push(
      "⚠️ = only one (or no) external contributor — a single point of failure " +
        "for cross-crew knowledge of that system.",
    );
    lines.push("");
  }
  return lines.join("\n");
}

export const report = {
  name: "@webframp/devops-measurement/force-multiplier",
  description:
    "Force-multiplier report: joins cross-boundary scores with interaction " +
    "centrality, re-classifies tiers, and renders the tier table plus " +
    "hub/bridge network summary. The headline output — who the force " +
    "multipliers are.",
  scope: "workflow" as const,
  labels: ["devops", "measurement", "force-multiplier", "dashboard"],

  async execute(
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const generatedAt = new Date().toISOString();
    try {
      const steps = context.stepExecutions ?? [];
      let scores: Score[] = [];
      let centrality: Centrality[] = [];
      let graphStats: GraphStats | null = null;
      const notes: string[] = [];

      for (const step of steps) {
        const handle = (step.dataHandles ?? [])[0];
        if (!handle) continue;

        if (step.modelType === SCORING_TYPE) {
          const { data, parseError } = await readJson(
            context.dataRepository,
            step.modelType,
            step.modelId,
            handle.name,
            handle.version,
          );
          if (parseError) notes.push("failed to read scoring data");
          else if (data && Array.isArray((data as any).scores)) {
            scores = (data as any).scores as Score[];
          }
        } else if (step.modelType === GRAPH_TYPE) {
          const { data, parseError } = await readJson(
            context.dataRepository,
            step.modelType,
            step.modelId,
            handle.name,
            handle.version,
          );
          if (parseError) notes.push("failed to read graph data");
          else if (data) {
            const c = (data as any).centrality;
            if (Array.isArray(c)) centrality = c as Centrality[];
            const st = (data as any).stats;
            if (st) {
              graphStats = {
                hubs: Array.isArray(st.hubs) ? st.hubs : [],
                bridges: Array.isArray(st.bridges) ? st.bridges : [],
                systemContributors: Array.isArray(st.systemContributors)
                  ? st.systemContributors
                  : [],
              };
            }
          }
        }
      }

      const degradedReason = scores.length === 0
        ? (notes.length
          ? notes.join("; ")
          : "no scoring data in this workflow run")
        : null;

      const enriched = joinAndClassify(scores, centrality, DEFAULT_TIERS);
      const markdown = renderMarkdown(enriched, graphStats, degradedReason);

      const tierCounts: Record<string, number> = {};
      for (const s of enriched) {
        tierCounts[s.tier] = (tierCounts[s.tier] ?? 0) + 1;
      }

      return {
        markdown,
        json: {
          generatedAt,
          workflow: context.workflowName ?? "",
          degraded: degradedReason !== null,
          notes,
          tierCounts,
          members: enriched,
          hubs: graphStats?.hubs ?? [],
          bridges: graphStats?.bridges ?? [],
          systemContributors: graphStats?.systemContributors ?? [],
        },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        markdown:
          `# DevOps Force-Multiplier Report\n\n> ⚠️ Degraded: ${reason}`,
        json: { generatedAt, degraded: true, notes: [reason], members: [] },
      };
    }
  },
};
