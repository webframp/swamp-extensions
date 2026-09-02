// Events aggregation tests.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { aggregate, type Batch, model, timeCutoff } from "./events.ts";

function ev(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
) {
  return {
    eventId: id,
    userId: "u",
    username: "u",
    eventType: "mr_review" as const,
    sourceCrew: "a",
    targetCrew: "b",
    targetUser: "",
    projectId: "1",
    timestamp,
    metadata: {},
    ...extra,
  };
}

Deno.test("aggregate unions batches and counts per source", () => {
  const batches: Batch[] = [
    {
      source: "gitlab",
      unresolvedCrews: 1,
      events: [ev("a", "2026-08-01T00:00:00Z")],
    },
    {
      source: "redmine",
      unresolvedCrews: 2,
      events: [ev("b", "2026-08-02T00:00:00Z")],
    },
  ];
  const r = aggregate(batches, "2026-01-01T00:00:00Z");
  assertEquals(r.events.length, 2);
  assertEquals(r.bySource, { gitlab: 1, redmine: 1 });
  assertEquals(r.unresolvedCrews, 3);
});

Deno.test("aggregate drops events before the cutoff", () => {
  const batches: Batch[] = [
    {
      source: "gitlab",
      unresolvedCrews: 0,
      events: [
        ev("old", "2025-01-01T00:00:00Z"),
        ev("new", "2026-08-01T00:00:00Z"),
      ],
    },
  ];
  const r = aggregate(batches, "2026-01-01T00:00:00Z");
  assertEquals(r.events.length, 1);
  assertEquals(r.events[0].eventId, "new");
  assertEquals(r.droppedOutOfWindow, 1);
});

Deno.test("aggregate dedups by eventId across batches", () => {
  const batches: Batch[] = [
    {
      source: "gitlab",
      unresolvedCrews: 0,
      events: [ev("dup", "2026-08-01T00:00:00Z")],
    },
    {
      source: "gitlab",
      unresolvedCrews: 0,
      events: [ev("dup", "2026-08-05T00:00:00Z")],
    },
  ];
  const r = aggregate(batches, "2026-01-01T00:00:00Z");
  assertEquals(r.events.length, 1);
  assertEquals(r.duplicatesCollapsed, 1);
});

Deno.test("aggregate drops events with an unparseable timestamp (cannot window)", () => {
  const batches: Batch[] = [
    { source: "gitlab", unresolvedCrews: 0, events: [ev("notime", "")] },
  ];
  const r = aggregate(batches, "2026-01-01T00:00:00Z");
  assertEquals(r.events.length, 0);
  assertEquals(r.droppedNoTimestamp, 1);
});

Deno.test("timeCutoff subtracts window hours from now", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  assertEquals(timeCutoff(24, now), "2026-08-31T00:00:00.000Z");
  assertEquals(
    timeCutoff(2160, now),
    new Date(now - 2160 * 3600_000).toISOString(),
  );
});

Deno.test("aggregate method writes events-current resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.aggregate.execute(
    {
      batches: [
        {
          source: "gitlab",
          unresolvedCrews: 0,
          events: [ev("a", new Date().toISOString())],
        },
      ],
      windowHours: 2160,
    },
    context as unknown as Parameters<typeof model.methods.aggregate.execute>[1],
  );
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "aggregated");
  assertEquals(resources[0].name, "events-current");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assertEquals(data.windowHours, 2160);
});
