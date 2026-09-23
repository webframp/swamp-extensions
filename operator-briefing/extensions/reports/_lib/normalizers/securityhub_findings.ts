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
  findings: Array<{ severity?: string } | null | undefined>,
): { critical: number; high: number } {
  return {
    critical: findings.filter((f) => f?.severity === "CRITICAL").length,
    high: findings.filter((f) => f?.severity === "HIGH").length,
  };
}

export function securityhubFindingsNormalizer(
  inputs: SourceInput[],
): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];
  // Track whether ANY input had a shape we did not recognize. account_map is
  // recognized-but-unemitted, so we cannot infer "recognized" from ops.length.
  // Flagging per-input (not a global counter) means a step mixing a known
  // account_map with an unknown shape still reports the unknown one.
  let sawUnrecognized = false;

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
      const truncated = data.truncated === true;
      const { critical: newCritical, high: newHigh } = countBySeverity(
        newFindings,
      );

      // The severity breakdown is counted from the client-side newFindings
      // array, but newCount is the server-side aggregate. When the diff is
      // truncated the array can be shorter than newCount (even empty), so
      // trusting only the array would understate a security signal — e.g.
      // newCount=50, truncated, newFindings=[] would grade "ok". Escalate to at
      // least "warn" whenever there are new findings we could not fully
      // classify, so a truncated batch of unknown severity is never silently ok.
      const unclassified = truncated && newCount > newFindings.length;
      const severity = newCritical > 0
        ? "critical"
        : (newHigh > 0 || (unclassified && newCount > 0))
        ? "warn"
        : "ok";

      const parts: string[] = [];
      if (newCount === 0) {
        parts.push("no new findings");
      } else {
        const bits: string[] = [];
        if (newCritical > 0) bits.push(`${newCritical} CRITICAL`);
        if (newHigh > 0) bits.push(`${newHigh} HIGH`);
        if (unclassified) {
          // Name the shortfall so the "warn" is explained rather than mysterious.
          const shown = newCritical + newHigh;
          const rest = newCount - shown;
          if (rest > 0) bits.push(`${rest} unclassified`);
        }
        parts.push(
          `${newCount} new` + (bits.length ? ` (${bits.join(", ")})` : ""),
        );
      }
      if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
      const truncatedNote = truncated ? ", truncated" : "";

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
    } else {
      // A shape we do not recognize at all.
      sawUnrecognized = true;
    }
  }

  // Fire the note when ANY input was an unrecognized shape. account_map and the
  // recognized specs above never set the flag, so a step that produced only an
  // account_map is not flagged — but a mixed step with one unknown shape still
  // reports it.
  if (sawUnrecognized) {
    notes.push("Security Hub: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
