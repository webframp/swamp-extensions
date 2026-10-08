/**
 * Report: @webframp/claude-cost-reconciliation (workflow scope).
 *
 * Joins the two sides of the monthly Claude Enterprise bill — the AWS
 * Marketplace "Claude Enterprise" line (from `@webframp/aws/cost-explorer`'s
 * `get_cost_for_period`) and Anthropic's own post-discount paid total (from
 * `@webframp/anthropic/analytics`'s `collect_cost_by_model`) — for the same
 * calendar month, and renders a reconciliation verdict:
 *
 *   verdict  : MATCH | MISMATCH | UNVERIFIABLE
 *   finality : FINAL | PROVISIONAL
 *
 * Trust and finality gates ensure the report never asserts a confident
 * MATCH/MISMATCH off incomplete or non-final data. See the extension's
 * DESIGN.md §6 for the exact join/verdict/gate logic.
 *
 * Contract: DEGRADE, NEVER THROW. Any absent handle, parse failure, or
 * unexpected error yields a valid `{ markdown, json }` with `degraded: true`
 * and `verdict: "UNVERIFIABLE"`.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */
// deno-lint-ignore-file no-explicit-any

import { type DataRepository, readJson } from "./_lib/read.ts";

/** AWS Cost Explorer model type whose `get_cost_for_period` feeds the AWS side. */
const AWS_TYPE = "@webframp/aws/cost-explorer";
const AWS_METHOD = "get_cost_for_period";
/** Anthropic analytics model type whose `collect_cost_by_model` feeds the Anthropic side. */
const ANTHROPIC_TYPE = "@webframp/anthropic/analytics";
const ANTHROPIC_METHOD = "collect_cost_by_model";

/** Cost Explorer usage-type group keys for the invoice-line split (footnote only). */
const USAGE_FEE_KEY = "MP:usage_fee-Units";
const SEAT_DAY_KEY = "MP:c4e_usage_based_seat_day-Units";

/** Default tolerances when the workflow inputs do not supply them. */
const DEFAULT_TOLERANCE_USD = 50;
const DEFAULT_TOLERANCE_PCT = 0.5;

type Verdict = "MATCH" | "MISMATCH" | "UNVERIFIABLE";
type Finality = "FINAL" | "PROVISIONAL";

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface StepExecution {
  jobName?: string;
  stepName?: string;
  modelName?: string;
  modelType: string;
  modelId: string;
  methodName?: string;
  status?: string;
  dataHandles?: DataHandle[];
}

interface WorkflowReportContext {
  workflowName?: string;
  workflowStatus?: string;
  inputs?: Record<string, unknown>;
  stepExecutions?: StepExecution[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

/** A finite number, or undefined when the value is missing/non-numeric/NaN. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Read a tolerance input, coercing a numeric string (CLI inputs can arrive as
 * strings) and rejecting negatives / non-finite values. Falls back to the
 * default when absent or unusable — the report must stay standalone-safe and
 * degrade on bad config rather than throw.
 */
function tolerance(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  const parsed = num(n);
  return parsed !== undefined && parsed >= 0 ? parsed : fallback;
}

/** Round to cents for stable display and comparison. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Round a percentage to three decimals. A reconciliation delta is routinely
 * sub-percent, so two decimals would collapse the signal to noise; three
 * decimals preserve it in the stable JSON contract.
 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Format a USD amount (e.g. `$1,234.56`). */
function formatCurrency(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const [whole, cents] = abs.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${cents}`;
}

/** Format a percentage to three decimals (e.g. `-0.123%`). */
function formatPct(pct: number): string {
  return `${pct.toFixed(3)}%`;
}

/** Render a markdown table from headers + rows (left-aligned). */
function formatTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/** The first succeeded step matching a model type + method, or undefined. */
function findStep(
  steps: StepExecution[],
  modelType: string,
  methodName: string,
): StepExecution | undefined {
  return steps.find((s) =>
    s.modelType === modelType && s.methodName === methodName &&
    s.status === "succeeded"
  );
}

/** The first non-report data handle on a step, or undefined. */
function primaryHandle(step: StepExecution): DataHandle | undefined {
  return (step.dataHandles ?? []).find((h) =>
    h?.name && !h.name.startsWith("report-")
  );
}

/** The outcome shape the markdown renderer and JSON contract both consume. */
interface Reconciliation {
  month: string;
  window: { start: string | null; end: string | null };
  aws: {
    paidUsd: number | null;
    truncated: boolean;
    usageFeeUsd: number | null;
    seatDayUsd: number | null;
  } | null;
  anthropic: {
    paidUsd: number | null;
    listUsd: number | null;
    discountUsd: number | null;
    unattributedUsd: number | null;
    reconciliationChecked: boolean;
    truncated: boolean;
  } | null;
  reconciliation: {
    deltaUsd: number | null;
    deltaPct: number | null;
    verdict: Verdict;
    finality: Finality;
    toleranceUsd: number;
    tolerancePct: number;
  };
  notes: string[];
  degraded: boolean;
  generatedAt: string;
}

/** Build the always-present footnotes plus any caveats accumulated so far. */
function footnotes(result: Reconciliation): string[] {
  const notes = [...result.notes];
  notes.push(
    "Amazon Bedrock usage is excluded (separate cost center).",
    "The AWS Marketplace line is a single rollup and cannot be split by model.",
  );
  const unattributed = result.anthropic?.unattributedUsd ?? 0;
  if (unattributed) {
    notes.push(
      `Anthropic reports ${
        formatCurrency(unattributed)
      } of unattributed (model-less) spend.`,
    );
  }
  if (result.reconciliation.finality === "PROVISIONAL") {
    notes.push(
      "This month has not fully settled (rangeExceedsWatermark); the delta is " +
        "provisional and may change as late usage lands.",
    );
  }
  return notes;
}

/** Render markdown from a completed reconciliation outcome. `notes` is the
 * fully-assembled footnote list (built once by the caller) so the markdown and
 * the JSON contract never diverge. */
function renderMarkdown(result: Reconciliation, notes: string[]): string {
  const { verdict, finality, deltaUsd, deltaPct } = result.reconciliation;
  const icon = verdict === "MATCH"
    ? "✅"
    : verdict === "MISMATCH"
    ? "❌"
    : "⚠️";
  const lines: string[] = [];
  lines.push(`# Claude Cost Reconciliation — ${result.month}`);
  lines.push("");
  const finalitySuffix = verdict === "UNVERIFIABLE" ? "" : ` (${finality})`;
  lines.push(`## ${icon} ${verdict}${finalitySuffix}`);
  lines.push("");

  if (result.aws && result.anthropic && deltaUsd !== null) {
    lines.push(
      formatTable(
        ["Source", "Paid (USD)"],
        [
          ["AWS — Claude Enterprise", formatCurrency(result.aws.paidUsd ?? 0)],
          ["Anthropic — paid", formatCurrency(result.anthropic.paidUsd ?? 0)],
          [
            "**Delta (AWS − Anthropic)**",
            `**${formatCurrency(deltaUsd)}${
              deltaPct !== null ? ` (${formatPct(deltaPct)})` : ""
            }**`,
          ],
        ],
      ),
    );
    lines.push("");
    lines.push(
      `Tolerance: ${
        formatCurrency(result.reconciliation.toleranceUsd)
      } or ${result.reconciliation.tolerancePct}% (either passes).`,
    );
    lines.push("");
  }

  if (notes.length > 0) {
    lines.push("### Notes");
    lines.push("");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push(`_Generated ${result.generatedAt}._`);
  return lines.join("\n");
}

/**
 * Finalize: build footnotes exactly once, render markdown from that same list,
 * then mirror it into `result.notes` so the markdown and the JSON contract
 * carry identical caveats. Returns the report result shape.
 */
function finalize(
  result: Reconciliation,
): { markdown: string; json: Record<string, unknown> } {
  const notes = footnotes(result);
  const markdown = renderMarkdown(result, notes);
  result.notes = notes;
  return { markdown, json: result as unknown as Record<string, unknown> };
}

/** Build the degraded/unverifiable result. */
function degrade(
  result: Reconciliation,
  note: string,
): { markdown: string; json: Record<string, unknown> } {
  result.degraded = true;
  result.reconciliation.verdict = "UNVERIFIABLE";
  result.notes.push(note);
  return finalize(result);
}

/**
 * The `@webframp/claude-cost-reconciliation` workflow-scope report. Reads the
 * AWS and Anthropic cost resources produced by the reconciliation workflow,
 * applies the trust/finality gates, computes the tolerance verdict, and returns
 * `{ markdown, json }`. Never throws — it degrades to UNVERIFIABLE and records
 * why.
 */
export const report = {
  name: "@webframp/claude-cost-reconciliation",
  description:
    "Reconcile the monthly AWS Marketplace Claude Enterprise invoice line against Anthropic's own post-discount paid total: MATCH / MISMATCH / UNVERIFIABLE with a FINAL / PROVISIONAL finality label, gated on upstream trust and settlement flags.",
  scope: "workflow" as const,
  labels: ["cost", "finops", "reconciliation", "anthropic", "aws"],

  async execute(
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const generatedAt = new Date().toISOString();
    const inputs = context.inputs ?? {};
    const toleranceUsd = tolerance(inputs.toleranceUsd, DEFAULT_TOLERANCE_USD);
    const tolerancePct = tolerance(inputs.tolerancePct, DEFAULT_TOLERANCE_PCT);
    const month = typeof inputs.month === "string" ? inputs.month : "unknown";

    const result: Reconciliation = {
      month,
      window: { start: null, end: null },
      aws: null,
      anthropic: null,
      reconciliation: {
        deltaUsd: null,
        deltaPct: null,
        verdict: "UNVERIFIABLE",
        finality: "FINAL",
        toleranceUsd,
        tolerancePct,
      },
      notes: [],
      degraded: false,
      generatedAt,
    };

    try {
      const steps = context.stepExecutions ?? [];

      // --- Locate both steps by model type + method (DR-4). ---
      const awsStep = findStep(steps, AWS_TYPE, AWS_METHOD);
      const anthroStep = findStep(steps, ANTHROPIC_TYPE, ANTHROPIC_METHOD);
      if (!awsStep) {
        return degrade(
          result,
          "AWS cost step (get_cost_for_period) is absent or did not succeed.",
        );
      }
      if (!anthroStep) {
        return degrade(
          result,
          "Anthropic cost step (collect_cost_by_model) is absent or did not succeed.",
        );
      }

      // --- Read both data handles (DR-2: absent handle -> UNVERIFIABLE). ---
      const awsHandle = primaryHandle(awsStep);
      const anthroHandle = primaryHandle(anthroStep);
      if (!awsHandle) {
        return degrade(result, "AWS cost step produced no data handle.");
      }
      if (!anthroHandle) {
        return degrade(result, "Anthropic cost step produced no data handle.");
      }

      const awsRead = await readJson(
        context.dataRepository,
        awsStep.modelType,
        awsStep.modelId,
        awsHandle.name,
        awsHandle.version,
      );
      const anthroRead = await readJson(
        context.dataRepository,
        anthroStep.modelType,
        anthroStep.modelId,
        anthroHandle.name,
        anthroHandle.version,
      );

      if (awsRead.parseError || awsRead.data === null) {
        return degrade(
          result,
          "AWS cost data could not be read or parsed (handle absent, expired, or malformed).",
        );
      }
      if (anthroRead.parseError || anthroRead.data === null) {
        return degrade(
          result,
          "Anthropic cost data could not be read or parsed (handle absent, expired, or malformed).",
        );
      }

      const aws = awsRead.data;
      const anthro = anthroRead.data;

      // --- Extract AWS side (DR-1: group field is `key`). ---
      const awsPaid = num(aws.totalCost);
      // DR-3 fail-open: absent `truncated` means not truncated.
      const awsTruncated = aws.truncated === true;
      const groups = Array.isArray(aws.groups) ? aws.groups : [];
      const groupAmount = (key: string): number | null => {
        const g = groups.find((row) =>
          row && typeof row === "object" &&
          (row as Record<string, unknown>).key === key
        ) as Record<string, unknown> | undefined;
        return g ? num(g.amount) ?? null : null;
      };
      result.aws = {
        paidUsd: awsPaid ?? null,
        truncated: awsTruncated,
        usageFeeUsd: groupAmount(USAGE_FEE_KEY),
        seatDayUsd: groupAmount(SEAT_DAY_KEY),
      };

      // --- Extract Anthropic side. ---
      const anthroPaid = num(anthro.totalPaidUsd);
      // DR-3 fail-closed: trust flags must be explicitly true.
      const collected = anthro.collected === true;
      const reconciliationChecked = anthro.reconciliationChecked === true;
      // DR-3 fail-open: completeness/finality flags default to safe-ok.
      const anthroTruncated = anthro.truncated === true;
      const rangeExceedsWatermark = anthro.rangeExceedsWatermark === true;
      result.anthropic = {
        paidUsd: anthroPaid ?? null,
        listUsd: num(anthro.totalListUsd) ?? null,
        discountUsd: num(anthro.totalDiscountUsd) ?? null,
        unattributedUsd: num(anthro.unattributedUsd) ?? null,
        reconciliationChecked,
        truncated: anthroTruncated,
      };

      // --- Window agreement (DR-5). ---
      const awsStart = typeof aws.start === "string" ? aws.start : null;
      const awsEnd = typeof aws.end === "string" ? aws.end : null;
      const anthroStart = typeof anthro.startDate === "string"
        ? anthro.startDate
        : null;
      const anthroEnd = typeof anthro.endDate === "string"
        ? anthro.endDate
        : null;
      result.window = { start: awsStart, end: awsEnd };

      // --- Finality label (DR-3 fail-open). Computed before gates so a
      //     provisional-but-trustworthy month is still labeled. ---
      result.reconciliation.finality = rangeExceedsWatermark
        ? "PROVISIONAL"
        : "FINAL";

      // --- Trust/finality gates (DESIGN §6.2). ---
      if (!collected) {
        return degrade(
          result,
          "Anthropic cost was not collected (collected=false) — fetch failed; no verdict.",
        );
      }
      if (!reconciliationChecked) {
        return degrade(
          result,
          "Anthropic total is untrustworthy (reconciliationChecked=false) — no verdict.",
        );
      }
      if (awsTruncated) {
        return degrade(
          result,
          "AWS cost result was truncated (page cap hit) — total incomplete; no verdict.",
        );
      }
      if (anthroTruncated) {
        return degrade(
          result,
          "Anthropic cost result was truncated — total incomplete; no verdict.",
        );
      }
      if (awsStart !== anthroStart || awsEnd !== anthroEnd) {
        return degrade(
          result,
          `Reconciliation windows disagree (AWS ${awsStart}..${awsEnd} vs Anthropic ${anthroStart}..${anthroEnd}) — refusing to compare different periods.`,
        );
      }
      if (awsPaid === undefined) {
        return degrade(result, "AWS total is missing or non-numeric.");
      }
      if (anthroPaid === undefined) {
        return degrade(result, "Anthropic total is missing or non-numeric.");
      }

      // --- Delta + verdict (DESIGN §6.1). Compare RAW values against the
      //     tolerances; round only for display/storage so a true delta just
      //     outside tolerance cannot round down into a false MATCH. ---
      const rawDelta = awsPaid - anthroPaid;
      result.reconciliation.deltaUsd = round2(rawDelta);

      if (anthroPaid === 0) {
        if (awsPaid === 0) {
          // Trivial match: both sides zero. Honest verdict, but noted so a
          // reader is not misled into thinking real spend reconciled.
          result.reconciliation.deltaPct = 0;
          result.reconciliation.verdict = "MATCH";
          result.notes.push(
            "Both totals are $0.00 — trivial match (no spend to reconcile).",
          );
        } else {
          // AWS billed but Anthropic reports nothing: cannot form a percentage
          // and the totals plainly disagree in a way a tolerance cannot judge.
          return degrade(
            result,
            "Anthropic total is $0.00 while AWS billed a non-zero amount — cannot reconcile.",
          );
        }
      } else {
        const rawPct = rawDelta / anthroPaid * 100;
        result.reconciliation.deltaPct = round3(rawPct);
        const withinUsd = Math.abs(rawDelta) <= toleranceUsd;
        const withinPct = Math.abs(rawPct) <= tolerancePct;
        result.reconciliation.verdict = (withinUsd || withinPct)
          ? "MATCH"
          : "MISMATCH";
      }

      const output = finalize(result);

      context.logger?.info?.(
        "claude-cost-reconciliation: {month} {verdict} {finality} delta={delta}",
        {
          month,
          verdict: result.reconciliation.verdict,
          finality: result.reconciliation.finality,
          delta: result.reconciliation.deltaUsd,
        },
      );

      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return degrade(result, `Report degraded: ${message}`);
    }
  },
};
