// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  classifyTier,
  DEFAULT_TIERS,
  meetsTier,
  type TierInputs,
} from "./tiers.ts";

function inputs(over: Partial<TierInputs>): TierInputs {
  return {
    crossBoundaryRatio: 0,
    networkCentrality: 0,
    unblockRate: 0,
    crewReach: 0,
    ...over,
  };
}

Deno.test("DEFAULT_TIERS matches the fixed Go config.yaml thresholds", () => {
  assertEquals(DEFAULT_TIERS, [
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
  ]);
});

Deno.test("classifyTier: first match wins, Watch is the default", () => {
  // Clears Tier 1 on every gate.
  assertEquals(
    classifyTier(
      inputs({
        crossBoundaryRatio: 0.3,
        networkCentrality: 0.9,
        unblockRate: 0.8,
      }),
      DEFAULT_TIERS,
    ),
    "Tier 1",
  );
  // Below every threshold → Watch.
  assertEquals(classifyTier(inputs({}), DEFAULT_TIERS), "Tier 3");
  assertEquals(
    classifyTier(inputs({ crossBoundaryRatio: -1 }), DEFAULT_TIERS),
    "Watch",
  );
});

Deno.test("Tier 1 is unreachable without centrality (DR-4 gap reproduced)", () => {
  // A strong contributor at score time (centrality 0) cannot reach Tier 1
  // because Tier 1 gates on minCentralityPct > 0.
  const scoreTime = inputs({
    crossBoundaryRatio: 0.9,
    networkCentrality: 0,
    unblockRate: 1,
  });
  assertEquals(classifyTier(scoreTime, DEFAULT_TIERS), "Tier 3");

  // The same contributor, once the graph supplies centrality, is lifted to
  // Tier 1 by the join pass.
  const joinTime = { ...scoreTime, networkCentrality: 0.85 };
  assertEquals(classifyTier(joinTime, DEFAULT_TIERS), "Tier 1");
});

Deno.test("meetsTier: a gate of 0 is not enforced", () => {
  // Tier 3 has all-zero gates → any non-negative ratio clears it.
  assertEquals(meetsTier(inputs({}), DEFAULT_TIERS[2]), true);
  // Tier 2 requires crewReach >= 3.
  assertEquals(
    meetsTier(
      inputs({ crossBoundaryRatio: 0.2, crewReach: 2 }),
      DEFAULT_TIERS[1],
    ),
    false,
  );
  assertEquals(
    meetsTier(
      inputs({ crossBoundaryRatio: 0.2, crewReach: 3 }),
      DEFAULT_TIERS[1],
    ),
    true,
  );
});
