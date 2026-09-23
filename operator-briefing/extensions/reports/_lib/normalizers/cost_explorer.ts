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
 * cached data ages out. Both the flattened specs and the legacy envelope are
 * covered for four query types: `cost_trend`, `cost_by_service`,
 * `cost_comparison` (period-over-period delta, warns on a material rise), and
 * `top_cost_drivers` (largest service+usage driver). The comparison and
 * drivers signals share one builder across the flattened and envelope paths.
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
 * Identify the flattened `costComparison` spec (from `get_cost_comparison`
 * after the model's flatten): `currentPeriod` + `previousPeriod` objects and a
 * numeric `totalDeltaPercent` at the top level (no `queryType`/`data` wrapper).
 */
function isCostComparison(data: Record<string, unknown>): boolean {
  return (
    typeof data.currentPeriod === "object" &&
    data.currentPeriod !== null &&
    !Array.isArray(data.currentPeriod) &&
    typeof data.previousPeriod === "object" &&
    data.previousPeriod !== null &&
    !Array.isArray(data.previousPeriod) &&
    typeof data.totalDeltaPercent === "number"
  );
}

/**
 * Identify the flattened `costDrivers` spec (from `get_top_cost_drivers` after
 * the model's flatten): a `drivers` array plus a numeric `totalCost` at the top
 * level. Distinct from `costByService` (which keys on `services`).
 */
function isCostDrivers(data: Record<string, unknown>): boolean {
  return Array.isArray(data.drivers) && typeof data.totalCost === "number";
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

interface CmpService {
  service?: string;
  delta?: number;
  deltaPercent?: number;
}

/**
 * Build the `spend-delta` signal from an unwrapped comparison payload (the
 * flattened `costComparison` spec and the legacy `cost_comparison` envelope
 * share these fields). Warns on a material period-over-period rise (>= 10%) and
 * names the single largest positive service increase.
 */
function buildComparisonSignal(
  payload: Record<string, unknown>,
  fetchedAt: string | null,
  stale: boolean,
  degraded: boolean,
): OpsSignal {
  const cur = payload.currentPeriod as { total?: number } | undefined;
  const prev = payload.previousPeriod as { total?: number } | undefined;
  // Finite-guard the percentage: a non-finite value (e.g. divide-by-zero in an
  // old cached envelope) must not render "NaN%" or drive the warn threshold.
  const rawPct = payload.totalDeltaPercent;
  const totalDeltaPct = typeof rawPct === "number" && Number.isFinite(rawPct)
    ? rawPct
    : undefined;
  const services = Array.isArray(payload.services)
    ? payload.services as CmpService[]
    : [];

  const topIncrease = services
    .filter((s) => typeof s.delta === "number" && s.delta > 0)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];

  const severity: "ok" | "warn" =
    totalDeltaPct !== undefined && totalDeltaPct >= 10 ? "warn" : "ok";

  const dir = totalDeltaPct === undefined
    ? ""
    : totalDeltaPct >= 0
    ? `+${totalDeltaPct.toFixed(1)}%`
    : `${totalDeltaPct.toFixed(1)}%`;
  const curTotal = typeof cur?.total === "number" ? cur.total : NaN;
  const prevTotal = typeof prev?.total === "number" ? prev.total : NaN;
  const driver = topIncrease?.service && severity === "warn"
    ? ` — top rise ${topIncrease.service} +${fmtUsd(topIncrease.delta ?? 0)}`
    : "";
  const dirLabel = dir ? ` (${dir})` : "";

  return {
    source: SOURCE,
    label: "spend-delta",
    severity,
    detail: `${fmtUsd(curTotal)} vs ${
      fmtUsd(prevTotal)
    } prior${dirLabel}${driver}`,
    fetchedAt,
    stale,
    degraded,
  };
}

/**
 * Build the `drivers` signal from an unwrapped drivers list (the flattened
 * `costDrivers` spec's `drivers` array and the legacy `top_cost_drivers`
 * envelope's `data` array share the `{ service, amount }` element shape).
 */
function buildDriversSignal(
  drivers: Array<{ service?: string; amount?: number }>,
  fetchedAt: string | null,
  stale: boolean,
  degraded: boolean,
): OpsSignal {
  const top = drivers[0];
  const topLabel = top?.service
    ? `${top.service} (${fmtUsd(top.amount ?? 0)})`
    : "n/a";
  return {
    source: SOURCE,
    label: "drivers",
    severity: "info",
    detail: `${drivers.length} top drivers; largest ${topLabel}`,
    fetchedAt,
    stale,
    degraded,
  };
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
    } else if (isCostComparison(data)) {
      // Flattened costComparison spec (post-flatten model output).
      ops.push(buildComparisonSignal(data, fetchedAt, stale, degraded));
    } else if (isCostDrivers(data)) {
      // Flattened costDrivers spec (post-flatten model output).
      ops.push(
        buildDriversSignal(
          data.drivers as Array<{ service?: string; amount?: number }>,
          fetchedAt,
          stale,
          degraded,
        ),
      );
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
      } else if (
        queryType === "cost_comparison" && nested &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        // Legacy envelope: unwrap `data` and reuse the shared builder.
        ops.push(
          buildComparisonSignal(
            nested as Record<string, unknown>,
            fetchedAt,
            stale,
            degraded,
          ),
        );
      } else if (queryType === "top_cost_drivers" && Array.isArray(nested)) {
        // Legacy envelope: `data` is the drivers array itself.
        ops.push(
          buildDriversSignal(
            nested as Array<{ service?: string; amount?: number }>,
            fetchedAt,
            stale,
            degraded,
          ),
        );
      }
    }
  }

  if (ops.length === 0) {
    notes.push("Cost Explorer: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
