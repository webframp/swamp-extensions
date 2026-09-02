/**
 * Interaction graph model — the Network Analysis context, swamp-native.
 *
 * Realizes the Go Neo4j graph concept as versioned swamp data, following the
 * @webframp/aws/event-topology pattern: a graph resource of nodes and edges
 * plus computed stats, built and analyzed in the data layer — no external graph
 * database.
 *
 * The domain question (domain-and-subdomains.md): who helps whom, and who is a
 * hub (many depend on them) or a bridge (connects crews that otherwise never
 * interact). The quantitative expression is centrality — computed here as
 * PageRank over the HELPED graph (a pure power-method, no external graph
 * database), with normalized in-degree as the documented fallback when the
 * graph has no edges. In-degree, not out-degree: the HELPED arrow points toward
 * the helper, so many incoming edges means many people depend on you.
 *
 * Edges are driven by ALL cross-boundary activity (reviews, comments, commits),
 * departing from the Go code that only edged targetUser-bearing events —
 * centrality reflects help broadly (agreed with Sean). An event with a
 * targetUser makes a helper→targetUser edge; a cross-boundary event without one
 * (a commit) makes helper→(each member of the target crew) edges.
 *
 * DR-4: this model computes centrality AND centralityRank. The scorer does not.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { type Event, EventSchema, isCrossBoundary } from "./_lib/event.ts";

const EXTENSION_NAME = "@webframp/devops-measurement";

// =============================================================================
// Schemas
// =============================================================================

const NodeSchema = z.object({
  id: z.string().describe("Person id (userId)"),
  username: z.string(),
  crew: z.string().describe("The person's crew"),
});

const EdgeSchema = z.object({
  source: z.string().describe("Helper (the person who helped)"),
  target: z.string().describe("Helped (the person who received help)"),
  type: z.string().describe("Event type that produced this edge"),
  weight: z.number().int().describe("Number of interactions of this type"),
});

const CentralitySchema = z.object({
  userId: z.string(),
  username: z.string(),
  crew: z.string(),
  inDegree: z.number().int().describe(
    "Count of DISTINCT people who helped this person (distinct incoming helpers)",
  ),
  centrality: z.number().describe(
    "Primary centrality [0,1]: PageRank (normalized to max) when the graph has " +
      "edges, else normalized in-degree. This is the value tiers/report use.",
  ),
  pageRank: z.number().describe(
    "Normalized PageRank score [0,1] (power method over HELPED edges)",
  ),
  inDegreeCentrality: z.number().describe(
    "Normalized in-degree centrality [0,1] — the documented fallback, always " +
      "computed so both signals are available.",
  ),
  rank: z.number().int().describe("1-based rank by centrality (1 = highest)"),
  busFactorContribution: z.number().int().describe(
    "Inverse bus factor: how many distinct systems (projects) this person is a " +
      "backup contributor to — i.e. has cross-crew history in, outside the " +
      "owning crew. High = a resilience builder spread across many systems.",
  ),
});

const SystemContributorsSchema = z.object({
  projectId: z.string().describe("Target project (system)"),
  ownerCrew: z.string().describe("Crew that owns the system"),
  externalContributors: z.array(z.string()).describe(
    "Distinct people outside the owning crew with cross-crew history here",
  ),
});

const StatsSchema = z.object({
  totalNodes: z.number().int(),
  totalEdges: z.number().int(),
  maxInDegree: z.number().int(),
  hubs: z.array(z.string()).describe("Nodes with in-degree >= hub threshold"),
  bridges: z.array(z.string()).describe(
    "Nodes helping members of >= bridge-threshold distinct crews",
  ),
  systemContributors: z.array(SystemContributorsSchema).describe(
    "Per-system (project) external-contributor lists — the inverse-bus-factor " +
      "resilience view: who provides backup knowledge to each system",
  ),
});

const GraphSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  centrality: z.array(CentralitySchema).describe(
    "Per-person centrality and rank (DR-4: computed here, joined by the report)",
  ),
  stats: StatsSchema,
  builtAt: z.string(),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const CrewReferenceSchema = z.object({
  members: z.array(z.object({ username: z.string(), crewId: z.string() }))
    .default([]),
});

const GlobalArgsSchema = z.object({});

// =============================================================================
// Graph construction (event-topology pattern), pure + exported
// =============================================================================

type Ref = z.infer<typeof CrewReferenceSchema>;
type Node = z.infer<typeof NodeSchema>;
type Edge = z.infer<typeof EdgeSchema>;
type Centrality = z.infer<typeof CentralitySchema>;

type EdgeKey = string; // `${source}\u0000${target}\u0000${type}`

/** The result of `build`: the HELPED graph's nodes and edges, per-node centrality, and summary stats. */
export type BuildResult = {
  nodes: Node[];
  edges: Edge[];
  centrality: Centrality[];
  stats: z.infer<typeof StatsSchema>;
};

/**
 * PageRank over the HELPED graph via the power method — a pure-TS realization of
 * the design's "PageRank (GDS) or in-degree fallback", with NO external graph
 * database. The HELPED arrow points helper←helped (edge.source = helper,
 * edge.target = helped... see build()), so to measure HELPER importance —
 * "rank flows toward the people many depend on" — we walk edges from helped to
 * helper. Standard damping 0.85, dangling-mass redistribution, fixed iterations
 * with an early-exit on convergence. Returns raw scores summing to ~1.
 */
export function pageRank(
  nodeIds: string[],
  edges: Edge[],
  opts: { damping?: number; iterations?: number; tolerance?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.iterations ?? 100;
  const tol = opts.tolerance ?? 1e-8;
  const n = nodeIds.length;
  const scores = new Map<string, number>();
  if (n === 0) return scores;
  for (const id of nodeIds) scores.set(id, 1 / n);

  // Rank flows toward helpers: an edge helped(target) -> helper(source) means
  // the helped person's rank contributes to the helper. Build out-links keyed
  // by the helped node, pointing at the helpers they depend on.
  const outLinks = new Map<string, string[]>();
  for (const id of nodeIds) outLinks.set(id, []);
  for (const e of edges) {
    // e.source helped e.target; the helped (e.target) depends on the helper
    // (e.source), so rank flows target -> source.
    (outLinks.get(e.target) ?? []).push(e.source);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map<string, number>();
    for (const id of nodeIds) next.set(id, (1 - damping) / n);

    let danglingMass = 0;
    for (const id of nodeIds) {
      const outs = outLinks.get(id) ?? [];
      const rank = scores.get(id) ?? 0;
      if (outs.length === 0) {
        danglingMass += rank; // node depends on no one — redistribute evenly
      } else {
        const share = (damping * rank) / outs.length;
        for (const target of outs) {
          next.set(target, (next.get(target) ?? 0) + share);
        }
      }
    }
    // Redistribute dangling mass evenly across all nodes.
    const spread = (damping * danglingMass) / n;
    if (spread > 0) {
      for (const id of nodeIds) next.set(id, (next.get(id) ?? 0) + spread);
    }

    let delta = 0;
    for (const id of nodeIds) {
      delta += Math.abs((next.get(id) ?? 0) - (scores.get(id) ?? 0));
      scores.set(id, next.get(id) ?? 0);
    }
    if (delta < tol) break;
  }
  return scores;
}

/**
 * Build the interaction graph from events. `hubThreshold` and `bridgeThreshold`
 * tune hub/bridge detection. Pure and exported for testing.
 */
export function build(
  events: Event[],
  ref: Ref,
  opts: { hubThreshold: number; bridgeThreshold: number },
): BuildResult {
  // Crew membership: crew -> usernames, for fanning commit edges to a crew.
  const crewMembers = new Map<string, string[]>();
  const crewOfUser = new Map<string, string>();
  for (const m of ref.members) {
    crewOfUser.set(m.username, m.crewId);
    const list = crewMembers.get(m.crewId) ?? [];
    list.push(m.username);
    crewMembers.set(m.crewId, list);
  }

  const nodes = new Map<string, Node>();
  const addNode = (id: string, username: string, crew: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, username, crew });
  };

  // Aggregate edges by (source, target, type).
  const edgeCounts = new Map<EdgeKey, number>();
  // Track, per helper, the distinct crews they helped — for bridge detection.
  const helperCrews = new Map<string, Set<string>>();
  // Inverse bus factor: per target project (system), the distinct people from
  // OUTSIDE the owning crew who contributed there (commits + reviews). These
  // are backup-knowledge holders — resilience against a crew being a single
  // point of failure for its systems.
  const systemExternals = new Map<
    string,
    { ownerCrew: string; contributors: Set<string> }
  >();

  const addEdge = (
    source: string,
    target: string,
    type: string,
    crew: string,
  ) => {
    if (source === "" || target === "" || source === target) return;
    const key = `${source}\u0000${target}\u0000${type}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    const s = helperCrews.get(source) ?? new Set<string>();
    if (crew !== "") s.add(crew);
    helperCrews.set(source, s);
  };

  for (const e of events) {
    // Only cross-boundary activity forms help edges (same-crew work is ordinary).
    if (!isCrossBoundary(e.sourceCrew, e.targetCrew)) continue;
    addNode(e.userId, e.username, e.sourceCrew);

    // Inverse bus factor: a cross-boundary commit or review to a project is
    // backup knowledge in another crew's system. (Comments/messages are help
    // but not "history in the codebase", so restrict to commit + mr_review.)
    if (
      e.projectId !== "" &&
      (e.eventType === "commit" || e.eventType === "mr_review")
    ) {
      const sys = systemExternals.get(e.projectId) ??
        { ownerCrew: e.targetCrew, contributors: new Set<string>() };
      sys.contributors.add(e.userId);
      systemExternals.set(e.projectId, sys);
    }

    if (e.targetUser !== "") {
      // Direct help to a specific person.
      addNode(e.targetUser, e.targetUser, e.targetCrew);
      addEdge(e.userId, e.targetUser, e.eventType, e.targetCrew);
    } else {
      // Help to the crew: fan out to each known member of the target crew.
      const members = crewMembers.get(e.targetCrew) ?? [];
      for (const member of members) {
        if (member === e.username) continue;
        addNode(member, member, e.targetCrew);
        addEdge(e.userId, member, e.eventType, e.targetCrew);
      }
    }
  }

  const edges: Edge[] = [];
  for (const [key, weight] of edgeCounts) {
    const [source, target, type] = key.split("\u0000");
    edges.push({ source, target, type, weight });
  }

  // In-degree centrality, per the design's HELPED convention: the arrow points
  // from the helped person TOWARD the helper, so a node's "incoming" edges are
  // the distinct people it HELPED — "how many others depend on you". We store
  // edges as source=helper, target=helped, so that is the count of DISTINCT
  // targets a node was the source for. This also bounds a single commit's
  // effect: fanning one commit to N crew members counts them as the distinct
  // people helped, but each is still one person depending on the committer.
  const helpedBy = new Map<string, Set<string>>();
  for (const node of nodes.keys()) helpedBy.set(node, new Set<string>());
  for (const e of edges) {
    (helpedBy.get(e.source) ?? new Set<string>()).add(e.target);
  }
  const inDegree = new Map<string, number>();
  for (const [node, helped] of helpedBy) inDegree.set(node, helped.size);
  let maxIn = 0;
  for (const v of inDegree.values()) if (v > maxIn) maxIn = v;

  // PageRank over the HELPED graph (pure power method). Normalize to its max so
  // it shares the [0,1] scale with in-degree centrality.
  const nodeIds = [...nodes.keys()];
  const prRaw = pageRank(nodeIds, edges);
  let maxPr = 0;
  for (const v of prRaw.values()) if (v > maxPr) maxPr = v;

  // Inverse bus factor per person: how many distinct systems they back up.
  const busFactorOf = new Map<string, number>();
  for (const { contributors } of systemExternals.values()) {
    for (const person of contributors) {
      busFactorOf.set(person, (busFactorOf.get(person) ?? 0) + 1);
    }
  }

  const centrality: Centrality[] = [];
  for (const node of nodes.values()) {
    const deg = inDegree.get(node.id) ?? 0;
    const inDegreeCentrality = maxIn > 0 ? deg / maxIn : 0;
    const pr = maxPr > 0 ? (prRaw.get(node.id) ?? 0) / maxPr : 0;
    centrality.push({
      userId: node.id,
      username: node.username,
      crew: node.crew,
      inDegree: deg,
      // Primary centrality is PageRank when the graph has edges (design's
      // preferred metric); in-degree is the documented fallback for an
      // edgeless graph.
      centrality: edges.length > 0 ? pr : inDegreeCentrality,
      pageRank: pr,
      inDegreeCentrality,
      rank: 0, // assigned below
      busFactorContribution: busFactorOf.get(node.id) ?? 0,
    });
  }
  // Rank by centrality desc (1 = highest). Ties share ascending order by id for
  // determinism.
  centrality.sort((a, b) =>
    b.centrality - a.centrality || a.userId.localeCompare(b.userId)
  );
  centrality.forEach((c, i) => {
    c.rank = i + 1;
  });

  const hubs = centrality.filter((c) => c.inDegree >= opts.hubThreshold).map((
    c,
  ) => c.userId);
  const bridges: string[] = [];
  for (const [helper, crews] of helperCrews) {
    if (crews.size >= opts.bridgeThreshold) bridges.push(helper);
  }
  bridges.sort();

  const systemContributors = [...systemExternals.entries()]
    .map(([projectId, sys]) => ({
      projectId,
      ownerCrew: sys.ownerCrew,
      externalContributors: [...sys.contributors].sort(),
    }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));

  return {
    nodes: [...nodes.values()],
    edges,
    centrality,
    stats: {
      totalNodes: nodes.size,
      totalEdges: edges.length,
      maxInDegree: maxIn,
      hubs,
      bridges,
      systemContributors,
    },
  };
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

/** Interaction graph model — HELPED edges, in-degree centrality, hubs/bridges. */
export const model = {
  type: "@webframp/devops-measurement/interaction-graph",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    graph: {
      description:
        "Interaction graph: Person nodes, HELPED edges, centrality + rank",
      schema: GraphSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    build: {
      description:
        "Build the interaction graph from the canonical aggregated event set " +
        "(wired in via CEL) and the crew reference. Forms HELPED edges from " +
        "all cross-boundary activity, computes normalized in-degree " +
        "centrality and rank (DR-4), and detects hubs and bridges. One " +
        "execution produces the whole graph (factory).",
      arguments: z.object({
        events: z.array(EventSchema).default([]).describe(
          "Canonical windowed events (data.latest of the events model)",
        ),
        crewReference: CrewReferenceSchema.describe(
          "Crew reference (members) for fanning commit edges to a crew",
        ),
        hubThreshold: z.number().int().positive().default(3).describe(
          "Min in-degree to be flagged a hub",
        ),
        bridgeThreshold: z.number().int().positive().default(3).describe(
          "Min distinct crews helped to be flagged a bridge",
        ),
      }),
      execute: async (
        args: {
          events: Event[];
          crewReference: Ref;
          hubThreshold: number;
          bridgeThreshold: number;
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const result = build(args.events, args.crewReference, {
          hubThreshold: args.hubThreshold,
          bridgeThreshold: args.bridgeThreshold,
        });

        const handle = await context.writeResource("graph", "graph-current", {
          nodes: result.nodes,
          edges: result.edges,
          centrality: result.centrality,
          stats: result.stats,
          builtAt: new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        context.logger.info(
          "Graph built: {nodes} nodes, {edges} edges, {hubs} hubs, {bridges} bridges",
          {
            nodes: result.stats.totalNodes,
            edges: result.stats.totalEdges,
            hubs: result.stats.hubs.length,
            bridges: result.stats.bridges.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
