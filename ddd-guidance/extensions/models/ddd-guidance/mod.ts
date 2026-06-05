// DDD Guidance Model
// Guides teams through applying Domain-Driven Design to an existing project.
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  projectContext: z.string().describe(
    "Brief description of the project, its domain, and team structure",
  ),
  teamSize: z
    .enum(["solo", "small", "medium", "large"])
    .default("small")
    .describe("Team size: solo (1), small (2-5), medium (6-12), large (13+)"),
  existingPatterns: z.array(z.string()).default([]).describe(
    "Architectural patterns already in use (e.g., microservices, monolith, event-driven)",
  ),
});

// --- Context Map resource schema ---

const RelationshipTypeSchema = z.enum([
  "partnership",
  "shared-kernel",
  "customer-supplier",
  "conformist",
  "anticorruption-layer",
  "open-host-service",
  "published-language",
  "separate-ways",
  "big-ball-of-mud",
]);

const ContextRelationshipSchema = z.object({
  upstream: z.string(),
  downstream: z.string(),
  type: RelationshipTypeSchema,
  description: z.string(),
});

const BoundedContextSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  ownerTeam: z.string().optional(),
  ubiquitousLanguageTerms: z.array(z.string()),
  coreSubdomain: z.boolean(),
});

const ContextMapSchema = z.object({
  contexts: z.array(BoundedContextSchema),
  relationships: z.array(ContextRelationshipSchema),
  overloadedTerms: z.array(z.object({
    term: z.string(),
    meanings: z.array(z.object({
      context: z.string(),
      definition: z.string(),
    })),
  })),
  discoveredAt: z.string(),
});

// --- Domain Glossary resource schema ---

const GlossaryEntrySchema = z.object({
  term: z.string(),
  context: z.string(),
  definition: z.string(),
  examples: z.array(z.string()),
  relatedTerms: z.array(z.string()),
  antiPatterns: z.array(z.string()).optional(),
});

const DomainGlossarySchema = z.object({
  entries: z.array(GlossaryEntrySchema),
  updatedAt: z.string(),
});

// --- Boundaries resource schema ---

const InvariantSchema = z.object({
  description: z.string(),
  transactional: z.boolean(),
  rationale: z.string(),
});

const AggregateDesignSchema = z.object({
  name: z.string(),
  context: z.string(),
  rootEntity: z.string(),
  entities: z.array(z.string()),
  valueObjects: z.array(z.string()),
  invariants: z.array(InvariantSchema),
  identityReferences: z.array(z.object({
    target: z.string(),
    reason: z.string(),
  })),
  eventsTrigger: z.array(z.string()),
});

const BoundariesSchema = z.object({
  aggregates: z.array(AggregateDesignSchema),
  eventualConsistencyRules: z.array(z.object({
    trigger: z.string(),
    affectedAggregates: z.array(z.string()),
    tolerableDelay: z.string(),
    rationale: z.string(),
  })),
  discoveredAt: z.string(),
});

// =============================================================================
// Context type shorthand
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

/** DDD guidance model — bounded context discovery, ubiquitous language capture, aggregate boundary design. */
export const model = {
  type: "@webframp/ddd-guidance",
  version: "2026.06.05.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    contextMap: {
      description:
        "Discovered bounded contexts, their relationships, and overloaded terms",
      schema: ContextMapSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    domainGlossary: {
      description:
        "Per-context term glossary capturing ubiquitous language definitions",
      schema: DomainGlossarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    boundaries: {
      description:
        "Aggregate designs with invariants, identity references, and consistency rules",
      schema: BoundariesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    contexts: {
      description: `Discover bounded contexts through structured conversation.

Guide the discussion through these phases:

1. TERM INVENTORY
   Ask: "What are the core terms in your domain? List the nouns your team
   uses daily — things like 'order', 'customer', 'deployment', 'incident'."
   For each term, ask: "Does this word mean the same thing to everyone
   on every team?" Record where terms are overloaded.

2. OWNERSHIP BOUNDARIES
   Ask: "Who owns what? Which teams or people are responsible for
   which parts of the system?" Map team boundaries — Conway's Law
   tells us these often align with context boundaries.

3. RATE OF CHANGE
   Ask: "Which parts of the system change together? Which parts change
   independently?" Things that change independently are likely separate
   contexts. Things forced to change together may be inappropriately coupled.

4. CONTEXT IDENTIFICATION
   From the overloaded terms, ownership boundaries, and change rates,
   propose bounded context boundaries. Each context should have:
   - A clear purpose (one sentence)
   - Its own meaning for shared terms
   - An identifiable owner or team
   - Independence from other contexts for most changes

5. RELATIONSHIP MAPPING
   For each pair of related contexts, determine the relationship type
   (use these exact values in the resource):
   - partnership: teams cooperate, evolve together
   - customer-supplier: downstream has veto power over upstream changes
   - conformist: downstream accepts upstream's model as-is
   - anticorruption-layer: downstream translates upstream concepts
   - shared-kernel: small shared model both teams maintain
   - open-host-service: upstream provides a protocol for many consumers
   - published-language: shared interchange format (JSON schema, protobuf)
   - separate-ways: no integration, independent
   - big-ball-of-mud: no clear boundaries (identify to improve)

6. CORE DOMAIN IDENTIFICATION
   Ask: "Which of these contexts represents your competitive advantage
   or primary business value?" Mark it as the core subdomain. The rest
   are supporting or generic subdomains. Strategic investment should
   concentrate on the core.

Write the contextMap resource with contexts, relationships, and
overloaded terms. This resource evolves — run this method again as
understanding deepens.`,
      arguments: z.object({
        focus: z.string().optional().describe(
          "Optional: narrow discovery to a specific area of the system",
        ),
      }),
      execute: async (
        args: { focus?: string },
        context: MethodContext,
      ) => {
        const { projectContext, existingPatterns } = context.globalArgs;

        const contextMap = {
          contexts: [] as z.infer<typeof BoundedContextSchema>[],
          relationships: [] as z.infer<typeof ContextRelationshipSchema>[],
          overloadedTerms: [] as Array<{
            term: string;
            meanings: Array<{ context: string; definition: string }>;
          }>,
          discoveredAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "contextMap",
          "current",
          contextMap as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Context map initialized for {project}. Existing patterns: [{patterns}]. Focus: {focus}",
          {
            project: projectContext,
            patterns: existingPatterns.join(", "),
            focus: args.focus ?? "full system",
          },
        );

        return { dataHandles: [handle] };
      },
    },

    language: {
      description: `Capture ubiquitous language for a bounded context.

Guide the conversation through these phases:

1. CONTEXT SELECTION
   Read the contextMap resource. Present the discovered bounded contexts.
   Ask: "Which context should we define language for?" If a 'context'
   argument is provided, use that directly.

2. TERM ELICITATION
   For the selected context, ask: "What are the essential nouns, verbs,
   and adjectives in this context? Think of the terms a new team member
   would need to learn before they could have a productive conversation
   about this part of the system."

3. DEFINITION PRECISION
   For each term, ask: "Define this term in one or two sentences, as it
   means SPECIFICALLY in this context." Push for precision — vague
   definitions hide misunderstandings. "What would a concrete example
   look like?"

4. BOUNDARY ENFORCEMENT
   For each term, ask: "Is this term used anywhere else in the system
   with a different meaning?" If yes, record it as an overloaded term
   and ensure the context-specific definition is clear.

5. RELATIONSHIP DISCOVERY
   Ask: "Which terms reference or depend on other terms?" Build a
   lightweight dependency graph. Terms that cluster together often
   indicate an aggregate or entity boundary.

6. ANTI-PATTERN IDENTIFICATION
   Flag terms that are:
   - Too generic ("data", "info", "item", "thing") — push for domain-specific names
   - Implementation-leaked ("table", "record", "row", "endpoint") — the language
     should describe the domain, not the technology
   - Passive ("is processed", "gets handled") — find the actor and the verb

Write or update the domainGlossary resource. Each invocation adds entries
for one context. Run repeatedly to build vocabulary across contexts.`,
      arguments: z.object({
        context: z.string().optional().describe(
          "Bounded context name to capture language for (uses first context if omitted)",
        ),
      }),
      execute: async (
        args: { context?: string },
        ctx: MethodContext,
      ) => {
        const contextMap = await ctx.readResource("current");

        const contexts = (contextMap && Array.isArray(contextMap.contexts))
          ? contextMap.contexts as Array<{ name: string }>
          : [];

        const targetContext = args.context ??
          contexts[0]?.name ??
          "unknown-context";

        const existing = await ctx.readResource(
          "glossary",
        ) as Record<string, unknown> | null;

        const entries = existing
          ? (existing.entries as z.infer<typeof GlossaryEntrySchema>[])
          : [];

        const glossary = {
          entries,
          updatedAt: new Date().toISOString(),
        };

        const handle = await ctx.writeResource(
          "domainGlossary",
          "glossary",
          glossary as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Domain glossary updated for context {context}. Total entries: {count}",
          { context: targetContext, count: entries.length },
        );

        return { dataHandles: [handle] };
      },
    },

    boundaries: {
      description: `Identify aggregate boundaries within a bounded context.

Guide the conversation through these phases using Vernon's Aggregate
Rules of Thumb:

1. CONTEXT SELECTION
   Read the contextMap and domainGlossary resources. Present context and
   its terms. Ask: "Which context should we design aggregate boundaries
   for?" If a 'context' argument is provided, use that directly.

2. INVARIANT DISCOVERY
   For each cluster of related terms, ask: "What rules MUST be true at
   all times? What would constitute an invalid state?" These are your
   true invariants — the things that must be transactionally consistent.

   Vernon's Rule: "Model true invariants in consistency boundaries."
   An invariant is a business rule that must always be consistent with
   other rules within the same aggregate. If two things must be
   atomically consistent, they belong in the same aggregate.

3. AGGREGATE SIZING
   Vernon's Rule: "Design small aggregates."
   Ask: "Could this aggregate be smaller? Does every entity and value
   object here participate in the SAME invariant?" If not, split it.
   Large aggregates cause transaction contention, memory pressure,
   and merge conflicts. Prefer one root entity with value objects.

4. REFERENCE STRATEGY
   Vernon's Rule: "Reference other aggregates by identity only."
   Ask: "When this aggregate needs data from another, does it need
   the entire object graph, or just an ID to look it up?" Direct object
   references create coupling. Identity references enable independent
   scaling and evolution.

5. CONSISTENCY BOUNDARY DECISIONS
   Vernon's Rule: "Use eventual consistency outside the boundary."
   For each cross-aggregate rule, ask: "Whose job is it to enforce
   this? The user doing the action, or the system afterward?" If it's
   the system's job, it can be eventually consistent.

   Ask domain experts: "How did this work before computers? Was it
   ever immediately consistent?" The answer is almost always no.
   Ask: "How many seconds/minutes/hours of delay is tolerable?"

6. EVENT IDENTIFICATION
   Where eventual consistency is chosen, identify the domain events
   that trigger cross-aggregate updates. Name them in past tense
   (OrderPlaced, InventoryReserved, PaymentConfirmed). Each event
   represents something that happened in one aggregate that other
   aggregates react to.

Write the boundaries resource with aggregate designs, invariants,
identity references, and eventual consistency rules.`,
      arguments: z.object({
        context: z.string().optional().describe(
          "Bounded context name to design boundaries for",
        ),
      }),
      execute: async (
        args: { context?: string },
        ctx: MethodContext,
      ) => {
        const contextMap = await ctx.readResource(
          "current",
        ) as Record<string, unknown> | null;

        if (!contextMap || !Array.isArray(contextMap.contexts)) {
          throw new Error(
            "No context map found. Run 'contexts' method first to discover bounded contexts.",
          );
        }

        const contexts = contextMap.contexts as Array<{ name: string }>;
        const targetContext = args.context ??
          contexts[0]?.name ??
          "unknown-context";

        const boundariesData = {
          aggregates: [] as z.infer<typeof AggregateDesignSchema>[],
          eventualConsistencyRules: [] as Array<{
            trigger: string;
            affectedAggregates: string[];
            tolerableDelay: string;
            rationale: string;
          }>,
          discoveredAt: new Date().toISOString(),
        };

        const handle = await ctx.writeResource(
          "boundaries",
          targetContext,
          boundariesData as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Aggregate boundaries initialized for context {context}",
          { context: targetContext },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
