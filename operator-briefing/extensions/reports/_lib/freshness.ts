/**
 * Freshness helpers. The report — not the swamp engine — owns freshness: the
 * engine timestamps the artifact, but whether the underlying observed data is
 * stale is judged here from each source's own `fetchedAt`.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

export interface Freshness {
  /** True when the snapshot is older than `maxAgeHours` (or has no timestamp). */
  stale: boolean;
  /** Age in hours, or null when no valid timestamp is available. */
  ageHours: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Assess a source's freshness from its `fetchedAt` timestamp. A missing or
 * unparseable timestamp is treated as stale (we cannot prove it is fresh).
 */
export function freshness(
  fetchedAt: string | null | undefined,
  maxAgeHours: number,
): Freshness {
  if (!fetchedAt) return { stale: true, ageHours: null };
  const ms = new Date(fetchedAt).getTime();
  if (Number.isNaN(ms)) return { stale: true, ageHours: null };
  const ageHours = (Date.now() - ms) / HOUR_MS;
  return { stale: ageHours > maxAgeHours, ageHours };
}

/**
 * Whole-day age of an ISO timestamp. Returns 0 for missing or unparseable
 * input (matches the review_dashboard convention). A future timestamp clamps
 * to 0 ("today") rather than rendering a negative age.
 */
export function ageDays(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / DAY_MS));
}
