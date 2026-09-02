/**
 * Events aggregation model (DR-3).
 *
 * Between the four collectors and the scorer/graph sits one aggregation step.
 * It unions the deduped event batches each collector produced (wired in via CEL
 * from each collector's `data.latest(...)`), applies the rolling window cutoff
 * ONCE, and writes a single canonical `events` collection that both the scorer
 * and the interaction graph read.
 *
 * Why this exists (swamp-extension-plan.md DR-3): each collector writes its own
 * event batch, and a model cannot read another model's data from TypeScript.
 * The scorer and graph MUST see identical inputs (or centrality won't line up
 * with scores), so a single explicit aggregation guarantees one canonical set
 * with the window applied in exactly one place.
 *
 * Because each collector already deduped by resource instance name, this union
 * is pure. It nonetheless dedups by `eventId` defensively so the result is
 * total even if two sources ever mint the same id (they should not).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { type Event, EventSchema } from "./_lib/event.ts";

const EXTENSION_NAME = "@webframp/devops-measurement";

// =============================================================================
// Schemas
// =============================================================================

/** One collector's output batch (the shape each collect_* model writes). */
const EventBatchSchema = z.object({
  events: z.array(EventSchema).default([]),
  source: z.string().default(""),
  unresolvedCrews: z.number().default(0),
});

const AggregatedEventsSchema = z.object({
  events: z.array(EventSchema).describe("Canonical windowed event set"),
  count: z.number().describe("Number of events after windowing and dedup"),
  windowHours: z.number().describe("Rolling window applied, in hours"),
  cutoff: z.string().describe("ISO 8601 lower time bound applied"),
  bySource: z.record(z.string(), z.number()).describe(
    "Event counts per source after windowing",
  ),
  droppedOutOfWindow: z.number().describe(
    "Events discarded for falling before the cutoff",
  ),
  droppedNoTimestamp: z.number().describe(
    "Events discarded for having no parseable timestamp (cannot be windowed)",
  ),
  duplicatesCollapsed: z.number().describe(
    "Duplicate eventIds collapsed across batches (expected 0)",
  ),
  unresolvedCrews: z.number().describe(
    "Total unresolved-crew count summed across collector batches (DR-5)",
  ),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const GlobalArgsSchema = z.object({});

// =============================================================================
// Pure aggregation
// =============================================================================

/** One collector's event batch, as parsed from its `events` resource. */
export type Batch = z.infer<typeof EventBatchSchema>;

/** The result of `aggregate`: the merged event log plus per-source counts and drop/dedup diagnostics. */
export type AggregateResult = {
  events: Event[];
  bySource: Record<string, number>;
  droppedOutOfWindow: number;
  droppedNoTimestamp: number;
  duplicatesCollapsed: number;
  unresolvedCrews: number;
};

/**
 * Union event batches, drop events older than `cutoff`, dedup by eventId.
 * Pure and exported for unit testing.
 *
 * @param batches   Per-collector event batches.
 * @param cutoffIso ISO 8601 lower bound; events with an EARLIER timestamp are
 *                  dropped (counted in droppedOutOfWindow). Events with an
 *                  empty/unparseable timestamp cannot be windowed and are also
 *                  dropped (counted separately in droppedNoTimestamp) rather
 *                  than retained forever.
 */
export function aggregate(
  batches: Batch[],
  cutoffIso: string,
): AggregateResult {
  const cutoffMs = Date.parse(cutoffIso);
  const byId = new Map<string, Event>();
  const bySource: Record<string, number> = {};
  let droppedOutOfWindow = 0;
  let droppedNoTimestamp = 0;
  let duplicatesCollapsed = 0;
  let unresolvedCrews = 0;

  for (const batch of batches) {
    unresolvedCrews += batch.unresolvedCrews ?? 0;
    for (const e of batch.events) {
      const ts = Date.parse(e.timestamp);
      // An event with no parseable timestamp cannot be placed in the window and
      // would otherwise be retained on every future run forever, permanently
      // inflating activity counts. It is not a valid observation for a windowed
      // system, so drop it (counted) rather than keep it indefinitely.
      if (Number.isNaN(ts)) {
        droppedNoTimestamp++;
        continue;
      }
      if (!Number.isNaN(cutoffMs) && ts < cutoffMs) {
        droppedOutOfWindow++;
        continue;
      }
      if (byId.has(e.eventId)) {
        duplicatesCollapsed++;
        continue;
      }
      byId.set(e.eventId, e);
      const src = batch.source || "unknown";
      bySource[src] = (bySource[src] ?? 0) + 1;
    }
  }

  return {
    events: [...byId.values()],
    bySource,
    droppedOutOfWindow,
    droppedNoTimestamp,
    duplicatesCollapsed,
    unresolvedCrews,
  };
}

/** now - windowHours, as an ISO string. The swamp-native `TimeCutoff`. */
export function timeCutoff(windowHours: number, nowMs = Date.now()): string {
  return new Date(nowMs - windowHours * 3600_000).toISOString();
}

// =============================================================================
// Context + model
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
  ) => Promise<{ name: string }>;
};

/** Events aggregation model — canonical windowed event set for scoring + graph. */
export const model = {
  type: "@webframp/devops-measurement/events",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    aggregated: {
      description: "Canonical windowed, deduped event set for scoring + graph",
      schema: AggregatedEventsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    aggregate: {
      description:
        "Union the collector event batches, apply the rolling window cutoff " +
        "once, and dedup by eventId — producing the single canonical event " +
        "set the scorer and interaction graph both read. Collector batches " +
        "are wired in via CEL (data.latest of each collect_* model).",
      arguments: z.object({
        batches: z.array(EventBatchSchema).default([]).describe(
          "Per-collector event batches (from each collect_* model)",
        ),
        windowHours: z.number().positive().default(2160).describe(
          "Rolling window in hours (default 2160h ≈ 90 days, matching the Go " +
            "default scoring.time_window)",
        ),
      }),
      execute: async (
        args: { batches: Batch[]; windowHours: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const cutoff = timeCutoff(args.windowHours);
        const result = aggregate(args.batches, cutoff);

        const handle = await context.writeResource(
          "aggregated",
          "events-current",
          {
            events: result.events,
            count: result.events.length,
            windowHours: args.windowHours,
            cutoff,
            bySource: result.bySource,
            droppedOutOfWindow: result.droppedOutOfWindow,
            droppedNoTimestamp: result.droppedNoTimestamp,
            duplicatesCollapsed: result.duplicatesCollapsed,
            unresolvedCrews: result.unresolvedCrews,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        context.logger.info(
          "Aggregated {count} events (window {win}h, dropped {dropped}, " +
            "dedup {dup}, unresolved crews {unres})",
          {
            count: result.events.length,
            win: args.windowHours,
            dropped: result.droppedOutOfWindow,
            dup: result.duplicatesCollapsed,
            unres: result.unresolvedCrews,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
