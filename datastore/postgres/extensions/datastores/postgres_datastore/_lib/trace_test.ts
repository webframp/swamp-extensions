// ABOUTME: Tests for the sync trace logger — verifies output format and
// ABOUTME: env-var gating behavior.

import { assertEquals } from "@std/assert";
import { createTracer, type TraceEvent } from "./trace.ts";

Deno.test("tracer: disabled by default — emits nothing", () => {
  const events: TraceEvent[] = [];
  const tracer = createTracer({ enabled: false, sink: (e) => events.push(e) });
  tracer.phase("pull", "metadata_scan", 42);
  assertEquals(events.length, 0);
});

Deno.test("tracer: enabled — emits phase event", () => {
  const events: TraceEvent[] = [];
  const tracer = createTracer({ enabled: true, sink: (e) => events.push(e) });
  tracer.phase("pull", "metadata_scan", 150);
  assertEquals(events.length, 1);
  assertEquals(events[0].operation, "pull");
  assertEquals(events[0].phase, "metadata_scan");
  assertEquals(events[0].durationMs, 150);
});

Deno.test("tracer: summary emits total duration and file count", () => {
  const events: TraceEvent[] = [];
  const tracer = createTracer({ enabled: true, sink: (e) => events.push(e) });
  tracer.summary("push", 3200, { files: 25, tombstones: 2 });
  assertEquals(events.length, 1);
  assertEquals(events[0].operation, "push");
  assertEquals(events[0].phase, "complete");
  assertEquals(events[0].durationMs, 3200);
  assertEquals(events[0].details?.files, 25);
  assertEquals(events[0].details?.tombstones, 2);
});

Deno.test("tracer: formatEvent produces readable line", () => {
  const events: string[] = [];
  const tracer = createTracer({
    enabled: true,
    sink: (e) => events.push(tracer.formatEvent(e)),
  });
  tracer.phase("pull", "content_fetch", 89);
  assertEquals(events[0].includes("[pg-sync]"), true);
  assertEquals(events[0].includes("pull"), true);
  assertEquals(events[0].includes("content_fetch"), true);
  assertEquals(events[0].includes("89ms"), true);
});

Deno.test("tracer: timer measures elapsed time", async () => {
  const events: TraceEvent[] = [];
  const tracer = createTracer({ enabled: true, sink: (e) => events.push(e) });
  const done = tracer.startTimer("push", "transaction");
  await new Promise((r) => setTimeout(r, 50));
  done();
  assertEquals(events.length, 1);
  assertEquals(events[0].durationMs >= 40, true);
  assertEquals(events[0].phase, "transaction");
});
