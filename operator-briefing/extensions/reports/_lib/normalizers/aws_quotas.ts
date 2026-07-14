/**
 * Normalizer: @webframp/aws/service-quotas -> OpsSignal[].
 *
 * `check_utilization` writes one resource per service (ec2/vpc/eks), each with
 * over-threshold `entries`. `list_pending_requests` writes a pending-requests
 * resource. Both carry `failedProfiles[]`: a non-empty list marks the signal
 * degraded ("N accounts unreachable"); the sentinel value `sso-login-required`
 * means the operator must re-run `granted sso login`, not a real quota problem.
 * `truncated` becomes a note.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "aws-quotas";
const MAX_AGE_HOURS = 24;

interface QuotaEntry {
  profile?: string;
  quotaName?: string;
  serviceCode?: string;
  utilizationPct?: number;
  usageValue?: number;
  value?: number;
  adjustable?: boolean;
  desiredValue?: number;
  status?: string;
  requestId?: string;
}

/**
 * The account-redacted, chartable fields of a signal's structured `entries`.
 * ONLY these quota facts are ever surfaced — never `profile`, `accountId`,
 * `requestId`, `caseId`, or any account number (CLAUDE.md forbids exposing
 * internal account IDs).
 */
type SignalEntry = NonNullable<OpsSignal["entries"]>[number];

/** Map utilization rows to their chartable, account-redacted fields. */
function utilizationEntries(entries: QuotaEntry[]): SignalEntry[] {
  return entries
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      kind: "utilization" as const,
      quotaName: String(e.quotaName ?? ""),
      utilizationPct: e.utilizationPct,
      usageValue: e.usageValue,
      value: e.value,
      adjustable: e.adjustable,
    }));
}

/** Map pending-request rows to their chartable, account-redacted fields. */
function pendingEntries(entries: QuotaEntry[]): SignalEntry[] {
  return entries
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      kind: "pending" as const,
      quotaName: String(e.quotaName ?? ""),
      serviceCode: e.serviceCode,
      desiredValue: e.desiredValue,
      status: e.status,
    }));
}

/**
 * Strip the role suffix (e.g. `/ReadOnlyPlus`) from a profile. Never expose a
 * numeric account id: if the remaining segment is all digits (a bare account
 * number), redact it to `account ****`; otherwise redact ANY embedded 6+ digit
 * run (e.g. `prod-123456789012` -> `prod-****`) so an account number never
 * leaks even inside a longer name (CLAUDE.md forbids printing raw IDs).
 */
function accountName(profile?: string): string {
  if (!profile) return "?";
  const name = profile.replace(/\/[^/]+$/, "");
  if (/^\d{6,}$/.test(name)) return "account ****";
  return name.replace(/\d{6,}/g, "****");
}

function failureInfo(failed: unknown): { count: number; sso: boolean } {
  if (!Array.isArray(failed) || failed.length === 0) {
    return { count: 0, sso: false };
  }
  return {
    count: failed.length,
    sso: JSON.stringify(failed).includes("sso-login-required"),
  };
}

function isPending(data: Record<string, unknown>): boolean {
  if ("statuses" in data) return true;
  const entries = data.entries;
  return Array.isArray(entries) &&
    entries.some((e) => e && typeof e === "object" && "requestId" in e);
}

export function awsQuotasNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const { count: failCount, sso } = failureInfo(data.failedProfiles);
    const degraded = failCount > 0;
    const degradedReason = degraded
      ? (sso
        ? `re-run granted sso login (${failCount} accounts)`
        : `${failCount} accounts unreachable`)
      : undefined;
    const truncated = data.truncated === true;

    const entries = Array.isArray(data.entries)
      ? data.entries as QuotaEntry[]
      : [];
    const first = entries[0];
    let emitted = false;

    if (isPending(data)) {
      // When the fetch is degraded and returned no entries, the result was not
      // actually observed — say "not checked" rather than claiming a real zero.
      // A non-empty result IS real (some accounts were reached), so keep it.
      const detail = entries.length === 0
        ? (degraded ? "not checked" : "no pending increases")
        : `${entries.length} pending increase(s)` +
          (first
            ? ` (${first.serviceCode} ${first.quotaName} in ${
              accountName(first.profile)
            })`
            : "");
      // Only the rows actually observed become structured entries; a degraded
      // fetch that read nothing leaves `entries` absent.
      const structured = pendingEntries(entries);
      ops.push({
        source: SOURCE,
        label: "pending",
        severity: entries.length > 0 ? "info" : "ok",
        detail,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
        truncated,
        entries: structured.length > 0 ? structured : undefined,
      });
      emitted = true;
    } else if ("serviceCode" in data && "threshold" in data) {
      const svc = String(data.serviceCode);
      // A degraded fetch with no entries never observed the quotas — say "not
      // checked" rather than the dishonest "all quotas below threshold". A
      // non-empty result IS real (some accounts were reached), so keep it.
      const detail = entries.length === 0
        ? (degraded
          ? `${svc}: not checked`
          : `${svc}: all quotas below threshold`)
        : `${svc}: ${entries.length} quota(s) over threshold` +
          (first
            ? ` (${first.quotaName} ${first.utilizationPct}% in ${
              accountName(first.profile)
            })`
            : "");
      // Only over-threshold rows actually observed become structured entries;
      // a degraded fetch that read nothing leaves `entries` absent.
      const structured = utilizationEntries(entries);
      ops.push({
        source: SOURCE,
        label: `utilization:${svc}`,
        severity: entries.length > 0 ? "warn" : "ok",
        detail,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
        truncated,
        entries: structured.length > 0 ? structured : undefined,
      });
      emitted = true;
    }

    // Unrecognized shape but accounts failed: emit a degraded signal anyway so
    // the "N accounts unreachable" / sso-login-required signal is never lost.
    if (!emitted && degraded) {
      ops.push({
        source: SOURCE,
        label: "unreachable",
        severity: "warn",
        detail: degradedReason ?? "accounts unreachable",
        fetchedAt,
        stale,
        degraded: true,
        degradedReason,
        truncated,
      });
    }

    if (truncated) {
      notes.push(
        `AWS quotas result truncated (${
          data.serviceCode ?? data.region ?? "?"
        }).`,
      );
    }
  }

  return { queue: [], ops, notes };
}
