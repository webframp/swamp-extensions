// DDD Guidance Model
// Guides teams through applying Domain-Driven Design to an existing project.
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

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
  version: "2026.06.21.1",
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

7. CROSS-RESOURCE FEEDBACK
   If any term discovered in this session is used in OTHER contexts with
   a different meaning, update the contextMap resource's overloadedTerms
   array. Read the current contextMap, append the new overloaded term with
   its per-context meanings, and write it back. The contextMap should always
   reflect the latest understanding of where language diverges.

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

        const entries = Array.isArray(existing?.entries)
          ? (existing!.entries as z.infer<typeof GlossaryEntrySchema>[])
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

2. AGGREGATE CANDIDATE CLUSTERING
   Before applying Vernon's rules, help the team translate glossary terms
   into candidate aggregates. Present the glossary entries for this context
   and ask: "Which of these terms cluster together — which ones are always
   discussed together, always change together, or make no sense without
   each other?" Group the terms into 2-5 clusters.

   For each cluster, ask: "What is the 'main thing' in this cluster — the
   one concept that the others describe or qualify?" That main thing is
   the candidate aggregate root. The others are candidate entities or
   value objects within it.

   Teams that think in database tables: ask "Which table would you query
   first? The other tables in this cluster — are they always JOINed with
   it, or can they be queried independently?" Tables always JOINed suggest
   one aggregate. Independently queryable tables suggest separate aggregates.

   Present the candidate aggregates before proceeding. The team should
   agree these are reasonable starting points before applying invariant
   analysis.

3. INVARIANT DISCOVERY
   For each candidate aggregate from step 2, ask: "What rules MUST be
   true at all times? What would constitute an invalid state?" These are
   your true invariants — the things that must be transactionally consistent.

   Vernon's Rule: "Model true invariants in consistency boundaries."
   An invariant is a business rule that must always be consistent with
   other rules within the same aggregate. If two things must be
   atomically consistent, they belong in the same aggregate.

4. AGGREGATE SIZING
   Vernon's Rule: "Design small aggregates."
   Ask: "Could this aggregate be smaller? Does every entity and value
   object here participate in the SAME invariant?" If not, split it.
   Large aggregates cause transaction contention, memory pressure,
   and merge conflicts. Prefer one root entity with value objects.

5. REFERENCE STRATEGY
   Vernon's Rule: "Reference other aggregates by identity only."
   Ask: "When this aggregate needs data from another, does it need
   the entire object graph, or just an ID to look it up?" Direct object
   references create coupling. Identity references enable independent
   scaling and evolution.

6. CONSISTENCY BOUNDARY DECISIONS
   Vernon's Rule: "Use eventual consistency outside the boundary."
   For each cross-aggregate rule, ask: "Whose job is it to enforce
   this? The user doing the action, or the system afterward?" If it's
   the system's job, it can be eventually consistent.

   Ask domain experts: "How did this work before computers? Was it
   ever immediately consistent?" The answer is almost always no.
   Ask: "How many seconds/minutes/hours of delay is tolerable?"

7. EVENT IDENTIFICATION
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

        if (
          !contextMap || !Array.isArray(contextMap.contexts) ||
          contextMap.contexts.length === 0
        ) {
          throw new Error(
            "No bounded contexts discovered yet. Complete the 'contexts' method first.",
          );
        }

        const contexts = contextMap.contexts as Array<{ name: string }>;
        const targetContext = args.context ?? contexts[0].name;

        if (!contexts.some((c) => c.name === targetContext)) {
          throw new Error(
            `Context "${targetContext}" not found in context map. Known contexts: ${
              contexts.map((c) => c.name).join(", ")
            }`,
          );
        }

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

    revisit: {
      description: `Review existing DDD decisions against recent system changes.

Domain understanding evolves. New services appear, teams reorganize, incidents
reveal hidden coupling, and business priorities shift. This method guides a
structured review of prior context, language, and boundary decisions to
determine what still holds and what needs updating.

Guide the conversation through these phases:

1. CHANGE INVENTORY
   Read all three resources (contextMap, domainGlossary, boundaries).
   Present the current state and its discoveredAt/updatedAt timestamps.
   Ask: "What has changed since these were last updated? Consider:
   - New services, APIs, or integrations added
   - Teams reorganized or ownership transferred
   - Incidents that revealed unexpected coupling
   - Features that were hard to build because they crossed boundaries
   - Terms the team argues about or uses inconsistently"

2. BOUNDARY STRESS TEST
   For each bounded context in the contextMap, ask: "Has this context's
   rate of change shifted? Is it still owned by the same team? Has its
   purpose expanded or contracted?" Contexts that have grown to serve
   multiple purposes or multiple teams are candidates for splitting.

   For each relationship, ask: "Is this still the right relationship
   type? Has a partnership become a customer-supplier? Has a conformist
   relationship developed enough friction to justify an anticorruption
   layer?"

3. LANGUAGE DRIFT
   For the domainGlossary, ask: "Are there terms the team has stopped
   using? New terms that have emerged? Definitions that no longer match
   how the team actually talks about the system?"

   Pay attention to terms that have silently changed meaning — the
   definition in the glossary says one thing, but the team uses the word
   differently now. These are signals of unacknowledged context shifts.

4. AGGREGATE PRESSURE
   For stored boundaries, ask: "Have any aggregates grown? Are there
   new invariants that were not present before? Have tolerable delays
   changed — is something that was eventually consistent now causing
   user-visible problems because the delay is too long?"

   Look for aggregates that have accumulated entities since the last
   review. Each addition should be justified by a shared invariant.

5. DECISION RECORD
   For each change identified, record: what changed, why it changed,
   and what resource to update. Write updated versions of affected
   resources. The version history (via GC retention) preserves the
   evolution — teams can query "what did we believe 3 months ago?"
   to understand how their domain model matured.

After identifying what changed, re-run the relevant methods (contexts,
language, boundaries) to write updated resource versions. This method
identifies what needs revision; the other methods perform the actual
writes. The version history (via GC retention) preserves the evolution.`,
      arguments: z.object({
        scope: z
          .enum(["all", "contexts", "language", "boundaries"])
          .default("all")
          .describe(
            "Which aspect to review: all resources, or focus on one",
          ),
      }),
      execute: async (
        args: { scope: string },
        ctx: MethodContext,
      ) => {
        const scope = args.scope;

        const contextMap = await ctx.readResource(
          "current",
        ) as Record<string, unknown> | null;

        if (!contextMap) {
          throw new Error(
            "No existing resources found. Run 'contexts' method first to establish a baseline.",
          );
        }

        const glossary = await ctx.readResource(
          "glossary",
        ) as Record<string, unknown> | null;

        const contextNames = Array.isArray(contextMap.contexts)
          ? (contextMap.contexts as Array<{ name: string }>).map((c) => c.name)
          : [];

        ctx.logger.info(
          "Revisit session started for scope {scope}. Contexts: [{contexts}]. Last discovered: {discoveredAt}",
          {
            scope,
            contexts: contextNames.join(", "),
            discoveredAt: (contextMap.discoveredAt as string) ?? "unknown",
            glossaryUpdatedAt: glossary
              ? (glossary.updatedAt as string) ?? "unknown"
              : "no glossary",
          },
        );

        return { dataHandles: [] };
      },
    },
  },
};
