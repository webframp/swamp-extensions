// Force-multiplier report tests — join/classify logic and rendering.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { DEFAULT_TIERS, joinAndClassify, type Score } from "./_lib/join.ts";
import { renderMarkdown, report } from "./force_multiplier_report.ts";

function score(over: Partial<Score>): Score {
  return {
    userId: "alice",
    username: "alice",
    crewId: "crew-alpha",
    crossBoundaryScore: 3,
    crossBoundaryRatio: 0.3,
    totalActivity: 5,
    crossCrewActivity: 2,
    crewReach: 2,
    depth: 1,
    unblockRate: 0.8,
    avgResponseTimeHours: 2,
    networkCentrality: 0,
    centralityRank: 0,
    tier: "Tier 3",
    ...over,
  };
}

Deno.test("DR-4 join: centrality lifts a strong contributor into Tier 1", () => {
  // Scorer produced Tier 3 (centrality 0). With high centrality from the graph,
  // the join re-classifies to Tier 1 — the headline behavior.
  const scores = [
    score({ crossBoundaryRatio: 0.3, unblockRate: 0.8, tier: "Tier 3" }),
  ];
  const centrality = [{ userId: "alice", centrality: 0.9, rank: 1 }];
  const out = joinAndClassify(scores, centrality, DEFAULT_TIERS);
  assertEquals(out[0].networkCentrality, 0.9);
  assertEquals(out[0].centralityRank, 1);
  assertEquals(out[0].tier, "Tier 1");
});

Deno.test("join: without centrality, strong contributor stays below Tier 1", () => {
  const scores = [
    score({ crossBoundaryRatio: 0.3, unblockRate: 0.8, crewReach: 4 }),
  ];
  const out = joinAndClassify(scores, [], DEFAULT_TIERS);
  assertEquals(out[0].networkCentrality, 0);
  // ratio>=0.15 and reach>=3 -> Tier 2
  assertEquals(out[0].tier, "Tier 2");
});

Deno.test("join sorts by cross-boundary ratio descending", () => {
  const scores = [
    score({ userId: "a", username: "a", crossBoundaryRatio: 0.1 }),
    score({ userId: "b", username: "b", crossBoundaryRatio: 0.5 }),
  ];
  const out = joinAndClassify(scores, [], DEFAULT_TIERS);
  assertEquals(out.map((s) => s.username), ["b", "a"]);
});

Deno.test("renderMarkdown produces a tier summary and member table", () => {
  const out = joinAndClassify(
    [score({ crossBoundaryRatio: 0.3, unblockRate: 0.8 })],
    [{ userId: "alice", centrality: 0.9, rank: 1 }],
    DEFAULT_TIERS,
  );
  const md = renderMarkdown(out, { hubs: ["alice"], bridges: [] }, null);
  assertStringIncludes(md, "# DevOps Force-Multiplier Report");
  assertStringIncludes(md, "Tier 1");
  assertStringIncludes(md, "| alice |");
  assertStringIncludes(md, "Hubs");
});

Deno.test("renderMarkdown shows a degraded banner when reason present", () => {
  const md = renderMarkdown([], null, "no scoring data in this workflow run");
  assertStringIncludes(md, "⚠️ Degraded");
});

Deno.test("renderMarkdown shows a resilience section flagging single-contributor systems", () => {
  const out = joinAndClassify(
    [score({ crossBoundaryRatio: 0.3 })],
    [{ userId: "alice", centrality: 0.9, rank: 1 }],
    DEFAULT_TIERS,
  );
  const md = renderMarkdown(
    out,
    {
      hubs: [],
      bridges: [],
      systemContributors: [
        {
          projectId: "100",
          ownerCrew: "crew-beta",
          externalContributors: ["alice", "dave"],
        },
        {
          projectId: "200",
          ownerCrew: "crew-gamma",
          externalContributors: ["alice"],
        },
      ],
    },
    null,
  );
  assertStringIncludes(md, "Resilience");
  assertStringIncludes(md, "| 100 |");
  assertStringIncludes(md, "⚠️"); // project 200 has a single external contributor
});

Deno.test("report degrades (never throws) on missing steps", async () => {
  const result = await report.execute({
    workflowName: "measure",
    stepExecutions: [],
    dataRepository: {
      getContent: () => Promise.resolve(null),
    },
  });
  assertEquals(result.json.degraded, true);
  assertStringIncludes(result.markdown, "Degraded");
});

Deno.test("report joins scoring + graph steps into a tier table", async () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const scoringData = {
    scores: [
      score({ crossBoundaryRatio: 0.3, unblockRate: 0.8, tier: "Tier 3" }),
    ],
  };
  const graphData = {
    centrality: [{ userId: "alice", centrality: 0.9, rank: 1 }],
    stats: { hubs: ["alice"], bridges: [] },
  };
  const result = await report.execute({
    workflowName: "measure",
    stepExecutions: [
      {
        modelType: "@webframp/devops-measurement/scoring",
        modelId: "scoring",
        dataHandles: [{ name: "scores-current", version: 1 }],
      },
      {
        modelType: "@webframp/devops-measurement/interaction-graph",
        modelId: "interaction-graph",
        dataHandles: [{ name: "graph-current", version: 1 }],
      },
    ],
    dataRepository: {
      getContent: (_t, modelId) =>
        Promise.resolve(
          modelId === "scoring" ? enc(scoringData) : enc(graphData),
        ),
    },
  });
  assertEquals(result.json.degraded, false);
  const members = result.json.members as Score[];
  assertEquals(members[0].tier, "Tier 1"); // lifted by centrality
  assertEquals((result.json.tierCounts as Record<string, number>)["Tier 1"], 1);
});
