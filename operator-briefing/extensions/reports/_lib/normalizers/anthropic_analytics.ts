/**
 * Normalizer: @webframp/anthropic/analytics -> OpsSignal[].
 *
 * The `collect_analytics` step produces several resources (seats, adoption,
 * cost window, daily summaries). Each is dispatched by its shape. A
 * `collected: false` flag means the fetch failed — it is rendered as
 * "unavailable (fetch failed)" and marked `degraded`, NEVER as a zero.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "analytics";
const MAX_AGE_HOURS = 24;

function fmtUsd(n: number): string {
  // Guard non-finite input (NaN/±Infinity from bad or missing data) so the
  // briefing never renders "$NaN" / "$∞".
  if (!Number.isFinite(n)) return "unavailable";
  return "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
}

/** An OpsSignal for a source whose `collected` flag reports a failed fetch. */
function unavailable(
  label: string,
  fetchedAt: string | null,
  stale: boolean,
): OpsSignal {
  return {
    source: SOURCE,
    label,
    severity: "warn",
    detail: "unavailable (fetch failed)",
    fetchedAt,
    stale,
    degraded: true,
    degradedReason: "collect returned collected=false",
  };
}

export function analyticsNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    // Seats (current): always present, no `collected` flag.
    if ("dau" in data && "mau" in data) {
      ops.push({
        source: SOURCE,
        label: "seats",
        severity: "info",
        detail:
          `DAU ${data.dau} / WAU ${data.wau} / MAU ${data.mau} (${data.total} total, ${data.active} active)`,
        fetchedAt,
        stale,
        degraded: false,
      });
      continue;
    }

    // Adoption.
    if ("projects" in data && "skills" in data) {
      if (data.collected === false) {
        ops.push(unavailable("adoption", fetchedAt, stale));
      } else {
        ops.push({
          source: SOURCE,
          label: "adoption",
          severity: "info",
          detail:
            `${data.projects} projects, ${data.skills} skills, ${data.connectors} connectors`,
          fetchedAt,
          stale,
          degraded: false,
        });
      }
      continue;
    }

    // Cost window.
    if ("total_usd" in data || "total_cents" in data) {
      if (data.collected === false) {
        ops.push(unavailable("cost", fetchedAt, stale));
      } else {
        const usd = Number(data.total_usd ?? 0);
        const since = data.startingAt
          ? ` since ${String(data.startingAt).slice(0, 10)}`
          : "";
        ops.push({
          source: SOURCE,
          label: "cost",
          severity: "info",
          detail: `${fmtUsd(usd)}${since}`,
          fetchedAt,
          stale,
          degraded: false,
        });
      }
      continue;
    }

    // Daily summaries (`recent`) are raw per-day rows — not surfaced as a signal.
  }

  return { queue: [], ops, notes: [] };
}
