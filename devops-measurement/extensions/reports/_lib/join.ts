/**
 * Pure join + re-classify logic for the force-multiplier report.
 *
 * The scorer computes tiers with centrality 0 (DR-4). The graph model computes
 * centrality and rank. This module joins the two by userId, then RE-CLASSIFIES
 * tiers now that centrality is known — this is the step that can lift a strong
 * cross-boundary contributor into Tier 1 (centrality gates Tier 1, per the
 * design). Kept pure and separate so it is unit-testable and the report stays a
 * thin renderer.
 *
 * The tier policy itself (thresholds + classify logic) is NOT defined here: it
 * lives in ../../models/devops-measurement/_lib/tiers.ts, the single source of
 * truth the scorer model also imports, so the score-time and join-time passes
 * can never disagree. This module re-exports TierConfig / DEFAULT_TIERS /
 * classifyTier so the report and its tests keep a stable import surface.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

export {
  classifyTier,
  DEFAULT_TIERS,
  type TierConfig,
} from "../../models/devops-measurement/_lib/tiers.ts";
import {
  classifyTier,
  DEFAULT_TIERS,
  type TierConfig,
} from "../../models/devops-measurement/_lib/tiers.ts";

export interface Score {
  userId: string;
  username: string;
  crewId: string;
  crossBoundaryScore: number;
  crossBoundaryRatio: number;
  totalActivity: number;
  crossCrewActivity: number;
  crewReach: number;
  depth: number;
  unblockRate: number;
  avgResponseTimeHours: number;
  networkCentrality: number;
  centralityRank: number;
  tier: string;
}

export interface Centrality {
  userId: string;
  centrality: number;
  rank: number;
}

/**
 * Join scores with graph centrality by userId and re-classify tiers with the
 * now-known centrality. Returns scores enriched with networkCentrality,
 * centralityRank, and the final tier, sorted by cross-boundary ratio desc.
 */
export function joinAndClassify(
  scores: Score[],
  centrality: Centrality[],
  tiers: TierConfig[] = DEFAULT_TIERS,
): Score[] {
  const byUser = new Map<string, Centrality>();
  for (const c of centrality) byUser.set(c.userId, c);

  const enriched = scores.map((s) => {
    const c = byUser.get(s.userId);
    const withCentrality: Score = {
      ...s,
      networkCentrality: c?.centrality ?? 0,
      centralityRank: c?.rank ?? 0,
    };
    withCentrality.tier = classifyTier(withCentrality, tiers);
    return withCentrality;
  });

  enriched.sort((a, b) =>
    b.crossBoundaryRatio - a.crossBoundaryRatio ||
    a.username.localeCompare(b.username)
  );
  return enriched;
}
