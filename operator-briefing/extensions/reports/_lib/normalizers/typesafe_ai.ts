/**
 * Normalizer: @swamp/typesafe-ai (Jev / System One) -> OpsSignal[].
 *
 * The daily-briefing workflow uses TypeSafe two ways, and this normalizer
 * handles both by data-name convention:
 *
 * 1. `evaluation-*` resources (from the `ask` method) — the interpretation
 *    verdicts on other signals: `evaluation-security-posture`,
 *    `evaluation-cost-anomaly`, `evaluation-gitlab-logs-health`. Shape:
 *    `{ model, state, questions, answers, usage, evaluatedAt }` where `answers`
 *    is a map keyed by question name. Each answer is either a `noul`
 *    (probability of yes) or a `score` (weighted 0..N with an ordered legend
 *    and per-level `probabilities`). These become graded ops signals.
 *
 * 2. `triage-*` and `triage-summary` resources (from the `triage` method) —
 *    the per-MR review-queue triage. These feed the GitLab queue ordering via
 *    the operator-board model, NOT the ops line, so they are recognized and
 *    intentionally skipped here (no signal, no "unrecognized" note).
 *
 * Severity mapping. When a `score` answer is present its ordered legend is the
 * intended scale (0 routine, 1 worth-a-look, 2 act-today), so it drives
 * severity directly. Absent a score, a `noul` >= 0.5 is treated as `warn`.
 * The signal label is derived from the evaluation name (e.g.
 * `evaluation-security-posture` -> `verdict:security-posture`).
 *
 * Contract reference: `swamp model type describe @swamp/typesafe-ai --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type {
  Contribution,
  OpsSignal,
  Severity,
  SourceInput,
} from "../shapes.ts";

const SOURCE = "jev";
const MAX_AGE_HOURS = 24;

interface ScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

type Answer = ScoreAnswer | NoulAnswer | { type?: string };

/** An evaluation resource carries an `answers` map and was `evaluatedAt`. */
function isEvaluation(data: Record<string, unknown>): boolean {
  return (
    typeof data.answers === "object" &&
    data.answers !== null &&
    !Array.isArray(data.answers)
  );
}

function isScore(a: Answer): a is ScoreAnswer {
  return a?.type === "score" && typeof (a as ScoreAnswer).score === "number";
}

function isNoul(a: Answer): a is NoulAnswer {
  return a?.type === "noul" && typeof (a as NoulAnswer).noul === "number";
}

/**
 * Normalized [0,1] fraction of a score against its legend's max level. A
 * non-finite score yields NaN, which the callers treat as "not gradable".
 */
function scoreFraction(a: ScoreAnswer): number {
  if (!Number.isFinite(a.score)) return NaN;
  const levels = a.legend ? Object.keys(a.legend).length : 3;
  const maxLevel = Math.max(1, levels - 1);
  return Math.min(1, Math.max(0, a.score / maxLevel));
}

/**
 * Comparable severity ordinal for picking the most severe score among several
 * answers: info(0) < ok(1) < warn(2) < critical(3). A non-finite score ranks
 * as info so it never wins selection over a real grade.
 */
function severityRank(a: ScoreAnswer): number {
  const order: Record<Severity, number> = {
    info: 0,
    ok: 1,
    warn: 2,
    critical: 3,
  };
  return order[scoreSeverity(a)];
}

/**
 * Map an ordered `score` (0..maxLevel per its legend) to a severity. A 3-level
 * legend (0,1,2) maps 0->ok, 1->warn, 2->critical via the normalized fraction.
 */
function scoreSeverity(a: ScoreAnswer): Severity {
  // A non-finite score (NaN/Infinity) is not a usable grade — do not let it
  // fall through the fraction math to a dishonest "ok". `typeof NaN` is
  // "number", so an upstream NaN otherwise passes isScore() unnoticed.
  const frac = scoreFraction(a);
  if (!Number.isFinite(frac)) return "info";
  if (frac >= 0.75) return "critical";
  if (frac >= 0.34) return "warn";
  return "ok";
}

/**
 * Human label for the score, from its legend when present. Uses the SAME
 * fraction basis as scoreSeverity (not an independent Math.round) so the label
 * and the severity never disagree on a fractional score: the legend level is
 * chosen by the fraction band, so e.g. 1.4/2 (frac 0.7 -> "warn") labels with
 * level 1, and 1.6/2 (frac 0.8 -> "critical") labels with level 2.
 */
function scoreLabel(a: ScoreAnswer): string {
  const frac = scoreFraction(a);
  if (!Number.isFinite(frac)) return "grade unavailable";
  const levels = a.legend ? Object.keys(a.legend).length : 3;
  const maxLevel = Math.max(1, levels - 1);
  // Band the fraction back to a legend level consistent with the severity
  // thresholds (>=0.75 top band, >=0.34 middle band, else bottom).
  const level = frac >= 0.75
    ? maxLevel
    : frac >= 0.34
    ? Math.min(maxLevel, Math.round(maxLevel / 2))
    : 0;
  const legend = a.legend?.[String(level)];
  // Legend text is like "Routine: ...": keep the leading clause for brevity.
  if (legend) return legend.split(":")[0].trim();
  return `level ${level}`;
}

/** Derive a stable ops label from the evaluation data name. */
function labelFromName(name: string): string {
  const stripped = name.replace(/^evaluation-/, "");
  return `verdict:${stripped || "eval"}`;
}

export function typesafeAiNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { dataName, data } of inputs) {
    // Triage resources feed the review-queue ordering, not the ops line.
    // Recognized and skipped — never an "unrecognized shape" note.
    if (dataName.startsWith("triage-")) continue;

    if (!isEvaluation(data)) continue;

    const fetchedAt = typeof data.evaluatedAt === "string"
      ? data.evaluatedAt
      : typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const answers = data.answers as Record<string, Answer>;
    const entries = Object.entries(answers);

    // Prefer a `score` answer for severity + headline; fall back to a `noul`.
    // A single evaluation can carry several score answers; picking the FIRST in
    // insertion order would let a benign leading score mask a later severe one.
    // Prefer an answer literally named "severity" (the workflow's convention
    // for the grading question); otherwise take the HIGHEST-severity score so a
    // critical grade is never silently dropped.
    const scoreEntries = entries.filter(
      (e): e is [string, ScoreAnswer] => isScore(e[1]),
    );
    const scoreEntry = scoreEntries.find(([k]) => k === "severity") ??
      scoreEntries
        .slice()
        .sort((a, b) => severityRank(b[1]) - severityRank(a[1]))[0];
    const noulEntry = entries.find(([, a]) => isNoul(a));

    let severity: Severity = "info";
    let headline: string;

    if (scoreEntry && isScore(scoreEntry[1])) {
      const sa = scoreEntry[1];
      severity = scoreSeverity(sa);
      headline = scoreLabel(sa);
    } else if (noulEntry && isNoul(noulEntry[1])) {
      const na = noulEntry[1];
      // A non-finite noul (NaN/Infinity) is not a usable probability — do not
      // let it fall through `>= 0.5` to a dishonest "ok" with a "NaN%" detail.
      // Mirrors the finite guard in scoreSeverity for the score path.
      if (!Number.isFinite(na.noul)) {
        severity = "info";
        headline = `${noulEntry[0]} (probability unavailable)`;
      } else {
        severity = na.noul >= 0.5 ? "warn" : "ok";
        headline = `${noulEntry[0]} ${(na.noul * 100).toFixed(0)}%`;
      }
    } else {
      // Recognized as an evaluation but no usable answer — skip quietly.
      continue;
    }

    // Add the yes/no probability as supporting context ONLY when a score is
    // the primary signal (e.g. "Act today, needs_attention 8%"). On the
    // noul-only path the noul already IS the headline, so appending it here
    // would duplicate it ("needs_attention 80%, needs_attention 80%"). A
    // non-finite supporting noul is omitted rather than rendered as "NaN%".
    const noulContext = scoreEntry && noulEntry && isNoul(noulEntry[1]) &&
        Number.isFinite(noulEntry[1].noul)
      ? `, ${noulEntry[0]} ${(noulEntry[1].noul * 100).toFixed(0)}%`
      : "";

    ops.push({
      source: SOURCE,
      label: labelFromName(dataName),
      severity,
      detail: `${headline}${noulContext}`,
      fetchedAt,
      stale,
      degraded: false,
    });
  }

  if (
    ops.length === 0 && inputs.some((i) => !i.dataName.startsWith("triage-"))
  ) {
    notes.push("TypeSafe: no recognizable evaluation in step output.");
  }

  return { queue: [], ops, notes };
}
