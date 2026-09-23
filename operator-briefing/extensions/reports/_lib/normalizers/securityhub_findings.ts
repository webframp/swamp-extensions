/**
 * Normalizer: @webframp/aws/securityhub-findings -> OpsSignal[].
 *
 * Handles four data specs from this model type:
 *
 * 1. `severity_summary` (from `get_severity_summary`) — flat top-level counts:
 *    `{ critical, high, medium, low, informational, total, truncated,
 *    accountBreakdown, fetchedAt }`.
 *
 * 2. `finding_list` (from `list_findings` / `list_all_findings`) — an array of
 *    finding summaries with a string `severity` field per finding.
 *
 * 3. `diff_findings` (from `diff_findings`) — new/resolved findings since the
 *    previous run: `{ newFindings, resolvedFindings, newCount, resolvedCount,
 *    truncated, currentSnapshot, fetchedAt }`. This is the actionable "N new
 *    criticals since yesterday" delta. The bulky `currentSnapshot` is ignored.
 *
 * 4. `account_map` (from `resolve_accounts`) — the account-ID -> friendly-name
 *    lookup: `{ accounts, count, truncated, fetchedAt }`. This is enrichment
 *    for other signals, not a signal itself, and it carries account IDs, so it
 *    is intentionally NOT emitted as an ops signal (avoids leaking account
 *    identifiers per CLAUDE.md). It is recognized only so it does not trip the
 *    "no recognizable data shape" note.
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

/**
 * Identify `diff_findings` spec by its required fields:
 * newFindings (array), resolvedFindings (array), newCount + resolvedCount
 * (numbers). The bulky `currentSnapshot` is present but intentionally ignored.
 */
function isDiffFindings(data: Record<string, unknown>): boolean {
  return (
    Array.isArray(data.newFindings) &&
    Array.isArray(data.resolvedFindings) &&
    typeof data.newCount === "number" &&
    typeof data.resolvedCount === "number"
  );
}

/**
 * Identify `account_map` spec (from resolve_accounts) by its required fields:
 * accounts (array), count (number). Recognized but not emitted — see module doc.
 */
function isAccountMap(data: Record<string, unknown>): boolean {
  return Array.isArray(data.accounts) && typeof data.count === "number";
}

/** Count findings in a diff list at CRITICAL / HIGH severity. */
function countBySeverity(
  findings: Array<{ severity?: string }>,
): { critical: number; high: number } {
  return {
    critical: findings.filter((f) => f.severity === "CRITICAL").length,
    high: findings.filter((f) => f.severity === "HIGH").length,
  };
}

export function securityhubFindingsNormalizer(
  inputs: SourceInput[],
): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];
  // Count inputs whose shape we recognized, even if they emit no signal (e.g.
  // account_map). Separate from ops.length so the "no recognizable shape" note
  // fires only for genuinely unknown shapes.
  let recognized = 0;

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
    } else if (isDiffFindings(data)) {
      // diff_findings spec: new/resolved findings since the previous run.
      // This is the actionable delta — surface new critical/high exposure.
      const newFindings = data.newFindings as Array<{ severity?: string }>;
      const newCount = data.newCount as number;
      const resolvedCount = data.resolvedCount as number;
      const { critical: newCritical, high: newHigh } = countBySeverity(
        newFindings,
      );

      const severity = newCritical > 0
        ? "critical"
        : newHigh > 0
        ? "warn"
        : "ok";

      const parts: string[] = [];
      if (newCount === 0) {
        parts.push("no new findings");
      } else {
        const bits: string[] = [];
        if (newCritical > 0) bits.push(`${newCritical} CRITICAL`);
        if (newHigh > 0) bits.push(`${newHigh} HIGH`);
        parts.push(
          `${newCount} new` + (bits.length ? ` (${bits.join(", ")})` : ""),
        );
      }
      if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
      const truncatedNote = data.truncated === true ? ", truncated" : "";

      ops.push({
        source: SOURCE,
        label: "findings-delta",
        severity: severity as "ok" | "warn" | "critical",
        detail: `${parts.join(", ")} since last run${truncatedNote}`,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
      });
    } else if (isAccountMap(data)) {
      // account_map (resolve_accounts): enrichment lookup, not a signal.
      // Recognized so it does not trip the "no recognizable shape" note, but
      // deliberately not emitted — it carries account IDs (CLAUDE.md forbids
      // surfacing them) and contributes no operational status on its own.
      recognized++;
    }
  }

  // The note fires only when NOTHING in the step was recognized. account_map is
  // recognized-but-not-emitted, so a step that produced only an account_map
  // must not be flagged as an unrecognized shape.
  if (ops.length === 0 && recognized === 0) {
    notes.push("Security Hub: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
