/**
 * Normalizer: @webframp/aws/kiro-usage -> OpsSignal[].
 *
 * The `scan` method writes one resource per billing month (data name is the
 * period, e.g. `2026-09-01`):
 * `{ scannedAt, billingPeriod, currency, users, tiers, discount, totals,
 *    fetchedAt, ... }`. The `totals` block carries the reconciled cost rollup:
 * `{ userCount, grossCostUsd, edpDiscountUsd, netCostUsd, creditsConsumed,
 *    overageUsd }`.
 *
 * The normalizer emits ONE cost signal from `totals`: net Kiro-on-Bedrock spend
 * for the period, the active user count, and any overage. Per-user rows in
 * `users` are never surfaced (they resolve to individual identities). The
 * signal warns only when there is a non-zero overage — otherwise it is an
 * informational spend line, mirroring the Claude analytics cost line.
 *
 * The Athena scan is monthly-grain, so the resource legitimately ages past the
 * 24h freshness budget mid-month; `MAX_AGE_HOURS` is set wide (35 days) so a
 * current-month snapshot is not falsely flagged stale.
 *
 * Contract reference: `swamp model type describe @webframp/aws/kiro-usage --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "kiro-usage";
// Monthly-grain snapshot: a current-month scan can be weeks old and still be
// the freshest available. Budget generously (35 days) so it is not flagged
// stale mid-month; a snapshot older than a full month IS stale.
const MAX_AGE_HOURS = 35 * 24;

interface KiroTotals {
  userCount?: number;
  grossCostUsd?: number;
  edpDiscountUsd?: number;
  netCostUsd?: number;
  creditsConsumed?: number;
  overageUsd?: number;
}

/** Identify the Kiro usage scan shape by its `totals` rollup + billingPeriod. */
function isKiroScan(data: Record<string, unknown>): boolean {
  return (
    typeof data.totals === "object" &&
    data.totals !== null &&
    typeof (data.totals as KiroTotals).netCostUsd === "number"
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "unavailable";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function kiroUsageNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    if (!isKiroScan(data)) continue;

    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : typeof data.scannedAt === "string"
      ? data.scannedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const totals = data.totals as KiroTotals;
    const net = totals.netCostUsd ?? 0;
    const users = totals.userCount ?? 0;
    const overage = totals.overageUsd ?? 0;
    const period = typeof data.billingPeriod === "string"
      ? data.billingPeriod
      : "current period";

    const severity: "ok" | "info" | "warn" = overage > 0 ? "warn" : "info";
    const overageNote = overage > 0 ? `, ${fmtUsd(overage)} overage` : "";

    ops.push({
      source: SOURCE,
      label: "spend",
      severity,
      detail: `${
        fmtUsd(net)
      } net across ${users} users (${period})${overageNote}`,
      fetchedAt,
      stale,
      degraded: false,
    });
  }

  if (ops.length === 0) {
    notes.push("Kiro usage: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
