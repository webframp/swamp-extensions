/**
 * Report: @webframp/operator-briefing (workflow scope).
 *
 * The unified daily briefing. Loops the workflow's step executions, dispatches
 * each step by `modelType` to a normalizer via the registry, reads that step's
 * data handles, and flattens everything into a `QueueItem[]` (four tiers) and
 * `OpsSignal[]` (freshness- and degradation-aware). Renders a consistent
 * markdown briefing plus a stable JSON contract that downstream renderers
 * (live HTML view, executive R/vellum reports) consume.
 *
 * Contract: degrade, never throw. Unknown modelType / missing normalizer /
 * parse failure -> skip and count. Any unexpected error -> a valid
 * `{ markdown, json }` with `degraded: true`.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */
// deno-lint-ignore-file no-explicit-any

import { nonSourceModelTypes, registry } from "./_lib/normalizers/registry.ts";
import { render } from "./_lib/render.ts";
import { type DataRepository, readJson } from "./_lib/read.ts";
import type {
  Contribution,
  NormalizerContext,
  OpsSignal,
  QueueItem,
  SourceInput,
} from "./_lib/shapes.ts";

interface DataHandle {
  name: string;
  dataId?: string;
  version?: number;
}

interface StepExecution {
  jobName?: string;
  stepName?: string;
  modelName?: string;
  modelType: string;
  modelId: string;
  methodName?: string;
  status?: string;
  dataHandles?: DataHandle[];
}

interface WorkflowReportContext {
  workflowName?: string;
  workflowStatus?: string;
  stepExecutions?: StepExecution[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

const SECURITYHUB_TYPE = "@webframp/aws/securityhub-findings";
const GITLAB_TYPE = "@webframp/gitlab";
const TYPESAFE_TYPE = "@swamp/typesafe-ai";

function canonicalJson(value: unknown): string {
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

export async function queueFingerprint(reviewing: unknown[]): Promise<string> {
  const items = reviewing.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.reference !== "string") return [];
    return [{
      id: item.reference,
      state: {
        reference: item.reference,
        title: item.title ?? null,
        updatedAt: item.updatedAt ?? null,
        draft: item.draft ?? null,
        labels: item.labels ?? null,
        approvedByMe: item.approvedByMe ?? null,
        myReviewState: item.myReviewState ?? null,
      },
    }];
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(items)),
  );
  return `sha256-${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function triageRank(answers: Record<string, unknown> | undefined): number {
  if (!answers) return Number.NEGATIVE_INFINITY;
  const urgency = answers.urgency;
  const reply = answers.reply_needed;
  const score = urgency && typeof urgency === "object" &&
      typeof (urgency as Record<string, unknown>).score === "number"
    ? (urgency as Record<string, number>).score
    : 0;
  const noul = reply && typeof reply === "object" &&
      typeof (reply as Record<string, unknown>).noul === "number"
    ? (reply as Record<string, number>).noul
    : 0;
  return score * 10 + noul;
}

/** Apply verified AI priority only within a tier; facts and deterministic ties remain intact. */
function prioritizeQueue(
  queue: QueueItem[],
  answers: ReadonlyMap<string, Record<string, unknown>>,
): void {
  if (answers.size === 0) return;
  const indexed = queue.map((item, index) => ({ item, index }));
  indexed.sort((a, b) => {
    if (a.item.tier !== b.item.tier) return a.item.tier - b.item.tier;
    const delta = triageRank(answers.get(b.item.reference)) -
      triageRank(answers.get(a.item.reference));
    if (!Number.isNaN(delta) && delta !== 0) return delta;
    const ageDelta = b.item.ageDays - a.item.ageDays;
    return ageDelta !== 0 ? ageDelta : a.index - b.index;
  });
  queue.splice(0, queue.length, ...indexed.map(({ item }) => item));
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Read a `{choice, confidence}` pair from a jev choice answer, or undefined
 * when the shape is not a usable choice answer.
 */
function choiceAnswer(
  value: unknown,
): { choice: string; confidence: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const confidence = num(a.confidence);
  return typeof a.choice === "string" && confidence !== undefined
    ? { choice: a.choice, confidence }
    : undefined;
}

/**
 * Read a `{score, confidence}` pair from a jev score answer, or undefined.
 */
function scoreAnswer(
  value: unknown,
): { score: number; confidence: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const score = num(a.score);
  const confidence = num(a.confidence);
  return score !== undefined && confidence !== undefined
    ? { score, confidence }
    : undefined;
}

/**
 * Attach jev triage/grade/assessment answers onto matching queue items as
 * advisory `QueueItem.jev` enrichment. Joins by `reference` == the jev item id
 * (MR reference or `<projectName>#<id>` for a Redmine issue — the same form
 * the Redmine normalizer builds as `reference`, using the project NAME, not its
 * numeric id). Partitions each answer
 * set by the keys present — MR triage (`recommendation`), Renovate grade
 * (`bump_risk`), issue assessment (`issue_type` / `source_domain` /
 * `describes_vulnerability`). ADDITIVE AND ADVISORY: this never reorders or
 * re-tiers the queue (operator decision, 2026-09-25) — it only decorates.
 */
function attachJevEnrichment(
  queue: QueueItem[],
  jevAnswers: ReadonlyMap<string, Record<string, unknown>>,
): void {
  if (jevAnswers.size === 0) return;
  for (const item of queue) {
    const answers = jevAnswers.get(item.reference);
    if (!answers) continue;
    const jev: NonNullable<QueueItem["jev"]> = {};
    const recommendation = choiceAnswer(answers.recommendation);
    if (recommendation) jev.recommendation = recommendation;
    const bumpRisk = scoreAnswer(answers.bump_risk);
    if (bumpRisk) jev.bumpRisk = bumpRisk;
    const issueType = choiceAnswer(answers.issue_type);
    if (issueType) jev.issueType = issueType;
    const sourceDomain = choiceAnswer(answers.source_domain);
    if (sourceDomain) jev.sourceDomain = sourceDomain;
    const vuln = answers.describes_vulnerability;
    if (vuln && typeof vuln === "object") {
      const noul = num((vuln as Record<string, unknown>).noul);
      if (noul !== undefined) jev.describesVulnerability = noul;
    }
    // Only attach when at least one dimension was present.
    if (Object.keys(jev).length > 0) item.jev = jev;
  }
}

/**
 * Read the Security Hub account map once for this report. It is enrichment
 * only: unknown IDs are deliberately not retained or rendered elsewhere.
 */
async function collectAccountNames(
  steps: StepExecution[],
  repository: DataRepository,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  for (const step of steps) {
    if (step.modelType !== SECURITYHUB_TYPE) continue;
    for (const handle of step.dataHandles ?? []) {
      if (!handle?.name || handle.name.startsWith("report-")) continue;
      const { data } = await readJson(
        repository,
        step.modelType,
        step.modelId,
        handle.name,
        handle.version,
      );
      if (!data || !Array.isArray(data.accounts)) continue;
      for (const account of data.accounts) {
        if (!account || typeof account !== "object") continue;
        const candidate = account as Record<string, unknown>;
        if (
          typeof candidate.id === "string" && candidate.id.length > 0 &&
          typeof candidate.name === "string" && candidate.name.length > 0
        ) {
          names.set(candidate.id, candidate.name);
        }
      }
    }
  }
  return names;
}

/**
 * The `@webframp/operator-briefing` workflow-scope report. Aggregates every
 * source that ran in a `daily-briefing` workflow into a four-tier review queue
 * plus ops signals, and returns `{ markdown, json }` where the JSON is the
 * stable downstream contract. Never throws — it degrades and records why.
 */
export const report = {
  name: "@webframp/operator-briefing",
  description:
    "Unified daily operator briefing: GitLab review queue (four tiers) plus ops signals (analytics, compliance, AWS quotas), normalized into a consistent markdown briefing and a stable JSON contract.",
  scope: "workflow" as const,
  labels: ["briefing", "operator", "gitlab", "ops", "dashboard"],

  async execute(
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const generatedAt = new Date().toISOString();

    try {
      const queue: QueueItem[] = [];
      const ops: OpsSignal[] = [];
      const notes: string[] = [];
      let skippedSteps = 0;
      let parseFailures = 0;

      const steps = context.stepExecutions ?? [];
      const normalizerContext: NormalizerContext = {
        accountNames: await collectAccountNames(steps, context.dataRepository),
        triageAnswers: new Map(),
        jevAnswers: new Map(),
      };

      for (const step of steps) {
        // Non-source steps (e.g. the metrics accumulator appending to the trend
        // series) run in the same workflow but contribute no queue/ops items.
        // Skip them silently — counting them as a skipped source would falsely
        // mark the whole briefing degraded.
        if (nonSourceModelTypes.has(step.modelType)) continue;

        // A step the workflow engine SKIPPED (its guard fired — an expected
        // idempotency outcome, e.g. jev triage guarded off an empty queue) is
        // not a source failure. It carries no data and often no modelType.
        // Skip it silently; counting it would falsely mark the contract
        // degraded. Same for a step that produced no data handles at all.
        if (step.status === "skipped") continue;

        const normalizer = registry[step.modelType];
        if (!normalizer) {
          skippedSteps++;
          notes.push(
            `No normalizer for ${step.modelType} — step "${
              step.stepName ?? step.methodName ?? "?"
            }" skipped.`,
          );
          continue;
        }

        // Collect this step's non-report data resources.
        const inputs: SourceInput[] = [];
        for (const handle of step.dataHandles ?? []) {
          if (!handle?.name || handle.name.startsWith("report-")) continue;
          const { data, parseError } = await readJson(
            context.dataRepository,
            step.modelType,
            step.modelId,
            handle.name,
            handle.version,
          );
          if (parseError) {
            parseFailures++;
            continue;
          }
          // A genuine null (absent/empty resource) is not an error — skip it
          // without counting it against the parse-failure budget.
          if (data === null) continue;
          inputs.push({ dataName: handle.name, data });
        }

        if (inputs.length === 0) {
          // An interpretation outage must not hide the factual signals that
          // precede it or fail the whole report. Make the degradation explicit
          // so callers can distinguish "no anomaly" from "no verdict".
          if (
            step.modelType === TYPESAFE_TYPE && step.methodName === "ask" &&
            step.status === "failed"
          ) {
            ops.push({
              source: "jev",
              label: `verdict:${step.stepName ?? step.methodName ?? "unknown"}`,
              severity: "warn",
              detail:
                "interpretation unavailable; factual source signals remain available",
              fetchedAt: null,
              stale: false,
              degraded: true,
              degradedReason: "ask evaluation failed",
            });
          }
          continue;
        }

        // Reuse the queue input already read for the GitLab normalizer. This
        // avoids a second repository read and scopes a later batch verdict to
        // this exact compact source snapshot.
        if (step.modelType === GITLAB_TYPE) {
          const queueData = inputs.find((input) =>
            Array.isArray(input.data.reviewing)
          )?.data.reviewing;
          if (Array.isArray(queueData)) {
            normalizerContext.triageFingerprint = await queueFingerprint(
              queueData,
            );
          }
        }

        try {
          const contrib: Contribution = normalizer(inputs, normalizerContext);
          queue.push(...contrib.queue);
          ops.push(...contrib.ops);
          notes.push(...contrib.notes);
        } catch (err) {
          skippedSteps++;
          notes.push(
            `Normalizer for ${step.modelType} failed (${
              err instanceof Error ? err.message : String(err)
            }) — skipped.`,
          );
        }
      }

      if (parseFailures > 0) {
        notes.push(
          `${parseFailures} data handle(s) could not be read or parsed — skipped.`,
        );
      }
      if (skippedSteps > 0) {
        notes.push(`${skippedSteps} step(s) skipped (no normalizer or error).`);
      }

      const triageAnswers = normalizerContext.triageAnswers ?? new Map();
      prioritizeQueue(queue, triageAnswers);

      // Advisory jev enrichment: decorate queue items with recommendation /
      // bump-risk / issue-assessment answers. Runs AFTER ordering so it can
      // never influence it (operator decision: jev does not reorder the
      // contract). Attach-only; additive to the stable contract.
      attachJevEnrichment(queue, normalizerContext.jevAnswers ?? new Map());

      const result = render(queue, ops, notes, generatedAt, false, {
        skippedSteps,
        parseFailures,
      }, triageAnswers.size > 0);

      context.logger?.info?.(
        "operator-briefing: {queue} queue items, {ops} ops signals, {skipped} skipped",
        { queue: queue.length, ops: ops.length, skipped: skippedSteps },
      );

      return { markdown: result.markdown, json: result.json as any };
    } catch (err) {
      // Degrade, never throw.
      const message = err instanceof Error ? err.message : String(err);
      const result = render(
        [],
        [],
        [
          `Report degraded: ${message}`,
        ],
        generatedAt,
        true,
      );
      return { markdown: result.markdown, json: result.json as any };
    }
  },
};
