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
  NormalizerContext,
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

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * State is caller-projected evidence, not model-generated rationale. Render a
 * bounded factual companion for known briefing verdicts so "Worth a look" is
 * useful without asking TypeSafe to generate prose or exposing identifiers.
 */
function evidence(
  state: Record<string, unknown> | undefined,
  accountNames: ReadonlyMap<string, string>,
): string | undefined {
  if (!state) return undefined;

  if ("newCount" in state || "newFindings" in state) {
    const newCount = finiteNumber(state.newCount);
    const findings = Array.isArray(state.newFindings) ? state.newFindings : [];
    let critical = 0;
    let high = 0;
    const affected = new Set<string>();
    for (const finding of findings) {
      const item = object(finding);
      if (!item) continue;
      if (item.severity === "CRITICAL") critical++;
      if (item.severity === "HIGH") high++;
      if (typeof item.accountId === "string") {
        const name = accountNames.get(item.accountId);
        if (name) affected.add(name);
      }
    }
    const count = newCount ?? findings.length;
    const accounts = affected.size > 0
      ? `; affected ${[...affected].sort().join(", ")}`
      : "";
    return `${count} new finding(s): ${critical} critical, ${high} high${accounts}`;
  }

  if ("comparison" in state || "topDrivers" in state) {
    const comparison = object(state.comparison);
    const delta = finiteNumber(comparison?.totalDeltaPercent);
    const driverContainer = object(state.topDrivers);
    const drivers = Array.isArray(state.topDrivers)
      ? state.topDrivers
      : Array.isArray(driverContainer?.drivers)
      ? driverContainer.drivers
      : [];
    const first = object(drivers[0]);
    const driver = typeof first?.service === "string"
      ? `; top driver ${first.service}`
      : "";
    const direction = delta === undefined
      ? "cost delta unavailable"
      : `period delta ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    return direction + driver;
  }

  if ("totalErrors" in state || "topPatterns" in state) {
    const total = finiteNumber(state.totalErrors);
    const patterns = Array.isArray(state.topPatterns) ? state.topPatterns : [];
    return `${
      total ?? 0
    } matched event(s) across ${patterns.length} top pattern(s)`;
  }

  return undefined;
}

function triageBatchContribution(
  data: Record<string, unknown>,
  context: NormalizerContext,
): Contribution {
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const fingerprint = typeof data.sourceFingerprint === "string"
    ? data.sourceFingerprint
    : undefined;
  if (!fingerprint || fingerprint !== context.triageFingerprint) {
    return {
      queue: [],
      ops: [{
        source: SOURCE,
        label: "review-triage",
        severity: "warn",
        detail:
          "review triage snapshot did not match the current queue; deterministic queue ordering used",
        fetchedAt: typeof data.evaluatedAt === "string"
          ? data.evaluatedAt
          : null,
        stale: false,
        degraded: true,
        degradedReason: "source fingerprint mismatch",
      }],
      notes: [],
    };
  }
  if (failures.length === 0) {
    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) {
      const item = object(result);
      if (!item || typeof item.id !== "string") continue;
      const answers = object(item.answers);
      if (answers) context.triageAnswers?.set(item.id, answers);
    }
    return {
      queue: [],
      ops: [],
      notes: ["Verified TypeSafe review triage applied to queue ordering."],
    };
  }
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    queue: [],
    ops: [{
      source: SOURCE,
      label: "review-triage",
      severity: "warn",
      detail:
        `${failures.length} review triage decision(s) unavailable; deterministic queue ordering used`,
      fetchedAt: typeof data.evaluatedAt === "string" ? data.evaluatedAt : null,
      stale: false,
      degraded: true,
      degradedReason: `${results.length} of ${
        results.length + failures.length
      } decisions completed`,
    }],
    notes: [],
  };
}

export function typesafeAiNormalizer(
  inputs: SourceInput[],
  context: NormalizerContext = { accountNames: new Map() },
): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { dataName, data } of inputs) {
    if (dataName.startsWith("triage-batch-")) {
      const contribution = triageBatchContribution(data, context);
      ops.push(...contribution.ops);
      notes.push(...contribution.notes);
      continue;
    }

    // Triage resources feed the review-queue ordering, not the ops line.
    // Recognized here; their answers are ALSO collected for advisory
    // attachment onto queue items (QueueItem.jev) by the report's join pass.
    // Never an "unrecognized shape" note.
    if (dataName.startsWith("triage-")) {
      const id = typeof data.id === "string" ? data.id : undefined;
      const answers = object(data.answers);
      if (id && answers && context.jevAnswers) {
        context.jevAnswers.set(id, answers);
        // A described improper-access mechanism (issue_assessment's strict 0/1
        // vulnerability noul >= 0.5) is the single highest-signal jev output.
        // Surface it EXPLICITLY as a jev-sourced ops signal so the contract
        // itself flags it — it does not reorder or re-tier the queue item
        // (operator decision, 2026-09-25); the flag is the whole point.
        const vuln = object(answers.describes_vulnerability);
        const noul = vuln && typeof vuln.noul === "number"
          ? vuln.noul
          : undefined;
        if (typeof noul === "number" && Number.isFinite(noul) && noul >= 0.5) {
          ops.push({
            source: SOURCE,
            label: "issue-vulnerability",
            severity: noul >= 0.75 ? "critical" : "warn",
            detail:
              `${id} may describe a specific access/secret/privilege exposure ` +
              `(jev ${
                (noul * 100).toFixed(0)
              }%) — verify the issue text before acting`,
            fetchedAt: typeof data.evaluatedAt === "string"
              ? data.evaluatedAt
              : null,
            stale: false,
            degraded: false,
          });
        }
      }
      continue;
    }

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

    const stateEvidence = evidence(object(data.state), context.accountNames);
    ops.push({
      source: SOURCE,
      label: labelFromName(dataName),
      severity,
      detail: `${headline}${noulContext}` +
        (stateEvidence ? ` — ${stateEvidence}` : ""),
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
