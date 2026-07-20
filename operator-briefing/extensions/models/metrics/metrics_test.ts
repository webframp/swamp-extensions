// Operator-briefing metrics time-series model — tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./metrics.ts";

// The harness round-trips writeResource -> readResource by instance name, so a
// single context accumulates the series across successive execute() calls —
// exactly the append-across-runs behavior we want to exercise.
function ctx() {
  return createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "metrics", version: 1, tags: {} },
  });
}

async function append(context: unknown, args: Record<string, unknown>) {
  return await model.methods.append_metrics.execute(
    args as any,
    context as any,
  );
}

/** Pull the latest written `series` resource's data. */
function latestSeries(getWrittenResources: () => Array<any>) {
  const series = getWrittenResources().filter((r) => r.specName === "series");
  return series[series.length - 1]?.data as {
    rows: Array<Record<string, unknown>>;
    count: number;
    updatedAt: string;
  };
}

// =============================================================================
// Structure
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/operator-briefing/metrics");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model defines the series resource with GC-safe settings", () => {
  assertEquals("series" in model.resources, true);
  assertEquals(model.resources.series.lifetime, "infinite");
  assertEquals(model.resources.series.garbageCollection, 5);
});

Deno.test("append_metrics requires a date argument", () => {
  const schema = model.methods.append_metrics.arguments;
  assertEquals(schema.safeParse({}).success, false);
  assertEquals(schema.safeParse({ date: "2026-07-13" }).success, true);
});

Deno.test("append_metrics accepts optional metrics and backfill", () => {
  const schema = model.methods.append_metrics.arguments;
  const r = schema.safeParse({
    date: "2026-07-13",
    spendUsd: 12.5,
    dau: 3,
    backfill: [{ date: "2026-07-12", spendUsd: 10 }],
  });
  assertEquals(r.success, true);
});

// =============================================================================
// Behavior
// =============================================================================

Deno.test("append to empty series produces one row with the given metrics", async () => {
  const { context, getWrittenResources } = ctx();

  const result = await append(context, {
    date: "2026-07-13",
    spendUsd: 42,
    dau: 7,
  });
  assertExists(result.dataHandles);

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows.length, 1);
  assertEquals(data.rows[0].date, "2026-07-13");
  assertEquals(data.rows[0].spendUsd, 42);
  assertEquals(data.rows[0].dau, 7);
  assertExists(data.updatedAt);
});

Deno.test("appending the same date twice with different fields merges, not clobbers", async () => {
  const { context, getWrittenResources } = ctx();

  // Run 1: only spend.
  await append(context, { date: "2026-07-13", spendUsd: 100 });
  // Run 2: only dau for the same date — spend must survive.
  await append(context, { date: "2026-07-13", dau: 9 });

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows.length, 1);
  assertEquals(data.rows[0].date, "2026-07-13");
  assertEquals(data.rows[0].spendUsd, 100); // from run 1
  assertEquals(data.rows[0].dau, 9); // from run 2
});

Deno.test("a date-only run preserves an existing day's metrics (merge, no wipe)", async () => {
  const { context, getWrittenResources } = ctx();

  await append(context, { date: "2026-07-13", dau: 5, mau: 50 });
  await append(context, { date: "2026-07-13" }); // dated marker, no metrics

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows[0].dau, 5);
  assertEquals(data.rows[0].mau, 50);
});

Deno.test("backfill rows are merged, deduped by date, and sorted ascending", async () => {
  const { context, getWrittenResources } = ctx();

  await append(context, {
    date: "2026-07-13",
    spendUsd: 30,
    backfill: [
      { date: "2026-07-11", spendUsd: 10 },
      { date: "2026-07-12", spendUsd: 20 },
      // Same date as the current run: backfill applies first, current wins.
      { date: "2026-07-13", dau: 4 },
    ],
  });

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 3);
  assertEquals(data.rows.map((r) => r.date), [
    "2026-07-11",
    "2026-07-12",
    "2026-07-13",
  ]);
  // 2026-07-13 keeps the backfilled dau AND the current run's spend.
  const last = data.rows[2];
  assertEquals(last.spendUsd, 30);
  assertEquals(last.dau, 4);
});

Deno.test("backfill into an existing series accumulates without dropping prior rows", async () => {
  const { context, getWrittenResources } = ctx();

  await append(context, { date: "2026-07-13", spendUsd: 30 });
  await append(context, {
    date: "2026-07-14",
    spendUsd: 40,
    backfill: [{ date: "2026-07-10", spendUsd: 5 }],
  });

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 3);
  assertEquals(data.rows.map((r) => r.date), [
    "2026-07-10",
    "2026-07-13",
    "2026-07-14",
  ]);
});

Deno.test("absent existing series is treated as empty (no throw)", async () => {
  const { context, getWrittenResources } = ctx();
  // Fresh context: readResource("metrics") returns null.
  const result = await append(context, { date: "2026-07-13", spendUsd: 1 });
  assertExists(result.dataHandles);
  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
});

Deno.test("an unreadable existing series SKIPS the write (never clobbers history)", async () => {
  const { context, getWrittenResources } = ctx();
  // Force the read to throw. A thrown read is not proof of absence, so the
  // method must NOT write — writing a fresh 1-row series would destroy a
  // history it simply failed to read this time.
  (context as any).readResource = () => Promise.reject(new Error("disk gone"));

  const result = await append(context, { date: "2026-07-13", dau: 2 });
  assertEquals(result.dataHandles.length, 0);
  // No series resource was written at all.
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "series").length,
    0,
  );
});

Deno.test("a read failure does not overwrite a long existing history", async () => {
  const { context, getWrittenResources } = ctx();

  // Seed a real 100-day history through the normal path, using 100 distinct
  // dates so none collapse on upsert.
  const distinct = Array.from({ length: 100 }, (_, i) => {
    const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    return { date: `2026-${month}-${day}`, spendUsd: i };
  });
  await append(context, { date: "2026-06-01", backfill: distinct });
  const seeded = latestSeries(getWrittenResources);
  const seededCount = seeded.count;

  // Now the read throws. The stored series must be left exactly as seeded.
  (context as any).readResource = () => Promise.reject(new Error("io error"));
  const result = await append(context, { date: "2026-06-02", spendUsd: 999 });

  assertEquals(result.dataHandles.length, 0);
  const after = latestSeries(getWrittenResources);
  assertEquals(after.count, seededCount); // unchanged — no new write
});

Deno.test("a stored series with a non-array rows field SKIPS the write", async () => {
  const { context, getWrittenResources } = ctx();
  (context as any).readResource = () =>
    Promise.resolve({ rows: "not-an-array", count: 0, updatedAt: "x" });

  const result = await append(context, { date: "2026-07-13", spendUsd: 3 });
  assertEquals(result.dataHandles.length, 0);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "series").length,
    0,
  );
});

Deno.test("a stored series whose rows are all unparseable SKIPS the write", async () => {
  const { context, getWrittenResources } = ctx();
  // Non-empty rows, but not one carries a valid date — corruption of unknown
  // extent, so we must not overwrite it with a fresh 1-row series.
  (context as any).readResource = () =>
    Promise.resolve({
      rows: [{ spendUsd: 1 }, { date: "not-a-date" }, 7],
      count: 3,
      updatedAt: "x",
    });

  const result = await append(context, { date: "2026-07-13", spendUsd: 3 });
  assertEquals(result.dataHandles.length, 0);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "series").length,
    0,
  );
});

Deno.test("a writeResource failure does not trigger a second empty write", async () => {
  const { context } = ctx();

  const writeCalls: Array<any> = [];
  (context as any).writeResource = (
    _spec: string,
    _name: string,
    data: unknown,
  ) => {
    writeCalls.push(data);
    return Promise.reject(new Error("payload too large"));
  };

  const result = await append(context, { date: "2026-07-13", spendUsd: 5 });

  // Degrade contract: no throw, no handles.
  assertEquals(result.dataHandles.length, 0);
  // Exactly one write attempt — the outer catch must NOT retry with an empty
  // series (the bug that would clobber history on a large-payload write).
  assertEquals(writeCalls.length, 1);
  assertEquals((writeCalls[0] as any).rows.length, 1);
  assertEquals((writeCalls[0] as any).rows[0].spendUsd, 5);
});

Deno.test("a logger failure after a good write leaves the persisted series intact", async () => {
  const { context, getWrittenResources } = ctx();

  // Write succeeds, then logger.info throws — the old outer-catch path would
  // then overwrite the just-written good series with an empty one.
  (context as any).logger = {
    info: () => {
      throw new Error("log sink down");
    },
    warn: () => {},
    error: () => {},
  };

  const result = await append(context, { date: "2026-07-13", spendUsd: 8 });

  // Handle is lost to the degrade path, but the DATA is what matters.
  assertEquals(result.dataHandles.length, 0);
  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows[0].spendUsd, 8);
  // No empty series was ever written.
  const series = getWrittenResources().filter((r) => r.specName === "series");
  assertEquals(series.every((r) => (r.data as any).rows.length > 0), true);
});

Deno.test("a zero-valued metric survives (0 is a real number, not absent)", async () => {
  const { context, getWrittenResources } = ctx();

  await append(context, {
    date: "2026-07-13",
    spendUsd: 0,
    quotaOverCount: 0,
  });

  const data = latestSeries(getWrittenResources);
  assertEquals(data.rows[0].spendUsd, 0);
  assertEquals(data.rows[0].quotaOverCount, 0);
});

Deno.test("a null read (genuinely absent) writes a fresh series", async () => {
  const { context, getWrittenResources } = ctx();
  (context as any).readResource = () => Promise.resolve(null);

  const result = await append(context, { date: "2026-07-13", spendUsd: 3 });
  assertEquals(result.dataHandles.length, 1);
  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows[0].spendUsd, 3);
});

Deno.test("a top-level non-object read (junk) SKIPS the write", async () => {
  // A read that resolves to something that isn't null and isn't a
  // rows-bearing object (a bare number, a bare array) must be treated as
  // corruption of unknown extent — skip, never overwrite.
  for (const junk of [42, "nope", [], [{ date: "2026-07-11" }]]) {
    const { context, getWrittenResources } = ctx();
    (context as any).readResource = () => Promise.resolve(junk as any);

    const result = await append(context, { date: "2026-07-13", spendUsd: 3 });
    assertEquals(result.dataHandles.length, 0);
    assertEquals(
      getWrittenResources().filter((r) => r.specName === "series").length,
      0,
    );
  }
});

Deno.test("append_metrics rejects a non-padded date at the schema layer", () => {
  const schema = model.methods.append_metrics.arguments;
  assertEquals(schema.safeParse({ date: "2026-7-3" }).success, false);
  assertEquals(schema.safeParse({ date: "2026-07-03" }).success, true);
});

Deno.test("a metric of the wrong shape is skipped, not thrown", async () => {
  const { context, getWrittenResources } = ctx();

  // spendUsd is a string, mau is NaN — both must be dropped, dau kept.
  const result = await append(context, {
    date: "2026-07-13",
    spendUsd: "oops",
    mau: NaN,
    dau: 6,
  });
  assertExists(result.dataHandles);

  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 1);
  assertEquals(data.rows[0].dau, 6);
  assertEquals("spendUsd" in data.rows[0], false);
  assertEquals("mau" in data.rows[0], false);
});

Deno.test("malformed rows already in the series are filtered out", async () => {
  const { context, getWrittenResources } = ctx();
  (context as any).readResource = () =>
    Promise.resolve({
      rows: [
        { date: "2026-07-11", spendUsd: 9 },
        { spendUsd: 99 }, // no date — must be dropped
        null, // must be dropped
      ],
      count: 3,
      updatedAt: "x",
    });

  await append(context, { date: "2026-07-12", spendUsd: 12 });
  const data = latestSeries(getWrittenResources);
  assertEquals(data.count, 2);
  assertEquals(data.rows.map((r) => r.date), ["2026-07-11", "2026-07-12"]);
});
