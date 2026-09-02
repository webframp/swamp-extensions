/**
 * Scoring model — the core subdomain.
 *
 * A fan-out factory and a pure function over the canonical aggregated event
 * set (wired in via CEL from the events model). One `score` execution produces
 * every member's UserScore, mirroring the Go `CalculateAll`.
 *
 * Faithful to the Go core (internal/scoring), and completing what the Go scorer
 * left unwired (the "intended system"):
 * - Cross-boundary: weighted score, ratio (cross/total weighted), cross-crew
 *   count, crew reach. Weights preserved EXACTLY as core policy.
 * - Force-multiplier: unblock rate (from review metadata), median response time
 *   (stored as HOURS, a float — resolving the Go float64-vs-Duration ambiguity),
 *   reach AND depth (adding the depth the Go UserScore never had).
 * - Tiers: ordered thresholds, first-match-wins, Watch default.
 *
 * Does NOT set centralityRank (DR-4): centrality and rank are computed in the
 * interaction-graph model; the report joins score + centrality.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import {
  DEFAULT_WEIGHTS,
  type Event,
  EventSchema,
  isCrossBoundary,
} from "./_lib/event.ts";
import { classifyTier, DEFAULT_TIERS, type TierConfig } from "./_lib/tiers.ts";

// Re-exported so the scorer's tier classification stays part of this module's
// public test surface even though the implementation is shared.
export { classifyTier };

const EXTENSION_NAME = "@webframp/devops-measurement";

// =============================================================================
// Schemas
// =============================================================================

const TierConfigSchema = z.object({
  name: z.string(),
  minCrossBoundary: z.number().default(0),
  minCentralityPct: z.number().default(0),
  minUnblockRate: z.number().default(0),
  minCrewReach: z.number().int().default(0),
});

// DEFAULT_TIERS and the classify/meets logic live in ./_lib/tiers.ts — the
// single source of truth the report (reports/_lib/join.ts) also imports.
// TierConfigSchema above stays local: it validates a caller-supplied `tiers`
// arg (Zod parsing), and its inferred shape is structurally identical to the
// shared TierConfig.

const UserScoreSchema = z.object({
  userId: z.string(),
  username: z.string(),
  crewId: z.string(),
  crossBoundaryScore: z.number().describe(
    "Weighted sum of cross-boundary activity",
  ),
  crossBoundaryRatio: z.number().describe(
    "Cross-boundary / total weighted [0,1]",
  ),
  totalActivity: z.number().int().describe("Raw event count (unweighted)"),
  crossCrewActivity: z.number().int().describe(
    "Raw cross-boundary event count",
  ),
  crewReach: z.number().int().describe("Distinct target crews helped"),
  depth: z.number().int().describe(
    "Repeat-interaction volume (sum of count-1 over crews helped >1 time)",
  ),
  unblockRate: z.number().describe(
    "Fraction of reviews merged within 24h [0,1]",
  ),
  avgResponseTimeHours: z.number().describe(
    "Median response time in hours (0 when no response pairs)",
  ),
  // Centrality fields are populated by the report join from the graph model,
  // NOT by this scorer (DR-4). Present in the schema as the canonical score
  // shape, defaulted to 0 here.
  networkCentrality: z.number().default(0).describe(
    "Populated by the interaction-graph model, not the scorer (DR-4)",
  ),
  centralityRank: z.number().int().default(0).describe(
    "Populated by the interaction-graph model, not the scorer (DR-4)",
  ),
  tier: z.string().describe("Tier classification (Tier 1/2/3 or Watch)"),
  calculatedAt: z.string(),
});

const ScoresSchema = z.object({
  scores: z.array(UserScoreSchema).describe("Per-member scores"),
  count: z.number(),
  tierCounts: z.record(z.string(), z.number()).describe("Members per tier"),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const GlobalArgsSchema = z.object({});

// =============================================================================
// Cross-boundary scoring (faithful to internal/scoring/crossboundary.go)
// =============================================================================

/** Per-event-type weights applied when scoring cross-boundary activity. */
export type Weights = Record<string, number>;

/** The per-user output of `calculateCrossBoundary`: raw and ratio scores, activity totals, reach, and per-crew interaction counts. */
export type CrossBoundaryResult = {
  crossBoundaryScore: number;
  crossBoundaryRatio: number;
  totalActivity: number;
  crossCrewActivity: number;
  crewReach: number;
  depth: number;
  /** per-target-crew interaction counts, for depth/reach-depth */
  crewInteractions: Record<string, number>;
};

/** Score one user's cross-boundary activity from their events. */
export function calculateCrossBoundary(
  userId: string,
  events: Event[],
  weights: Weights,
): CrossBoundaryResult {
  let totalScore = 0;
  let crossScore = 0;
  let crossCount = 0;
  let totalActivity = 0;
  const crewInteractions: Record<string, number> = {};

  for (const e of events) {
    if (e.userId !== userId) continue;
    totalActivity++;
    const w = weights[e.eventType] ?? 0;
    totalScore += w;
    if (isCrossBoundary(e.sourceCrew, e.targetCrew)) {
      crossScore += w;
      crossCount++;
      crewInteractions[e.targetCrew] = (crewInteractions[e.targetCrew] ?? 0) +
        1;
    }
  }

  const ratio = totalScore > 0 ? crossScore / totalScore : 0;
  const { reach, depth } = reachDepth(crewInteractions);

  return {
    crossBoundaryScore: crossScore,
    crossBoundaryRatio: ratio,
    totalActivity,
    crossCrewActivity: crossCount,
    crewReach: reach,
    depth,
    crewInteractions,
  };
}

/**
 * Reach and depth from per-crew interaction counts (internal/scoring/
 * multiplier.go CalculateReachDepth). Reach = distinct crews; depth = repeat
 * volume (sum of count-1 for crews interacted with more than once).
 */
export function reachDepth(
  interactions: Record<string, number>,
): { reach: number; depth: number } {
  let depth = 0;
  for (const count of Object.values(interactions)) {
    if (count > 1) depth += count - 1;
  }
  return { reach: Object.keys(interactions).length, depth };
}

// =============================================================================
// Force-multiplier metrics (internal/scoring/multiplier.go), now WIRED IN
// =============================================================================

/**
 * Unblock rate: fraction of a user's reviews whose MR merged within 24h of the
 * review. Reviews are mr_review events; the paired merge timestamp rides in
 * event.metadata.mergedAt (collected via the @webframp/gitlab mergedAt field).
 */
export function calculateUnblockRate(userId: string, events: Event[]): number {
  let reviews = 0;
  let unblocked = 0;
  for (const e of events) {
    if (e.userId !== userId || e.eventType !== "mr_review") continue;
    reviews++;
    const merged = e.metadata?.mergedAt;
    if (typeof merged === "string" && merged !== "") {
      const reviewedMs = Date.parse(e.timestamp);
      const mergedMs = Date.parse(merged);
      if (
        !Number.isNaN(reviewedMs) && !Number.isNaN(mergedMs) &&
        mergedMs - reviewedMs <= 24 * 3600_000 &&
        mergedMs - reviewedMs >= 0
      ) {
        unblocked++;
      }
    }
  }
  return reviews > 0 ? unblocked / reviews : 0;
}

/**
 * Median response time in HOURS. Response pairs ride in event.metadata as
 * { taggedAt, respondedAt } ISO strings when a collector can derive them
 * (e.g. Redmine first-response). Returns 0 when there are no pairs.
 * Resolves the Go float64-vs-Duration ambiguity by fixing the unit to hours.
 */
export function calculateMedianResponseHours(
  userId: string,
  events: Event[],
): number {
  const durationsHrs: number[] = [];
  for (const e of events) {
    if (e.userId !== userId) continue;
    const tagged = e.metadata?.taggedAt;
    const responded = e.metadata?.respondedAt;
    if (typeof tagged === "string" && typeof responded === "string") {
      const t = Date.parse(tagged);
      const r = Date.parse(responded);
      if (!Number.isNaN(t) && !Number.isNaN(r) && r >= t) {
        durationsHrs.push((r - t) / 3600_000);
      }
    }
  }
  if (durationsHrs.length === 0) return 0;
  durationsHrs.sort((a, b) => a - b);
  const mid = Math.floor(durationsHrs.length / 2);
  return durationsHrs.length % 2 === 0
    ? (durationsHrs[mid - 1] + durationsHrs[mid]) / 2
    : durationsHrs[mid];
}

// =============================================================================
// Tier classification (internal/scoring/tiers.go)
// =============================================================================
//
// classifyTier / meetsTier now live in ../../_shared/tiers.ts (the single
// source of truth shared with the report). The scorer imports classifyTier and
// passes each user's four tier-input fields; the shared TierInputs type accepts
// them structurally.

// =============================================================================
// Score-all (the fan-out factory core)
// =============================================================================

/** A fully scored user: identity, crew, cross-boundary metrics, tier, and force-multiplier flag. */
export type ScoredUser = z.infer<typeof UserScoreSchema>;

/**
 * Score every distinct user in the event set. `crewOf` resolves a user's own
 * crew for the score's crewId (the source crew they act from). Centrality is
 * left at 0 here; tiers are evaluated with centrality 0, so a tier requiring
 * centrality is only reachable after the report join — matching the Go behavior
 * where centrality gates Tier 1.
 */
export function scoreAll(
  events: Event[],
  weights: Weights,
  tiers: TierConfig[],
  nowIso: string,
): ScoredUser[] {
  const userIds = new Set<string>();
  const usernameOf = new Map<string, string>();
  const crewOf = new Map<string, string>();
  for (const e of events) {
    userIds.add(e.userId);
    if (!usernameOf.has(e.userId)) usernameOf.set(e.userId, e.username);
    // A user's own crew is the source crew they act from; first non-empty wins.
    if (e.sourceCrew !== "" && !crewOf.has(e.userId)) {
      crewOf.set(e.userId, e.sourceCrew);
    }
  }

  const scores: ScoredUser[] = [];
  for (const userId of userIds) {
    const cb = calculateCrossBoundary(userId, events, weights);
    const unblockRate = calculateUnblockRate(userId, events);
    const avgResponseTimeHours = calculateMedianResponseHours(userId, events);

    const base = {
      crossBoundaryRatio: cb.crossBoundaryRatio,
      networkCentrality: 0,
      unblockRate,
      crewReach: cb.crewReach,
    };

    scores.push({
      userId,
      username: usernameOf.get(userId) ?? userId,
      crewId: crewOf.get(userId) ?? "",
      crossBoundaryScore: cb.crossBoundaryScore,
      crossBoundaryRatio: cb.crossBoundaryRatio,
      totalActivity: cb.totalActivity,
      crossCrewActivity: cb.crossCrewActivity,
      crewReach: cb.crewReach,
      depth: cb.depth,
      unblockRate,
      avgResponseTimeHours,
      networkCentrality: 0,
      centralityRank: 0,
      tier: classifyTier(base, tiers),
      calculatedAt: nowIso,
    });
  }
  return scores;
}

// =============================================================================
// Trend (six-month comparison) — the design's "emerging vs. declining" signal
// =============================================================================

const TrendSchema = z.object({
  userId: z.string(),
  username: z.string(),
  crewId: z.string(),
  currentRatio: z.number(),
  priorRatio: z.number(),
  ratioDelta: z.number().describe("current - prior cross-boundary ratio"),
  currentTier: z.string(),
  priorTier: z.string(),
  direction: z.enum(["rising", "falling", "steady", "new", "gone"]).describe(
    "rising/falling if |ratioDelta| exceeds the threshold; new = no prior; " +
      "gone = scored before, absent now",
  ),
});

const TrendReportSchema = z.object({
  trends: z.array(TrendSchema),
  count: z.number(),
  rising: z.number(),
  falling: z.number(),
  windowLabel: z.string().describe("Human label for the comparison window"),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

/** A minimal prior-score shape — only what trend needs from an older run. */
const PriorScoreSchema = z.object({
  userId: z.string(),
  username: z.string().default(""),
  crewId: z.string().default(""),
  crossBoundaryRatio: z.number().default(0),
  tier: z.string().default("Watch"),
});

/** A prior period's score for a user, the baseline `computeTrend` compares against. */
export type PriorScore = z.infer<typeof PriorScoreSchema>;
/** The six-month trend for a user: direction and delta of their cross-boundary score. */
export type Trend = z.infer<typeof TrendSchema>;

/**
 * Compute per-member trend between a prior scoring run and the current one.
 * Pure and exported. `threshold` is the minimum absolute ratio change to be
 * called rising/falling rather than steady. A member present now but not in the
 * prior set is "new"; present before but absent now is "gone".
 *
 * The history this compares against is swamp's own versioned data: each `score`
 * run writes a new version of scores-current, so a caller wires a prior version
 * (e.g. ~6 months ago) as `prior` and the latest as `current`.
 */
export function computeTrend(
  current: {
    userId: string;
    username: string;
    crewId: string;
    crossBoundaryRatio: number;
    tier: string;
  }[],
  prior: PriorScore[],
  threshold = 0.05,
): Trend[] {
  const priorBy = new Map<string, PriorScore>();
  for (const p of prior) priorBy.set(p.userId, p);
  const currentIds = new Set(current.map((c) => c.userId));

  const trends: Trend[] = [];
  for (const c of current) {
    const p = priorBy.get(c.userId);
    const priorRatio = p?.crossBoundaryRatio ?? 0;
    const ratioDelta = c.crossBoundaryRatio - priorRatio;
    let direction: Trend["direction"];
    if (!p) direction = "new";
    else if (ratioDelta > threshold) direction = "rising";
    else if (ratioDelta < -threshold) direction = "falling";
    else direction = "steady";
    trends.push({
      userId: c.userId,
      username: c.username,
      crewId: c.crewId,
      currentRatio: c.crossBoundaryRatio,
      priorRatio,
      ratioDelta,
      currentTier: c.tier,
      priorTier: p?.tier ?? "—",
      direction,
    });
  }
  // People who were scored before but have no current activity: gone.
  for (const p of prior) {
    if (!currentIds.has(p.userId)) {
      trends.push({
        userId: p.userId,
        username: p.username,
        crewId: p.crewId,
        currentRatio: 0,
        priorRatio: p.crossBoundaryRatio,
        ratioDelta: -p.crossBoundaryRatio,
        currentTier: "—",
        priorTier: p.tier,
        direction: "gone",
      });
    }
  }
  return trends;
}

// =============================================================================
// Context + model
// =============================================================================

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Scoring model — cross-boundary + force-multiplier scoring, tier classification. */
export const model = {
  type: "@webframp/devops-measurement/scoring",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    scores: {
      description: "Per-member cross-boundary + force-multiplier scores",
      schema: ScoresSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    trends: {
      description:
        "Per-member trend (current vs. a prior scoring run): rising/falling " +
        "cross-boundary contributors over time",
      schema: TrendReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    score: {
      description:
        "Score every member from the canonical aggregated event set (wired " +
        "in via CEL). Computes cross-boundary ratio/reach/cross-count, depth, " +
        "unblock rate, median response time (hours), and tier. Does NOT set " +
        "centrality/rank — those are joined from the interaction-graph model.",
      arguments: z.object({
        events: z.array(EventSchema).default([]).describe(
          "Canonical windowed events (data.latest of the events model)",
        ),
        weights: z.record(z.string(), z.number()).default({}).describe(
          "Optional event-type weight overrides; defaults to core policy",
        ),
        tiers: z.array(TierConfigSchema).default([]).describe(
          "Optional tier definitions; defaults to the core policy tiers",
        ),
      }),
      execute: async (
        args: {
          events: Event[];
          weights: Record<string, number>;
          tiers: z.infer<typeof TierConfigSchema>[];
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        // Merge overrides ONTO the defaults so a partial override (e.g. just
        // `commit`) does not zero out the unlisted event types. The description
        // promises "overrides", not "replace the whole map".
        const weights = { ...DEFAULT_WEIGHTS, ...args.weights };
        const tiers = args.tiers.length > 0 ? args.tiers : DEFAULT_TIERS;
        const nowIso = new Date().toISOString();

        const scores = scoreAll(args.events, weights, tiers, nowIso);

        const tierCounts: Record<string, number> = {};
        for (const s of scores) {
          tierCounts[s.tier] = (tierCounts[s.tier] ?? 0) + 1;
        }

        const handle = await context.writeResource("scores", "scores-current", {
          scores,
          count: scores.length,
          tierCounts,
          fetchedAt: nowIso,
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        context.logger.info(
          "Scored {count} members; tiers: {tiers}",
          { count: scores.length, tiers: JSON.stringify(tierCounts) },
        );

        return { dataHandles: [handle] };
      },
    },

    trend: {
      description:
        "Compute per-member trend between a prior scoring run and the current " +
        "one — the design's emerging-vs-declining signal. Wire `current` and " +
        "`prior` via CEL from two scores-current versions (e.g. latest and a " +
        "~6-month-old version). A member rising/falling by more than the " +
        "threshold is flagged; new/gone members are surfaced too.",
      arguments: z.object({
        current: z.array(PriorScoreSchema).default([]).describe(
          "Current per-member scores (from the latest scores-current)",
        ),
        prior: z.array(PriorScoreSchema).default([]).describe(
          "Prior per-member scores (from an older scores-current version)",
        ),
        threshold: z.number().default(0.05).describe(
          "Minimum |ratio change| to be called rising/falling vs. steady",
        ),
        windowLabel: z.string().default("current vs. prior").describe(
          "Human label for the comparison window (e.g. '90d vs 6mo ago')",
        ),
      }),
      execute: async (
        args: {
          current: PriorScore[];
          prior: PriorScore[];
          threshold: number;
          windowLabel: string;
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const trends = computeTrend(args.current, args.prior, args.threshold);
        const rising = trends.filter((t) => t.direction === "rising").length;
        const falling = trends.filter((t) => t.direction === "falling").length;

        const handle = await context.writeResource("trends", "trends-current", {
          trends,
          count: trends.length,
          rising,
          falling,
          windowLabel: args.windowLabel,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        context.logger.info(
          "Trend computed: {count} members ({rising} rising, {falling} falling)",
          { count: trends.length, rising, falling },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
