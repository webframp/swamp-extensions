/**
 * Normalizer: @webframp/aws/ecr-observation -> OpsSignal[].
 *
 * The `survey` method writes one `fleet` resource per run:
 * `{ generatedAt, primaryRegion, probeRegions, profilesChecked, failedProfiles,
 *    accounts, aggregate, ... }`. The `aggregate` block carries the
 * fleet-wide hygiene rollup:
 * `{ totalRepos, standardRepos, exemptRepos, namingLandmines,
 *    reposWithoutLifecycle, accountsWithStrayRegionRepos,
 *    accountsWithReplication }`.
 *
 * The normalizer emits ONE hygiene signal from `aggregate`, warning when there
 * are ADR-011 naming violations (`namingLandmines`) or repos missing a
 * lifecycle policy. Per-account detail and account identifiers in `accounts`
 * are never surfaced (CLAUDE.md forbids exposing account IDs); only fleet-wide
 * counts are reported. A non-empty `failedProfiles` marks the signal degraded.
 *
 * Contract reference: `swamp model type describe @webframp/aws/ecr-observation --json`
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { freshness } from "../freshness.ts";
import type { Contribution, OpsSignal, SourceInput } from "../shapes.ts";

const SOURCE = "ecr";
const MAX_AGE_HOURS = 24;

interface EcrAggregate {
  totalRepos?: number;
  standardRepos?: number;
  exemptRepos?: number;
  namingLandmines?: number;
  reposWithoutLifecycle?: number;
  accountsWithStrayRegionRepos?: number;
  accountsWithReplication?: number;
}

/** Identify the `fleet` survey shape by its `aggregate` rollup object. */
function isFleetSurvey(data: Record<string, unknown>): boolean {
  return (
    typeof data.aggregate === "object" &&
    data.aggregate !== null &&
    typeof (data.aggregate as EcrAggregate).totalRepos === "number"
  );
}

export function ecrObservationNormalizer(inputs: SourceInput[]): Contribution {
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    if (!isFleetSurvey(data)) continue;

    // ECR survey stamps `generatedAt`, not `fetchedAt`.
    const fetchedAt = typeof data.generatedAt === "string"
      ? data.generatedAt
      : typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const failedProfiles = Array.isArray(data.failedProfiles)
      ? data.failedProfiles
      : [];
    const degraded = failedProfiles.length > 0;
    const degradedReason = degraded
      ? `${failedProfiles.length} accounts unreachable`
      : undefined;

    const agg = data.aggregate as EcrAggregate;
    const total = agg.totalRepos ?? 0;
    const landmines = agg.namingLandmines ?? 0;
    const noLifecycle = agg.reposWithoutLifecycle ?? 0;

    // Warn on real hygiene gaps: ADR-011 naming violations or repos without a
    // lifecycle policy (unbounded image growth). Otherwise nominal.
    const severity: "ok" | "warn" = landmines > 0 || noLifecycle > 0
      ? "warn"
      : "ok";

    const issues: string[] = [];
    if (landmines > 0) issues.push(`${landmines} naming violation(s)`);
    if (noLifecycle > 0) issues.push(`${noLifecycle} without lifecycle`);

    const detail = issues.length > 0
      ? `${issues.join(", ")} across ${total} repos`
      : `${total} repos, hygiene clean`;

    ops.push({
      source: SOURCE,
      label: "hygiene",
      severity,
      detail,
      fetchedAt,
      stale,
      degraded,
      degradedReason,
    });
  }

  if (ops.length === 0) {
    notes.push("ECR: no recognizable data shape in step output.");
  }

  return { queue: [], ops, notes };
}
