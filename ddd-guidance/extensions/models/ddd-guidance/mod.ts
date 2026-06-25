/**
 * DDD Guidance Model
 *
 * Guides teams through applying Domain-Driven Design to existing projects.
 * Agent conducts structured conversations, then persists results as typed
 * method arguments — the same pattern as rice-scoring and good-planning.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

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
// Method Argument Schemas
// =============================================================================

const ContextsArgsSchema = z.object({
  focus: z.string().optional().describe(
    "Optional: narrow discovery to a specific area of the system",
  ),
  contexts: z.array(BoundedContextSchema).min(1).describe(
    "Bounded contexts discovered through conversation",
  ),
  relationships: z.array(ContextRelationshipSchema).describe(
    "Relationships between bounded contexts",
  ),
  overloadedTerms: z.array(z.object({
    term: z.string(),
    meanings: z.array(z.object({
      context: z.string(),
      definition: z.string(),
    })),
  })).describe(
    "Terms that mean different things in different contexts",
  ),
});

const LanguageArgsSchema = z.object({
  context: z.string().describe(
    "Bounded context name these terms belong to",
  ),
  entries: z.array(z.object({
    term: z.string().describe("The domain term"),
    definition: z.string().describe(
      "Precise definition within this bounded context",
    ),
    examples: z.array(z.string()).describe("Concrete usage examples"),
    relatedTerms: z.array(z.string()).describe(
      "Terms that reference or depend on this term",
    ),
    antiPatterns: z.array(z.string()).optional().describe(
      "Names to avoid and why (too generic, implementation-leaked, passive)",
    ),
  })).min(1).describe(
    "Glossary entries captured through conversation",
  ),
  overloadedTerms: z.array(z.object({
    term: z.string(),
    meanings: z.array(z.object({
      context: z.string(),
      definition: z.string(),
    })),
  })).optional().describe(
    "Any newly discovered terms that are overloaded across contexts",
  ),
});

const BoundariesArgsSchema = z.object({
  context: z.string().describe(
    "Bounded context name these boundaries belong to",
  ),
  aggregates: z.array(z.object({
    name: z.string().describe("Aggregate name"),
    rootEntity: z.string().describe("The aggregate root entity"),
    entities: z.array(z.string()).describe("Entities within this aggregate"),
    valueObjects: z.array(z.string()).describe(
      "Value objects within this aggregate",
    ),
    invariants: z.array(InvariantSchema).min(1).describe(
      "Business rules that must hold within this aggregate boundary",
    ),
    identityReferences: z.array(z.object({
      target: z.string().describe("Target aggregate referenced by ID"),
      reason: z.string().describe("Why this reference exists"),
    })).describe("References to other aggregates by identity only"),
    eventsTrigger: z.array(z.string()).describe(
      "Domain events this aggregate emits (past tense: OrderPlaced, etc.)",
    ),
  })).min(1).describe(
    "Aggregate designs produced through Vernon's rules analysis",
  ),
  eventualConsistencyRules: z.array(z.object({
    trigger: z.string().describe("The domain event that triggers this rule"),
    affectedAggregates: z.array(z.string()).describe(
      "Aggregates that react to this event",
    ),
    tolerableDelay: z.string().describe(
      "How much delay is acceptable (seconds, minutes, hours)",
    ),
    rationale: z.string().describe(
      "Why eventual consistency is acceptable here",
    ),
  })).describe(
    "Cross-aggregate consistency rules that tolerate eventual consistency",
  ),
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
  version: "2026.06.24.1",
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
   For each pair of related contexts, determine the relationship type:
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
   are supporting or generic subdomains.

After completing the conversation, call this method with the discovered
contexts, relationships, and overloaded terms as structured arguments.
The contextMap resource evolves — run this method again as understanding
deepens.`,
      arguments: ContextsArgsSchema,
      execute: async (
        args: z.infer<typeof ContextsArgsSchema>,
        context: MethodContext,
      ) => {
        const contextMap = {
          contexts: args.contexts,
          relationships: args.relationships,
          overloadedTerms: args.overloadedTerms,
          discoveredAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "contextMap",
          "current",
          contextMap as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Context map written with {contextCount} contexts and {relCount} relationships",
          {
            contextCount: args.contexts.length,
            relCount: args.relationships.length,
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

After completing the conversation, call this method with the captured
glossary entries. Entries are MERGED with existing glossary data —
run repeatedly to build vocabulary across contexts.

If any terms are overloaded across contexts, include them in the
overloadedTerms argument to update the contextMap as well.`,
      arguments: LanguageArgsSchema,
      execute: async (
        args: z.infer<typeof LanguageArgsSchema>,
        ctx: MethodContext,
      ) => {
        const existing = await ctx.readResource(
          "glossary",
        ) as Record<string, unknown> | null;

        const existingEntries = Array.isArray(existing?.entries)
          ? (existing!.entries as z.infer<typeof GlossaryEntrySchema>[])
          : [];

        const newEntries: z.infer<typeof GlossaryEntrySchema>[] = args.entries
          .map((e) => ({
            term: e.term,
            context: args.context,
            definition: e.definition,
            examples: e.examples,
            relatedTerms: e.relatedTerms,
            antiPatterns: e.antiPatterns,
          }));

        const mergedEntries = [
          ...existingEntries.filter(
            (e) =>
              !newEntries.some(
                (n) => n.term === e.term && n.context === e.context,
              ),
          ),
          ...newEntries,
        ];

        const glossary = {
          entries: mergedEntries,
          updatedAt: new Date().toISOString(),
        };

        const handle = await ctx.writeResource(
          "domainGlossary",
          "glossary",
          glossary as unknown as Record<string, unknown>,
        );

        if (args.overloadedTerms && args.overloadedTerms.length > 0) {
          const contextMap = await ctx.readResource(
            "current",
          ) as Record<string, unknown> | null;

          if (contextMap) {
            const existingOverloaded = Array.isArray(contextMap.overloadedTerms)
              ? (contextMap.overloadedTerms as Array<{
                term: string;
                meanings: Array<{ context: string; definition: string }>;
              }>)
              : [];

            const merged = [...existingOverloaded];
            for (const newTerm of args.overloadedTerms) {
              const idx = merged.findIndex((t) => t.term === newTerm.term);
              if (idx >= 0) {
                const existingMeanings = [...merged[idx].meanings];
                for (const newMeaning of newTerm.meanings) {
                  const mIdx = existingMeanings.findIndex(
                    (m) => m.context === newMeaning.context,
                  );
                  if (mIdx >= 0) {
                    existingMeanings[mIdx] = newMeaning;
                  } else {
                    existingMeanings.push(newMeaning);
                  }
                }
                merged[idx] = {
                  term: newTerm.term,
                  meanings: existingMeanings,
                };
              } else {
                merged.push(newTerm);
              }
            }

            await ctx.writeResource(
              "contextMap",
              "current",
              { ...contextMap, overloadedTerms: merged },
            );
          }
        }

        ctx.logger.info(
          "Domain glossary updated for context {context}. Added {newCount} entries, total {totalCount}",
          {
            context: args.context,
            newCount: newEntries.length,
            totalCount: mergedEntries.length,
          },
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
   Present the glossary entries for this context and ask: "Which of these
   terms cluster together — which ones are always discussed together,
   always change together, or make no sense without each other?" Group
   the terms into 2-5 clusters.

   For each cluster, ask: "What is the 'main thing' in this cluster — the
   one concept that the others describe or qualify?" That main thing is
   the candidate aggregate root.

3. INVARIANT DISCOVERY
   For each candidate aggregate, ask: "What rules MUST be true at all
   times? What would constitute an invalid state?" These are your true
   invariants.

   Vernon's Rule: "Model true invariants in consistency boundaries."

4. AGGREGATE SIZING
   Vernon's Rule: "Design small aggregates."
   Ask: "Could this aggregate be smaller? Does every entity and value
   object here participate in the SAME invariant?" If not, split it.

5. REFERENCE STRATEGY
   Vernon's Rule: "Reference other aggregates by identity only."
   Ask: "When this aggregate needs data from another, does it need
   the entire object graph, or just an ID to look it up?"

6. CONSISTENCY BOUNDARY DECISIONS
   Vernon's Rule: "Use eventual consistency outside the boundary."
   For each cross-aggregate rule, ask: "How many seconds/minutes/hours
   of delay is tolerable?"

7. EVENT IDENTIFICATION
   Where eventual consistency is chosen, identify the domain events
   that trigger cross-aggregate updates. Name them in past tense
   (OrderPlaced, InventoryReserved, PaymentConfirmed).

After completing the conversation, call this method with the aggregate
designs and eventual consistency rules as structured arguments.`,
      arguments: BoundariesArgsSchema,
      execute: async (
        args: z.infer<typeof BoundariesArgsSchema>,
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

        if (!contexts.some((c) => c.name === args.context)) {
          throw new Error(
            `Context "${args.context}" not found in context map. Known contexts: ${
              contexts.map((c) => c.name).join(", ")
            }`,
          );
        }

        const boundariesData = {
          aggregates: args.aggregates.map((a) => ({
            ...a,
            context: args.context,
          })),
          eventualConsistencyRules: args.eventualConsistencyRules,
          discoveredAt: new Date().toISOString(),
        };

        const handle = await ctx.writeResource(
          "boundaries",
          args.context,
          boundariesData as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Aggregate boundaries written for context {context}. {aggCount} aggregates, {ruleCount} consistency rules",
          {
            context: args.context,
            aggCount: args.aggregates.length,
            ruleCount: args.eventualConsistencyRules.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    revisit: {
      description: `Review existing DDD decisions against recent system changes.

Domain understanding evolves. This method guides a structured review of
prior context, language, and boundary decisions to determine what still
holds and what needs updating.

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
   purpose expanded or contracted?"

   For each relationship, ask: "Is this still the right relationship
   type? Has a partnership become a customer-supplier?"

3. LANGUAGE DRIFT
   For the domainGlossary, ask: "Are there terms the team has stopped
   using? New terms that have emerged? Definitions that no longer match
   how the team actually talks about the system?"

4. AGGREGATE PRESSURE
   For stored boundaries, ask: "Have any aggregates grown? Are there
   new invariants? Have tolerable delays changed?"

5. DECISION RECORD
   For each change identified, record: what changed, why it changed,
   and what resource to update.

After identifying what changed, re-run the relevant methods (contexts,
language, boundaries) with updated arguments to write new resource
versions. This method identifies what needs revision; the other methods
perform the actual writes.`,
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
            scope: args.scope,
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
