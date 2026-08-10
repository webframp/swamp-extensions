/**
 * Normalizer: @webframp/aws/cost-explorer -> OpsSignal[].
 *
 * `get_cost_trend` produces a daily cost trend with a direction indicator
 * (increasing, decreasing, stable) and total spend for the window.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "aws-cost";
const MAX_AGE_HOURS = 24;

export function costExplorerNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    // Check for degraded state (partial account coverage)
    const failedProfiles = Array.isArray(data.failedProfiles)
      ? data.failedProfiles
      : [];
    const degraded = failedProfiles.length > 0;
    const degradedReason = degraded
      ? `${failedProfiles.length} accounts unreachable`
      : undefined;

    // get_cost_trend output shape
    const totalCost = typeof data.totalCost === "number"
      ? data.totalCost
      : typeof data.total === "number"
      ? data.total
      : undefined;
    const trend = typeof data.trend === "string" ? data.trend : undefined;
    const days = typeof data.days === "number" ? data.days : 7;

    if (totalCost !== undefined) {
      const formatted = totalCost.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

      const trendLabel = trend ? ` (${trend})` : "";

      const severity: "ok" | "warn" = trend === "increasing" ? "warn" : "ok";

      ops.push({
        source: SOURCE,
        label: "spend",
        severity,
        detail: `${formatted} over ${days}d${trendLabel}`,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
      });
    } else if (data.services && Array.isArray(data.services)) {
      // get_cost_by_service output — sum totals
      const services = data.services as Array<{ total?: number }>;
      const sum = services.reduce(
        (acc, s) => acc + (typeof s.total === "number" ? s.total : 0),
        0,
      );
      const formatted = sum.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

      ops.push({
        source: SOURCE,
        label: "spend",
        severity: "info",
        detail: `${formatted} across ${services.length} services`,
        fetchedAt,
        stale,
        degraded,
        degradedReason,
      });
    }
  }

  if (ops.length === 0) {
    notes.push("Cost Explorer: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
