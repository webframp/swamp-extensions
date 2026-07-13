/**
 * Report: @webframp/operator-briefing/review-queue (method scope).
 *
 * The GitLab review-queue fast path. Attached to the `@webframp/gitlab` model,
 * it fires after ONE `list_my_merge_requests` execution and renders the four
 * review tiers LIVE — no workflow run, no ops section. It reuses the SAME
 * `_lib` the daily briefing uses (the gitlab normalizer and the shared queue
 * renderer), so its GitLab output is identical in shape and format to the
 * workflow briefing's GitLab section. The two reports render their tiers
 * through one `renderQueueSection`, so the tiering can never diverge.
 *
 * Contract: degrade, never throw. A handle that cannot be read/parsed is
 * counted; a missing dashboard yields a valid empty queue; any unexpected
 * error returns a valid `{ markdown, json }` with `degraded: true`. The JSON is
 * the same stable contract as the workflow report, restricted to the queue
 * tiers (`ops: []`).
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */
// deno-lint-ignore-file no-explicit-any

import { gitlabNormalizer, isDashboard } from "./_lib/normalizers/gitlab.ts";
import { renderQueueOnly } from "./_lib/render.ts";
import { type DataRepository, readJson } from "./_lib/read.ts";
import type { QueueItem, SourceInput } from "./_lib/shapes.ts";

interface DataHandle {
  name: string;
  dataId?: string;
  version?: number;
}

interface MethodReportContext {
  modelType: unknown;
  modelId: string;
  methodName?: string;
  executionStatus?: string;
  dataHandles?: DataHandle[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

/**
 * The `@webframp/operator-briefing/review-queue` method-scope report. Reads the
 * just-produced dashboard resource, runs the shared gitlab normalizer, and
 * renders only the four review tiers. Never throws — it degrades and records
 * why.
 */
export const report = {
  name: "@webframp/operator-briefing/review-queue",
  description:
    "Fast-path GitLab review queue (four tiers) rendered live on every `list_my_merge_requests` run. Reuses the daily briefing's shared normalizer and renderer so its output matches the briefing's GitLab section; emits the same stable JSON contract restricted to the queue tiers (no ops).",
  scope: "method" as const,
  labels: ["briefing", "operator", "gitlab", "review-queue", "fast-path"],

  async execute(
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const generatedAt = new Date().toISOString();

    try {
      const inputs: SourceInput[] = [];
      const notes: string[] = [];
      let parseFailures = 0;

      for (const handle of context.dataHandles ?? []) {
        // Skip this report's own output handles and unnamed handles.
        if (!handle?.name || handle.name.startsWith("report-")) continue;
        const { data, parseError } = await readJson(
          context.dataRepository,
          context.modelType,
          context.modelId,
          handle.name,
          handle.version,
        );
        if (parseError) {
          parseFailures++;
          continue;
        }
        // A genuine null (absent/empty resource) is not an error.
        if (data === null) continue;
        // Only the dashboard resource carries the review tiers; ignore any
        // other resource this method may have produced.
        if (!isDashboard(data)) continue;
        inputs.push({ dataName: handle.name, data });
      }

      if (parseFailures > 0) {
        notes.push(
          `${parseFailures} data handle(s) could not be read or parsed — skipped.`,
        );
      }
      if (inputs.length === 0 && parseFailures === 0) {
        notes.push("No dashboard resource in this execution.");
      }

      let skippedSteps = 0;
      let queue: QueueItem[] = [];
      try {
        const contrib = gitlabNormalizer(inputs);
        queue = contrib.queue;
        notes.push(...contrib.notes);
      } catch (err) {
        // Match the workflow report: a normalizer throw is counted, not fatal.
        skippedSteps++;
        notes.push(
          `Normalizer for @webframp/gitlab failed (${
            err instanceof Error ? err.message : String(err)
          }) — skipped.`,
        );
      }

      const result = renderQueueOnly(queue, notes, generatedAt, false, {
        skippedSteps,
        parseFailures,
      });

      context.logger?.info?.(
        "operator-briefing/review-queue: {queue} queue items, {parseFailures} unreadable",
        { queue: queue.length, parseFailures },
      );

      return { markdown: result.markdown, json: result.json as any };
    } catch (err) {
      // Degrade, never throw.
      const message = err instanceof Error ? err.message : String(err);
      const result = renderQueueOnly(
        [],
        [`Report degraded: ${message}`],
        generatedAt,
        true,
      );
      return { markdown: result.markdown, json: result.json as any };
    }
  },
};
