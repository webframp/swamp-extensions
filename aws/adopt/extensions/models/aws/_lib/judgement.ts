/**
 * Judgement and decision helpers for adoption candidates.
 *
 * Three steps sit between a plan and an observe run. Deterministic flags
 * settle what they can. jev (`@swamp/typesafe-ai`, through `triage_batch`)
 * advises on the rest. `decideCandidates` then applies fixed rules over both
 * and orders the result into waves. jev never decides alone: rules beat the
 * model, low confidence goes to a human, and a missing or mismatched answer is
 * never guessed. Everything here is pure except the SHA-256 digest.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  ADOPTION_TYPES_BY_CFN,
  type AdoptionCandidate,
  fnv1a,
} from "./adoption.ts";

// =============================================================================
// Questions
// =============================================================================

/** What adopt can do with a candidate. */
export const DISPOSITIONS = [
  "manage",
  "observe-only",
  "exclude",
  "retire-candidate",
  "needs-human",
] as const;

/** One of {@link DISPOSITIONS}. */
export type Disposition = typeof DISPOSITIONS[number];

/** Who settled a candidate's disposition. */
export const DECIDED_BY = ["rule", "jev", "default"] as const;

/**
 * The four questions sent to jev with every candidate. They live in code, not
 * in the workflow, so the questions and the rules that read the answers change
 * together and are tested together.
 */
export const JUDGE_QUESTIONS = Object.freeze({
  disposition: {
    type: "choice",
    instructions:
      "This AWS resource is running in the account and swamp does not manage " +
      "it yet. What should swamp do with it? Judge from its type, tier, " +
      "tags, and attributes. Who created it does not matter.",
    criteria: {
      "manage":
        "A durable resource a person or an IaC tool owns; swamp should hold " +
        "its definition and keep it equal to reality.",
      "observe-only":
        "Worth watching for drift or posture, but changing it through swamp " +
        "would be risky or pointless (shared, foundational, or rarely edited).",
      "exclude": "Ephemeral or created and reconciled by another controller " +
        "(Auto Scaling, EKS, CDK bootstrap, Control Tower, an AWS service).",
      "retire-candidate":
        "Looks abandoned or unused: no meaningful tags, empty, disabled, or " +
        "named as a test or temporary resource.",
      "needs-human":
        "The attributes do not support any of the other answers with " +
        "confidence.",
    },
  },
  blast_radius: {
    type: "score",
    instructions:
      "If swamp misconfigured or replaced this resource, how bad would the " +
      "consequence be?",
    criteria: [
      "Low: easily recreated, nothing depends on it",
      "Moderate: brief disruption to one workload",
      "High: outage or data loss for a workload, or broad network impact",
      "Critical: account-wide outage, irreversible data loss, or loss of " +
      "access",
    ],
  },
  controller_owned: {
    type: "noul",
    instructions:
      "Is this resource created and reconciled by another controller (Auto " +
      "Scaling, EKS, CDK, Control Tower, or a service-linked role) rather " +
      "than by a person or an IaC tool?",
    criteria: {
      true: "A controller creates it and would recreate or revert it.",
      false: "A person or an IaC tool such as Terraform or CloudFormation " +
        "created it.",
    },
  },
  risk: {
    type: "score",
    instructions:
      "Under a basic threat model, how exposed is this resource as it " +
      "stands? Consider exposure (public, internet-facing, open ingress), " +
      "protection (encryption at rest and in transit), privilege (IAM " +
      "wildcards, admin trust), sensitivity (data classification from tags " +
      "and names), and recoverability (backups, versioning, deletion " +
      "protection).",
    criteria: [
      "Low: private, encrypted, least privilege, recoverable",
      "Moderate: one weak control with no direct exposure",
      "High: exposed to the internet or broadly privileged, or sensitive " +
      "data without encryption or backups",
      "Critical: public access to sensitive data, or admin privilege open " +
      "to untrusted principals",
    ],
  },
});

// =============================================================================
// Deterministic settlement
// =============================================================================

/**
 * Flags that settle a candidate before any AI call. Flags not listed here
 * (`cfn-stack`) are informational: CloudFormation is an IaC tool, not a
 * controller, and its members are judged like anything else.
 */
export const SETTLING_FLAGS: Readonly<
  Record<string, { disposition: Disposition; reason: string }>
> = Object.freeze({
  "asg-managed": {
    disposition: "exclude",
    reason: "an Auto Scaling group creates and replaces it",
  },
  "eks-managed": {
    disposition: "exclude",
    reason: "EKS creates and reconciles it",
  },
  "service-linked-role": {
    disposition: "exclude",
    reason: "service-linked role owned by an AWS service",
  },
  "cdk-assets": {
    disposition: "exclude",
    reason: "CDK bootstrap assets bucket",
  },
  "control-tower": {
    disposition: "exclude",
    reason: "managed by Control Tower",
  },
  "default-vpc": {
    disposition: "observe-only",
    reason: "the region's default VPC",
  },
  "read-failed": {
    disposition: "needs-human",
    reason: "GetResource failed, so its attributes are incomplete",
  },
});

/** Order in which settling flags win when a candidate carries several. */
const SETTLE_ORDER = [
  "read-failed",
  "service-linked-role",
  "control-tower",
  "asg-managed",
  "eks-managed",
  "cdk-assets",
  "default-vpc",
];

/** The rule that settles a candidate, or null when jev should judge it. */
export function settle(
  candidate: Pick<AdoptionCandidate, "flags">,
): { flag: string; disposition: Disposition; reason: string } | null {
  for (const flag of SETTLE_ORDER) {
    if (candidate.flags.includes(flag)) {
      return { flag, ...SETTLING_FLAGS[flag] };
    }
  }
  return null;
}

// =============================================================================
// Judge request
// =============================================================================

/** Largest batch `triage_batch` accepts. */
export const MAX_JUDGE_ITEMS = 100;

/** One item as `triage_batch` takes it. */
export interface JudgeItem {
  id: string;
  state: Record<string, unknown>;
}

/** The `judgeRequest` resource written by `prepare_judgement`. */
export const JudgeRequestSchema = z.object({
  planName: z.string(),
  planFetchedAt: z.string(),
  batchName: z.string().describe("`name` to pass to triage_batch"),
  maxItems: z.number().describe("The item cap this request was built with"),
  items: z.array(z.object({
    id: z.string(),
    state: z.record(z.string(), z.unknown()),
  })),
  itemCandidates: z.record(z.string(), z.string()).describe(
    "Item id → candidate id",
  ),
  questions: z.record(z.string(), z.unknown()),
  fingerprint: z.string().describe(
    "SHA-256 of items, computed as triage_batch computes sourceFingerprint",
  ),
  overflow: z.array(z.string()).describe(
    "Candidate ids left out by the item cap; decide sends them to a human",
  ),
  counts: z.object({
    candidates: z.number(),
    alreadyManaged: z.number(),
    settled: z.number(),
    judged: z.number(),
    overflow: z.number(),
  }),
  fetchedAt: z.string(),
  collectedBy: z.string().optional(),
});

/** Parsed `judgeRequest`. */
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;

/** What jev sees for one candidate: type facts plus its judgeState. */
export function judgeItemState(
  candidate: AdoptionCandidate,
): Record<string, unknown> {
  const type = ADOPTION_TYPES_BY_CFN.get(candidate.cfnType);
  return {
    cfnType: candidate.cfnType,
    tier: type?.tier ?? null,
    stateful: type?.stateful ?? null,
    cfnStack: candidate.cfnStack,
    flags: candidate.flags,
    attributes: candidate.judgeState,
  };
}

/** Deterministic JSON with sorted keys, matching `triage_batch`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")
  }}`;
}

/** SHA-256 over `{id, state}` items, as `triage_batch` writes it. */
export async function itemsFingerprint(
  items: readonly JudgeItem[],
): Promise<string> {
  const snapshot = items.map(({ id, state }) => ({ id, state }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(snapshot)),
  );
  return `sha256-${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

/** Rank of a candidate's type; unknown types sort last. */
function rankOf(candidate: Pick<AdoptionCandidate, "cfnType">): number {
  return ADOPTION_TYPES_BY_CFN.get(candidate.cfnType)?.rank ?? 999;
}

/** Plan fields the judgement and decision steps read. */
export interface PlanView {
  scope: "sweep" | "stack";
  accountId: string;
  region: string;
  stackName: string | null;
  candidates: AdoptionCandidate[];
  fetchedAt: string;
}

/**
 * Build the batch jev judges: unmanaged candidates the flags did not settle,
 * in rank order, capped at `maxItems`. Item ids are candidate model names,
 * which are unique within a plan and short enough for `triage_batch`.
 */
export async function buildJudgeRequest(
  plan: PlanView,
  planName: string,
  maxItems: number,
): Promise<Omit<JudgeRequest, "fetchedAt" | "collectedBy">> {
  const cap = Math.min(Math.max(maxItems, 0), MAX_JUDGE_ITEMS);
  const unsettled = plan.candidates
    .filter((c) => !c.swampManaged && settle(c) === null)
    .sort((a, b) => rankOf(a) - rankOf(b) || a.id.localeCompare(b.id));
  const judged = unsettled.slice(0, cap);
  // Round-trip through JSON so the items are exactly what the workflow
  // transports to triage_batch: no undefined values, no Dates.
  const items: JudgeItem[] = JSON.parse(JSON.stringify(
    judged.map((c) => ({ id: c.modelName, state: judgeItemState(c) })),
  ));
  const alreadyManaged = plan.candidates.filter((c) => c.swampManaged).length;
  return {
    planName,
    planFetchedAt: plan.fetchedAt,
    batchName: `adopt-${fnv1a(`${plan.accountId}|${planName}`)}`,
    maxItems: cap,
    items,
    itemCandidates: Object.fromEntries(judged.map((c) => [c.modelName, c.id])),
    questions: JUDGE_QUESTIONS,
    fingerprint: await itemsFingerprint(items),
    overflow: unsettled.slice(cap).map((c) => c.id),
    counts: {
      candidates: plan.candidates.length,
      alreadyManaged,
      settled: plan.candidates.length - alreadyManaged - unsettled.length,
      judged: judged.length,
      overflow: unsettled.length - judged.length,
    },
  };
}

// =============================================================================
// jev answers
// =============================================================================

/**
 * The `triageBatch` resource from `triage_batch`, validated loosely: answers
 * are read defensively, and anything malformed counts as no answer.
 */
export const JudgementSchema = z.object({
  sourceFingerprint: z.string(),
  results: z.array(z.object({
    id: z.string(),
    answers: z.record(z.string(), z.unknown()),
  })),
  failures: z.array(z.object({ id: z.string(), reason: z.string() }))
    .default([]),
  model: z.string().optional(),
  evaluatedAt: z.string().optional(),
}).loose();

/** Parsed `triageBatch`. */
export type Judgement = z.infer<typeof JudgementSchema>;

/** jev's answers for one candidate, normalised. */
export interface JevView {
  disposition: string | null;
  confidence: number | null;
  /** 0–1: the score's position along its levels. */
  blastRadius: number | null;
  controllerOwned: number | null;
  /** 0–1: the score's position along its levels. */
  risk: number | null;
  riskLevel: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A score answer as a 0–1 position, and the legend text of its nearest level.
 * jev's `score` runs from 0 to one less than the number of levels.
 */
export function normalizeScore(
  answer: unknown,
): { value: number; level: string | null } | null {
  const a = asRecord(answer);
  if (!a || a.type !== "score") return null;
  const score = finite(a.score);
  const legend = asRecord(a.legend);
  const levels = legend ? Object.keys(legend).length : 0;
  if (score === null || levels < 2) return null;
  const value = Math.min(Math.max(score / (levels - 1), 0), 1);
  const nearest = legend?.[String(Math.round(score))];
  return { value, level: typeof nearest === "string" ? nearest : null };
}

/** Read one candidate's answers into a {@link JevView}. */
export function readAnswers(answers: Record<string, unknown>): JevView {
  const choice = asRecord(answers.disposition);
  const owned = asRecord(answers.controller_owned);
  const blast = normalizeScore(answers.blast_radius);
  const risk = normalizeScore(answers.risk);
  return {
    disposition: choice?.type === "choice" && typeof choice.choice === "string"
      ? choice.choice
      : null,
    confidence: choice?.type === "choice" ? finite(choice.confidence) : null,
    blastRadius: blast?.value ?? null,
    controllerOwned: owned?.type === "noul" ? finite(owned.noul) : null,
    risk: risk?.value ?? null,
    riskLevel: risk?.level ?? null,
  };
}

// =============================================================================
// Decide
// =============================================================================

/** Thresholds for {@link decideCandidates}. */
export interface DecideOptions {
  /** Whether the workflow asked jev at all. */
  judge: boolean;
  /** A jev disposition below this confidence goes to a human. */
  minConfidence: number;
  /** 0–1 blast radius at or above which a stateful `manage` needs a human. */
  highBlastRadius: number;
  /** 0–1 risk at or above which a candidate is listed in `findings`. */
  highRisk: number;
  /** A controller_owned probability at or above this blocks `manage`. */
  controllerOwnedAt: number;
}

/** Defaults: a four-level score is "high" from its third level up. */
export const DEFAULT_DECIDE_OPTIONS: Readonly<Omit<DecideOptions, "judge">> =
  Object.freeze({
    minConfidence: 0.7,
    highBlastRadius: 2 / 3,
    highRisk: 2 / 3,
    controllerOwnedAt: 0.5,
  });

/** One candidate's decision and its provenance. */
export const CandidateDecisionSchema = z.object({
  id: z.string(),
  cfnType: z.string(),
  swampType: z.string(),
  identifier: z.string(),
  region: z.string(),
  modelName: z.string(),
  tier: z.string().nullable(),
  rank: z.number(),
  stateful: z.boolean(),
  disposition: z.enum(DISPOSITIONS),
  decidedBy: z.enum(DECIDED_BY),
  confidence: z.number().nullable(),
  reason: z.string(),
  jev: z.object({
    disposition: z.string().nullable(),
    confidence: z.number().nullable(),
    blastRadius: z.number().nullable(),
    controllerOwned: z.number().nullable(),
    risk: z.number().nullable(),
    riskLevel: z.string().nullable(),
  }).nullable(),
  wave: z.number().nullable(),
});

/** Inferred decision type. */
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

/** What happened to the jev batch. */
export const JUDGEMENT_STATUSES = [
  "used",
  "disabled",
  "unavailable",
  "mismatched",
  "not-needed",
  "capped",
] as const;

/** The `adoptionDecision` resource written by `decide`. */
export const AdoptionDecisionSchema = z.object({
  scope: z.enum(["sweep", "stack"]),
  planName: z.string(),
  planFetchedAt: z.string(),
  accountId: z.string(),
  region: z.string(),
  stackName: z.string().nullable(),
  judgement: z.object({
    status: z.enum(JUDGEMENT_STATUSES),
    model: z.string().nullable(),
    evaluatedAt: z.string().nullable(),
    requested: z.number(),
    answered: z.number(),
    failed: z.number(),
    overflow: z.number(),
  }),
  options: z.object({
    minConfidence: z.number(),
    highBlastRadius: z.number(),
    highRisk: z.number(),
    controllerOwnedAt: z.number(),
  }),
  decisions: z.array(CandidateDecisionSchema),
  observe: z.array(z.object({
    id: z.string(),
    swampType: z.string(),
    modelName: z.string(),
    identifier: z.string(),
    region: z.string(),
    disposition: z.enum(["manage", "observe-only"]),
    wave: z.number(),
  })).describe("manage and observe-only candidates in wave order"),
  waves: z.array(z.object({
    wave: z.number(),
    candidates: z.array(z.string()),
  })),
  findings: z.array(z.object({
    id: z.string(),
    cfnType: z.string(),
    identifier: z.string(),
    modelName: z.string(),
    disposition: z.enum(DISPOSITIONS),
    risk: z.number(),
    riskLevel: z.string().nullable(),
  })).describe("High-risk candidates, whatever their disposition"),
  alreadyManaged: z.array(z.string()),
  warnings: z.array(z.string()),
  summary: z.object({
    total: z.number(),
    alreadyManaged: z.number(),
    byDisposition: z.record(z.string(), z.number()),
    byDecidedBy: z.record(z.string(), z.number()),
    waves: z.number(),
    findings: z.number(),
  }),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

/** Inferred decision resource type. */
export type AdoptionDecision = z.infer<typeof AdoptionDecisionSchema>;

/** Why an unsettled candidate has no usable jev answer. */
function missingAnswerReason(
  status: typeof JUDGEMENT_STATUSES[number],
  cap: number,
  overflow: boolean,
  failed: boolean,
): string {
  // Say why jev was not asked before saying which candidates it would skip.
  if (status === "disabled") return "not judged: the judge input is off";
  if (overflow) return `not judged: over the judge cap of ${cap} candidates`;
  switch (status) {
    case "mismatched":
      return "not judged: the jev batch was computed from a different " +
        "candidate set";
    case "unavailable":
      return "not judged: no jev batch reached decide (jev failed, or " +
        "decide ran without one)";
    default:
      return failed
        ? "not judged: jev could not evaluate this candidate"
        : "not judged: jev returned no answer for this candidate";
  }
}

/** Apply the rules to one jev answer. */
function ruleOnAnswer(
  view: JevView,
  stateful: boolean,
  options: DecideOptions,
): { disposition: Disposition; decidedBy: "rule" | "jev"; reason: string } {
  const choice = view.disposition;
  if (!choice || !(DISPOSITIONS as readonly string[]).includes(choice)) {
    return {
      disposition: "needs-human",
      decidedBy: "rule",
      reason: "jev returned no valid disposition",
    };
  }
  const confidence = view.confidence ?? 0;
  if (confidence < options.minConfidence) {
    return {
      disposition: "needs-human",
      decidedBy: "rule",
      reason: `jev suggested ${choice} at confidence ${
        confidence.toFixed(2)
      }, below ${options.minConfidence}`,
    };
  }
  if (
    choice === "manage" && view.controllerOwned !== null &&
    view.controllerOwned >= options.controllerOwnedAt
  ) {
    return {
      disposition: "needs-human",
      decidedBy: "rule",
      reason: `jev suggested manage but rates it controller-owned (${
        view.controllerOwned.toFixed(2)
      })`,
    };
  }
  if (
    choice === "manage" && stateful && view.blastRadius !== null &&
    view.blastRadius >= options.highBlastRadius
  ) {
    return {
      disposition: "needs-human",
      decidedBy: "rule",
      reason: `stateful with high blast radius (${
        view.blastRadius.toFixed(2)
      }); manage needs a human`,
    };
  }
  return {
    disposition: choice as Disposition,
    decidedBy: "jev",
    reason: `jev: ${choice} at confidence ${confidence.toFixed(2)}`,
  };
}

/**
 * Assign waves to the candidates to observe. A candidate's wave is one past
 * the latest wave among its dependencies in the same set, so dependencies are
 * observed and promoted first. A dependency cycle is broken at the edge that
 * closes it and reported in `warnings`.
 */
export function assignWaves(
  items: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>,
  warnings: string[],
): Map<string, number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = waves.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let wave = 0;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      if (visiting.has(dep)) {
        warnings.push(`dependency cycle broken at ${id} → ${dep}`);
        continue;
      }
      wave = Math.max(wave, visit(dep) + 1);
    }
    visiting.delete(id);
    waves.set(id, wave);
    return wave;
  };
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    visit(item.id);
  }
  return waves;
}

function count(
  values: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * Decide every unmanaged candidate in a plan. Rules settle flagged
 * candidates; jev's answers decide the rest only when its batch matches the
 * request's fingerprint and the rules allow it; everything else goes to a
 * human. High-risk candidates are listed in `findings` whatever their
 * disposition. `decide` changes nothing in AWS.
 */
export function decideCandidates(
  plan: PlanView,
  request: Omit<JudgeRequest, "fetchedAt" | "collectedBy">,
  judgement: Judgement | null,
  options: DecideOptions,
): Omit<AdoptionDecision, "fetchedAt" | "durationMs" | "collectedBy"> {
  const warnings: string[] = [];
  let status: typeof JUDGEMENT_STATUSES[number];
  if (request.items.length === 0 && request.overflow.length === 0) {
    status = "not-needed";
  } else if (!options.judge) status = "disabled";
  else if (request.items.length === 0) status = "capped";
  else if (!judgement) status = "unavailable";
  else if (judgement.sourceFingerprint !== request.fingerprint) {
    status = "mismatched";
    warnings.push(
      "the jev batch fingerprint does not match this plan's judge request; " +
        "its answers were ignored",
    );
  } else status = "used";

  const answers = new Map<string, Record<string, unknown>>();
  const failedItems = new Set<string>();
  if (status === "used" && judgement) {
    for (const r of judgement.results) {
      const candidateId = request.itemCandidates[r.id];
      if (candidateId) answers.set(candidateId, r.answers);
    }
    for (const f of judgement.failures) {
      const candidateId = request.itemCandidates[f.id];
      if (candidateId) failedItems.add(candidateId);
    }
  }
  const overflow = new Set(request.overflow);

  const alreadyManaged: string[] = [];
  const decisions: CandidateDecision[] = [];
  const dependsOn = new Map<string, readonly string[]>();
  for (const c of plan.candidates) {
    if (c.swampManaged) {
      alreadyManaged.push(c.id);
      continue;
    }
    dependsOn.set(c.id, c.dependsOn);
    const type = ADOPTION_TYPES_BY_CFN.get(c.cfnType);
    const stateful = type?.stateful ?? false;
    const base = {
      id: c.id,
      cfnType: c.cfnType,
      swampType: c.swampType,
      identifier: c.identifier,
      region: c.region,
      modelName: c.modelName,
      tier: type?.tier ?? null,
      rank: rankOf(c),
      stateful,
      wave: null,
    };
    const settled = settle(c);
    if (settled) {
      decisions.push({
        ...base,
        disposition: settled.disposition,
        decidedBy: "rule",
        confidence: null,
        reason: `${settled.flag}: ${settled.reason}`,
        jev: null,
      });
      continue;
    }
    const raw = answers.get(c.id);
    if (!raw) {
      decisions.push({
        ...base,
        disposition: "needs-human",
        decidedBy: "default",
        confidence: null,
        reason: missingAnswerReason(
          status,
          request.maxItems,
          overflow.has(c.id),
          failedItems.has(c.id),
        ),
        jev: null,
      });
      continue;
    }
    const view = readAnswers(raw);
    const ruled = ruleOnAnswer(view, stateful, options);
    decisions.push({
      ...base,
      ...ruled,
      confidence: view.confidence,
      jev: view,
    });
  }

  const actionable = decisions.filter((d) =>
    d.disposition === "manage" || d.disposition === "observe-only"
  );
  const waveOf = assignWaves(
    actionable.map((d) => ({ id: d.id, dependsOn: dependsOn.get(d.id) ?? [] })),
    warnings,
  );
  for (const d of actionable) d.wave = waveOf.get(d.id) ?? 0;

  const blast = (d: CandidateDecision) => d.jev?.blastRadius ?? 0;
  const ordered = [...actionable].sort((a, b) =>
    (a.wave ?? 0) - (b.wave ?? 0) || a.rank - b.rank ||
    blast(a) - blast(b) || a.id.localeCompare(b.id)
  );
  const waves: Array<{ wave: number; candidates: string[] }> = [];
  for (const d of ordered) {
    const wave = d.wave ?? 0;
    let group = waves.find((w) => w.wave === wave);
    if (!group) {
      group = { wave, candidates: [] };
      waves.push(group);
    }
    group.candidates.push(d.id);
  }

  const findings = decisions
    .filter((d) => d.jev?.risk !== null && d.jev?.risk !== undefined)
    .filter((d) => (d.jev!.risk as number) >= options.highRisk)
    .sort((a, b) =>
      (b.jev!.risk as number) - (a.jev!.risk as number) ||
      a.id.localeCompare(b.id)
    )
    .map((d) => ({
      id: d.id,
      cfnType: d.cfnType,
      identifier: d.identifier,
      modelName: d.modelName,
      disposition: d.disposition,
      risk: d.jev!.risk as number,
      riskLevel: d.jev!.riskLevel,
    }));

  const answered = status === "used" ? answers.size : 0;
  return {
    scope: plan.scope,
    planName: request.planName,
    planFetchedAt: plan.fetchedAt,
    accountId: plan.accountId,
    region: plan.region,
    stackName: plan.stackName,
    judgement: {
      status,
      model: judgement?.model ?? null,
      evaluatedAt: judgement?.evaluatedAt ?? null,
      requested: request.items.length,
      answered,
      failed: status === "used" ? failedItems.size : 0,
      overflow: request.overflow.length,
    },
    options: {
      minConfidence: options.minConfidence,
      highBlastRadius: options.highBlastRadius,
      highRisk: options.highRisk,
      controllerOwnedAt: options.controllerOwnedAt,
    },
    decisions,
    observe: ordered.map((d) => ({
      id: d.id,
      swampType: d.swampType,
      modelName: d.modelName,
      identifier: d.identifier,
      region: d.region,
      disposition: d.disposition as "manage" | "observe-only",
      wave: d.wave ?? 0,
    })),
    waves,
    findings,
    alreadyManaged,
    warnings,
    summary: {
      total: plan.candidates.length,
      alreadyManaged: alreadyManaged.length,
      byDisposition: count(decisions.map((d) => d.disposition)),
      byDecidedBy: count(decisions.map((d) => d.decidedBy)),
      waves: waves.length,
      findings: findings.length,
    },
  };
}
