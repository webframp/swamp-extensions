/**
 * Normalizer: @webframp/anthropic/compliance -> OpsSignal[].
 *
 * `sync_effective_settings` writes an effective-settings resource (keyed by
 * orgId); `collect_activities` writes a recent-activities resource. Both are
 * dispatched by shape, not by data name.
 *
 * These signals report the PRESENCE of effective settings and recent activity
 * (counts at `severity: "info"`) — they are not drift detection.
 * TODO(drift): real drift detection (diffing effective settings against a
 * prior-version baseline to flag actual changes) is a future enhancement; it
 * needs a stored baseline to compare against, which this report does not yet
 * carry.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "compliance";
const MAX_AGE_HOURS = 24;

export function complianceNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    if ("settings" in data) {
      const count = (data.count as number) ??
        (Array.isArray(data.settings) ? data.settings.length : 0);
      ops.push({
        source: SOURCE,
        label: "settings",
        severity: "info",
        detail: `${count} effective settings`,
        fetchedAt,
        stale,
        degraded: false,
      });
    } else if ("activities" in data) {
      const count = (data.count as number) ??
        (Array.isArray(data.activities) ? data.activities.length : 0);
      const more = data.has_more === true ? " (more available)" : "";
      ops.push({
        source: SOURCE,
        label: "activity",
        severity: "info",
        detail: `${count} recent activities${more}`,
        fetchedAt,
        stale,
        degraded: false,
      });
    }
  }

  return { queue: [], ops, notes: [] };
}
