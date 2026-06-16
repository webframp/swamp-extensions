/**
 * Agile threat modeling as an agent-guided concept model.
 *
 * Guides structured threat assessment through progressive discovery:
 * scope → identify → evaluate → mitigate → posture. Stores versioned
 * threat models that evolve as systems change.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const LikelihoodEnum = z.enum(["certain", "probable", "possible", "unlikely"]);
const ImpactEnum = z.enum(["critical", "high", "medium", "low"]);
const RiskLevelEnum = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "negligible",
]);
const ThreatStatusEnum = z.enum([
  "mitigated",
  "accepted",
  "deferred",
  "unaddressed",
]);

const GlobalArgsSchema = z.object({
  likelihoodScale: z.string().default(
    "certain = architectural/by-design, probable = likely without controls, possible = requires compound conditions, unlikely = theoretical only",
  ).describe("Definition of likelihood levels for consistent scoring"),
  impactScale: z.string().default(
    "critical = full system compromise or data breach, high = significant data exposure or service disruption, medium = limited exposure or degraded service, low = minimal operational impact",
  ).describe("Definition of impact levels for consistent scoring"),
  mitigationFramework: z.string().default("CWE Monster Mitigations").describe(
    "Reference framework for control selection (CWE, NIST, OWASP, custom)",
  ),
});

const AssetSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const ThreatScenarioSchema = z.object({
  id: z.string().describe("Short identifier like T1, T2"),
  title: z.string(),
  description: z.string(),
  likelihood: LikelihoodEnum,
  impact: ImpactEnum,
  inherentRisk: RiskLevelEnum,
  exploitation: z.string().describe("How an attacker would exploit this"),
  mitigatingFactors: z.string().describe("What limits the blast radius"),
  status: ThreatStatusEnum.default("unaddressed"),
});

const ControlSchema = z.object({
  id: z.string().describe("Short identifier like C1, C2"),
  description: z.string(),
  mitigates: z.array(z.string()).describe("Threat IDs this control addresses"),
  effectiveness: z.enum(["full", "partial", "minimal"]),
  implemented: z.boolean().default(false),
});

const AcceptanceSchema = z.object({
  threatId: z.string(),
  rationale: z.string(),
  conditions: z.string().optional().describe(
    "Conditions under which acceptance is valid",
  ),
  acceptedBy: z.string(),
  acceptedAt: z.string(),
});

const AssessmentSchema = z.object({
  scope: z.string(),
  subject: z.string().describe("What is being assessed"),
  currentPosture: z.string(),
  assessedAt: z.string(),
  assets: z.array(AssetSchema).default([]),
  threats: z.array(ThreatScenarioSchema).default([]),
  controls: z.array(ControlSchema).default([]),
  acceptances: z.array(AcceptanceSchema).default([]),
  recommendation: z.string().default(""),
  openQuestions: z.array(z.string()).default([]),
  updatedAt: z.string(),
});

const PostureSchema = z.object({
  subject: z.string(),
  assessedAt: z.string(),
  totalThreats: z.number(),
  byStatus: z.object({
    mitigated: z.number(),
    accepted: z.number(),
    deferred: z.number(),
    unaddressed: z.number(),
  }),
  byRiskLevel: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    negligible: z.number(),
  }),
  controlsCoverage: z.object({
    total: z.number(),
    implemented: z.number(),
  }),
  unmitigatedAboveThreshold: z.array(z.object({
    id: z.string(),
    title: z.string(),
    inherentRisk: RiskLevelEnum,
    status: ThreatStatusEnum,
  })),
  openQuestions: z.number(),
  overallPosture: z.enum([
    "acceptable",
    "conditionally-acceptable",
    "unacceptable",
  ]),
  recommendation: z.string(),
  snapshotAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Compute risk level from likelihood × impact. */
function computeRiskLevel(
  likelihood: z.infer<typeof LikelihoodEnum>,
  impact: z.infer<typeof ImpactEnum>,
): z.infer<typeof RiskLevelEnum> {
  const matrix: Record<string, Record<string, z.infer<typeof RiskLevelEnum>>> =
    {
      certain: {
        critical: "critical",
        high: "high",
        medium: "medium",
        low: "low",
      },
      probable: {
        critical: "high",
        high: "high",
        medium: "medium",
        low: "low",
      },
      possible: {
        critical: "high",
        high: "medium",
        medium: "low",
        low: "negligible",
      },
      unlikely: {
        critical: "medium",
        high: "low",
        medium: "low",
        low: "negligible",
      },
    };
  return matrix[likelihood][impact];
}

/** Determine overall posture from threat statuses and risk levels. */
function computePosture(
  threats: z.infer<typeof ThreatScenarioSchema>[],
): "acceptable" | "conditionally-acceptable" | "unacceptable" {
  const unaddressedCritical = threats.some(
    (t) =>
      t.status === "unaddressed" &&
      (t.inherentRisk === "critical" || t.inherentRisk === "high"),
  );
  const allHandled = threats.every((t) =>
    t.status === "mitigated" || t.status === "accepted"
  );

  if (unaddressedCritical) return "unacceptable";
  if (allHandled) return "acceptable";
  return "conditionally-acceptable";
}

// =============================================================================
// Context type
// =============================================================================

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<
    {
      name: string;
      specName: string;
      kind: string;
      dataId: string;
      version: number;
      size: number;
    }
  >;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
}

// =============================================================================
// Model
// =============================================================================

/** Agile threat modeling concept model. */
export const model = {
  type: "@webframp/threat-model",
  version: "2026.06.09.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    assessment: {
      description:
        "Full threat model state: scope, threats, controls, acceptances, recommendation",
      schema: AssessmentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    posture: {
      description:
        "Compact risk posture snapshot. Derived from assessment; safe for periodic monitoring.",
      schema: PostureSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    scope: {
      description: `Define the threat assessment scope and establish context.

AGENT GUIDANCE:

1. Ask: "What system, feature, or change are we assessing?"
   Get a one-sentence subject and a paragraph of current security posture.

2. Ask: "What assets are at stake? List the key properties — credential types,
   data classifications, integration points, trust boundaries."
   Record as name/value pairs.

3. Ask: "What is the assessment date and any relevant context about timing
   (e.g., pre-deployment, post-incident, periodic review)?"

4. Record the scope statement: what IS and IS NOT included in this assessment.

Write the assessment resource with scope, subject, posture, and assets.
Subsequent methods (identify, evaluate, mitigate) build on this foundation.`,
      arguments: z.object({
        subject: z.string().min(1).describe(
          "What is being assessed (system, feature, change)",
        ),
        scope: z.string().min(1).describe(
          "Boundary statement: what is/is not included",
        ),
        currentPosture: z.string().min(1).describe(
          "Current security posture before this change",
        ),
        assets: z.array(z.object({
          name: z.string(),
          value: z.string(),
        })).default([]).describe(
          "Key assets at stake (credential types, data, integrations)",
        ),
      }),
      execute: async (
        args: {
          subject: string;
          scope: string;
          currentPosture: string;
          assets: Array<{ name: string; value: string }>;
        },
        ctx: ModelContext,
      ) => {
        const now = new Date().toISOString();
        const handle = await ctx.writeResource("assessment", "current", {
          subject: args.subject,
          scope: args.scope,
          currentPosture: args.currentPosture,
          assessedAt: now,
          assets: args.assets,
          threats: [],
          controls: [],
          acceptances: [],
          recommendation: "",
          openQuestions: [],
          updatedAt: now,
        });
        ctx.logger.info("Assessment scoped for {subject}", {
          subject: args.subject,
        });
        return { dataHandles: [handle] };
      },
    },

    identify: {
      description: `Identify threat scenarios through structured conversation.

AGENT GUIDANCE:

1. Read the current assessment resource to understand scope and assets.

2. For each asset/trust boundary, guide discovery:
   - "Who might attack this? What is their motivation?"
   - "What could go wrong if this is compromised?"
   - "What is the attack chain — what steps does exploitation require?"

3. For each threat scenario, capture:
   - A short ID (T1, T2, ...)
   - Title (one line)
   - Description (what could happen)
   - Likelihood: ${"`"}certain${"`"} (architectural), ${"`"}probable${"`"} (likely without controls),
     ${"`"}possible${"`"} (compound conditions), ${"`"}unlikely${"`"} (theoretical)
   - Impact: ${"`"}critical${"`"}, ${"`"}high${"`"}, ${"`"}medium${"`"}, ${"`"}low${"`"}
   - Exploitation: how an attacker would do it
   - Mitigating factors: what limits blast radius

4. Use the configured scales (globalArgs.likelihoodScale, impactScale) to
   anchor consistent scoring across scenarios.

5. The inherent risk is computed automatically from likelihood × impact.

Call this method with all identified threats. Can be called multiple times
to add threats as they are discovered.`,
      arguments: z.object({
        threats: z.array(z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          description: z.string().min(1),
          likelihood: LikelihoodEnum,
          impact: ImpactEnum,
          exploitation: z.string().min(1),
          mitigatingFactors: z.string().min(1),
        })).min(1),
      }),
      execute: async (
        args: {
          threats: Array<
            {
              id: string;
              title: string;
              description: string;
              likelihood: z.infer<typeof LikelihoodEnum>;
              impact: z.infer<typeof ImpactEnum>;
              exploitation: string;
              mitigatingFactors: string;
            }
          >;
        },
        ctx: ModelContext,
      ) => {
        const existing = await ctx.readResource("current");
        if (!existing) throw new Error("No assessment — run 'scope' first");

        const currentThreats =
          (Array.isArray(existing.threats) ? existing.threats : []) as z.infer<
            typeof ThreatScenarioSchema
          >[];

        const newThreats = args.threats.map((t) => ({
          ...t,
          inherentRisk: computeRiskLevel(t.likelihood, t.impact),
          status: "unaddressed" as const,
        }));

        // Upsert: new threats with existing IDs replace the old entry
        const newIds = new Set(newThreats.map((t) => t.id));
        const merged = [
          ...currentThreats.filter((t) => !newIds.has(t.id)),
          ...newThreats,
        ];

        const handle = await ctx.writeResource("assessment", "current", {
          ...existing,
          threats: merged,
          updatedAt: new Date().toISOString(),
        });

        ctx.logger.info("Identified {count} threats", {
          count: newThreats.length,
        });
        return { dataHandles: [handle] };
      },
    },

    evaluate: {
      description: `Produce the risk matrix and add open questions.

AGENT GUIDANCE:

1. Read the current assessment to review identified threats.

2. Present the risk matrix (likelihood × impact → risk level) to the user.
   Discuss whether any scenarios need re-scoring based on new information.

3. Identify open questions — things that would change the assessment if answered:
   - Undocumented behaviors
   - Vendor dependencies
   - Propagation delays
   - Missing telemetry

4. Call this method to record open questions and optionally adjust threat scores.`,
      arguments: z.object({
        openQuestions: z.array(z.string()).default([]),
        adjustments: z.array(z.object({
          threatId: z.string(),
          likelihood: LikelihoodEnum.optional(),
          impact: ImpactEnum.optional(),
        })).default([]).describe(
          "Optional re-scoring of threats based on discussion",
        ),
      }),
      execute: async (
        args: {
          openQuestions: string[];
          adjustments: Array<
            {
              threatId: string;
              likelihood?: z.infer<typeof LikelihoodEnum>;
              impact?: z.infer<typeof ImpactEnum>;
            }
          >;
        },
        ctx: ModelContext,
      ) => {
        const existing = await ctx.readResource("current");
        if (!existing) throw new Error("No assessment — run 'scope' first");

        let threats = (existing.threats ?? []) as z.infer<
          typeof ThreatScenarioSchema
        >[];

        for (const adj of args.adjustments) {
          threats = threats.map((t) => {
            if (t.id !== adj.threatId) return t;
            const l = adj.likelihood ?? t.likelihood;
            const i = adj.impact ?? t.impact;
            return {
              ...t,
              likelihood: l,
              impact: i,
              inherentRisk: computeRiskLevel(l, i),
            };
          });
        }

        const existingQuestions =
          (Array.isArray(existing.openQuestions)
            ? existing.openQuestions
            : []) as string[];
        const mergedQuestions = [
          ...new Set([...existingQuestions, ...args.openQuestions]),
        ];

        const handle = await ctx.writeResource("assessment", "current", {
          ...existing,
          threats,
          openQuestions: mergedQuestions,
          updatedAt: new Date().toISOString(),
        });

        ctx.logger.info("Evaluated risk matrix. Open questions: {count}", {
          count: mergedQuestions.length,
        });
        return { dataHandles: [handle] };
      },
    },

    mitigate: {
      description: `Define compensating controls and produce recommendation.

AGENT GUIDANCE:

1. Read the current assessment and its threat scenarios.

2. For each threat (or cluster of related threats), guide control definition:
   - "What compensating control reduces this risk?"
   - "Does it fully mitigate, partially reduce, or minimally address the threat?"
   - "Is it already implemented or proposed?"
   Reference the configured mitigationFramework (globalArgs) for principles.

3. For threats where no control is cost-effective, propose risk acceptance:
   - Who accepts it?
   - Under what conditions?
   - What rationale?

4. For threats awaiting external input, mark as deferred with the relevant
   open question.

5. Produce the overall recommendation:
   - "Enable/proceed with compensating controls" (conditionally acceptable)
   - "Enable/proceed" (acceptable)
   - "Do not proceed" (unacceptable)

Call with controls, acceptances, and recommendation.`,
      arguments: z.object({
        controls: z.array(z.object({
          id: z.string().min(1),
          description: z.string().min(1),
          mitigates: z.array(z.string()).min(1),
          effectiveness: z.enum(["full", "partial", "minimal"]),
          implemented: z.boolean().default(false),
        })).default([]),
        acceptances: z.array(z.object({
          threatId: z.string().min(1),
          rationale: z.string().min(1),
          conditions: z.string().optional(),
          acceptedBy: z.string().min(1),
        })).default([]),
        deferred: z.array(z.string()).default([]).describe(
          "Threat IDs to mark as deferred",
        ),
        recommendation: z.string().min(1),
      }),
      execute: async (
        args: {
          controls: Array<
            {
              id: string;
              description: string;
              mitigates: string[];
              effectiveness: "full" | "partial" | "minimal";
              implemented: boolean;
            }
          >;
          acceptances: Array<
            {
              threatId: string;
              rationale: string;
              conditions?: string;
              acceptedBy: string;
            }
          >;
          deferred: string[];
          recommendation: string;
        },
        ctx: ModelContext,
      ) => {
        const existing = await ctx.readResource("current");
        if (!existing) throw new Error("No assessment — run 'scope' first");

        const now = new Date().toISOString();
        let threats = (existing.threats ?? []) as z.infer<
          typeof ThreatScenarioSchema
        >[];

        // Determine which threats are fully mitigated by controls.
        // Only "full" effectiveness changes threat status to "mitigated".
        // Partial and minimal controls are recorded but do NOT flip status —
        // the threat remains visible in posture calculations.
        const mitigatedByControl = new Set<string>();
        for (const c of args.controls) {
          for (const tid of c.mitigates) {
            if (c.effectiveness === "full") mitigatedByControl.add(tid);
          }
        }

        // Update threat statuses
        const acceptedIds = new Set(args.acceptances.map((a) => a.threatId));
        const deferredIds = new Set(args.deferred);

        threats = threats.map((t) => {
          if (mitigatedByControl.has(t.id)) {
            return { ...t, status: "mitigated" as const };
          }
          if (acceptedIds.has(t.id)) {
            return { ...t, status: "accepted" as const };
          }
          if (deferredIds.has(t.id)) {
            return { ...t, status: "deferred" as const };
          }
          return t;
        });

        // Merge controls and acceptances with existing (dedup by ID)
        const existingControls =
          (Array.isArray(existing.controls) ? existing.controls : []) as Array<
            { id: string }
          >;
        const existingAcceptances =
          (Array.isArray(existing.acceptances)
            ? existing.acceptances
            : []) as Array<{ threatId: string }>;

        const newControlIds = new Set(args.controls.map((c) => c.id));
        const mergedControls = [
          ...existingControls.filter((c) => !newControlIds.has(c.id)),
          ...args.controls,
        ];

        const acceptanceRecords = args.acceptances.map((a) => ({
          ...a,
          acceptedAt: now,
        }));
        const newAcceptanceIds = new Set(
          args.acceptances.map((a) => a.threatId),
        );
        const mergedAcceptances = [
          ...existingAcceptances.filter((a) =>
            !newAcceptanceIds.has(a.threatId)
          ),
          ...acceptanceRecords,
        ];

        const handle = await ctx.writeResource("assessment", "current", {
          ...existing,
          threats,
          controls: mergedControls,
          acceptances: mergedAcceptances,
          recommendation: args.recommendation,
          updatedAt: now,
        });

        ctx.logger.info(
          "Mitigations recorded. Controls: {controls}, Acceptances: {acceptances}",
          {
            controls: args.controls.length,
            acceptances: args.acceptances.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    posture: {
      description:
        "Compute and write a compact risk posture snapshot. Reads the current " +
        "assessment, surfaces unmitigated threats above threshold, reports " +
        "control coverage, and determines overall posture. Idempotent — " +
        "writes to the posture resource only.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ) => {
        const existing = await ctx.readResource("current");
        if (!existing) throw new Error("No assessment — run 'scope' first");

        const threats = (existing.threats ?? []) as z.infer<
          typeof ThreatScenarioSchema
        >[];
        const controls = (existing.controls ?? []) as z.infer<
          typeof ControlSchema
        >[];

        const byStatus = {
          mitigated: 0,
          accepted: 0,
          deferred: 0,
          unaddressed: 0,
        };
        const byRiskLevel = {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          negligible: 0,
        };

        for (const t of threats) {
          byStatus[t.status]++;
          byRiskLevel[t.inherentRisk]++;
        }

        const unmitigatedAboveThreshold = threats
          .filter((t) =>
            t.status === "unaddressed" &&
            (t.inherentRisk === "critical" || t.inherentRisk === "high" ||
              t.inherentRisk === "medium")
          )
          .map((t) => ({
            id: t.id,
            title: t.title,
            inherentRisk: t.inherentRisk,
            status: t.status,
          }));

        const posture = {
          subject: existing.subject as string,
          assessedAt: existing.assessedAt as string,
          totalThreats: threats.length,
          byStatus,
          byRiskLevel,
          controlsCoverage: {
            total: controls.length,
            implemented: controls.filter((c) => c.implemented).length,
          },
          unmitigatedAboveThreshold,
          openQuestions: (existing.openQuestions as string[] ?? []).length,
          overallPosture: computePosture(threats),
          recommendation: existing.recommendation as string ?? "",
          snapshotAt: new Date().toISOString(),
        };

        const handle = await ctx.writeResource("posture", "current", posture);
        ctx.logger.info(
          "Posture: {posture}. Unaddressed above threshold: {count}",
          {
            posture: posture.overallPosture,
            count: unmitigatedAboveThreshold.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    revisit: {
      description: `Review an existing threat model against system changes.

AGENT GUIDANCE:

1. Read both the assessment and posture resources. Present the current state.

2. Ask: "What has changed since this was last assessed? Consider:
   - New integrations, APIs, or dependencies added
   - Configuration changes (features enabled/disabled)
   - Incidents that revealed new attack surface
   - Controls that have been implemented since last review
   - Open questions that now have answers"

3. For each change, determine impact:
   - Does it introduce new threats? → add via 'identify'
   - Does it change likelihood/impact of existing threats? → adjust via 'evaluate'
   - Does it add new controls? → record via 'mitigate'
   - Does it resolve open questions? → update via 'evaluate'

4. After capturing changes, run 'posture' to generate an updated snapshot.

This method itself is read-only — it surfaces what needs updating.
The other methods perform the actual writes.`,
      arguments: z.object({
        changesNoted: z.array(z.string()).default([]).describe(
          "Summary of changes identified during review discussion",
        ),
      }),
      execute: async (
        args: { changesNoted: string[] },
        ctx: ModelContext,
      ) => {
        const existing = await ctx.readResource("current");
        if (!existing) throw new Error("No assessment — run 'scope' first");

        const threats = (existing.threats ?? []) as z.infer<
          typeof ThreatScenarioSchema
        >[];
        const posture = computePosture(threats);

        ctx.logger.info(
          "Revisit started. Subject: {subject}. Current posture: {posture}. Threats: {count}. Changes noted: {changes}",
          {
            subject: existing.subject,
            posture,
            count: threats.length,
            changes: args.changesNoted.length,
          },
        );
        return { dataHandles: [] };
      },
    },
  },
};
