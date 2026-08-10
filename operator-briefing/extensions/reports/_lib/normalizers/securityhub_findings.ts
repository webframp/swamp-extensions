/**
 * Normalizer: @webframp/aws/securityhub-findings -> OpsSignal[].
 *
 * `get_severity_summary` produces a severity breakdown (CRITICAL, HIGH, MEDIUM,
 * LOW, INFORMATIONAL counts). The briefing surfaces CRITICAL and HIGH counts
 * as the primary security signal.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "security-hub";
const MAX_AGE_HOURS = 24;

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

    // Check for degraded state
    const failedProfiles = Array.isArray(data.failedProfiles)
      ? data.failedProfiles
      : [];
    const degraded = failedProfiles.length > 0;
    const degradedReason = degraded
      ? `${failedProfiles.length} accounts unreachable`
      : undefined;

    // get_severity_summary produces a summary object with severity counts
    const summary = data.summary as
      | Record<string, number>
      | undefined;

    if (summary && typeof summary === "object") {
      const critical = typeof summary.CRITICAL === "number"
        ? summary.CRITICAL
        : 0;
      const high = typeof summary.HIGH === "number" ? summary.HIGH : 0;
      const medium = typeof summary.MEDIUM === "number" ? summary.MEDIUM : 0;
      const low = typeof summary.LOW === "number" ? summary.LOW : 0;
      const total = critical + high + medium + low;

      const severity = critical > 0 ? "critical" : high > 0 ? "warn" : "ok";

      const parts: string[] = [];
      if (critical > 0) parts.push(`${critical} CRITICAL`);
      if (high > 0) parts.push(`${high} HIGH`);
      if (medium > 0) parts.push(`${medium} MEDIUM`);
      if (low > 0) parts.push(`${low} LOW`);

      const detail = total === 0
        ? "no active findings (24h)"
        : parts.join(", ") + ` (${total} total, 24h)`;

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
    } else if (Array.isArray(data.findings)) {
      // list_findings output — count by severity from the array
      const findings = data.findings as Array<{
        severity?: { label?: string };
      }>;
      const critical = findings.filter(
        (f) => f.severity?.label === "CRITICAL",
      ).length;
      const high = findings.filter(
        (f) => f.severity?.label === "HIGH",
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
