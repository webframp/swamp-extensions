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

import { registry } from "./_lib/normalizers/registry.ts";
import { render } from "./_lib/render.ts";
import type {
  Contribution,
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

interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface WorkflowReportContext {
  workflowName?: string;
  workflowStatus?: string;
  stepExecutions?: StepExecution[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

/**
 * Outcome of reading one data handle. `data` is the parsed object, or `null`
 * when the resource is genuinely absent/empty (NOT an error). `parseError` is
 * true only for a real read failure (both `getContent` attempts threw) or a
 * `JSON.parse` failure — those are the only cases the caller counts.
 */
interface ReadResult {
  data: Record<string, unknown> | null;
  parseError: boolean;
}

/**
 * Read a data handle's bytes and JSON-parse. Tries the string modelType first
 * (works with the test mock); ONLY if that first `getContent` call itself
 * throws does it retry with a type-like object. A `JSON.parse` failure never
 * re-fetches. A genuine `null`/empty body is reported as `{ data: null,
 * parseError: false }` so the caller does not miscount an absent resource as a
 * parse failure. Never throws (degrade contract).
 */
async function readJson(
  repo: DataRepository,
  modelType: string,
  modelId: string,
  dataName: string,
  version?: number,
): Promise<ReadResult> {
  let raw: Uint8Array | null;
  try {
    raw = await repo.getContent(modelType, modelId, dataName, version);
  } catch {
    // The first getContent call itself threw — retry the alternate modelType
    // arg once. A parse failure below must NOT reach this path.
    try {
      const typeArg = {
        raw: modelType,
        toDirectoryPath: () => modelType,
        toString: () => modelType,
      };
      raw = await repo.getContent(typeArg, modelId, dataName, version);
    } catch {
      return { data: null, parseError: true };
    }
  }
  if (!raw) return { data: null, parseError: false };
  try {
    return {
      data: JSON.parse(new TextDecoder().decode(raw)),
      parseError: false,
    };
  } catch {
    return { data: null, parseError: true };
  }
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

      for (const step of steps) {
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

        if (inputs.length === 0) continue;

        try {
          const contrib: Contribution = normalizer(inputs);
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

      const result = render(queue, ops, notes, generatedAt, false, {
        skippedSteps,
        parseFailures,
      });

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
