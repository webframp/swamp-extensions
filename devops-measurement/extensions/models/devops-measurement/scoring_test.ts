// Scoring model tests — the core subdomain, given the most scrutiny.
// SPDX-License-Identifier: Apache-2.0

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { DEFAULT_WEIGHTS } from "./_lib/event.ts";
import {
  calculateCrossBoundary,
  calculateMedianResponseHours,
  calculateUnblockRate,
  classifyTier,
  computeTrend,
  model,
  reachDepth,
  scoreAll,
} from "./scoring.ts";

const W = { ...DEFAULT_WEIGHTS };

function ev(
  userId: string,
  eventType:
    | "mr_review"
    | "mr_comment"
    | "commit"
    | "teams_message"
    | "redmine_comment"
    | "cloudtrail",
  sourceCrew: string,
  targetCrew: string,
  extra: Record<string, unknown> = {},
) {
  return {
    eventId: `${userId}-${eventType}-${sourceCrew}-${targetCrew}-${
      JSON.stringify(extra)
    }`,
    userId,
    username: userId,
    eventType,
    sourceCrew,
    targetCrew,
    targetUser: "",
    projectId: "1",
    timestamp: "2026-08-01T00:00:00Z",
    metadata: {},
    ...extra,
  };
}

Deno.test("cross-boundary ratio: weighted cross over weighted total", () => {
  // alice: 1 cross review (w3) + 1 same-crew commit (w4). cross=3, total=7.
  const events = [
    ev("alice", "mr_review", "a", "b"), // cross, w3
    ev("alice", "commit", "a", "a"), // same-crew, w4
  ];
  const r = calculateCrossBoundary("alice", events, W);
  assertEquals(r.crossBoundaryScore, 3);
  assertAlmostEquals(r.crossBoundaryRatio, 3 / 7, 1e-9);
  assertEquals(r.totalActivity, 2);
  assertEquals(r.crossCrewActivity, 1);
  assertEquals(r.crewReach, 1);
});

Deno.test("cross-boundary ratio is 0 when no activity", () => {
  const r = calculateCrossBoundary("ghost", [], W);
  assertEquals(r.crossBoundaryRatio, 0);
  assertEquals(r.totalActivity, 0);
});

Deno.test("crew reach counts distinct target crews; depth counts repeats", () => {
  const events = [
    ev("alice", "mr_review", "a", "b", { eventId: "1" }),
    ev("alice", "mr_review", "a", "b", { eventId: "2" }), // repeat to b
    ev("alice", "mr_review", "a", "c", { eventId: "3" }),
    ev("alice", "commit", "a", "d", { eventId: "4" }),
  ];
  const r = calculateCrossBoundary("alice", events, W);
  assertEquals(r.crewReach, 3); // b, c, d
  assertEquals(r.depth, 1); // b interacted with twice -> +1
});

Deno.test("reachDepth: repeats beyond the first add to depth", () => {
  assertEquals(reachDepth({ b: 3, c: 1, d: 2 }), { reach: 3, depth: 3 }); // (3-1)+(2-1)
});

Deno.test("unblock rate: fraction of reviews merged within 24h", () => {
  const events = [
    ev("alice", "mr_review", "a", "b", {
      eventId: "r1",
      timestamp: "2026-08-01T00:00:00Z",
      metadata: { mergedAt: "2026-08-01T06:00:00Z" }, // within 24h
    }),
    ev("alice", "mr_review", "a", "b", {
      eventId: "r2",
      timestamp: "2026-08-01T00:00:00Z",
      metadata: { mergedAt: "2026-08-05T00:00:00Z" }, // >24h
    }),
    ev("alice", "mr_review", "a", "b", {
      eventId: "r3",
      timestamp: "2026-08-01T00:00:00Z",
      metadata: { mergedAt: null }, // never merged
    }),
  ];
  assertAlmostEquals(calculateUnblockRate("alice", events), 1 / 3, 1e-9);
});

Deno.test("unblock rate is 0 with no reviews", () => {
  assertEquals(
    calculateUnblockRate("alice", [ev("alice", "commit", "a", "b")]),
    0,
  );
});

Deno.test("median response time in hours", () => {
  const events = [
    ev("alice", "redmine_comment", "a", "b", {
      eventId: "1",
      metadata: {
        taggedAt: "2026-08-01T00:00:00Z",
        respondedAt: "2026-08-01T02:00:00Z",
      },
    }), // 2h
    ev("alice", "redmine_comment", "a", "b", {
      eventId: "2",
      metadata: {
        taggedAt: "2026-08-01T00:00:00Z",
        respondedAt: "2026-08-01T06:00:00Z",
      },
    }), // 6h
  ];
  assertEquals(calculateMedianResponseHours("alice", events), 4); // median of 2,6
});

Deno.test("median response time is 0 with no response pairs", () => {
  assertEquals(
    calculateMedianResponseHours("alice", [ev("alice", "commit", "a", "b")]),
    0,
  );
});

Deno.test("tier: first match wins, Watch default", () => {
  const tiers = [
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
  ];
  // High ratio + centrality + unblock -> Tier 1
  assertEquals(
    classifyTier(
      {
        crossBoundaryRatio: 0.3,
        networkCentrality: 0.9,
        unblockRate: 0.8,
        crewReach: 5,
      },
      tiers,
    ),
    "Tier 1",
  );
  // Tier-1 ratio but no centrality -> falls to Tier 2 (needs reach>=3)
  assertEquals(
    classifyTier(
      {
        crossBoundaryRatio: 0.3,
        networkCentrality: 0,
        unblockRate: 0,
        crewReach: 4,
      },
      tiers,
    ),
    "Tier 2",
  );
  // Nothing matches -> Watch
  assertEquals(
    classifyTier(
      {
        crossBoundaryRatio: 0.05,
        networkCentrality: 0,
        unblockRate: 0,
        crewReach: 1,
      },
      tiers,
    ),
    "Watch",
  );
});

Deno.test("Go gap-2 reproduced: Tier 1 unreachable without centrality at score time", () => {
  // With centrality 0 at score time and Tier-1 requiring minCentralityPct 0.8,
  // even a strong cross-boundary contributor cannot reach Tier 1 in the scorer.
  // (The report join with graph centrality is what can lift them — faithful to
  // the design: centrality gates Tier 1.)
  const events = [
    ev("alice", "mr_review", "a", "b", {
      eventId: "r1",
      metadata: { mergedAt: "2026-08-01T01:00:00Z" },
      timestamp: "2026-08-01T00:00:00Z",
    }),
  ];
  const tiers = [
    {
      name: "Tier 1",
      minCrossBoundary: 0.25,
      minCentralityPct: 0.8,
      minUnblockRate: 0.7,
      minCrewReach: 0,
    },
    {
      name: "Tier 3",
      minCrossBoundary: 0,
      minCentralityPct: 0,
      minUnblockRate: 0,
      minCrewReach: 0,
    },
  ];
  const scores = scoreAll(events, W, tiers, "2026-09-01T00:00:00Z");
  assertEquals(scores.length, 1);
  assertEquals(scores[0].unblockRate, 1); // review merged within 24h
  assertEquals(scores[0].tier, "Tier 3"); // centrality 0 blocks Tier 1
});

Deno.test("scoreAll assigns crewId from the user's source crew", () => {
  const events = [
    ev("alice", "mr_review", "crew-alpha", "crew-beta"),
  ];
  const scores = scoreAll(events, W, [{
    name: "Tier 3",
    minCrossBoundary: 0,
    minCentralityPct: 0,
    minUnblockRate: 0,
    minCrewReach: 0,
  }], "2026-09-01T00:00:00Z");
  assertEquals(scores[0].crewId, "crew-alpha");
  assertEquals(scores[0].networkCentrality, 0); // DR-4: scorer never sets it
  assertEquals(scores[0].centralityRank, 0);
});

Deno.test("score method writes scores-current with tier counts", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.score.execute(
    {
      events: [ev("alice", "mr_review", "a", "b")],
      weights: {},
      tiers: [],
    },
    context as unknown as Parameters<typeof model.methods.score.execute>[1],
  );
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "scores");
  assertEquals(resources[0].name, "scores-current");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
});

Deno.test("score method merges partial weight overrides onto defaults", async () => {
  // A caller overrides ONLY `commit`. The unlisted `mr_review` must keep its
  // default weight (3), not fall to 0 — otherwise a partial override silently
  // zeroes every event type the caller did not mention.
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.score.execute(
    {
      events: [ev("alice", "mr_review", "crew-alpha", "crew-beta")],
      weights: { commit: 10 }, // partial override; mr_review omitted
      tiers: [],
    },
    context as unknown as Parameters<typeof model.methods.score.execute>[1],
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  const scores = data.scores as Array<Record<string, unknown>>;
  assertEquals(scores.length, 1);
  // mr_review still weighted (3), so the cross-boundary score is > 0.
  assertEquals((scores[0].crossBoundaryScore as number) > 0, true);
});

Deno.test("computeTrend flags rising, falling, steady, new, and gone", () => {
  const current = [
    {
      userId: "rise",
      username: "rise",
      crewId: "a",
      crossBoundaryRatio: 0.5,
      tier: "Tier 2",
    },
    {
      userId: "fall",
      username: "fall",
      crewId: "a",
      crossBoundaryRatio: 0.1,
      tier: "Tier 3",
    },
    {
      userId: "same",
      username: "same",
      crewId: "a",
      crossBoundaryRatio: 0.3,
      tier: "Tier 2",
    },
    {
      userId: "fresh",
      username: "fresh",
      crewId: "a",
      crossBoundaryRatio: 0.4,
      tier: "Tier 2",
    },
  ];
  const prior = [
    {
      userId: "rise",
      username: "rise",
      crewId: "a",
      crossBoundaryRatio: 0.2,
      tier: "Tier 3",
    },
    {
      userId: "fall",
      username: "fall",
      crewId: "a",
      crossBoundaryRatio: 0.5,
      tier: "Tier 2",
    },
    {
      userId: "same",
      username: "same",
      crewId: "a",
      crossBoundaryRatio: 0.31,
      tier: "Tier 2",
    },
    {
      userId: "left",
      username: "left",
      crewId: "a",
      crossBoundaryRatio: 0.6,
      tier: "Tier 1",
    },
  ];
  const t = computeTrend(current, prior, 0.05);
  const dir = (id: string) => t.find((x) => x.userId === id)!.direction;
  assertEquals(dir("rise"), "rising"); // 0.2 -> 0.5
  assertEquals(dir("fall"), "falling"); // 0.5 -> 0.1
  assertEquals(dir("same"), "steady"); // 0.31 -> 0.3 within threshold
  assertEquals(dir("fresh"), "new"); // no prior
  assertEquals(dir("left"), "gone"); // prior only
});

Deno.test("trend method writes trends-current with rising/falling counts", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.trend.execute(
    {
      current: [
        {
          userId: "a",
          username: "a",
          crewId: "x",
          crossBoundaryRatio: 0.5,
          tier: "Tier 2",
        },
      ],
      prior: [
        {
          userId: "a",
          username: "a",
          crewId: "x",
          crossBoundaryRatio: 0.1,
          tier: "Tier 3",
        },
      ],
      threshold: 0.05,
      windowLabel: "90d vs 6mo",
    },
    context as unknown as Parameters<typeof model.methods.trend.execute>[1],
  );
  const r = getWrittenResources();
  assertEquals(r[0].specName, "trends");
  assertEquals(r[0].name, "trends-current");
  const data = r[0].data as Record<string, unknown>;
  assertEquals(data.rising, 1);
});
