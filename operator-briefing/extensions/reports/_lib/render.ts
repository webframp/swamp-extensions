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

/** Max visible length of a free-text markdown cell before it is truncated. */
const MAX_CELL = 80;

/**
 * Cap free-text (a title or a todo body) to `MAX_CELL` visible characters with
 * an ellipsis, so a long mention body cannot dump a wall of text into a table
 * cell. Markdown-only — the full text is preserved in the JSON contract. Runs
 * BEFORE `esc`, so the cap is on visible characters, not escaped ones.
 */
const truncate = (s: unknown, max = MAX_CELL): string => {
  const str = String(s);
  // Slice on code points, not UTF-16 units, so a cut never lands mid-surrogate
  // and emits a lone "�" (MR titles routinely contain emoji, e.g. ♻️).
  const cp = Array.from(str);
  return cp.length > max ? cp.slice(0, max - 1).join("") + "…" : str;
};

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

/** Items for a tier, oldest-waiting first unless a caller applied a safe priority. */
function tierItems(
  queue: QueueItem[],
  tier: Tier,
  preserveOrder = false,
): QueueItem[] {
  const items = queue.filter((q) => q.tier === tier);
  return preserveOrder ? items : items.sort((a, b) => b.ageDays - a.ageDays);
}

/** Compact jev enrichment cell for the queue table, or "" when absent. */
function jevCell(item: QueueItem): string {
  const jev = item.jev;
  if (!jev) return "";
  const parts: string[] = [];
  // Vulnerability is the highest-signal output — surface it first and loudly.
  if (typeof jev.describesVulnerability === "number") {
    const pct = (jev.describesVulnerability * 100).toFixed(0);
    if (jev.describesVulnerability >= 0.5) parts.push(`⚠ vuln ${pct}%`);
  }
  if (jev.recommendation && jev.recommendation.confidence >= 0.5) {
    parts.push(
      `rec: ${jev.recommendation.choice} (${
        (jev.recommendation.confidence * 100).toFixed(0)
      }%)`,
    );
  }
  if (jev.bumpRisk && jev.bumpRisk.confidence >= 0.5) {
    parts.push(`bump-risk ${jev.bumpRisk.score.toFixed(1)}/2`);
  }
  if (jev.issueType && jev.issueType.confidence >= 0.5) {
    parts.push(`type: ${jev.issueType.choice}`);
  }
  if (jev.sourceDomain && jev.sourceDomain.confidence >= 0.5) {
    parts.push(`src: ${jev.sourceDomain.choice}`);
  }
  return parts.join("; ");
}

function renderQueueTable(items: QueueItem[]): string[] {
  const lines: string[] = [];
  // The jev column appears only when at least one item in this tier carries
  // enrichment, so tiers with no grades keep the original compact shape.
  const anyJev = items.some((i) => jevCell(i) !== "");
  const header = anyJev
    ? "| Item | Title | Who | Age | Effort | Action | jev |"
    : "| Item | Title | Who | Age | Effort | Action |";
  const divider = anyJev
    ? "|------|-------|-----|-----|--------|--------|-----|"
    : "|------|-------|-----|-----|--------|--------|";
  lines.push(header);
  lines.push(divider);
  for (const i of items) {
    const staleMark = i.stale ? " ⚠" : "";
    const draftMark = i.draft ? " 🚧" : "";
    const effort = i.effort != null ? `${i.effort}/5` : "";
    const base = `| ${esc(i.reference)} | ${
      esc(truncate(i.title))
    }${draftMark} | ${
      esc(i.who)
    } | ${i.ageDays}d${staleMark} | ${effort} | ${i.actionHint} |`;
    lines.push(anyJev ? `${base} ${esc(jevCell(i))} |` : base);
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
  preserveQueueOrder = false,
): BriefingJson {
  const sourceDegraded = sourceErrors.skippedSteps > 0 ||
    sourceErrors.parseFailures > 0;
  return {
    generatedAt,
    tiers: {
      waitingOnYou: tierItems(queue, 1, preserveQueueOrder),
      awaitingMerge: tierItems(queue, 2, preserveQueueOrder),
      mentions: tierItems(queue, 3, preserveQueueOrder),
      yourOpenMrs: tierItems(queue, 4, preserveQueueOrder),
    },
    queue,
    ops,
    degraded: degraded || sourceDegraded || ops.some((o) => o.degraded),
    sourceErrors,
    notes,
  };
}

/**
 * Render the shared queue section: heading, generated stamp, the one-line lead
 * summary, and the four tier tables. BOTH the workflow briefing and the
 * method-scope fast path render their GitLab tiers through this one function,
 * so the tiering can never diverge between the two reports.
 */
function renderQueueSection(json: BriefingJson, title: string): string[] {
  const tier1 = json.tiers.waitingOnYou;
  const tier2 = json.tiers.awaitingMerge;
  const tier3 = json.tiers.mentions;
  const tier4 = json.tiers.yourOpenMrs;

  const queue = json.queue;
  const staleCount = queue.filter((q) => q.stale).length;
  const highEffort = queue.filter((q) => (q.effort ?? 0) >= 4).length;

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`_Generated ${json.generatedAt}_`);
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

  return lines;
}

/** Render the shared Notes section and the degraded-run footer. */
function renderNotesAndFooter(
  json: BriefingJson,
  notes: string[],
  degradedFooter: string,
): string[] {
  const lines: string[] = [];
  if (notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }
  if (json.degraded) {
    lines.push(`> ${degradedFooter}`);
    lines.push("");
  }
  return lines;
}

/** Render the full briefing (markdown + JSON) — queue tiers plus ops. */
export function render(
  queue: QueueItem[],
  ops: OpsSignal[],
  notes: string[],
  generatedAt: string,
  degraded = false,
  sourceErrors: SourceErrors = { skippedSteps: 0, parseFailures: 0 },
  preserveQueueOrder = false,
): BriefingResult {
  const json = buildJson(
    queue,
    ops,
    notes,
    generatedAt,
    degraded,
    sourceErrors,
    preserveQueueOrder,
  );

  const lines = renderQueueSection(json, "Operator Briefing");
  lines.push(...renderOps(ops));
  lines.push(...renderNotesAndFooter(
    json,
    notes,
    "Some sources were degraded this run — see the ops table and notes.",
  ));

  return { markdown: lines.join("\n"), json };
}

/**
 * Render the queue-only fast path (markdown + JSON) — the GitLab tiers with NO
 * ops section. Used by the method-scope `review-queue` report so its GitLab
 * output is identical in shape/format to the workflow briefing's GitLab
 * section. The JSON is the same stable contract with `ops: []`.
 */
export function renderQueueOnly(
  queue: QueueItem[],
  notes: string[],
  generatedAt: string,
  degraded = false,
  sourceErrors: SourceErrors = { skippedSteps: 0, parseFailures: 0 },
): BriefingResult {
  const json = buildJson(queue, [], notes, generatedAt, degraded, sourceErrors);

  const lines = renderQueueSection(json, "GitLab Review Queue");
  lines.push(...renderNotesAndFooter(
    json,
    notes,
    "Some sources were degraded this run — see the notes.",
  ));

  return { markdown: lines.join("\n"), json };
}
