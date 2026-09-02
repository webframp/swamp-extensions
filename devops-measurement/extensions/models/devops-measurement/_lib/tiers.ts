/**
 * Force-multiplier tier policy — the single source of truth.
 *
 * This is deliberate, load-bearing policy (faithful to the Go `config.yaml`):
 * the tier thresholds and the first-match-wins classification are applied at
 * two different times against the same rules —
 *
 *   1. score time, in `models/devops-measurement/scoring.ts`, with centrality 0
 *      (DR-4: the scorer does not know centrality yet), and
 *   2. join time, in `reports/_lib/join.ts`, after the interaction-graph model
 *      supplies centrality — the pass that can lift a strong contributor into
 *      Tier 1.
 *
 * Both passes MUST use identical thresholds and identical gate logic, or a
 * member's tier can differ between the score resource and the report. This
 * module exists so there is exactly one copy of the policy: the scoring model
 * imports it from its own `_lib` (`./tiers.ts`), and the report's join imports
 * it across the tree (`../../models/devops-measurement/_lib/tiers.ts`). swamp's
 * bundler inlines it into each entry point's bundle, so a threshold change here
 * changes both passes at once — it cannot drift.
 *
 * Kept dependency-free (no Zod): the report is Zod-free, and `classifyTier`
 * only reads the four gate fields, so it is typed structurally against any
 * score-like value the two callers pass.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** One tier's admission thresholds. A gate with value 0 is not enforced. */
export interface TierConfig {
  name: string;
  minCrossBoundary: number;
  minCentralityPct: number;
  minUnblockRate: number;
  minCrewReach: number;
}

/**
 * Default tiers, faithful to the Go `config.yaml`. Ordered most-selective
 * first; `classifyTier` returns the first tier a score satisfies.
 *
 * Tier 1 gates on centrality (`minCentralityPct` > 0), so it is unreachable at
 * score time (centrality 0) by construction — only the report's join pass, with
 * centrality known, can award it. This reproduces the Go behavior exactly.
 */
export const DEFAULT_TIERS: TierConfig[] = [
  {
    name: "Tier 1",
    minCrossBoundary: 0.25,
    minCentralityPct: 0.8,
    minUnblockRate: 0.7,
    minCrewReach: 0,
  },
  {
    name: "Tier 2",
    minCrossBoundary: 0.15,
    minCentralityPct: 0,
    minUnblockRate: 0,
    minCrewReach: 3,
  },
  {
    name: "Tier 3",
    minCrossBoundary: 0,
    minCentralityPct: 0,
    minUnblockRate: 0,
    minCrewReach: 0,
  },
];

/**
 * The four fields tier admission reads. Both the scorer's `ScoreForTier` and
 * the report's `Score` satisfy this structurally, so `classifyTier` works for
 * either without coupling this module to either's full score shape.
 */
export interface TierInputs {
  crossBoundaryRatio: number;
  networkCentrality: number;
  unblockRate: number;
  crewReach: number;
}

/** True when `score` clears every enforced gate of `tier` (0-gates are skipped). */
export function meetsTier(score: TierInputs, tier: TierConfig): boolean {
  if (score.crossBoundaryRatio < tier.minCrossBoundary) return false;
  if (
    tier.minCentralityPct > 0 && score.networkCentrality < tier.minCentralityPct
  ) {
    return false;
  }
  if (tier.minUnblockRate > 0 && score.unblockRate < tier.minUnblockRate) {
    return false;
  }
  if (tier.minCrewReach > 0 && score.crewReach < tier.minCrewReach) {
    return false;
  }
  return true;
}

/** First-match-wins over ordered `tiers`; "Watch" if a score clears none. */
export function classifyTier(score: TierInputs, tiers: TierConfig[]): string {
  for (const tier of tiers) {
    if (meetsTier(score, tier)) return tier.name;
  }
  return "Watch";
}
