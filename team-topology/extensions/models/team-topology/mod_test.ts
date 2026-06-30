// Team Topology Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// =============================================================================
// Helper
// =============================================================================

function createTopologyContext() {
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        organizationContext:
          "Mid-size SaaS company, ~40 engineers across 6 teams",
        scope: "engineering",
      },
    });

  return { context, getWrittenResources, getLogsByLevel };
}

const SAMPLE_TEAM = {
  name: "Payments",
  type: "stream-aligned" as const,
  domains: ["payment processing", "billing"],
  systems: ["payment-api", "billing-service"],
  size: 7,
};

const SAMPLE_TEAM_WITH_LOAD = {
  ...SAMPLE_TEAM,
  cognitiveLoad: {
    intrinsic: 7,
    extraneous: 4,
    germane: 3,
    capacity: 8,
  },
};

const SAMPLE_INTERACTION = {
  source: "Payments",
  target: "Platform",
  mode: "x-as-a-service" as const,
  purpose: "CI/CD and deployment infrastructure",
  duration: "permanent" as const,
  health: "flowing" as const,
};

const SAMPLE_SYSTEM_DEP = {
  from: "payment-api",
  to: "user-service",
  type: "sync" as const,
  ownerFrom: "Payments",
  ownerTo: "Identity",
};

const SAMPLE_STREAM = {
  name: "Feature Delivery",
  purpose: "Ship new features to customers",
  trigger: "Product requirement",
  steps: [
    {
      name: "Design",
      ownerTeam: "Payments",
      leadTimeDays: 3,
      processTimeDays: 2,
      waitTimeDays: 1,
    },
    {
      name: "Implementation",
      ownerTeam: "Payments",
      leadTimeDays: 5,
      processTimeDays: 4,
      waitTimeDays: 1,
    },
    {
      name: "Deploy",
      ownerTeam: "Platform",
      leadTimeDays: 0.5,
      processTimeDays: 0.25,
      waitTimeDays: 0.25,
    },
  ],
  totalLeadTimeDays: 8.5,
};

const SAMPLE_FINDING = {
  id: "CL-01",
  category: "cognitive-load" as const,
  severity: "critical" as const,
  title: "Payments team overloaded",
  description: "Intrinsic + extraneous exceeds capacity",
  affectedTeams: ["Payments"],
  recommendation: "Split team or reduce scope",
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/team-topology");
});

Deno.test("model has correct version format", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model exports globalArguments schema", () => {
  assertExists(model.globalArguments);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.topology);
  assertExists(model.resources.flows);
  assertExists(model.resources.assessment);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.discover_topology);
  assertExists(model.methods.map_flow);
  assertExists(model.methods.record_assessment);
});

// =============================================================================
// Resource Configuration Tests
// =============================================================================

Deno.test("topology resource has infinite lifetime with GC 20", () => {
  assertEquals(model.resources.topology.lifetime, "infinite");
  assertEquals(model.resources.topology.garbageCollection, 20);
});

Deno.test("flows resource has infinite lifetime with GC 20", () => {
  assertEquals(model.resources.flows.lifetime, "infinite");
  assertEquals(model.resources.flows.garbageCollection, 20);
});

Deno.test("assessment resource has infinite lifetime with GC 10", () => {
  assertEquals(model.resources.assessment.lifetime, "infinite");
  assertEquals(model.resources.assessment.garbageCollection, 10);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArgs requires organizationContext", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArgs accepts organizationContext only (scope defaults)", () => {
  const result = model.globalArguments.safeParse({
    organizationContext: "A small startup with 3 teams",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.scope, "full");
  }
});

Deno.test("globalArgs accepts full input", () => {
  const result = model.globalArguments.safeParse({
    organizationContext: "Enterprise org, 500 engineers",
    scope: "platform-division",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// discover_topology — Argument Validation Tests
// =============================================================================

Deno.test("discover_topology rejects empty object", () => {
  const result = model.methods.discover_topology.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("discover_topology rejects empty teams array", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology accepts minimal valid input (one team)", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [{ name: "Alpha", type: "stream-aligned", domains: ["billing"] }],
  });
  assertEquals(result.success, true);
  if (result.success) {
    // defaults applied
    assertEquals(result.data.interactions, []);
    assertEquals(result.data.systemDependencies, []);
  }
});

Deno.test("discover_topology accepts full input with all fields", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [SAMPLE_TEAM_WITH_LOAD],
    interactions: [SAMPLE_INTERACTION],
    systemDependencies: [SAMPLE_SYSTEM_DEP],
    notes: "Discovery session 1",
  });
  assertEquals(result.success, true);
});

Deno.test("discover_topology rejects invalid team type", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [{ name: "Bad", type: "devops", domains: ["stuff"] }],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology rejects invalid interaction mode", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [SAMPLE_TEAM],
    interactions: [{
      source: "A",
      target: "B",
      mode: "partnership",
      purpose: "test",
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology rejects invalid health value", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [SAMPLE_TEAM],
    interactions: [{
      source: "A",
      target: "B",
      mode: "collaboration",
      purpose: "test",
      health: "broken",
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology validates cognitive load bounds", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [{
      name: "Bad",
      type: "platform",
      domains: ["infra"],
      cognitiveLoad: { intrinsic: 11, extraneous: 5, germane: 3, capacity: 8 },
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology validates system dependency types", () => {
  const result = model.methods.discover_topology.arguments.safeParse({
    teams: [SAMPLE_TEAM],
    systemDependencies: [{
      from: "a",
      to: "b",
      type: "grpc",
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("discover_topology accepts all valid team types", () => {
  for (
    const type of [
      "stream-aligned",
      "enabling",
      "complicated-subsystem",
      "platform",
    ]
  ) {
    const result = model.methods.discover_topology.arguments.safeParse({
      teams: [{ name: "T", type, domains: ["d"] }],
    });
    assertEquals(result.success, true, `type "${type}" should be accepted`);
  }
});

Deno.test("discover_topology accepts all valid interaction modes", () => {
  for (const mode of ["collaboration", "x-as-a-service", "facilitating"]) {
    const result = model.methods.discover_topology.arguments.safeParse({
      teams: [SAMPLE_TEAM],
      interactions: [{
        source: "A",
        target: "B",
        mode,
        purpose: "test",
      }],
    });
    assertEquals(result.success, true, `mode "${mode}" should be accepted`);
  }
});

// =============================================================================
// discover_topology — Execute Tests
// =============================================================================

Deno.test("discover_topology writes topology resource with correct data", async () => {
  const { context, getWrittenResources } = createTopologyContext();

  const result = await model.methods.discover_topology.execute(
    {
      teams: [SAMPLE_TEAM, { name: "Platform", type: "platform" as const, domains: ["infra"], systems: [] }],
      interactions: [SAMPLE_INTERACTION],
      systemDependencies: [SAMPLE_SYSTEM_DEP],
      notes: "First pass",
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
    teams: Array<{ name: string }>;
    interactions: Array<{ source: string }>;
    systemDependencies: Array<{ from: string }>;
    discoveredAt: string;
    notes: string;
  };
  assertEquals(data.teams.length, 2);
  assertEquals(data.teams[0].name, "Payments");
  assertEquals(data.interactions.length, 1);
  assertEquals(data.systemDependencies.length, 1);
  assertExists(data.discoveredAt);
  assertEquals(data.notes, "First pass");
});

Deno.test("discover_topology logs team and interaction counts", async () => {
  const { context, getLogsByLevel } = createTopologyContext();

  await model.methods.discover_topology.execute(
    {
      teams: [SAMPLE_TEAM],
      interactions: [SAMPLE_INTERACTION, { ...SAMPLE_INTERACTION, target: "DevEx" }],
      systemDependencies: [],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as {
    teamCount: number;
    interactionCount: number;
    depCount: number;
  };
  assertEquals(meta.teamCount, 1);
  assertEquals(meta.interactionCount, 2);
  assertEquals(meta.depCount, 0);
});

// =============================================================================
// map_flow — Argument Validation Tests
// =============================================================================

Deno.test("map_flow rejects empty object", () => {
  const result = model.methods.map_flow.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("map_flow rejects empty streams array", () => {
  const result = model.methods.map_flow.arguments.safeParse({
    streams: [],
  });
  assertEquals(result.success, false);
});

Deno.test("map_flow accepts minimal stream (name, purpose, steps)", () => {
  const result = model.methods.map_flow.arguments.safeParse({
    streams: [{
      name: "Incident Response",
      purpose: "Restore service",
      steps: [{ name: "Triage", ownerTeam: "SRE" }],
    }],
  });
  assertEquals(result.success, true);
});

Deno.test("map_flow accepts full stream with all metrics", () => {
  const result = model.methods.map_flow.arguments.safeParse({
    streams: [SAMPLE_STREAM],
  });
  assertEquals(result.success, true);
});

Deno.test("map_flow validates percentCompleteAccurate bounds (0-100)", () => {
  const result = model.methods.map_flow.arguments.safeParse({
    streams: [{
      name: "Bad",
      purpose: "Test",
      steps: [{
        name: "Step",
        ownerTeam: "T",
        percentCompleteAccurate: 150,
      }],
    }],
  });
  assertEquals(result.success, false);
});

Deno.test("map_flow accepts multiple streams", () => {
  const result = model.methods.map_flow.arguments.safeParse({
    streams: [
      SAMPLE_STREAM,
      {
        name: "Incident",
        purpose: "Fix outages",
        steps: [{ name: "Triage", ownerTeam: "On-call" }],
      },
    ],
  });
  assertEquals(result.success, true);
});

// =============================================================================
// map_flow — Execute Tests
// =============================================================================

Deno.test("map_flow writes flows resource with correct data", async () => {
  const { context, getWrittenResources } = createTopologyContext();

  const result = await model.methods.map_flow.execute(
    { streams: [SAMPLE_STREAM] },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "flows");
  assertEquals(resources[0].name, "flows-current");

  const data = resources[0].data as {
    streams: Array<{ name: string; steps: Array<{ name: string }> }>;
    mappedAt: string;
  };
  assertEquals(data.streams.length, 1);
  assertEquals(data.streams[0].name, "Feature Delivery");
  assertEquals(data.streams[0].steps.length, 3);
  assertExists(data.mappedAt);
});

Deno.test("map_flow logs stream and step counts", async () => {
  const { context, getLogsByLevel } = createTopologyContext();

  await model.methods.map_flow.execute(
    { streams: [SAMPLE_STREAM, { ...SAMPLE_STREAM, name: "Second", steps: [{ name: "S1", ownerTeam: "T" }] }] },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as { streamCount: number; stepCount: number };
  assertEquals(meta.streamCount, 2);
  assertEquals(meta.stepCount, 4); // 3 from SAMPLE + 1 from second
});

// =============================================================================
// record_assessment — Argument Validation Tests
// =============================================================================

Deno.test("record_assessment rejects empty object", () => {
  const result = model.methods.record_assessment.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("record_assessment rejects empty findings array", () => {
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [],
    summary: "Nothing found",
  });
  assertEquals(result.success, false);
});

Deno.test("record_assessment rejects missing summary", () => {
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [SAMPLE_FINDING],
  });
  assertEquals(result.success, false);
});

Deno.test("record_assessment accepts valid input", () => {
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [SAMPLE_FINDING],
    summary: "One critical finding identified",
  });
  assertEquals(result.success, true);
});

Deno.test("record_assessment validates finding category enum", () => {
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [{ ...SAMPLE_FINDING, category: "performance" }],
    summary: "test",
  });
  assertEquals(result.success, false);
});

Deno.test("record_assessment validates finding severity enum", () => {
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [{ ...SAMPLE_FINDING, severity: "high" }],
    summary: "test",
  });
  assertEquals(result.success, false);
});

Deno.test("record_assessment accepts all valid categories", () => {
  const categories = [
    "cognitive-load",
    "conways-mismatch",
    "interaction-friction",
    "bottleneck",
    "missing-team",
    "team-coupling",
    "culture",
    "other",
  ];
  for (const category of categories) {
    const result = model.methods.record_assessment.arguments.safeParse({
      findings: [{ ...SAMPLE_FINDING, category }],
      summary: "test",
    });
    assertEquals(
      result.success,
      true,
      `category "${category}" should be accepted`,
    );
  }
});

Deno.test("record_assessment accepts all valid severities", () => {
  for (const severity of ["info", "warning", "critical"]) {
    const result = model.methods.record_assessment.arguments.safeParse({
      findings: [{ ...SAMPLE_FINDING, severity }],
      summary: "test",
    });
    assertEquals(
      result.success,
      true,
      `severity "${severity}" should be accepted`,
    );
  }
});

Deno.test("record_assessment allows optional recommendation", () => {
  const findingNoRec = { ...SAMPLE_FINDING };
  delete (findingNoRec as Record<string, unknown>).recommendation;
  const result = model.methods.record_assessment.arguments.safeParse({
    findings: [findingNoRec],
    summary: "test",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// record_assessment — Execute Tests
// =============================================================================

Deno.test("record_assessment writes assessment resource with correct data", async () => {
  const { context, getWrittenResources } = createTopologyContext();

  const result = await model.methods.record_assessment.execute(
    {
      findings: [SAMPLE_FINDING, { ...SAMPLE_FINDING, id: "IF-01", category: "interaction-friction" as const, severity: "warning" as const }],
      summary: "Two findings: one critical, one warning",
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "assessment");
  assertEquals(resources[0].name, "assessment-current");

  const data = resources[0].data as {
    findings: Array<{ id: string; severity: string }>;
    summary: string;
    assessedAt: string;
  };
  assertEquals(data.findings.length, 2);
  assertEquals(data.summary, "Two findings: one critical, one warning");
  assertExists(data.assessedAt);
});

Deno.test("record_assessment logs severity breakdown", async () => {
  const { context, getLogsByLevel } = createTopologyContext();

  await model.methods.record_assessment.execute(
    {
      findings: [
        SAMPLE_FINDING,
        { ...SAMPLE_FINDING, id: "W-01", severity: "warning" as const },
        { ...SAMPLE_FINDING, id: "W-02", severity: "warning" as const },
        { ...SAMPLE_FINDING, id: "I-01", severity: "info" as const },
      ],
      summary: "Mixed severity",
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
  assertEquals(meta.total, 4);
  assertEquals(meta.critical, 1);
  assertEquals(meta.warning, 2);
  assertEquals(meta.info, 1);
});
