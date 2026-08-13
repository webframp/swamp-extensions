/**
 * Normalizer: @webframp/aws/securityhub-findings -> OpsSignal[].
 *
 * Handles two data specs from this model type:
 *
 * 1. `severity_summary` (from `get_severity_summary`) — flat top-level counts:
 *    `{ critical, high, medium, low, informational, total, truncated,
 *    accountBreakdown, fetchedAt }`.
 *
 * 2. `finding_list` (from `list_findings` / `list_all_findings`) — an array of
 *    finding summaries with a string `severity` field per finding.
 *
 * Contract reference: `swamp model type describe @webframp/aws/securityhub-findings --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "security-hub";
const MAX_AGE_HOURS = 24;

/**
 * Identify `severity_summary` spec by its required fields:
 * critical, high, medium, low, total (all numbers at top level).
 */
function isSeveritySummary(data: Record<string, unknown>): boolean {
  return (
    typeof data.critical === "number" &&
    typeof data.high === "number" &&
    typeof data.medium === "number" &&
    typeof data.low === "number" &&
    typeof data.total === "number"
  );
}

/**
 * Identify `finding_list` or `full_export` spec by its required fields:
 * findings (array), count (number).
 */
function isFindingList(data: Record<string, unknown>): boolean {
  return Array.isArray(data.findings) && typeof data.count === "number";
}

export function securityhubFindingsNormalizer(
  inputs: SourceInput[],
): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    // Degradation: the severity_summary spec does not carry failedProfiles
    // today, but guard for future addition.
    const failedProfiles = Array.isArray(data.failedProfiles)
      ? data.failedProfiles
      : [];
    const degraded = failedProfiles.length > 0;
    const degradedReason = degraded
      ? `${failedProfiles.length} accounts unreachable`
      : undefined;

    if (isSeveritySummary(data)) {
      // severity_summary spec: flat lowercase counts at top level
      const critical = data.critical as number;
      const high = data.high as number;
      const medium = data.medium as number;
      const low = data.low as number;
      const total = data.total as number;

      const severity = critical > 0 ? "critical" : high > 0 ? "warn" : "ok";

      const parts: string[] = [];
      if (critical > 0) parts.push(`${critical} CRITICAL`);
      if (high > 0) parts.push(`${high} HIGH`);
      if (medium > 0) parts.push(`${medium} MEDIUM`);
      if (low > 0) parts.push(`${low} LOW`);

      const truncatedNote = data.truncated === true ? ", truncated" : "";
      const detail = total === 0
        ? "no active findings (24h)"
        : parts.join(", ") + ` (${total} total, 24h${truncatedNote})`;

      ops.push({
        source: SOURCE,
        label: "findings",
        severity: severity as "ok" | "warn" | "critical",
        detail,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
      });
    } else if (isFindingList(data)) {
      // finding_list / full_export spec: array of finding summaries
      // Each finding has `severity: string` (e.g. "CRITICAL", "HIGH")
      const findings = data.findings as Array<{ severity?: string }>;
      const critical = findings.filter(
        (f) => f.severity === "CRITICAL",
      ).length;
      const high = findings.filter(
        (f) => f.severity === "HIGH",
      ).length;
      const total = findings.length;

      const severity = critical > 0 ? "critical" : high > 0 ? "warn" : "ok";

      const detail = total === 0
        ? "no active findings"
        : `${critical} CRITICAL, ${high} HIGH of ${total} findings`;

      ops.push({
        source: SOURCE,
        label: "findings",
        severity: severity as "ok" | "warn" | "critical",
        detail,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
      });
    }
  }

  if (ops.length === 0) {
    notes.push("Security Hub: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
