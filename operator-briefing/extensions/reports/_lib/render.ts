/**
 * Render the aggregated queue + ops signals into the briefing markdown and the
 * stable JSON contract. The JSON is the seam every downstream renderer (live
 * HTML view, executive R/vellum reports) consumes — design it as the durable
 * interface, the markdown as one projection of it.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import type { OpsSignal, QueueItem, Tier } from "./shapes.ts";
import { TIER_LABELS } from "./shapes.ts";

/**
 * Escape a cell for a markdown table: pipes are escaped so they cannot open a
 * new column, and any newline (CR/LF) is flattened to a space so a value can
 * never split the physical row or inject a fabricated one.
 */
const esc = (s: unknown) =>
  String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Source-level failure counts, surfaced in the JSON contract. */
export interface SourceErrors {
  /** Steps skipped: no normalizer, or a normalizer that threw. */
  skippedSteps: number;
  /** Data handles that could not be read or parsed. */
  parseFailures: number;
}

/** The stable JSON contract returned by the report. */
export interface BriefingJson {
  generatedAt: string;
  tiers: {
    waitingOnYou: QueueItem[];
    awaitingMerge: QueueItem[];
    mentions: QueueItem[];
    yourOpenMrs: QueueItem[];
  };
  queue: QueueItem[];
  ops: OpsSignal[];
  degraded: boolean;
  /** Source-failure counts; always present (0/0 on a clean run). */
  sourceErrors: SourceErrors;
  notes: string[];
}

export interface BriefingResult {
  markdown: string;
  json: BriefingJson;
}

/** Items for a tier, oldest-waiting first (design §3). */
function tierItems(queue: QueueItem[], tier: Tier): QueueItem[] {
  return queue
    .filter((q) => q.tier === tier)
    .sort((a, b) => b.ageDays - a.ageDays);
}

function renderQueueTable(items: QueueItem[]): string[] {
  const lines: string[] = [];
  lines.push("| Item | Title | Who | Age | Effort | Action |");
  lines.push("|------|-------|-----|-----|--------|--------|");
  for (const i of items) {
    const staleMark = i.stale ? " ⚠" : "";
    const draftMark = i.draft ? " 🚧" : "";
    const effort = i.effort != null ? `${i.effort}/5` : "";
    lines.push(
      `| ${esc(i.reference)} | ${esc(i.title)}${draftMark} | ${
        esc(i.who)
      } | ${i.ageDays}d${staleMark} | ${effort} | ${i.actionHint} |`,
    );
  }
  return lines;
}

/** True when a signal represents an anomaly worth a mention in the ops line. */
function isAnomaly(s: OpsSignal): boolean {
  return s.degraded || s.severity === "warn" || s.severity === "critical";
}

function renderOps(ops: OpsSignal[]): string[] {
  const lines: string[] = [];
  lines.push("## Ops");
  lines.push("");
  if (ops.length === 0) {
    lines.push("No ops signals in this run.");
    lines.push("");
    return lines;
  }

  const anomalies = ops.filter(isAnomaly);
  const summary = anomalies.length === 0
    ? `All ${ops.length} ops signals nominal.`
    : anomalies
      .map((s) => {
        const tag = s.degraded ? ` [degraded: ${s.degradedReason}]` : "";
        return `${s.label}: ${s.detail}${tag}`;
      })
      .join("; ");
  lines.push(`**${summary}**`);
  lines.push("");

  lines.push("| Source | Signal | Detail | Fresh |");
  lines.push("|--------|--------|--------|-------|");
  for (const s of ops) {
    const flags: string[] = [];
    if (s.stale) flags.push("stale");
    if (s.degraded) flags.push(`degraded: ${s.degradedReason ?? "yes"}`);
    if (s.truncated) flags.push("truncated");
    const fresh = flags.length ? flags.join(", ") : "ok";
    lines.push(
      `| ${esc(s.source)} | ${esc(s.label)} | ${esc(s.detail)} | ${
        esc(fresh)
      } |`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * Build the stable JSON contract from the flat queue + ops.
 *
 * Top-level `degraded` is true when the outer catch fired (`degraded` arg),
 * any ops signal is degraded, OR a source failed (a skipped step or a data
 * handle that could not be parsed). `sourceErrors` always carries those counts.
 */
export function buildJson(
  queue: QueueItem[],
  ops: OpsSignal[],
  notes: string[],
  generatedAt: string,
  degraded: boolean,
  sourceErrors: SourceErrors = { skippedSteps: 0, parseFailures: 0 },
): BriefingJson {
  const sourceDegraded = sourceErrors.skippedSteps > 0 ||
    sourceErrors.parseFailures > 0;
  return {
    generatedAt,
    tiers: {
      waitingOnYou: tierItems(queue, 1),
      awaitingMerge: tierItems(queue, 2),
      mentions: tierItems(queue, 3),
      yourOpenMrs: tierItems(queue, 4),
    },
    queue,
    ops,
    degraded: degraded || sourceDegraded || ops.some((o) => o.degraded),
    sourceErrors,
    notes,
  };
}

/** Render the full briefing (markdown + JSON). */
export function render(
  queue: QueueItem[],
  ops: OpsSignal[],
  notes: string[],
  generatedAt: string,
  degraded = false,
  sourceErrors: SourceErrors = { skippedSteps: 0, parseFailures: 0 },
): BriefingResult {
  const json = buildJson(
    queue,
    ops,
    notes,
    generatedAt,
    degraded,
    sourceErrors,
  );

  const tier1 = json.tiers.waitingOnYou;
  const tier2 = json.tiers.awaitingMerge;
  const tier3 = json.tiers.mentions;
  const tier4 = json.tiers.yourOpenMrs;

  const staleCount = queue.filter((q) => q.stale).length;
  const highEffort = queue.filter((q) => (q.effort ?? 0) >= 4).length;

  const lines: string[] = [];
  lines.push("# Operator Briefing");
  lines.push("");
  lines.push(`_Generated ${generatedAt}_`);
  lines.push("");

  // Lead line — one scannable summary before the tiers (design §3).
  const lead = `${queue.length} item(s): ` +
    `${tier1.length} waiting on you, ` +
    `${tier2.length} awaiting merge, ` +
    `${tier3.length} mention(s), ` +
    `${tier4.length} open MR(s)` +
    (staleCount ? ` — ${staleCount} stale (>7d)` : "") +
    (highEffort ? `, ${highEffort} high-effort` : "") +
    ".";
  lines.push(`**${lead}**`);
  lines.push("");

  const sections: Array<[Tier, QueueItem[]]> = [
    [1, tier1],
    [2, tier2],
    [3, tier3],
    [4, tier4],
  ];
  for (const [tier, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`## ${TIER_LABELS[tier]} (${items.length})`);
    lines.push("");
    lines.push(...renderQueueTable(items));
    lines.push("");
  }

  lines.push(...renderOps(ops));

  if (notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }

  if (json.degraded) {
    lines.push(
      "> Some sources were degraded this run — see the ops table and notes.",
    );
    lines.push("");
  }

  return { markdown: lines.join("\n"), json };
}
