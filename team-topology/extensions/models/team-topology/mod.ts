/**
 * Team Topology Model
 *
 * Agent-guided discovery and versioned snapshot model for team topologies,
 * value stream mapping, and organizational design assessment.
 *
 * Draws on:
 * - Team Topologies (Skelton & Pais): 4 team types, 3 interaction modes
 * - Conway's Law: team structure = system architecture
 * - Westrum typology: culture predicts information flow
 * - GROWS tracer bullets: thin end-to-end slices reveal integration friction
 * - Ruth Malan: architecture as hypothesis, evolutionary design
 *
 * Design: snapshot-based (like ddd-guidance's contextMap). One topology
 * resource containing all teams, interactions, and system mappings —
 * versioned atomically. The agent discovers incrementally through
 * conversation but writes the full topology each time.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas — Team Topologies Domain
// =============================================================================

const TeamTypeSchema = z.enum([
  "stream-aligned",
  "enabling",
  "complicated-subsystem",
  "platform",
]);

const InteractionModeSchema = z.enum([
  "collaboration",
  "x-as-a-service",
  "facilitating",
]);

const CognitiveLoadSchema = z.object({
  intrinsic: z.number().min(0).max(10).describe(
    "Load from the core domain complexity the team owns (0-10)",
  ),
  extraneous: z.number().min(0).max(10).describe(
    "Load from environment/tooling/process overhead (0-10)",
  ),
  germane: z.number().min(0).max(10).describe(
    "Load invested in learning and improving (0-10, higher is good)",
  ),
  capacity: z.number().min(0).max(10).default(7).describe(
    "Team's total cognitive capacity (0-10, typically 7-8 for a well-staffed team)",
  ),
});

const WestumCultureSchema = z.enum([
  "pathological",
  "bureaucratic",
  "generative",
]);

const TeamSchema = z.object({
  name: z.string().describe("Team name"),
  type: TeamTypeSchema.describe("Team Topologies fundamental team type"),
  domains: z.array(z.string()).describe(
    "Business domains or bounded contexts this team owns",
  ),
  systems: z.array(z.string()).default([]).describe(
    "Systems, services, or repositories this team owns",
  ),
  cognitiveLoad: CognitiveLoadSchema.optional().describe(
    "Cognitive load assessment (optional — fill during assess phase)",
  ),
  size: z.number().optional().describe("Number of team members"),
  culture: WestumCultureSchema.optional().describe(
    "Westrum culture assessment (optional)",
  ),
  notes: z.string().optional().describe(
    "Freeform context about the team",
  ),
});

const InteractionSchema = z.object({
  source: z.string().describe("Source team name"),
  target: z.string().describe("Target team name"),
  mode: InteractionModeSchema.describe(
    "Current interaction mode between teams",
  ),
  purpose: z.string().describe("Why these teams interact"),
  duration: z.enum(["permanent", "temporary", "evolving"]).default("permanent")
    .describe(
      "Is this interaction intended to be permanent or time-boxed?",
    ),
  health: z.enum(["flowing", "friction", "blocked"]).default("flowing")
    .describe("Current health signal for this interaction"),
  notes: z.string().optional(),
});

const SystemDependencySchema = z.object({
  from: z.string().describe("Consuming system/service name"),
  to: z.string().describe("Providing system/service name"),
  type: z.enum(["sync", "async", "shared-db", "file", "manual"]).describe(
    "Nature of the dependency",
  ),
  ownerFrom: z.string().optional().describe("Team owning the consumer"),
  ownerTo: z.string().optional().describe("Team owning the provider"),
});

// --- Topology snapshot (the primary resource) ---

const TopologySchema = z.object({
  teams: z.array(TeamSchema),
  interactions: z.array(InteractionSchema),
  systemDependencies: z.array(SystemDependencySchema).default([]),
  discoveredAt: z.string(),
  notes: z.string().optional().describe("Context about this topology snapshot"),
});

// --- Value Stream Flows ---

const FlowStepSchema = z.object({
  name: z.string().describe(
    "Step name (e.g., 'Code Review', 'Deploy to Staging')",
  ),
  ownerTeam: z.string().describe("Team responsible for this step"),
  leadTimeDays: z.number().optional().describe(
    "Total time from step start to step done (calendar days)",
  ),
  processTimeDays: z.number().optional().describe(
    "Actual hands-on work time within this step (days)",
  ),
  waitTimeDays: z.number().optional().describe(
    "Time spent waiting/queued before work begins (days)",
  ),
  percentCompleteAccurate: z.number().min(0).max(100).optional().describe(
    "%C&A — what percentage of work arrives from upstream without rework needed",
  ),
  notes: z.string().optional(),
});

const ValueStreamSchema = z.object({
  name: z.string().describe("Value stream name"),
  purpose: z.string().describe(
    "What value does this stream deliver and to whom",
  ),
  trigger: z.string().optional().describe("What initiates work in this stream"),
  steps: z.array(FlowStepSchema),
  totalLeadTimeDays: z.number().optional().describe(
    "End-to-end lead time (can be computed from steps or measured directly)",
  ),
  notes: z.string().optional(),
});

const FlowsSchema = z.object({
  streams: z.array(ValueStreamSchema),
  mappedAt: z.string(),
});

// --- Assessments (agent-produced findings) ---

const FindingSchema = z.object({
  id: z.string().describe("Short finding ID (e.g., CL-01, CW-03)"),
  category: z.enum([
    "cognitive-load",
    "conways-mismatch",
    "interaction-friction",
    "bottleneck",
    "missing-team",
    "team-coupling",
    "culture",
    "other",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  description: z.string(),
  affectedTeams: z.array(z.string()),
  recommendation: z.string().optional(),
});

const AssessmentSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string().describe("Brief narrative summary of the assessment"),
  assessedAt: z.string(),
});

// =============================================================================
// GlobalArgs
// =============================================================================

const GlobalArgsSchema = z.object({
  organizationContext: z.string().describe(
    "Brief description of the organization, its size, and primary business",
  ),
  scope: z.string().default("full").describe(
    "Scope of this topology instance: 'full' org, a division name, or a product area",
  ),
});

// =============================================================================
// Method Argument Schemas
// =============================================================================

const DiscoverTopologyArgsSchema = z.object({
  teams: z.array(TeamSchema).min(1).describe(
    "Teams discovered through conversation",
  ),
  interactions: z.array(InteractionSchema).default([]).describe(
    "Interactions between teams",
  ),
  systemDependencies: z.array(SystemDependencySchema).default([]).describe(
    "System-level dependencies that cross team boundaries",
  ),
  notes: z.string().optional().describe(
    "Context about this discovery session",
  ),
});

const MapFlowArgsSchema = z.object({
  streams: z.array(ValueStreamSchema).min(1).describe(
    "Value streams mapped through conversation",
  ),
});

const RecordAssessmentArgsSchema = z.object({
  findings: z.array(FindingSchema).min(1).describe(
    "Findings from analyzing the topology and flows",
  ),
  summary: z.string().describe(
    "Brief narrative summary of the assessment",
  ),
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
// Model Definition
// =============================================================================

/** Team topology and value stream mapping model. */
export const model = {
  type: "@webframp/team-topology",
  version: "2026.07.18.1",
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,

  resources: {
    topology: {
      description:
        "Snapshot of team structure, interactions, and system ownership",
      schema: TopologySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    flows: {
      description: "Value stream maps with step-level metrics",
      schema: FlowsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    assessment: {
      description:
        "Agent-produced findings about the topology (load, mismatches, friction)",
      schema: AssessmentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    discover_topology: {
      description:
        `Discover and record team topology through structured conversation.

AGENT GUIDANCE:

You are mapping an organization's team structure using Team Topologies
concepts. Guide the conversation through these phases:

1. TEAM INVENTORY
   Ask: "What teams exist in this area? For each team, what is their
   primary responsibility?" List them out. Don't worry about classification
   yet — just get names and purposes.

2. TEAM TYPE CLASSIFICATION
   For each team, determine its fundamental type:
   - stream-aligned: delivers value directly to customers/users along a
     flow of work (most teams should be this)
   - enabling: helps stream-aligned teams acquire missing capabilities
     (temporary, teaching-focused)
   - complicated-subsystem: owns a subsystem requiring deep specialist
     knowledge (math, legacy, hardware interfaces)
   - platform: provides self-service capabilities that reduce cognitive
     load for stream-aligned teams

   Ask: "Does this team deliver value directly to end-users, or does it
   exist to support other teams?" and "Does this team own something that
   requires deep specialist knowledge most engineers wouldn't have?"

3. DOMAIN & SYSTEM OWNERSHIP
   For each team, ask: "What business domains does this team own? What
   services, repos, or systems do they maintain?"
   Look for Conway's Law signals — does system ownership match team
   boundaries cleanly, or are there shared systems?

4. COGNITIVE LOAD (optional, can defer to assess phase)
   For key teams, ask: "On a 0-10 scale, how much mental load comes from:
   (a) the core domain complexity they deal with (intrinsic),
   (b) environment/tooling/process overhead (extraneous),
   (c) learning and improving (germane)?"
   If intrinsic + extraneous approaches or exceeds capacity, that team
   is overloaded.

5. INTERACTION MAPPING
   Ask: "Which teams depend on each other? For each dependency:
   - Are they actively collaborating (shared work, pairing)?
   - Is one providing a service the other consumes (x-as-a-service)?
   - Is one helping the other build a capability (facilitating)?"
   Also capture health: is the interaction flowing smoothly, causing
   friction, or effectively blocked?

6. SYSTEM DEPENDENCIES (optional)
   Ask: "Are there system-level dependencies that cross team boundaries?
   APIs team A consumes from team B's service? Shared databases?"

After the conversation, call this method with the complete topology.
Each call writes a new version — run it again as understanding deepens.
Start with a tracer bullet: map ONE value stream's teams first, then expand.`,
      arguments: DiscoverTopologyArgsSchema,
      execute: async (
        args: z.infer<typeof DiscoverTopologyArgsSchema>,
        context: MethodContext,
      ) => {
        const topology = {
          teams: args.teams,
          interactions: args.interactions,
          systemDependencies: args.systemDependencies,
          discoveredAt: new Date().toISOString(),
          notes: args.notes,
        };

        const handle = await context.writeResource(
          "topology",
          "topology-current",
          topology as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Topology written: {teamCount} teams, {interactionCount} interactions, {depCount} system deps",
          {
            teamCount: args.teams.length,
            interactionCount: args.interactions.length,
            depCount: args.systemDependencies.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    map_flow: {
      description: `Map value streams through structured conversation.

AGENT GUIDANCE:

You are mapping how work flows through the organization end-to-end.
Use a tracer-bullet approach: pick ONE flow first, map it completely,
then add more.

1. STREAM IDENTIFICATION
   Ask: "What are the main flows of work in this area? Think about it
   from trigger to customer outcome. Examples:
   - Feature request → shipped feature
   - Incident → resolution
   - New hire → productive engineer
   - Security finding → remediated"
   Pick the most important or most painful one to map first.

2. STEP MAPPING
   For the chosen stream, ask: "Walk me through the steps from trigger
   to done. For each step, who does the work?"
   Capture the step name and which team owns it. Look for handoffs —
   places where work moves from one team to another.

3. FLOW METRICS (optional — can be estimated or measured)
   For each step, ask:
   - "How long does this step typically take end-to-end?" (lead time)
   - "Of that time, how much is actual work vs waiting?" (process vs wait)
   - "What percentage of work arriving at this step is usable without
     rework?" (%C&A — percent complete and accurate)

   Don't force precision. "About a day" or "a few hours" is fine.
   The goal is to identify bottlenecks, not produce a precise model.

4. BOTTLENECK IDENTIFICATION
   Look for:
   - Steps with high wait time relative to process time (queuing)
   - Steps with low %C&A (upstream quality problems)
   - Handoffs between teams (coordination overhead)
   - Steps that multiple value streams share (contention)

After the conversation, call this method with the mapped streams.
Each call replaces the flows resource — include ALL streams, not just new ones.`,
      arguments: MapFlowArgsSchema,
      execute: async (
        args: z.infer<typeof MapFlowArgsSchema>,
        context: MethodContext,
      ) => {
        const flows = {
          streams: args.streams,
          mappedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "flows",
          "flows-current",
          flows as unknown as Record<string, unknown>,
        );

        const totalSteps = args.streams.reduce(
          (sum, s) => sum + s.steps.length,
          0,
        );
        context.logger.info(
          "Flows written: {streamCount} streams, {stepCount} total steps",
          { streamCount: args.streams.length, stepCount: totalSteps },
        );

        return { dataHandles: [handle] };
      },
    },

    record_assessment: {
      description: `Record an assessment of the current topology and flows.

AGENT GUIDANCE:

You have read the topology and flows resources. Now analyze them for
problems and opportunities. Look for these categories of findings:

1. COGNITIVE LOAD
   - Teams where intrinsic + extraneous exceeds capacity
   - Teams owning too many domains or systems
   - Platform teams that are actually doing stream-aligned work

2. CONWAY'S LAW MISMATCHES
   - System dependencies that don't match team interaction patterns
   - Teams that own systems they shouldn't (organizational accident)
   - Communication paths forced by architecture that don't match
     desired team interactions

3. INTERACTION FRICTION
   - Collaboration mode that should have evolved to x-as-a-service
     (collaboration is expensive — it should be temporary)
   - Blocked interactions (teams that need something but can't get it)
   - Missing facilitating relationships (teams struggling alone)

4. VALUE STREAM BOTTLENECKS
   - Steps with wait time >> process time
   - Handoffs between teams (each is a queue)
   - Low %C&A (rework loops)
   - Single team appearing in many unrelated value streams (overload)

5. STRUCTURAL ISSUES
   - Missing team types (no platform team but every team builds infra)
   - Teams that should split (too many responsibilities)
   - Teams that should merge (unnecessary handoff between them)

For each finding, assign:
- A short ID (CL-01, CW-01, IF-01, BN-01, etc.)
- A severity: info (observation), warning (should address), critical (blocking flow)
- Affected teams
- A recommendation if you have one

Write a brief summary narrative tying the findings together.`,
      arguments: RecordAssessmentArgsSchema,
      execute: async (
        args: z.infer<typeof RecordAssessmentArgsSchema>,
        context: MethodContext,
      ) => {
        const assessment = {
          findings: args.findings,
          summary: args.summary,
          assessedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "assessment",
          "assessment-current",
          assessment as unknown as Record<string, unknown>,
        );

        const bySeverity = args.findings.reduce(
          (acc, f) => {
            acc[f.severity] = (acc[f.severity] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );

        context.logger.info(
          "Assessment written: {total} findings ({critical} critical, {warning} warning, {info} info)",
          {
            total: args.findings.length,
            critical: bySeverity.critical || 0,
            warning: bySeverity.warning || 0,
            info: bySeverity.info || 0,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
