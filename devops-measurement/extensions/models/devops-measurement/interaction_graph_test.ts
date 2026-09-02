// Interaction graph tests.
// SPDX-License-Identifier: Apache-2.0

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { build, model } from "./interaction_graph.ts";

function ev(
  eventId: string,
  userId: string,
  eventType: "mr_review" | "commit",
  sourceCrew: string,
  targetCrew: string,
  targetUser: string,
) {
  return {
    eventId,
    userId,
    username: userId,
    eventType,
    sourceCrew,
    targetCrew,
    targetUser,
    projectId: "1",
    timestamp: "2026-08-01T00:00:00Z",
    metadata: {},
  };
}

const REF = {
  members: [
    { username: "bob", crewId: "crew-beta" },
    { username: "carol", crewId: "crew-beta" },
  ],
};

// Like ev() but with an explicit projectId and any event type — for the
// inverse-bus-factor tests which key on distinct projects.
function cev(
  eventId: string,
  userId: string,
  eventType: "mr_review" | "commit" | "mr_comment",
  sourceCrew: string,
  targetCrew: string,
  targetUser: string,
  projectId: string,
) {
  return {
    eventId,
    userId,
    username: userId,
    eventType,
    sourceCrew,
    targetCrew,
    targetUser,
    projectId,
    timestamp: "2026-08-01T00:00:00Z",
    metadata: {},
  };
}

const OPTS = { hubThreshold: 3, bridgeThreshold: 2 };

Deno.test("review with targetUser makes a helper->helped edge", () => {
  const g = build(
    [ev(
      "1",
      "alice",
      "mr_review",
      "crew-alpha",
      "crew-beta",
      "bob",
    )],
    REF,
    OPTS,
  );
  assertEquals(g.edges.length, 1);
  assertEquals(g.edges[0].source, "alice");
  assertEquals(g.edges[0].target, "bob");
  assertEquals(g.edges[0].type, "mr_review");
});

Deno.test("same-crew activity forms no edge", () => {
  const g = build(
    [ev("1", "bob", "mr_review", "crew-beta", "crew-beta", "carol")],
    REF,
    OPTS,
  );
  assertEquals(g.edges.length, 0);
});

Deno.test("commit (no targetUser) fans out to target crew members", () => {
  // alice (crew-alpha) commits to crew-beta -> edges to bob and carol.
  const g = build(
    [ev("1", "alice", "commit", "crew-alpha", "crew-beta", "")],
    REF,
    OPTS,
  );
  const targets = g.edges.map((e) => e.target).sort();
  assertEquals(targets, ["bob", "carol"]);
});

Deno.test("in-degree centrality: a helper who helped more people ranks higher", () => {
  // Per the design's HELPED convention, "depend on you" = distinct people you
  // helped. alice helps bob AND carol (2); dave helps only bob (1). alice is
  // more central.
  const g = build(
    [
      ev(
        "1",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "bob",
      ),
      ev(
        "2",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "carol",
      ),
      ev("3", "dave", "mr_review", "crew-gamma", "crew-beta", "bob"),
    ],
    REF,
    OPTS,
  );
  const alice = g.centrality.find((c) => c.userId === "alice")!;
  const dave = g.centrality.find((c) => c.userId === "dave")!;
  assertEquals(alice.inDegree, 2); // helped 2 distinct people
  assertEquals(dave.inDegree, 1); // helped 1
  assertEquals(alice.inDegreeCentrality, 1); // normalized to max
  assertAlmostEquals(dave.inDegreeCentrality, 0.5, 1e-9);
  assertEquals(alice.centrality >= dave.centrality, true); // PageRank agrees
  assertEquals(alice.rank, 1); // most depended-on ranks 1
});

Deno.test("hub detection: in-degree >= threshold", () => {
  // A hub is depended on by many = helped many distinct people. alice helps
  // bob, carol, and dave -> in-degree 3 >= hubThreshold 3.
  const g = build(
    [
      ev(
        "1",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "bob",
      ),
      ev(
        "2",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "carol",
      ),
      ev(
        "3",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-gamma",
        "dave",
      ),
    ],
    REF,
    OPTS,
  );
  assertEquals(g.stats.hubs.includes("alice"), true);
});

Deno.test("bridge detection: helps members of >= threshold distinct crews", () => {
  // alice helps crew-beta and crew-gamma -> 2 distinct crews >= bridge 2.
  const g = build(
    [
      ev(
        "1",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "bob",
      ),
      ev(
        "2",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-gamma",
        "zoe",
      ),
    ],
    REF,
    OPTS,
  );
  assertEquals(g.stats.bridges.includes("alice"), true);
});

Deno.test("commit fan-out: committer's in-degree is distinct people helped, members not inflated", () => {
  // One alice commit to crew-beta (bob, carol, erin). Under the corrected HELPED
  // convention, alice (the helper) accrues in-degree = distinct people helped
  // (3); the crew members she helped accrue nothing from merely receiving help.
  // A single commit therefore contributes bounded, legitimate reach — not the
  // summed-weight inflation the earlier design flagged.
  const bigRef = {
    members: [
      { username: "bob", crewId: "crew-beta" },
      { username: "carol", crewId: "crew-beta" },
      { username: "erin", crewId: "crew-beta" },
    ],
  };
  const g = build(
    [ev("1", "alice", "commit", "crew-alpha", "crew-beta", "")],
    bigRef,
    OPTS,
  );
  const alice = g.centrality.find((x) => x.userId === "alice")!;
  assertEquals(alice.inDegree, 3); // helped 3 distinct people (legit reach)
  for (const member of ["bob", "carol", "erin"]) {
    const c = g.centrality.find((x) => x.userId === member)!;
    assertEquals(c.inDegree, 0); // receiving help does not inflate you
  }
});

Deno.test("pageRank: a helper many depend on outranks a peripheral one", () => {
  // alice helps bob AND carol (2 distinct); dave and erin each help only bob.
  // Per the design's HELPED convention (incoming edges = people you helped =
  // who depends on you), alice is the most central and tops the ranking.
  const g = build(
    [
      ev(
        "1",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "bob",
      ),
      ev("2", "dave", "mr_review", "crew-gamma", "crew-beta", "bob"),
      ev("3", "erin", "mr_review", "crew-delta", "crew-beta", "bob"),
      ev(
        "4",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "carol",
      ),
    ],
    {
      members: [{ username: "bob", crewId: "crew-beta" }, {
        username: "carol",
        crewId: "crew-beta",
      }],
    },
    OPTS,
  );
  const ranked = [...g.centrality].sort((a, b) => a.rank - b.rank);
  assertEquals(ranked[0].userId, "alice"); // helped the most people -> ranks 1
  const alice = g.centrality.find((c) => c.userId === "alice")!;
  const dave = g.centrality.find((c) => c.userId === "dave")!;
  assertEquals(alice.pageRank >= dave.pageRank, true);
  assertEquals(alice.pageRank > 0, true);
});

Deno.test("inverse bus factor: counts distinct systems a person backs up", () => {
  // alice commits to two crew-beta-owned projects (100, 200) and reviews a third
  // (300) — she is backup knowledge across 3 systems. Commits/reviews count;
  // a comment does not.
  const g = build(
    [
      cev(
        "c1",
        "alice",
        "commit",
        "crew-alpha",
        "crew-beta",
        "",
        "100",
      ),
      cev(
        "c2",
        "alice",
        "commit",
        "crew-alpha",
        "crew-beta",
        "",
        "200",
      ),
      cev(
        "r1",
        "alice",
        "mr_review",
        "crew-alpha",
        "crew-beta",
        "bob",
        "300",
      ),
      cev(
        "m1",
        "alice",
        "mr_comment",
        "crew-alpha",
        "crew-beta",
        "bob",
        "400",
      ),
    ],
    REF,
    OPTS,
  );
  const alice = g.centrality.find((c) => c.userId === "alice")!;
  assertEquals(alice.busFactorContribution, 3); // 100, 200, 300 — not the comment's 400
  const systems = g.stats.systemContributors.map((s) => s.projectId).sort();
  assertEquals(systems, ["100", "200", "300"]);
});

Deno.test("build method writes graph-current resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.build.execute(
    {
      events: [
        ev(
          "1",
          "alice",
          "mr_review",
          "crew-alpha",
          "crew-beta",
          "bob",
        ),
      ],
      crewReference: REF,
      hubThreshold: 3,
      bridgeThreshold: 3,
    },
    context as unknown as Parameters<typeof model.methods.build.execute>[1],
  );
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "graph");
  assertEquals(resources[0].name, "graph-current");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals((data.edges as unknown[]).length, 1);
});
