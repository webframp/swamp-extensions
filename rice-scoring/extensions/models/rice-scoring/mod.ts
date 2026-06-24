/**
 * RICE scoring methodology as an agent-guided concept model.
 *
 * Accepts items, guides scoring through structured agent conversation,
 * computes Reach * Impact * Confidence / Effort, and stores versioned
 * ranked scorecards.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  reachDefinition: z.string().default(
    "Number of users/customers affected per quarter",
  ).describe(
    "What 'reach' means for this team — e.g. users per quarter, requests per month, teams affected",
  ),
  reachScale: z.string().default(
    "1-10 where 1 = tens of users, 5 = thousands, 10 = entire user base",
  ).describe(
    "Anchor points for reach scoring so values are consistent across scorers",
  ),
  impactScale: z.string().default(
    "0.25 = minimal, 0.5 = low, 1 = medium, 2 = high, 3 = massive",
  ).describe(
    "Impact multiplier scale — how much this moves the needle per user reached",
  ),
  effortUnit: z.string().default("person-weeks").describe(
    "Unit for effort estimation — person-days, person-weeks, story points, etc.",
  ),
  confidenceGuidance: z.string().default(
    "1.0 = high (data-backed), 0.8 = medium (strong intuition), 0.5 = low (speculation)",
  ).describe(
    "Guide for setting confidence — what evidence corresponds to each level",
  ),
  scoringContext: z.string().default("").describe(
    "Optional team/product context to anchor relative comparisons",
  ),
});

const RationaleSchema = z.object({
  reach: z.string().describe("Why this reach value was chosen"),
  impact: z.string().describe("Why this impact value was chosen"),
  confidence: z.string().describe("What evidence supports this confidence"),
  effort: z.string().describe("What drives the effort estimate"),
});

const ScoredItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  reach: z.number().min(0).describe("Reach value per the configured scale"),
  impact: z.number().min(0).describe("Impact multiplier"),
  confidence: z.number().min(0).max(1).describe(
    "Confidence factor between 0 and 1",
  ),
  effort: z.number().min(0.1).describe(
    "Effort in configured units (minimum 0.1 to avoid division by zero)",
  ),
  score: z.number().describe(
    "Computed RICE score: reach * impact * confidence / effort",
  ),
  rationale: RationaleSchema,
  scoredAt: z.string().describe("ISO timestamp of when this item was scored"),
});

const ScoresResourceSchema = z.object({
  items: z.array(ScoredItemSchema),
});

const ScoreArgsSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().min(1).describe("Short identifier for the item"),
      description: z.string().describe("What this item is about"),
      reach: z.number().min(0).describe("Reach value"),
      impact: z.number().min(0).describe("Impact multiplier"),
      confidence: z.number().min(0).max(1).describe("Confidence 0-1"),
      effort: z.number().min(0.1).describe("Effort estimate"),
      rationale: RationaleSchema,
    }),
  ).min(1).describe("Items to score with their RICE dimension values"),
});

// =============================================================================
// Context Interface
// =============================================================================

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
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
}

// =============================================================================
// Model
// =============================================================================

/** RICE scoring methodology model. */
export const model = {
  type: "@webframp/rice-scoring",
  version: "2026.06.23.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    scores: {
      description: "Versioned RICE scorecards with ranked items",
      schema: ScoresResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    score: {
      description:
        `Score items using the RICE methodology. This method is agent-guided:
the calling agent conducts a structured interview with the user to derive
values for each dimension before invoking this method with final numbers.

AGENT GUIDANCE FOR CONDUCTING THE INTERVIEW:

1. Read globalArgs to understand the team's configured scales:
   - reachDefinition: what "reach" means (users/quarter, requests/month, etc.)
   - reachScale: anchor points for numeric reach values
   - impactScale: what each impact multiplier level represents
   - effortUnit: the unit of effort (person-weeks, story points, etc.)
   - confidenceGuidance: what evidence maps to what confidence level
   - scoringContext: optional team context for relative comparisons

2. For each item, ask 1-2 focused questions per dimension:
   - REACH: "How many [reachDefinition] does this affect? Using the scale
     [reachScale], where would you place it?"
   - IMPACT: "For each person reached, how much does this move the needle?
     Using [impactScale], what level fits?"
   - CONFIDENCE: "What evidence do you have? [confidenceGuidance] — where
     does your certainty fall?"
   - EFFORT: "How many [effortUnit] would this take? Include design, build,
     test, and deploy."

3. After gathering answers, propose concrete numeric values and ask for
   confirmation before calling this method.

4. For batches of 5+ items, use relative comparison: rank items against each
   other within each dimension before assigning absolute values. This reduces
   anchoring bias.

5. The RICE score is computed as: reach * impact * confidence / effort.
   Higher scores indicate higher priority.`,
      arguments: ScoreArgsSchema,
      execute: async (
        args: z.infer<typeof ScoreArgsSchema>,
        context: ModelContext,
      ) => {
        if (args.items.length === 0) {
          throw new Error("At least one item is required for scoring");
        }

        const scoredItems = args.items.map((item) => {
          const score = (item.reach * item.impact * item.confidence) /
            item.effort;
          return {
            name: item.name,
            description: item.description,
            reach: item.reach,
            impact: item.impact,
            confidence: item.confidence,
            effort: item.effort,
            score: Math.round(score * 100) / 100,
            rationale: item.rationale,
            scoredAt: new Date().toISOString(),
          };
        });

        // Sort by score descending before storing
        scoredItems.sort((a, b) => b.score - a.score);

        const data = { items: scoredItems };
        const handle = await context.writeResource(
          "scores",
          "scores-latest",
          data,
        );

        context.logger.info("Scored items using RICE methodology", {
          count: scoredItems.length,
          topItem: scoredItems[0]?.name,
          topScore: scoredItems[0]?.score,
        });

        return { dataHandles: [handle] };
      },
    },

    rank: {
      description:
        "Read the latest scored items and display them ranked by RICE score descending. " +
        "Does not write a new resource — reads and presents existing scores.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const stored = await context.readResource("scores-latest");
        if (!stored) {
          throw new Error(
            "No scores found. Run the 'score' method first to create a scorecard.",
          );
        }

        const parsed = ScoresResourceSchema.safeParse(stored);
        if (!parsed.success) {
          throw new Error(
            `Invalid scorecard format: ${parsed.error.message}`,
          );
        }
        const items = parsed.data.items;

        if (items.length === 0) {
          context.logger.info("No items in scorecard", {});
          return { dataHandles: [] };
        }

        const sorted = [...items].sort((a, b) => b.score - a.score);

        for (let i = 0; i < sorted.length; i++) {
          const item = sorted[i];
          context.logger.info(
            `#${
              i + 1
            } ${item.name} — score: ${item.score} (R:${item.reach} I:${item.impact} C:${item.confidence} E:${item.effort})`,
            { rank: i + 1, name: item.name, score: item.score },
          );
        }

        return { dataHandles: [] };
      },
    },
  },
};
