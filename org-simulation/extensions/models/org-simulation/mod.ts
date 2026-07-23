/**
 * Organization design simulation model.
 *
 * Agent-guided concept model inspired by the Curious Duck simulation studio
 * (https://ducksimng.onrender.com/scenarios/studio), a tool for exploring how
 * team structure, engineering discipline, deploy cadence, and code reliability
 * interact to produce emergent flow and quality outcomes.
 *
 * The model captures an organization as a topology of widgets (teams, repos,
 * environments, customer bases) wired by connectors, plus a defect/reliability
 * model and a deploy policy. A deterministic, seedable flow simulation then
 * estimates cycle times, defect detection, find-vs-fix balance, and customer
 * sentiment (NPS) over a time horizon — producing versioned, comparable
 * scenario snapshots for organization design decisions.
 *
 * Design: the agent interviews the user to capture the current org and a
 * proposed redesign as two topology snapshots, runs the simulation against
 * each, and records a design decision comparing the outcomes. Everything is
 * pure TypeScript — no network calls, no live services.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas — Organization Topology (mirrors the DuckSim studio canvas)
// =============================================================================

// --- Shared enums ---

const DisciplineSchema = z.enum([
  "Programmer",
  "Tester",
  "Analyst",
  "Operations",
  "Manager",
]).describe("Primary discipline of a team member");

const SkillSchema = z.object({
  Coding: z.number().min(0).max(100).default(70).describe(
    "Coding proficiency 0-100",
  ),
  Testing: z.number().min(0).max(100).default(70).describe(
    "Testing proficiency 0-100",
  ),
  Analysis: z.number().min(0).max(100).default(70).describe(
    "Analysis proficiency 0-100",
  ),
  Operations: z.number().min(0).max(100).default(70).describe(
    "Operations proficiency 0-100",
  ),
});

const DispositionSchema = z.enum(["urgency", "quality"]).describe(
  "Team's working disposition: 'urgency' ships faster but introduces more defects; 'quality' is more careful",
);

const CollaborationSchema = z.enum(["solo", "pairing", "ensemble", "swarm"])
  .describe(
    "How members collaborate: 'solo' (independent), 'pairing' (two), 'ensemble' (whole team navigates together), 'swarm' (all contribute to one task)",
  );

const MemberSchema = z.object({
  id: z.string().min(1).describe("Stable member id unique within the team"),
  name: z.string().min(1).describe("Member display name"),
  avatarKey: z.string().optional().describe(
    "Optional cosmetic avatar key (ignored by simulation)",
  ),
  disciplines: z.array(DisciplineSchema).min(1).default(["Programmer"])
    .describe("Disciplines this member practices"),
  skills: SkillSchema.default({
    Coding: 70,
    Testing: 70,
    Analysis: 70,
    Operations: 70,
  }).describe("Skill proficiencies 0-100"),
});

// --- Widgets ---

const TeamConfigSchema = z.object({
  members: z.array(MemberSchema).min(1).describe("People on this team"),
  disposition: DispositionSchema.default("urgency").describe(
    "Working disposition",
  ),
  collaboration: CollaborationSchema.default("solo").describe(
    "Collaboration style",
  ),
  coordinationEase: z.number().min(0).max(10).default(10).describe(
    "How easily this team coordinates internally (0-10, higher = less friction)",
  ),
  collaborationEffectiveness: z.number().min(0).max(100).default(99).describe(
    "Effectiveness of the chosen collaboration mode (0-100)",
  ),
});

const ModuleSchema = z.object({
  id: z.string().min(1).describe("Module id unique within the repo"),
  name: z.string().min(1).describe("Module name (e.g. 'Front End')"),
  color: z.string().optional().describe("Optional cosmetic hex color"),
  width: z.number().int().min(1).max(100).default(20).describe(
    "Module width in environment grid cells",
  ),
  height: z.number().int().min(1).max(100).default(10).describe(
    "Module height in environment grid cells",
  ),
});

const RepoConfigSchema = z.object({
  modules: z.array(ModuleSchema).min(1).describe("Modules in this repo"),
});

// Cell state in an environment grid: empty, healthy code, or buggy code.
const CellStateSchema = z.enum(["empty", "healthy", "buggy"]).describe(
  "State of a single environment grid cell",
);

const PlacementSchema = z.object({
  repoWidgetId: z.string().min(1).describe(
    "Id of the repo widget placed in this environment",
  ),
  moduleIndex: z.number().int().min(0).default(0).describe(
    "Index into the repo's modules array",
  ),
  xOffset: z.number().int().default(0).describe("Grid x offset for placement"),
  yOffset: z.number().int().default(0).describe("Grid y offset for placement"),
});

const DeployModeSchema = z.enum(["continuous", "weekly", "monthly"]).describe(
  "Deploy cadence: 'continuous' (many small), 'weekly', or 'monthly' (large batches)",
);

const DeployPolicySchema = z.object({
  mode: DeployModeSchema.default("monthly").describe("Deploy cadence mode"),
  interval: z.number().int().min(1).default(1).describe(
    "Number of mode periods between deploys (e.g. every 2 weeks)",
  ),
  days: z.array(z.union([z.string().min(1), z.number().int()])).default([
    "last",
    15,
  ]).describe(
    "Deploy days: day-of-month numbers (1-31) or 'last' for end of month. Ignored for continuous mode.",
  ),
  time: z.string().default("00:00").describe(
    "Deploy time of day HH:MM (cosmetic — ignored by simulation)",
  ),
});

const EnvironmentConfigSchema = z.object({
  certaintyBaseline: z.number().min(0).max(10).default(7).describe(
    "Floor certainty of a subroutine written with maximum recklessness (0-10). The defect model baseline.",
  ),
  riskSensitivity: z.number().min(0).max(1).default(0.03).describe(
    "How quickly certainty improves as reliability increases (0-1). Higher = careful practices pay off more dramatically.",
  ),
  placements: z.array(PlacementSchema).default([]).describe(
    "Where repos/modules are placed in this environment's grid",
  ),
  gridW: z.number().int().min(1).max(100).default(20).describe(
    "Grid width in cells",
  ),
  gridH: z.number().int().min(1).max(100).default(20).describe(
    "Grid height in cells",
  ),
  cells: z.array(z.array(CellStateSchema)).default([]).describe(
    "Optional pre-seeded grid (rows x gridW). Used to model a starting codebase that is healthy or already buggy. If omitted the grid is built from placements and starts empty.",
  ),
  deployPolicy: DeployPolicySchema.default({
    mode: "monthly",
    interval: 1,
    days: ["last", 15],
    time: "00:00",
  }).describe(
    "How this environment is deployed to",
  ),
});

const CustomerBaseConfigSchema = z.object({
  initialCount: z.number().int().min(0).default(0).describe(
    "Starting number of customers",
  ),
  initialSatisfaction: z.number().min(0).max(10).default(5).describe(
    "Starting satisfaction 0-10 (5 = neutral)",
  ),
  patience: z.number().min(0).max(20).default(10).describe(
    "How many bad experiences before a customer churns (higher = more patient)",
  ),
  growthRate: z.number().min(0).default(3).describe(
    "New customers added per period",
  ),
  experienceFrequency: z.number().int().min(1).default(7).describe(
    "Days between customer experiences of the product",
  ),
  // Cosmetic spawn-region bounds (kept for fidelity to the source topology;
  // the simulation does not spatialize customers, so these are informational).
  startsXMin: z.number().default(0),
  startsXMax: z.number().default(19),
  startsYMin: z.number().default(0),
  startsYMax: z.number().default(2),
  stopsXMin: z.number().default(0),
  stopsXMax: z.number().default(19),
  stopsYMin: z.number().default(17),
  stopsYMax: z.number().default(19),
});

const WidgetBaseSchema = z.object({
  id: z.string().min(1).describe("Widget id unique across the topology"),
  name: z.string().min(1).describe("Widget display name"),
  x: z.number().default(0).describe("Canvas x (cosmetic)"),
  y: z.number().default(0).describe("Canvas y (cosmetic)"),
});

const TeamWidgetSchema = WidgetBaseSchema.extend({
  type: z.literal("team"),
  config: TeamConfigSchema,
});

const RepoWidgetSchema = WidgetBaseSchema.extend({
  type: z.literal("repo"),
  config: RepoConfigSchema,
});

const EnvironmentWidgetSchema = WidgetBaseSchema.extend({
  type: z.literal("environment"),
  config: EnvironmentConfigSchema,
});

const CustomerBaseWidgetSchema = WidgetBaseSchema.extend({
  type: z.literal("customerBase"),
  config: CustomerBaseConfigSchema,
});

const WidgetSchema = z.union([
  TeamWidgetSchema,
  RepoWidgetSchema,
  EnvironmentWidgetSchema,
  CustomerBaseWidgetSchema,
]);

const ConnectorSchema = z.object({
  id: z.string().min(1).describe("Connector id unique across the topology"),
  fromId: z.string().min(1).describe("Source widget id"),
  toId: z.string().min(1).describe("Target widget id"),
}).describe(
  "A directed wire between widgets. Semantics by endpoint types: team→repo (team owns/works on repo), repo→environment (repo deploys into environment), customerBase→environment (customers experience this environment), team→environment (team operates environment).",
);

const ChartKindSchema = z.enum([
  "cycle",
  "flow",
  "defect-detection",
  "find-fix",
  "customer-sentiment",
  "worker-activity",
  "environment-reliability",
]).describe("Metric chart kind");

const ChartSchema = z.object({
  kind: ChartKindSchema,
  size: z.enum(["standard", "compact", "wide"]).default("standard")
    .describe("Cosmetic chart size (ignored by simulation)"),
  ticketType: z.enum([
    "feature",
    "bug",
    "request",
    "incident",
    "internal",
  ]).optional().describe(
    "Ticket type filter for cycle charts (optional)",
  ),
});

const MetricsConfigSchema = z.object({
  horizon: z.enum(["3mo", "6mo", "12mo", "all"]).default("12mo").describe(
    "Time horizon for simulation and charts",
  ),
  aggregation: z.enum(["day", "week", "month"]).default("month").describe(
    "Aggregation granularity for chart series",
  ),
  charts: z.array(ChartSchema).default([
    { kind: "cycle", size: "standard", ticketType: "feature" },
    { kind: "cycle", size: "standard", ticketType: "bug" },
    { kind: "flow", size: "standard" },
    { kind: "defect-detection", size: "standard" },
    { kind: "find-fix", size: "standard" },
    { kind: "customer-sentiment", size: "standard" },
  ]).describe("Charts to render (describes which result series to populate)"),
});

const DEFAULT_METRICS_CONFIG = {
  horizon: "12mo" as const,
  aggregation: "month" as const,
  charts: [
    {
      kind: "cycle" as const,
      size: "standard" as const,
      ticketType: "feature" as const,
    },
    {
      kind: "cycle" as const,
      size: "standard" as const,
      ticketType: "bug" as const,
    },
    { kind: "flow" as const, size: "standard" as const },
    { kind: "defect-detection" as const, size: "standard" as const },
    { kind: "find-fix" as const, size: "standard" as const },
    { kind: "customer-sentiment" as const, size: "standard" as const },
  ],
};

// --- The topology snapshot (primary resource) ---

const TopologySchema = z.object({
  widgets: z.array(WidgetSchema).min(1).describe(
    "All widgets on the organization canvas",
  ),
  connectors: z.array(ConnectorSchema).default([]).describe(
    "Wires between widgets",
  ),
  metrics: MetricsConfigSchema.default(DEFAULT_METRICS_CONFIG).describe(
    "Simulation/metrics configuration",
  ),
  designedAt: z.string().describe(
    "ISO timestamp of when this topology was captured",
  ),
  notes: z.string().optional().describe(
    "Context about this topology snapshot — e.g. 'current state' or 'proposed redesign'",
  ),
});

// =============================================================================
// Schemas — Simulation Results
// =============================================================================

const SeriesPointSchema = z.object({
  t: z.number().int().min(0).describe("Day index from simulation start"),
  value: z.number().describe("Metric value at this point"),
});

const CycleSeriesSchema = z.object({
  ticketType: z.enum(["feature", "bug", "request", "incident", "internal"]),
  avgDays: z.number().min(0).describe(
    "Average cycle time in days across completed tickets of this type",
  ),
  completed: z.number().int().min(0).describe(
    "Number of tickets of this type completed during the run",
  ),
});

const DefectSeriesSchema = z.object({
  detected: z.number().int().min(0).describe("Cumulative defects detected"),
  fixed: z.number().int().min(0).describe("Cumulative defects fixed"),
  outstanding: z.number().int().min(0).describe("Defects detected but unfixed"),
  detectionByStage: z.array(SeriesPointSchema).describe(
    "Cumulative defects by first-detection stage over time",
  ),
});

const FlowSeriesSchema = z.object({
  byActivity: z.array(SeriesPointSchema).describe(
    "Tickets in each activity (develop, test, deploy, support) over time",
  ),
  inFlight: z.number().int().min(0).describe(
    "Tickets still in progress at run end",
  ),
});

const SentimentSeriesSchema = z.object({
  nps: z.number().min(-100).max(100).describe(
    "Final Net Promoter Score across all customers",
  ),
  customers: z.number().min(0).describe("Customer count at run end"),
  churned: z.number().int().min(0).describe("Customers lost during the run"),
  series: z.array(SeriesPointSchema).describe("NPS over time"),
});

const ReliabilitySeriesSchema = z.object({
  avgCertainty: z.number().min(0).max(1).describe(
    "Average code certainty across environments at run end (0-1)",
  ),
  buggyCells: z.number().int().min(0).describe(
    "Buggy environment cells at run end",
  ),
  healthyCells: z.number().int().min(0).describe(
    "Healthy environment cells at run end",
  ),
  series: z.array(SeriesPointSchema).describe("Average certainty over time"),
});

const SimulationResultsSchema = z.object({
  seed: z.number().int().describe("RNG seed used for this run (reproducible)"),
  horizonDays: z.number().int().min(1).describe("Simulated days in this run"),
  cycles: z.array(CycleSeriesSchema).describe(
    "Cycle-time outcomes per ticket type",
  ),
  flow: FlowSeriesSchema.describe("Work-in-flight and activity flow"),
  defects: DefectSeriesSchema.describe("Defect detection and fix balance"),
  sentiment: SentimentSeriesSchema.describe("Customer sentiment outcomes"),
  reliability: ReliabilitySeriesSchema.describe(
    "Environment code reliability outcomes",
  ),
  deployCount: z.number().int().min(0).describe(
    "Number of deploys that occurred during the run",
  ),
  runAt: z.string().describe("ISO timestamp of when the simulation ran"),
}).describe(
  "Outcomes of one deterministic simulation run over the configured horizon",
);

// =============================================================================
// Schemas — Design Decision (compare scenarios)
// =============================================================================

const DecisionKindSchema = z.enum([
  "adopt",
  "reject",
  "iterate",
  "hold",
]).describe(
  "adopt: proceed with the redesign; reject: keep current state; iterate: redesign needs changes; hold: gather more data first",
);

const DesignDecisionSchema = z.object({
  scenarioLabel: z.string().min(1).describe(
    "Label for the proposed scenario this decision concerns (e.g. 'split-platform-team')",
  ),
  decision: DecisionKindSchema,
  rationale: z.string().min(1).describe(
    "Why this decision — tie to specific simulated deltas (cycle time, defects, NPS, reliability)",
  ),
  expectedDeltas: z.object({
    featureCycleDays: z.number().describe(
      "Change in feature cycle time (proposed minus baseline); negative is better",
    ),
    bugCycleDays: z.number().describe(
      "Change in bug cycle time (proposed minus baseline); negative is better",
    ),
    nps: z.number().describe(
      "Change in NPS (proposed minus baseline); positive is better",
    ),
    outstandingDefects: z.number().describe(
      "Change in outstanding defects (proposed minus baseline); negative is better",
    ),
    avgCertainty: z.number().describe(
      "Change in average code certainty (proposed minus baseline); positive is better",
    ),
  }).describe("Quantified deltas from baseline to proposed scenario"),
  risks: z.array(z.string()).default([]).describe(
    "Risks / second-order effects to watch if this decision is adopted",
  ),
  decidedAt: z.string().describe("ISO timestamp of the decision"),
});

// =============================================================================
// GlobalArgs
// =============================================================================

const GlobalArgsSchema = z.object({
  organizationContext: z.string().describe(
    "Brief description of the organization, its size, business, and the team area under design",
  ),
  defectModel: z.object({
    ceilingCertainty: z.number().min(0.5).max(0.9999).default(0.999).describe(
      "Certainty at maximum reliability (the asymptote of the defect model). 0-1.",
    ),
  }).default({ ceilingCertainty: 0.999 }).describe(
    "Global defect-model parameters shared across all environments",
  ),
});

// =============================================================================
// Method Argument Schemas
// =============================================================================

const DesignTopologyArgsSchema = z.object({
  scenarioLabel: z.string().min(1).default("current").describe(
    "Label for this topology snapshot — 'current' for the as-is org, or a proposed-design name like 'split-platform-team'",
  ),
  widgets: z.array(WidgetSchema).min(1).describe(
    "Widgets on the organization canvas (teams, repos, environments, customer bases)",
  ),
  connectors: z.array(ConnectorSchema).default([]).describe(
    "Wires between widgets",
  ),
  metrics: MetricsConfigSchema.default(DEFAULT_METRICS_CONFIG).describe(
    "Simulation/metrics configuration for this scenario",
  ),
  notes: z.string().optional().describe(
    "Context about this snapshot — what it represents and why",
  ),
});

const RunSimulationArgsSchema = z.object({
  scenarioLabel: z.string().min(1).default("current").describe(
    "Which topology snapshot to run. Must match a label previously passed to design_topology, or 'current'.",
  ),
  seed: z.number().int().min(0).default(0).describe(
    "RNG seed for deterministic, reproducible runs. Use different seeds to estimate variance.",
  ),
  horizon: z.enum(["3mo", "6mo", "12mo", "all"]).optional().describe(
    "Override the topology's metrics.horizon for this run. Defaults to the topology's configured horizon.",
  ),
});

const RecordDecisionArgsSchema = z.object({
  baselineLabel: z.string().min(1).default("current").describe(
    "Label of the baseline scenario results were compared against",
  ),
  decision: DesignDecisionSchema,
});

// =============================================================================
// Context type
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
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
};

// =============================================================================
// Simulation Engine
//
// Pure, deterministic, seedable. No network calls. This is a fluid
// (system-dynamics style) approximation, not a literal per-tick discrete
// event replay of the DuckSim canvas — it tracks continuous backlog levels
// per team/ticket-type and integrates queue-time (Little's Law: W = L / λ)
// to derive average cycle times, while stepping day-by-day for genuinely
// path-dependent state (code certainty, customer satisfaction, churn).
// =============================================================================

type Topology = z.infer<typeof TopologySchema>;
type Widget = z.infer<typeof WidgetSchema>;
type TeamWidget = z.infer<typeof TeamWidgetSchema>;
type EnvironmentWidget = z.infer<typeof EnvironmentWidgetSchema>;
type CustomerBaseWidget = z.infer<typeof CustomerBaseWidgetSchema>;
type Connector = z.infer<typeof ConnectorSchema>;
type SimulationResults = z.infer<typeof SimulationResultsSchema>;
type TicketType = "feature" | "bug" | "request" | "incident" | "internal";

const TICKET_TYPES: TicketType[] = [
  "bug",
  "incident",
  "feature",
  "request",
  "internal",
];

function horizonToDays(horizon: "3mo" | "6mo" | "12mo" | "all"): number {
  switch (horizon) {
    case "3mo":
      return 90;
    case "6mo":
      return 180;
    case "12mo":
    case "all":
      return 365;
  }
}

function aggregationDays(agg: "day" | "week" | "month"): number {
  switch (agg) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
  }
}

/** Deterministic PRNG (mulberry32) — same seed always produces same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const COLLAB_THROUGHPUT: Record<string, number> = {
  solo: 1.0,
  pairing: 0.85,
  ensemble: 0.7,
  swarm: 0.6,
};

const COLLAB_QUALITY_BONUS: Record<string, number> = {
  solo: 0,
  pairing: 0.1,
  ensemble: 0.2,
  swarm: 0.15,
};

/** Average member skill (0-1) across the four skill dimensions. */
function avgSkill(team: TeamWidget["config"]): number {
  if (team.members.length === 0) return 0;
  const sum = team.members.reduce((acc, m) => {
    const s = m.skills;
    return acc + (s.Coding + s.Testing + s.Analysis + s.Operations) / 4;
  }, 0);
  return sum / team.members.length / 100;
}

function testerFraction(team: TeamWidget["config"]): number {
  if (team.members.length === 0) return 0;
  const testers =
    team.members.filter((m) => m.disciplines.includes("Tester")).length;
  return testers / team.members.length;
}

/** Daily throughput (ticket-units/day) and quality effort (0-1.5) for a team. */
function teamCapacity(
  team: TeamWidget["config"],
): { throughput: number; qualityEffort: number } {
  const skill = avgSkill(team);
  const collabThroughput = COLLAB_THROUGHPUT[team.collaboration] ?? 1.0;
  const collabQuality = COLLAB_QUALITY_BONUS[team.collaboration] ?? 0;
  const dispThroughput = team.disposition === "urgency" ? 1.25 : 0.85;
  const dispQuality = team.disposition === "urgency" ? -0.15 : 0.2;
  const coordFactor = 0.5 + team.coordinationEase / 20;
  const effFactor = team.collaborationEffectiveness / 100;

  const throughput = team.members.length * skill * dispThroughput *
    collabThroughput * coordFactor * effFactor;
  const qualityEffort = clamp(skill + dispQuality + collabQuality, 0, 1.5);

  return { throughput, qualityEffort };
}

/** Certainty (0-1) that code written with the given quality effort is healthy. */
function certaintyFor(
  env: EnvironmentWidget["config"],
  qualityEffort: number,
  ceilingCertainty: number,
): number {
  const baseline = env.certaintyBaseline / 10;
  const certainty = baseline +
    (ceilingCertainty - baseline) *
      (1 - Math.exp(-env.riskSensitivity * qualityEffort * 10));
  return clamp(certainty, 0, ceilingCertainty);
}

function environmentTotalCells(env: EnvironmentWidget["config"]): number {
  if (env.cells.length > 0) {
    return env.cells.reduce((sum, row) => sum + row.length, 0);
  }
  if (env.placements.length > 0) {
    // Approximate cell coverage from placements; fall back to grid size if
    // placements don't carry explicit module dimensions here.
    return env.gridW * env.gridH;
  }
  return env.gridW * env.gridH;
}

/** Initial certainty (0-1) of an environment's pre-seeded/placed code. */
function environmentInitialCertainty(
  env: EnvironmentWidget["config"],
): number {
  if (env.cells.length > 0) {
    let healthy = 0;
    let total = 0;
    for (const row of env.cells) {
      for (const cell of row) {
        if (cell === "empty") continue;
        total++;
        if (cell === "healthy") healthy++;
      }
    }
    if (total > 0) return healthy / total;
  }
  return env.certaintyBaseline / 10;
}

function deploysPerHorizon(
  policy: z.infer<typeof DeployPolicySchema>,
  horizonDays: number,
): { count: number; avgWaitDays: number } {
  const interval = Math.max(1, policy.interval);
  switch (policy.mode) {
    case "continuous":
      return { count: horizonDays, avgWaitDays: 0.5 };
    case "weekly": {
      const periodDays = 7 * interval;
      return {
        count: Math.floor(horizonDays / periodDays),
        avgWaitDays: periodDays / 2,
      };
    }
    case "monthly": {
      const periodDays = 30 * interval;
      return {
        count: Math.floor(horizonDays / periodDays),
        avgWaitDays: periodDays / 2,
      };
    }
  }
}

const FEATURE_DEMAND_PER_REPO = 0.3;
const REQUEST_DEMAND_PER_REPO = 0.05;
const INTERNAL_DEMAND_PER_TEAM = 0.02;
const DETECTION_CONST = 0.5;
const INCIDENT_CONST = 0.05;
const SAT_GOOD_DELTA = 0.15;
const SAT_BAD_DELTA = 0.4;
const FIX_CERTAINTY_BONUS = 0.02;

/** Run a deterministic organization-design simulation over one topology. */
export function runSimulation(
  topology: Topology,
  seed: number,
  ceilingCertainty: number,
  horizonOverride?: "3mo" | "6mo" | "12mo" | "all",
): SimulationResults {
  const rng = mulberry32(seed);
  const horizon = horizonOverride ?? topology.metrics.horizon;
  const horizonDays = horizonToDays(horizon);
  const sampleEvery = aggregationDays(topology.metrics.aggregation);

  const widgetsById = new Map<string, Widget>(
    topology.widgets.map((w) => [w.id, w]),
  );
  const teams = topology.widgets.filter((w): w is TeamWidget =>
    w.type === "team"
  );
  const environments = topology.widgets.filter((
    w,
  ): w is EnvironmentWidget => w.type === "environment");
  const customerBases = topology.widgets.filter((
    w,
  ): w is CustomerBaseWidget => w.type === "customerBase");

  const byFrom = new Map<string, Connector[]>();
  for (const c of topology.connectors) {
    const list = byFrom.get(c.fromId) ?? [];
    list.push(c);
    byFrom.set(c.fromId, list);
  }
  const targetsOfType = (id: string, type: Widget["type"]): string[] => {
    return (byFrom.get(id) ?? [])
      .map((c) => c.toId)
      .filter((toId) => widgetsById.get(toId)?.type === type);
  };

  // Repos this team works on, environments those repos deploy to, plus any
  // environments the team directly operates.
  const teamEnvIds = new Map<string, string[]>();
  const teamRepoIds = new Map<string, string[]>();
  for (const team of teams) {
    const repoIds = targetsOfType(team.id, "repo");
    teamRepoIds.set(team.id, repoIds);
    const envIds = new Set<string>(targetsOfType(team.id, "environment"));
    for (const repoId of repoIds) {
      for (const envId of targetsOfType(repoId, "environment")) {
        envIds.add(envId);
      }
    }
    teamEnvIds.set(team.id, Array.from(envIds));
  }

  // Repos worked by more than one team split exogenous demand evenly.
  const repoTeamCount = new Map<string, number>();
  for (const [, repoIds] of teamRepoIds) {
    for (const repoId of repoIds) {
      repoTeamCount.set(repoId, (repoTeamCount.get(repoId) ?? 0) + 1);
    }
  }

  // Environment mutable state.
  const envState = new Map<string, {
    certainty: number;
    volume: number;
    totalCells: number;
    deploy: { count: number; avgWaitDays: number };
  }>();
  for (const env of environments) {
    const totalCells = environmentTotalCells(env.config);
    envState.set(env.id, {
      certainty: environmentInitialCertainty(env.config),
      volume: totalCells,
      totalCells,
      deploy: deploysPerHorizon(env.config.deployPolicy, horizonDays),
    });
  }

  // Team mutable state: backlog + accumulated queue-days per ticket type.
  const teamState = new Map<string, {
    capacity: { throughput: number; qualityEffort: number };
    queue: Record<TicketType, number>;
    completed: Record<TicketType, number>;
    queueDays: Record<TicketType, number>;
  }>();
  const zeroByType = (): Record<TicketType, number> => ({
    feature: 0,
    bug: 0,
    request: 0,
    incident: 0,
    internal: 0,
  });
  for (const team of teams) {
    teamState.set(team.id, {
      capacity: teamCapacity(team.config),
      queue: zeroByType(),
      completed: zeroByType(),
      queueDays: zeroByType(),
    });
  }

  // Customer mutable state.
  const customerState = new Map<string, {
    count: number;
    satisfaction: number;
    churned: number;
  }>();
  for (const cb of customerBases) {
    customerState.set(cb.id, {
      count: cb.config.initialCount,
      satisfaction: cb.config.initialSatisfaction,
      churned: 0,
    });
  }

  let defectsDetected = 0;
  let defectsFixed = 0;
  const flowSeries: { t: number; value: number }[] = [];
  const defectSeries: { t: number; value: number }[] = [];
  const npsSampleSum: { t: number; sum: number; count: number }[] = [];
  const certaintySeries: { t: number; value: number }[] = [];

  for (let day = 0; day < horizonDays; day++) {
    // 1. Exogenous demand arrivals (feature/request/internal), split across
    //    teams sharing a repo.
    for (const team of teams) {
      const state = teamState.get(team.id)!;
      const repoIds = teamRepoIds.get(team.id) ?? [];
      for (const repoId of repoIds) {
        const split = repoTeamCount.get(repoId) ?? 1;
        state.queue.feature += FEATURE_DEMAND_PER_REPO / split;
        state.queue.request += REQUEST_DEMAND_PER_REPO / split;
      }
      state.queue.internal += INTERNAL_DEMAND_PER_TEAM;

      // 2. Bug arrivals from defect detection: testers surface bugs in the
      //    environments this team touches, proportional to how buggy those
      //    environments currently are.
      const envIds = teamEnvIds.get(team.id) ?? [];
      if (envIds.length > 0) {
        const avgBuggy = envIds.reduce((sum, envId) => {
          const es = envState.get(envId);
          return sum + (es ? 1 - es.certainty : 0);
        }, 0) / envIds.length;
        const detectionRate = testerFraction(team.config) *
          team.config.members.length * DETECTION_CONST * avgBuggy;
        state.queue.bug += detectionRate;
        defectsDetected += detectionRate;

        // Incidents: buggy code that reaches customers without being caught
        // internally first.
        const incidentRate = team.config.members.length * INCIDENT_CONST *
          avgBuggy * (1 - testerFraction(team.config));
        state.queue.incident += incidentRate;
      }
    }

    // 3. Process capacity: priority order bug > incident > feature > request
    //    > internal, then integrate remaining backlog for Little's Law.
    // Track this day's completions per team so step 4 can attribute new
    // code volume and fixes to the environments each team touches.
    const completedToday = new Map<string, Record<TicketType, number>>();
    for (const team of teams) {
      const state = teamState.get(team.id)!;
      let remaining = state.capacity.throughput;
      const before = { ...state.completed };
      for (const type of TICKET_TYPES) {
        const take = Math.min(state.queue[type], remaining);
        state.queue[type] -= take;
        state.completed[type] += take;
        remaining -= take;
        if (type === "bug") defectsFixed += take;
      }
      for (const type of TICKET_TYPES) {
        state.queueDays[type] += state.queue[type];
      }
      completedToday.set(team.id, {
        feature: state.completed.feature - before.feature,
        bug: state.completed.bug - before.bug,
        request: state.completed.request - before.request,
        incident: state.completed.incident - before.incident,
        internal: state.completed.internal - before.internal,
      });
    }

    // 4. Code written (feature+internal completions) lands in connected
    //    environments with certainty determined by the writing team's
    //    quality effort; bug fixes nudge certainty back up. Multi-team
    //    environments blend contributions by volume.
    for (const env of environments) {
      const es = envState.get(env.id)!;
      let writtenVolume = 0;
      let writtenCertaintySum = 0;
      let fixVolume = 0;
      for (const team of teams) {
        const envIds = teamEnvIds.get(team.id) ?? [];
        if (!envIds.includes(env.id)) continue;
        const state = teamState.get(team.id)!;
        const todays = completedToday.get(team.id)!;
        const share = 1 / envIds.length;
        const written = (todays.feature + todays.internal) * share;
        if (written > 0) {
          const c = certaintyFor(
            env.config,
            state.capacity.qualityEffort,
            ceilingCertainty,
          );
          writtenVolume += written;
          writtenCertaintySum += c * written;
        }
        fixVolume += todays.bug * share;
      }
      if (writtenVolume > 0) {
        const blended = writtenCertaintySum / writtenVolume;
        const totalVolume = es.volume + writtenVolume;
        es.certainty = (es.certainty * es.volume + blended * writtenVolume) /
          totalVolume;
        es.volume = totalVolume;
      }
      if (fixVolume > 0) {
        es.certainty = clamp(
          es.certainty +
            (fixVolume * FIX_CERTAINTY_BONUS) / Math.max(1, es.totalCells),
          0,
          ceilingCertainty,
        );
      }
    }

    // 5. Customer experiences: sample every experienceFrequency days.
    for (const cb of customerBases) {
      if (cb.config.experienceFrequency <= 0) continue;
      if (day % cb.config.experienceFrequency !== 0) continue;
      const cs = customerState.get(cb.id)!;
      const envIds = targetsOfType(cb.id, "environment");
      const relevantEnvs = envIds
        .map((id) => envState.get(id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
      const avgCertainty = relevantEnvs.length > 0
        ? relevantEnvs.reduce((sum, e) => sum + e.certainty, 0) /
          relevantEnvs.length
        : 1;

      if (rng() < avgCertainty) {
        cs.satisfaction = clamp(cs.satisfaction + SAT_GOOD_DELTA, 0, 10);
      } else {
        cs.satisfaction = clamp(cs.satisfaction - SAT_BAD_DELTA, 0, 10);
        const churnProb = 1 / Math.max(1, cb.config.patience);
        const churned = cs.count * churnProb;
        cs.count = Math.max(0, cs.count - churned);
        cs.churned += churned;
      }
      cs.count += cb.config.growthRate;
    }

    // Sample series at the configured aggregation interval.
    if (day % sampleEvery === 0) {
      const inFlightNow = Array.from(teamState.values()).reduce(
        (sum, s) => sum + TICKET_TYPES.reduce((a, t) => a + s.queue[t], 0),
        0,
      );
      flowSeries.push({ t: day, value: inFlightNow });
      defectSeries.push({ t: day, value: defectsDetected });
      const npsAvg = customerBases.length > 0
        ? customerBases.reduce(
          (sum, cb) =>
            sum + clamp(
              (customerState.get(cb.id)!.satisfaction - 5) * 20,
              -100,
              100,
            ),
          0,
        ) / customerBases.length
        : 0;
      npsSampleSum.push({ t: day, sum: npsAvg, count: 1 });
      const certAvg = environments.length > 0
        ? environments.reduce(
          (sum, env) => sum + envState.get(env.id)!.certainty,
          0,
        ) / environments.length
        : ceilingCertainty;
      certaintySeries.push({ t: day, value: certAvg });
    }
  }

  const cycles = TICKET_TYPES.map((type) => {
    let totalCompleted = 0;
    let totalQueueDays = 0;
    for (const state of teamState.values()) {
      totalCompleted += state.completed[type];
      totalQueueDays += state.queueDays[type];
    }
    let avgDays = totalCompleted > 0 ? totalQueueDays / totalCompleted : 0;
    if (type === "feature" || type === "bug") {
      // Add average deploy-wait latency (weighted across environments) since
      // these ticket types must reach production to count as truly "done".
      const avgWait = environments.length > 0
        ? environments.reduce(
          (sum, env) => sum + envState.get(env.id)!.deploy.avgWaitDays,
          0,
        ) / environments.length
        : 0;
      avgDays += avgWait;
    }
    return { ticketType: type, avgDays, completed: Math.round(totalCompleted) };
  });

  const inFlight = Array.from(teamState.values()).reduce(
    (sum, s) => sum + TICKET_TYPES.reduce((a, t) => a + s.queue[t], 0),
    0,
  );

  const totalFixed = Array.from(teamState.values()).reduce(
    (sum, s) => sum + s.completed.bug,
    0,
  );
  const outstanding = Math.max(0, Math.round(defectsDetected - totalFixed));

  let totalCells = 0;
  let weightedCertainty = 0;
  for (const env of environments) {
    const es = envState.get(env.id)!;
    totalCells += es.totalCells;
    weightedCertainty += es.certainty * es.totalCells;
  }
  const avgCertainty = totalCells > 0
    ? weightedCertainty / totalCells
    : ceilingCertainty;
  const healthyCells = Math.round(totalCells * avgCertainty);
  const buggyCells = Math.max(0, totalCells - healthyCells);

  let totalCustomers = 0;
  let totalChurned = 0;
  let npsWeightedSum = 0;
  for (const cb of customerBases) {
    const cs = customerState.get(cb.id)!;
    totalCustomers += cs.count;
    totalChurned += cs.churned;
    npsWeightedSum += clamp((cs.satisfaction - 5) * 20, -100, 100);
  }
  const finalNps = customerBases.length > 0
    ? npsWeightedSum / customerBases.length
    : 0;

  let deployCount = 0;
  for (const env of environments) {
    deployCount += envState.get(env.id)!.deploy.count;
  }

  return {
    seed,
    horizonDays,
    cycles,
    flow: {
      byActivity: flowSeries,
      inFlight: Math.round(inFlight),
    },
    defects: {
      detected: Math.round(defectsDetected),
      fixed: Math.round(totalFixed),
      outstanding,
      detectionByStage: defectSeries,
    },
    sentiment: {
      nps: finalNps,
      customers: Math.round(totalCustomers),
      churned: Math.round(totalChurned),
      series: npsSampleSum.map((p) => ({ t: p.t, value: p.sum / p.count })),
    },
    reliability: {
      avgCertainty,
      buggyCells,
      healthyCells,
      series: certaintySeries,
    },
    deployCount,
    runAt: new Date().toISOString(),
  };
}

// =============================================================================
// Model Definition
// =============================================================================

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "") || "current";
}

/** Organization design simulation model. */
export const model = {
  type: "@webframp/org-simulation",
  version: "2026.07.23.1",
  upgrades: [
    {
      toVersion: "2026.07.23.1",
      description: "Initial release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,

  resources: {
    topology: {
      description:
        "Snapshot of an organization design scenario: widgets (teams, repos, environments, customer bases), connectors, and metrics config",
      schema: TopologySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    simulation_results: {
      description:
        "Outcomes of a deterministic simulation run against a topology scenario",
      schema: SimulationResultsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    design_decision: {
      description:
        "Recorded decision comparing a proposed scenario's simulated outcomes against a baseline",
      schema: DesignDecisionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    design_topology: {
      description:
        `Capture an organization design scenario as a topology of widgets and connectors, through structured conversation.

AGENT GUIDANCE:

You are modeling an organization the way the DuckSim studio
(https://ducksimng.onrender.com/scenarios/studio) represents it: as a canvas
of widgets wired together. Guide the conversation through these phases, and
always confirm you're capturing either the CURRENT state (scenarioLabel:
"current") or a PROPOSED redesign (a descriptive scenarioLabel like
"split-platform-team").

1. TEAMS
   For each team: who is on it (name, disciplines: Programmer/Tester/
   Analyst/Operations/Manager, rough skill levels 0-100 if known), and how
   they work:
   - disposition: "urgency" (ship fast, more defects) or "quality"
     (careful, slower)
   - collaboration: "solo", "pairing", "ensemble", or "swarm"
   - coordinationEase (0-10): how easily this team coordinates internally
   Ask: "How many people, what disciplines, and does this team optimize for
   speed or quality? Do they work solo or in some pairing/ensemble mode?"

2. REPOS / MODULES
   Ask: "What codebases or services does each team own? Break each into
   modules if there are logically distinct parts (e.g. frontend, API,
   worker)."

3. ENVIRONMENTS
   Ask: "What environments does code deploy to (e.g. production, staging)?
   For each: how is it deployed (continuous/weekly/monthly, and how often),
   and how careful is the team about reliability?"
   - certaintyBaseline (0-10): floor code quality even under max recklessness
   - riskSensitivity (0-1): how much careful practice improves quality
   Use certaintyBaseline ~7-8 and riskSensitivity ~0.03 as reasonable
   defaults unless the user has specific reliability engineering context.

4. CUSTOMER BASES
   Ask: "Who uses this system? Roughly how many customers, and how
   satisfied are they today (0-10)? How often does a typical customer
   experience the product (e.g. daily, weekly)? How patient are they with
   bad experiences before churning?"

5. CONNECTORS
   Wire the widgets together: team→repo (owns/works on), repo→environment
   (deploys into), team→environment (operates), customerBase→environment
   (experiences). Every environment should have at least one path back to a
   customer base to produce sentiment metrics, and at least one team
   writing to it to produce flow/defect metrics.

6. METRICS CONFIG
   Ask: "What time horizon matters — 3, 6, or 12 months? What aggregation
   (daily/weekly/monthly) do you want for the charts?" Default to 12mo /
   month if the user has no preference.

IMPORTANT: to compare a redesign against the status quo, first call this
method once with scenarioLabel "current" to capture the as-is org, then call
it again with a new scenarioLabel for each proposed redesign. Each call is a
full snapshot — include every widget and connector for that scenario, not
just what changed.`,
      arguments: DesignTopologyArgsSchema,
      execute: async (
        args: z.infer<typeof DesignTopologyArgsSchema>,
        context: MethodContext,
      ) => {
        const ids = new Set(args.widgets.map((w) => w.id));
        for (const c of args.connectors) {
          if (!ids.has(c.fromId)) {
            throw new Error(
              `Connector ${c.id} references unknown fromId widget "${c.fromId}"`,
            );
          }
          if (!ids.has(c.toId)) {
            throw new Error(
              `Connector ${c.id} references unknown toId widget "${c.toId}"`,
            );
          }
        }

        const topology = {
          widgets: args.widgets,
          connectors: args.connectors,
          metrics: args.metrics,
          designedAt: new Date().toISOString(),
          notes: args.notes,
        };

        const handle = await context.writeResource(
          "topology",
          `topology-${slugify(args.scenarioLabel)}`,
          topology as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Topology '{scenarioLabel}' written: {widgetCount} widgets, {connectorCount} connectors",
          {
            scenarioLabel: args.scenarioLabel,
            widgetCount: args.widgets.length,
            connectorCount: args.connectors.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    run_simulation: {
      description:
        `Run the deterministic flow simulation against a previously-designed topology scenario.

AGENT GUIDANCE:

Before calling this, a topology must already exist for the given
scenarioLabel (call design_topology first). This method reads that snapshot,
runs a seedable simulation over the configured (or overridden) time horizon,
and persists the results.

The simulation approximates system dynamics, not a literal pixel-for-pixel
replay of the DuckSim canvas: teams generate throughput based on skill,
disposition, and collaboration mode; code they write lands in connected
environments with a certainty determined by their quality effort and that
environment's defect model; testers detect bugs proportional to how buggy an
environment currently is; undetected bugs surface as customer-facing
incidents; customers experience environments periodically and their
satisfaction (and eventually NPS/churn) responds to whether that experience
was healthy or buggy.

WORKFLOW:
1. Run once with seed 0 for a baseline reading.
2. Optionally run again with different seeds (1, 2, 3...) to see how much
   variance there is — if results swing wildly between seeds, treat any
   single run's numbers as directional, not precise.
3. Compare the SAME scenario across different seeds, and compare DIFFERENT
   scenarios (e.g. "current" vs a proposed redesign) using the SAME seed for
   an apples-to-apples read.
4. After running both a baseline and a proposed scenario, use
   record_design_decision to capture the comparison and your recommendation.

Read the resulting cycle times, defect detection/fix balance, customer NPS,
and environment reliability. Look for: rising bug backlogs (quality debt
accumulating faster than it's paid down), feature cycle time increasing with
team size (coordination overhead / cognitive load), and NPS trending down
despite feature throughput trending up (customers churning to reliability
issues, not feature velocity).`,
      arguments: RunSimulationArgsSchema,
      execute: async (
        args: z.infer<typeof RunSimulationArgsSchema>,
        context: MethodContext,
      ) => {
        const slug = slugify(args.scenarioLabel);
        const stored = await context.readResource(`topology-${slug}`);
        if (!stored) {
          throw new Error(
            `No topology found for scenarioLabel "${args.scenarioLabel}". Call design_topology first.`,
          );
        }

        const topology = TopologySchema.parse(stored);
        const ceilingCertainty =
          context.globalArgs.defectModel.ceilingCertainty;
        const results = runSimulation(
          topology,
          args.seed,
          ceilingCertainty,
          args.horizon,
        );

        const handle = await context.writeResource(
          "simulation_results",
          `results-${slug}-seed${args.seed}`,
          results as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Simulation '{scenarioLabel}' (seed {seed}) complete: {days} days, NPS {nps}, {detected} defects detected / {fixed} fixed, {deploys} deploys",
          {
            scenarioLabel: args.scenarioLabel,
            seed: args.seed,
            days: results.horizonDays,
            nps: Math.round(results.sentiment.nps),
            detected: results.defects.detected,
            fixed: results.defects.fixed,
            deploys: results.deployCount,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    record_design_decision: {
      description:
        `Record a design decision comparing a proposed scenario's simulated outcomes against a baseline.

AGENT GUIDANCE:

Before calling this, you should have run_simulation results for BOTH the
baseline scenario (usually "current") and the proposed scenario, ideally
with the same seed for a fair comparison. Read both simulation_results
resources, compute the deltas (proposed minus baseline) for feature cycle
time, bug cycle time, NPS, outstanding defects, and average certainty, and
form a recommendation:

- adopt: the redesign clearly improves the metrics that matter for this
  organization's goals, and the risks are acceptable
- reject: the redesign doesn't improve things enough to justify the
  disruption, or it regresses a metric that matters more
- iterate: the redesign has promise but needs adjustment (e.g. a team split
  helped defects but hurt coordination — try adjusting coordinationEase or
  collaboration mode)
- hold: the simulated deltas are within noise (run more seeds) or the
  organization needs more real-world data before deciding

Tie the rationale to SPECIFIC numbers from the simulation runs, not vibes.
List risks / second-order effects the simulation can't capture (team morale
during a transition, hiring lead time, customer communication) so the human
decision-maker sees the full picture, not just the model's blind spots.`,
      arguments: RecordDecisionArgsSchema,
      execute: async (
        args: z.infer<typeof RecordDecisionArgsSchema>,
        context: MethodContext,
      ) => {
        const decision = {
          ...args.decision,
          decidedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "design_decision",
          `decision-${slugify(args.decision.scenarioLabel)}-vs-${
            slugify(args.baselineLabel)
          }`,
          decision as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Decision recorded: {decision} '{scenarioLabel}' vs baseline '{baselineLabel}' ({rationale})",
          {
            decision: args.decision.decision,
            scenarioLabel: args.decision.scenarioLabel,
            baselineLabel: args.baselineLabel,
            rationale: args.decision.rationale.slice(0, 80),
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
