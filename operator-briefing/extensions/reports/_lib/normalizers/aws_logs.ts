/**
 * Normalizer: @webframp/aws/logs -> OpsSignal[].
 *
 * The `find_errors` method writes one `error_analysis` resource per invocation
 * (data name is content-hashed):
 * `{ logGroupName, timeRange, totalErrors, patterns, fetchedAt, ... }`, where
 * `patterns` is an array of `{ pattern, count, ... }` clusters.
 *
 * IMPORTANT — this is a deliberately UNGRADED signal. The GitLab EKS clusters
 * emit high-volume Kubernetes audit events that match error keywords but are
 * not application faults, so a raw `totalErrors` count is a poor severity proxy.
 * The severity judgment (real fault vs. background noise) is made by the
 * paired `logs_interpret` TypeSafe step, whose verdict this report surfaces
 * separately (see the typesafe_ai normalizer). This normalizer therefore
 * reports the factual counts at `info` severity and never escalates to `warn`
 * on its own — it provides context, not a verdict.
 *
 * Contract reference: `swamp model type describe @webframp/aws/logs --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "gitlab-logs";
const MAX_AGE_HOURS = 24;

/** Identify the `error_analysis` shape by totalErrors + patterns array. */
function isErrorAnalysis(data: Record<string, unknown>): boolean {
  return (
    typeof data.totalErrors === "number" && Array.isArray(data.patterns)
  );
}

export function awsLogsNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    if (!isErrorAnalysis(data)) continue;

    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const totalErrors = data.totalErrors as number;
    const patterns = data.patterns as Array<{ count?: number }>;

    // Factual, ungraded: matched error-keyword events and distinct clusters.
    // The logs_interpret TypeSafe verdict carries the real-fault judgment.
    const detail = totalErrors === 0
      ? "no error-keyword matches (24h)"
      : `${totalErrors} error-keyword match(es) in ${patterns.length} pattern(s) (24h)`;

    ops.push({
      source: SOURCE,
      label: "errors",
      severity: "info",
      detail,
      fetchedAt,
      stale,
      degraded: false,
    });
  }

  if (ops.length === 0) {
    notes.push("GitLab logs: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
