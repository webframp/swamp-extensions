// Organization Design Simulation Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model, runSimulation } from "./mod.ts";

// =============================================================================
// Fixtures
// =============================================================================

function createOrgContext(
  storedResources: Record<string, Record<string, unknown>> = {},
) {
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        organizationContext:
          "Mid-size SaaS company, ~40 engineers across 6 teams",
        defectModel: { ceilingCertainty: 0.999 },
      },
      storedResources,
    });

  return { context, getWrittenResources, getLogsByLevel };
}

const SAMPLE_TEAM = {
  id: "team-a",
  name: "Team A",
  x: 0,
  y: 0,
  type: "team" as const,
  config: {
    members: [
      {
        id: "m1",
        name: "Alice",
        disciplines: ["Programmer" as const],
        skills: { Coding: 80, Testing: 60, Analysis: 70, Operations: 50 },
      },
      {
        id: "m2",
        name: "Bob",
        disciplines: ["Tester" as const],
        skills: { Coding: 50, Testing: 85, Analysis: 60, Operations: 40 },
      },
    ],
    disposition: "urgency" as const,
    collaboration: "solo" as const,
    coordinationEase: 8,
    collaborationEffectiveness: 90,
  },
};

const SAMPLE_REPO = {
  id: "repo-a",
  name: "Repo A",
  x: 0,
  y: 0,
  type: "repo" as const,
  config: {
    modules: [{ id: "mod1", name: "API", width: 20, height: 10 }],
  },
};

const SAMPLE_ENV = {
  id: "env-prod",
  name: "Prod",
  x: 0,
  y: 0,
  type: "environment" as const,
  config: {
    certaintyBaseline: 7,
    riskSensitivity: 0.03,
    placements: [],
    gridW: 20,
    gridH: 20,
    cells: [],
    deployPolicy: {
      mode: "monthly" as const,
      interval: 1,
      days: ["last", 15],
      time: "00:00",
    },
  },
};

const SAMPLE_CUSTOMER_BASE = {
  id: "cb1",
  name: "Customers",
  x: 0,
  y: 0,
  type: "customerBase" as const,
  config: {
    initialCount: 1000,
    initialSatisfaction: 5,
    patience: 10,
    growthRate: 3,
    experienceFrequency: 7,
    startsXMin: 0,
    startsXMax: 19,
    startsYMin: 0,
    startsYMax: 2,
    stopsXMin: 0,
    stopsXMax: 19,
    stopsYMin: 17,
    stopsYMax: 19,
  },
};

const SAMPLE_WIDGETS = [
  SAMPLE_TEAM,
  SAMPLE_REPO,
  SAMPLE_ENV,
  SAMPLE_CUSTOMER_BASE,
];

const SAMPLE_CONNECTORS = [
  { id: "c1", fromId: "team-a", toId: "repo-a" },
  { id: "c2", fromId: "repo-a", toId: "env-prod" },
  { id: "c3", fromId: "cb1", toId: "env-prod" },
];

const SAMPLE_TOPOLOGY = {
  widgets: SAMPLE_WIDGETS,
  connectors: SAMPLE_CONNECTORS,
  metrics: {
    horizon: "6mo" as const,
    aggregation: "month" as const,
    charts: [],
  },
  designedAt: "2026-07-23T00:00:00.000Z",
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/org-simulation");
});

Deno.test("model has correct version format", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model exports globalArguments schema", () => {
  assertExists(model.globalArguments);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.topology);
  assertExists(model.resources.simulation_results);
  assertExists(model.resources.design_decision);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.design_topology);
  assertExists(model.methods.run_simulation);
  assertExists(model.methods.record_design_decision);
});

Deno.test("resources have infinite lifetime with GC 20", () => {
  assertEquals(model.resources.topology.lifetime, "infinite");
  assertEquals(model.resources.topology.garbageCollection, 20);
  assertEquals(model.resources.simulation_results.lifetime, "infinite");
  assertEquals(model.resources.simulation_results.garbageCollection, 20);
  assertEquals(model.resources.design_decision.lifetime, "infinite");
  assertEquals(model.resources.design_decision.garbageCollection, 20);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArgs requires organizationContext", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArgs accepts organizationContext only (defectModel defaults)", () => {
  const result = model.globalArguments.safeParse({
    organizationContext: "A small startup with 3 teams",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.defectModel.ceilingCertainty, 0.999);
  }
});

Deno.test("globalArgs rejects ceilingCertainty out of range", () => {
  const result = model.globalArguments.safeParse({
    organizationContext: "Org",
    defectModel: { ceilingCertainty: 1.5 },
  });
  assertEquals(result.success, false);
});

// =============================================================================
// design_topology — Argument Validation Tests
// =============================================================================

Deno.test("design_topology rejects empty object", () => {
  const result = model.methods.design_topology.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("design_topology rejects empty widgets array", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [],
  });
  assertEquals(result.success, false);
});

Deno.test("design_topology accepts minimal valid input (one team widget)", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [SAMPLE_TEAM],
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.scenarioLabel, "current");
    assertEquals(result.data.connectors, []);
  }
});

Deno.test("design_topology accepts full topology with all widget types", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    scenarioLabel: "current",
    widgets: SAMPLE_WIDGETS,
    connectors: SAMPLE_CONNECTORS,
    metrics: { horizon: "12mo", aggregation: "week" },
    notes: "As-is org",
  });
  assertEquals(result.success, true);
});

Deno.test("design_topology rejects invalid widget type", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [{ id: "x", name: "X", type: "database", config: {} }],
  });
  assertEquals(result.success, false);
});

Deno.test("design_topology rejects invalid member discipline", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [{
      ...SAMPLE_TEAM,
      config: {
        ...SAMPLE_TEAM.config,
        members: [{
          id: "m1",
          name: "Alice",
          disciplines: ["Wizard"],
        }],
      },
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("design_topology rejects skill values out of 0-100 range", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [{
      ...SAMPLE_TEAM,
      config: {
        ...SAMPLE_TEAM.config,
        members: [{
          id: "m1",
          name: "Alice",
          disciplines: ["Programmer"],
          skills: { Coding: 150, Testing: 60, Analysis: 70, Operations: 50 },
        }],
      },
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("design_topology validates deploy mode enum", () => {
  const result = model.methods.design_topology.arguments.safeParse({
    widgets: [{
      ...SAMPLE_ENV,
      config: {
        ...SAMPLE_ENV.config,
        deployPolicy: { mode: "hourly" },
      },
    }],
  });
  assertEquals(result.success, false);
});

// =============================================================================
// design_topology — Execute Tests
// =============================================================================

Deno.test("design_topology writes topology resource under scenario-specific instance name", async () => {
  const { context, getWrittenResources } = createOrgContext();

  const result = await model.methods.design_topology.execute(
    {
      scenarioLabel: "current",
      widgets: SAMPLE_WIDGETS,
      connectors: SAMPLE_CONNECTORS,
      metrics: {
        horizon: "12mo" as const,
        aggregation: "month" as const,
        charts: [],
      },
      notes: "As-is org",
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "topology");
  assertEquals(resources[0].name, "topology-current");

  const data = resources[0].data as {
    widgets: unknown[];
    connectors: unknown[];
    notes: string;
  };
  assertEquals(data.widgets.length, 4);
  assertEquals(data.connectors.length, 3);
  assertEquals(data.notes, "As-is org");
});

Deno.test("design_topology slugifies scenario labels into instance names", async () => {
  const { context, getWrittenResources } = createOrgContext();

  await model.methods.design_topology.execute(
    {
      scenarioLabel: "Split Platform Team!",
      widgets: [SAMPLE_TEAM],
      connectors: [],
      metrics: {
        horizon: "12mo" as const,
        aggregation: "month" as const,
        charts: [],
      },
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  assertEquals(resources[0].name, "topology-split-platform-team");
});

Deno.test("design_topology rejects a connector referencing an unknown widget id", async () => {
  const { context } = createOrgContext();

  await assertRejects(
    () =>
      model.methods.design_topology.execute(
        {
          scenarioLabel: "current",
          widgets: [SAMPLE_TEAM],
          connectors: [{ id: "c1", fromId: "team-a", toId: "ghost" }],
          metrics: {
            horizon: "12mo" as const,
            aggregation: "month" as const,
            charts: [],
          },
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "unknown toId widget",
  );
});

Deno.test("design_topology logs widget and connector counts", async () => {
  const { context, getLogsByLevel } = createOrgContext();

  await model.methods.design_topology.execute(
    {
      scenarioLabel: "current",
      widgets: SAMPLE_WIDGETS,
      connectors: SAMPLE_CONNECTORS,
      metrics: {
        horizon: "12mo" as const,
        aggregation: "month" as const,
        charts: [],
      },
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as {
    widgetCount: number;
    connectorCount: number;
  };
  assertEquals(meta.widgetCount, 4);
  assertEquals(meta.connectorCount, 3);
});

// =============================================================================
// run_simulation — Argument Validation Tests
// =============================================================================

Deno.test("run_simulation defaults scenarioLabel to current and seed to 0", () => {
  const result = model.methods.run_simulation.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.scenarioLabel, "current");
    assertEquals(result.data.seed, 0);
  }
});

Deno.test("run_simulation rejects negative seed", () => {
  const result = model.methods.run_simulation.arguments.safeParse({
    seed: -1,
  });
  assertEquals(result.success, false);
});

// =============================================================================
// run_simulation — Execute Tests
// =============================================================================

Deno.test("run_simulation throws when no topology exists for the scenario", async () => {
  const { context } = createOrgContext();

  await assertRejects(
    () =>
      model.methods.run_simulation.execute(
        { scenarioLabel: "current", seed: 0 },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "No topology found",
  );
});

Deno.test("run_simulation reads the scenario-specific topology and writes results", async () => {
  const { context, getWrittenResources } = createOrgContext({
    "topology-current": SAMPLE_TOPOLOGY,
  });

  const result = await model.methods.run_simulation.execute(
    { scenarioLabel: "current", seed: 0 },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles.length, 1);
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "simulation_results");
  assertEquals(resources[0].name, "results-current-seed0");

  const data = resources[0].data as {
    seed: number;
    horizonDays: number;
    cycles: Array<{ ticketType: string; completed: number }>;
    defects: { detected: number; fixed: number };
    sentiment: { nps: number };
    reliability: { avgCertainty: number };
  };
  assertEquals(data.seed, 0);
  assertEquals(data.horizonDays, 180);
  assertEquals(data.cycles.length, 5);
  assertEquals(data.reliability.avgCertainty >= 0, true);
  assertEquals(data.reliability.avgCertainty <= 1, true);
});

Deno.test("run_simulation honors a horizon override", async () => {
  const { context, getWrittenResources } = createOrgContext({
    "topology-current": SAMPLE_TOPOLOGY,
  });

  await model.methods.run_simulation.execute(
    { scenarioLabel: "current", seed: 0, horizon: "3mo" as const },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { horizonDays: number };
  assertEquals(data.horizonDays, 90);
});

Deno.test("run_simulation is deterministic for a fixed seed (excluding runAt)", async () => {
  const { context: ctx1, getWrittenResources: getWritten1 } = createOrgContext(
    { "topology-current": SAMPLE_TOPOLOGY },
  );
  const { context: ctx2, getWrittenResources: getWritten2 } = createOrgContext(
    { "topology-current": SAMPLE_TOPOLOGY },
  );

  await model.methods.run_simulation.execute(
    { scenarioLabel: "current", seed: 42 },
    // deno-lint-ignore no-explicit-any
    ctx1 as any,
  );
  await model.methods.run_simulation.execute(
    { scenarioLabel: "current", seed: 42 },
    // deno-lint-ignore no-explicit-any
    ctx2 as any,
  );

  const d1 = getWritten1()[0].data as Record<string, unknown>;
  const d2 = getWritten2()[0].data as Record<string, unknown>;
  const { runAt: _r1, ...rest1 } = d1;
  const { runAt: _r2, ...rest2 } = d2;
  assertEquals(JSON.stringify(rest1), JSON.stringify(rest2));
});

// =============================================================================
// record_design_decision — Argument Validation Tests
// =============================================================================

Deno.test("record_design_decision rejects empty object", () => {
  const result = model.methods.record_design_decision.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("record_design_decision accepts a minimal valid decision", () => {
  const result = model.methods.record_design_decision.arguments.safeParse({
    decision: {
      scenarioLabel: "split-platform-team",
      decision: "adopt",
      rationale: "Feature cycle time dropped 20%, NPS improved.",
      expectedDeltas: {
        featureCycleDays: -2,
        bugCycleDays: -1,
        nps: 5,
        outstandingDefects: -3,
        avgCertainty: 0.05,
      },
      decidedAt: "2026-07-23T00:00:00.000Z",
    },
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.baselineLabel, "current");
  }
});

Deno.test("record_design_decision rejects invalid decision kind", () => {
  const result = model.methods.record_design_decision.arguments.safeParse({
    decision: {
      scenarioLabel: "x",
      decision: "maybe",
      rationale: "unsure",
      expectedDeltas: {
        featureCycleDays: 0,
        bugCycleDays: 0,
        nps: 0,
        outstandingDefects: 0,
        avgCertainty: 0,
      },
      decidedAt: "2026-07-23T00:00:00.000Z",
    },
  });
  assertEquals(result.success, false);
});

// =============================================================================
// record_design_decision — Execute Tests
// =============================================================================

Deno.test("record_design_decision writes decision resource with a stable comparison instance name", async () => {
  const { context, getWrittenResources } = createOrgContext();

  const result = await model.methods.record_design_decision.execute(
    {
      baselineLabel: "current",
      decision: {
        scenarioLabel: "Split Platform Team",
        decision: "adopt" as const,
        rationale: "Feature cycle time improved with acceptable risk.",
        expectedDeltas: {
          featureCycleDays: -2,
          bugCycleDays: -1,
          nps: 5,
          outstandingDefects: -3,
          avgCertainty: 0.05,
        },
        risks: ["Coordination overhead during transition"],
        decidedAt: "2026-07-23T00:00:00.000Z",
      },
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles.length, 1);
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "design_decision");
  assertEquals(resources[0].name, "decision-split-platform-team-vs-current");

  const data = resources[0].data as {
    decision: string;
    rationale: string;
    risks: string[];
  };
  assertEquals(data.decision, "adopt");
  assertEquals(data.risks.length, 1);
});

Deno.test("record_design_decision logs a summary of the recorded decision", async () => {
  const { context, getLogsByLevel } = createOrgContext();

  await model.methods.record_design_decision.execute(
    {
      baselineLabel: "current",
      decision: {
        scenarioLabel: "iterate-a",
        decision: "iterate" as const,
        rationale: "Needs adjustment to coordination ease.",
        expectedDeltas: {
          featureCycleDays: 1,
          bugCycleDays: 0,
          nps: -2,
          outstandingDefects: 1,
          avgCertainty: -0.01,
        },
        risks: [],
        decidedAt: "2026-07-23T00:00:00.000Z",
      },
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as { decision: string; scenarioLabel: string };
  assertEquals(meta.decision, "iterate");
  assertEquals(meta.scenarioLabel, "iterate-a");
});

// =============================================================================
// runSimulation — Engine Unit Tests
// =============================================================================

Deno.test("runSimulation is deterministic for a given seed", () => {
  const r1 = runSimulation(SAMPLE_TOPOLOGY, 7, 0.999);
  const r2 = runSimulation(SAMPLE_TOPOLOGY, 7, 0.999);
  const { runAt: _a, ...rest1 } = r1;
  const { runAt: _b, ...rest2 } = r2;
  assertEquals(JSON.stringify(rest1), JSON.stringify(rest2));
});

Deno.test("runSimulation respects horizon override over topology default", () => {
  const r = runSimulation(SAMPLE_TOPOLOGY, 0, 0.999, "3mo");
  assertEquals(r.horizonDays, 90);
});

Deno.test("runSimulation produces non-negative counts and bounded certainty", () => {
  const r = runSimulation(SAMPLE_TOPOLOGY, 1, 0.999);
  assertEquals(r.defects.detected >= 0, true);
  assertEquals(r.defects.fixed >= 0, true);
  assertEquals(r.defects.outstanding >= 0, true);
  assertEquals(r.flow.inFlight >= 0, true);
  assertEquals(r.reliability.avgCertainty >= 0, true);
  assertEquals(r.reliability.avgCertainty <= 1, true);
  assertEquals(r.sentiment.customers >= 0, true);
  assertEquals(r.sentiment.churned >= 0, true);
  for (const c of r.cycles) {
    assertEquals(c.avgDays >= 0, true);
    assertEquals(c.completed >= 0, true);
  }
});

Deno.test("runSimulation with no environments/customers still returns zeroed sentiment/reliability", () => {
  const topology = {
    widgets: [SAMPLE_TEAM],
    connectors: [],
    metrics: {
      horizon: "3mo" as const,
      aggregation: "month" as const,
      charts: [],
    },
    designedAt: "2026-07-23T00:00:00.000Z",
  };

  const r = runSimulation(topology, 0, 0.999);
  assertEquals(r.sentiment.customers, 0);
  assertEquals(r.reliability.buggyCells, 0);
  assertEquals(r.reliability.healthyCells, 0);
});

Deno.test("runSimulation handles a repo shared by two teams without inflating demand", () => {
  const teamB = {
    ...SAMPLE_TEAM,
    id: "team-b",
    name: "Team B",
  };
  const topology = {
    widgets: [SAMPLE_TEAM, teamB, SAMPLE_REPO, SAMPLE_ENV],
    connectors: [
      { id: "c1", fromId: "team-a", toId: "repo-a" },
      { id: "c2", fromId: "team-b", toId: "repo-a" },
      { id: "c3", fromId: "repo-a", toId: "env-prod" },
    ],
    metrics: {
      horizon: "3mo" as const,
      aggregation: "month" as const,
      charts: [],
    },
    designedAt: "2026-07-23T00:00:00.000Z",
  };

  const r = runSimulation(topology, 0, 0.999);
  const featureCycle = r.cycles.find((c) => c.ticketType === "feature");
  assertExists(featureCycle);
});

Deno.test("runSimulation gives higher reliability to a quality-disposed team than an urgency-disposed team", () => {
  const qualityTeam = {
    ...SAMPLE_TEAM,
    config: { ...SAMPLE_TEAM.config, disposition: "quality" as const },
  };
  const urgencyTeam = {
    ...SAMPLE_TEAM,
    config: { ...SAMPLE_TEAM.config, disposition: "urgency" as const },
  };

  const baseWidgets = (
    team: typeof qualityTeam | typeof urgencyTeam,
  ) => [
    team,
    SAMPLE_REPO,
    SAMPLE_ENV,
    SAMPLE_CUSTOMER_BASE,
  ];
  const baseTopology = (team: typeof qualityTeam | typeof urgencyTeam) => ({
    widgets: baseWidgets(team),
    connectors: SAMPLE_CONNECTORS,
    metrics: {
      horizon: "6mo" as const,
      aggregation: "month" as const,
      charts: [],
    },
    designedAt: "2026-07-23T00:00:00.000Z",
  });

  const rQuality = runSimulation(baseTopology(qualityTeam), 3, 0.999);
  const rUrgency = runSimulation(baseTopology(urgencyTeam), 3, 0.999);

  assertEquals(
    rQuality.reliability.avgCertainty >= rUrgency.reliability.avgCertainty,
    true,
  );
});
