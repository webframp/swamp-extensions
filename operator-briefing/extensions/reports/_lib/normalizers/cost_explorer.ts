/**
 * Normalizer: @webframp/aws/cost-explorer -> OpsSignal[].
 *
 * Handles two data specs from this model type:
 *
 * 1. `costTrend` (from `get_cost_trend`) — flat top-level fields:
 *    `{ dataPoints, trend, totalCost, days, fetchedAt }`.
 *
 * 2. `costByService` (from `get_cost_by_service`) — flat top-level fields:
 *    `{ services, totalCost, days, fetchedAt }`.
 *
 * Also handles the legacy envelope shape `{ region, queryType, data, fetchedAt }`
 * from cached resources written before the 2026.08.13.1 flatten, so the
 * normalizer produces correct output during the transition period while old
 * cached data ages out.
 *
 * Contract reference: `swamp model type describe @webframp/aws/cost-explorer --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "aws-cost";
const MAX_AGE_HOURS = 24;

/**
 * Identify `costTrend` spec by its required fields:
 * dataPoints (array), trend (string), totalCost (number).
 */
function isCostTrend(data: Record<string, unknown>): boolean {
  return (
    Array.isArray(data.dataPoints) &&
    typeof data.trend === "string" &&
    typeof data.totalCost === "number"
  );
}

/**
 * Identify `costByService` spec by its required fields:
 * services (array), totalCost (number).
 */
function isCostByService(data: Record<string, unknown>): boolean {
  return Array.isArray(data.services) && typeof data.totalCost === "number";
}

/**
 * Identify legacy envelope shape: { region, queryType, data, fetchedAt }.
 * These are cached resources from before the 2026.08.13.1 flatten.
 */
function isLegacyEnvelope(data: Record<string, unknown>): boolean {
  return typeof data.queryType === "string" && "data" in data;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "unavailable";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function costExplorerNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    // No degradation fields on cost-explorer today, but guard for future.
    const degraded = false;

    if (isCostTrend(data)) {
      // costTrend spec: flat top-level fields
      const totalCost = data.totalCost as number;
      const trend = data.trend as string;
      const days = typeof data.days === "number" ? data.days : 7;

      const severity: "ok" | "warn" = trend === "increasing" ? "warn" : "ok";
      const trendLabel = trend ? ` (${trend})` : "";

      ops.push({
        source: SOURCE,
        label: "spend",
        severity,
        detail: `${fmtUsd(totalCost)} over ${days}d${trendLabel}`,
        fetchedAt,
        stale,
        degraded,
      });
    } else if (isCostByService(data)) {
      // costByService spec: flat top-level fields
      const totalCost = data.totalCost as number;
      const services = data.services as Array<Record<string, unknown>>;
      const days = typeof data.days === "number" ? data.days : 30;

      ops.push({
        source: SOURCE,
        label: "spend",
        severity: "info",
        detail: `${
          fmtUsd(totalCost)
        } across ${services.length} services (${days}d)`,
        fetchedAt,
        stale,
        degraded,
      });
    } else if (isLegacyEnvelope(data)) {
      // Legacy envelope shape from before 2026.08.13.1
      const queryType = data.queryType as string;
      const nested = data.data as Record<string, unknown> | unknown[] | null;

      if (
        queryType === "cost_trend" && nested && typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        const totalCost = typeof nested.totalCost === "number"
          ? nested.totalCost
          : Array.isArray(nested.dataPoints)
          ? (nested.dataPoints as Array<{ amount?: number }>).reduce(
            (s, p) => s + (typeof p.amount === "number" ? p.amount : 0),
            0,
          )
          : undefined;
        const trend = typeof nested.trend === "string"
          ? nested.trend
          : undefined;

        if (totalCost !== undefined) {
          const severity: "ok" | "warn" = trend === "increasing"
            ? "warn"
            : "ok";
          const trendLabel = trend ? ` (${trend})` : "";

          ops.push({
            source: SOURCE,
            label: "spend",
            severity,
            detail: `${fmtUsd(totalCost)} over 7d${trendLabel}`,
            fetchedAt,
            stale,
            degraded,
          });
        }
      } else if (queryType === "cost_by_service" && Array.isArray(nested)) {
        const services = nested as Array<{ total?: number; amount?: number }>;
        const sum = services.reduce(
          (acc, s) =>
            acc +
            (typeof s.amount === "number"
              ? s.amount
              : typeof s.total === "number"
              ? s.total
              : 0),
          0,
        );

        ops.push({
          source: SOURCE,
          label: "spend",
          severity: "info",
          detail: `${fmtUsd(sum)} across ${services.length} services`,
          fetchedAt,
          stale,
          degraded,
        });
      }
    }
  }

  if (ops.length === 0) {
    notes.push("Cost Explorer: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
