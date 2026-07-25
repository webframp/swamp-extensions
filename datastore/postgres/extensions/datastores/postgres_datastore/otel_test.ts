// ABOUTME: Asserts the OpenTelemetry spans emitted by the PostgreSQL datastore —
// ABOUTME: names, attributes, error status, retry events, and parent/child nesting.
// ABOUTME: Sync spans use a fake sql client so they run without a live database.

import { assert, assertEquals, assertExists } from "@std/assert";
import type postgres from "npm:postgres@3.4.9";
import { context, trace } from "npm:@opentelemetry/api@1.9.0";
import { AsyncLocalStorageContextManager } from "npm:@opentelemetry/context-async-hooks@2.10.0";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@2.10.0";

import { createSyncService } from "./sync.ts";
import { datastore } from "./mod.ts";
import { retryable } from "./_lib/retry.ts";
import { Attr, sqlSpan, withSpan } from "./_lib/tracing.ts";

const FILES_TABLE = "swamp.files";
const TEST_URL = Deno.env.get("POSTGRES_TEST_URL");

/** Registers a real SDK provider, runs `fn`, then restores the no-op API. */
async function withSpans(
  fn: (spans: () => ReadableSpan[]) => Promise<void>,
): Promise<void> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // Without a context manager the API cannot propagate the active span, so
  // parent/child nesting and trace.getActiveSpan() would both be untestable.
  const ctxManager = new AsyncLocalStorageContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);
  trace.setGlobalTracerProvider(provider);
  try {
    await fn(() => exporter.getFinishedSpans());
  } finally {
    trace.disable();
    context.disable();
    ctxManager.disable();
    await provider.shutdown();
  }
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((s) => s.name === name);
  assertExists(span, `no span named "${name}" in [${namesOf(spans)}]`);
  return span;
}

function namesOf(spans: ReadableSpan[]): string {
  return spans.map((s) => s.name).join(", ");
}

/** parentSpanContext on SDK 2.x, parentSpanId on 1.x — accept either. */
function parentIdOf(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId?: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

interface FakeSqlOptions {
  /** Rows returned per statement, matched on a substring of the SQL text. */
  rows?: Array<{ match: string; rows: Record<string, unknown>[] }>;
  /** Statement substring that should throw instead of returning rows. */
  failOn?: { match: string; error: Error };
}

interface FakeSql {
  sql: postgres.Sql;
  statements: string[];
}

/**
 * Minimal stand-in for the `postgres` client.
 *
 * Only `unsafe`, `begin`, and the template-tag call form are implemented —
 * that is the entire surface the sync service uses. Keeping this local means
 * the span assertions run in CI, where no database is available.
 */
function fakeSql(options: FakeSqlOptions = {}): FakeSql {
  const statements: string[] = [];

  const rowsFor = (text: string): Record<string, unknown>[] => {
    if (options.failOn && text.includes(options.failOn.match)) {
      throw options.failOn.error;
    }
    for (const entry of options.rows ?? []) {
      if (text.includes(entry.match)) return entry.rows;
    }
    return [];
  };

  const unsafe = (text: string, _params?: unknown[]) => {
    statements.push(text);
    const rows = rowsFor(text);
    // postgres.js exposes `count` on results; the lock reads it.
    return Promise.resolve(
      Object.assign(rows, { count: rows.length }),
    );
  };

  const tag = (strings: TemplateStringsArray | string[]) => {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    statements.push(text);
    return Promise.resolve(rowsFor(text));
  };

  const sql = Object.assign(tag, {
    unsafe,
    begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) => {
      await fn({ unsafe });
    },
    end: () => Promise.resolve(),
  }) as unknown as postgres.Sql;

  return { sql, statements };
}

async function seedFile(
  cachePath: string,
  relPath: string,
  body: string,
): Promise<void> {
  const slash = relPath.lastIndexOf("/");
  await Deno.mkdir(`${cachePath}/${relPath.slice(0, slash)}`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${cachePath}/${relPath}`, body);
}

async function withCache(fn: (cachePath: string) => Promise<void>) {
  const cachePath = await Deno.makeTempDir();
  try {
    await fn(cachePath);
  } finally {
    await Deno.remove(cachePath, { recursive: true });
  }
}

Deno.test("sqlSpan records system, operation, and table", async () => {
  await withSpans(async (spans) => {
    await sqlSpan(
      "someQuery",
      "SELECT",
      "swamp.files",
      () => Promise.resolve(),
    );

    const span = findSpan(spans(), "PostgreSQL someQuery");
    assertEquals(span.attributes[Attr.DB_SYSTEM], "postgresql");
    assertEquals(span.attributes[Attr.DB_OPERATION], "SELECT");
    assertEquals(span.attributes[Attr.DB_COLLECTION], "swamp.files");
  });
});

Deno.test("sqlSpan never records statement text or parameters", async () => {
  await withSpans(async (spans) => {
    await sqlSpan(
      "insertFile",
      "INSERT",
      FILES_TABLE,
      () => Promise.resolve(),
    );

    // Parameters bound to these statements carry file content, and the
    // connection string carries a password — neither may reach a backend.
    const span = findSpan(spans(), "PostgreSQL insertFile");
    const serialized = JSON.stringify(span.attributes);
    assertEquals(serialized.includes("INSERT INTO"), false);
    assertEquals(serialized.includes("password"), false);
    assertEquals(Object.keys(span.attributes).sort(), [
      Attr.DB_COLLECTION,
      Attr.DB_OPERATION,
      Attr.DB_SYSTEM,
    ]);
  });
});

Deno.test("ensureSchema emits a span per DDL statement", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql();
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await svc.pushChanged();

      const files = findSpan(spans(), "PostgreSQL createFilesTable");
      assertEquals(files.attributes[Attr.DB_OPERATION], "CREATE TABLE");
      assertEquals(files.attributes[Attr.DB_COLLECTION], FILES_TABLE);
      findSpan(spans(), "PostgreSQL createUpdatedAtIndex");
      const state = findSpan(spans(), "PostgreSQL createSyncStateTable");
      assertEquals(state.attributes[Attr.DB_COLLECTION], "swamp.sync_state");
    });
  });
});

Deno.test("pushChanged span reports files pushed and nests its SQL", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql();
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await seedFile(cachePath, "data/m/i/b.json", "b");
      await svc.pushChanged();

      const push = findSpan(spans(), "postgres-datastore pushChanged");
      assertEquals(push.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      // Two files pushed, no tombstones — `changes` also counts tombstones,
      // so files_pushed must not be derived from it.
      assertEquals(push.attributes[Attr.DATASTORE_FILES_PUSHED], 2);
      assertEquals(push.attributes[Attr.DATASTORE_FILES_DELETED], 0);

      // The transaction gets one span, not one per statement — a push of a
      // thousand files would otherwise produce a thousand spans.
      const tx = findSpan(spans(), "PostgreSQL fullWalkPushTransaction");
      assertEquals(tx.attributes[Attr.DB_OPERATION], "TRANSACTION");
      assertEquals(tx.attributes[Attr.DATASTORE_FILES_PUSHED], 2);
      assertEquals(tx.attributes[Attr.DATASTORE_FILES_DELETED], 0);
      assertEquals(tx.spanContext().traceId, push.spanContext().traceId);
      assertEquals(parentIdOf(push), undefined);

      const manifest = findSpan(spans(), "PostgreSQL fetchRemoteManifest");
      assertEquals(manifest.attributes[Attr.DB_RETURNED_ROWS], 0);
    });
  });
});

Deno.test("pushChanged span reports the no-dirty-paths fast path", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql();
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      // A missing sidecar reads as bulkInvalidated, so the fast path is only
      // reachable after a push has cleared that flag.
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.pushChanged();
      assertEquals(await svc.pushChanged(), 0);

      const pushes = spans().filter((s) =>
        s.name === "postgres-datastore pushChanged"
      );
      assertEquals(pushes.length, 2);
      assertEquals(pushes[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FILES_PUSHED], 0);
    });
  });
});

Deno.test("pullChanged span reports rows scanned and the watermark fast path", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql({
        rows: [
          {
            match: "SELECT now()::text",
            rows: [{ ts: "2026-07-25 00:00:00" }],
          },
          // The watermark predates lastPulledAt, so the second pull
          // short-circuits before scanning file metadata.
          {
            match: "WHERE key = 'last_pushed_at'",
            rows: [{ value: "2026-07-24 00:00:00" }],
          },
        ],
      });
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await svc.pullChanged();
      await svc.pullChanged();

      const pulls = spans().filter((s) =>
        s.name === "postgres-datastore pullChanged"
      );
      assertEquals(pulls.length, 2);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_SCOPED], false);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_METADATA_ONLY], false);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FILES_PULLED], 0);

      const watermark = findSpan(spans(), "PostgreSQL readWatermark");
      assertEquals(
        watermark.attributes[Attr.DB_COLLECTION],
        "swamp.sync_state",
      );
      const scan = findSpan(spans(), "PostgreSQL scanFileMetadata");
      assertEquals(scan.attributes[Attr.DB_RETURNED_ROWS], 0);
    });
  });
});

Deno.test("scoped pullChanged span records datastore.scoped", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql({
        rows: [
          {
            match: "SELECT now()::text",
            rows: [{ ts: "2026-07-25 00:00:00" }],
          },
        ],
      });
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await svc.pullChanged({
        context: { models: [{ modelType: "m", modelId: "i" }] },
      });

      const pull = findSpan(spans(), "postgres-datastore pullChanged");
      assertEquals(pull.attributes[Attr.DATASTORE_SCOPED], true);
    });
  });
});

Deno.test("hydrateFile span records the file and hydration outcome", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql({
        rows: [
          {
            match: "SELECT content FROM",
            rows: [{ content: new TextEncoder().encode("hello") }],
          },
        ],
      });
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      assertEquals(await svc.hydrateFile!("data/m/i/a.json"), true);
      assertEquals(await svc.hydrateFile!("../escape.json"), false);

      const hydrations = spans().filter((s) =>
        s.name === "postgres-datastore hydrateFile"
      );
      assertEquals(hydrations.length, 2);
      assertEquals(
        hydrations[0].attributes[Attr.DATASTORE_FILE],
        "data/m/i/a.json",
      );
      assertEquals(hydrations[0].attributes[Attr.DATASTORE_HYDRATED], true);
      const fetch = findSpan(spans(), "PostgreSQL fetchOneFile");
      assertEquals(fetch.attributes[Attr.DB_RETURNED_ROWS], 1);
      // Traversal is rejected before any SQL runs.
      assertEquals(hydrations[1].attributes[Attr.DATASTORE_HYDRATED], false);
    });
  });
});

Deno.test("preparePush and commitPush spans report planned work", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql();
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      const manifest = await svc.preparePush();
      await svc.commitPush(manifest);

      const prepare = findSpan(spans(), "postgres-datastore preparePush");
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 1);
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_DELETE], 0);

      const commit = findSpan(spans(), "postgres-datastore commitPush");
      assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
      assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      findSpan(spans(), "PostgreSQL commitPushTransaction");
    });
  });
});

Deno.test("commitPush of an empty manifest reports the fast path", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      const { sql } = fakeSql();
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await svc.pushChanged(); // clears bulkInvalidated
      const manifest = await svc.preparePush();
      assertEquals(await svc.commitPush(manifest), 0);

      const commit = findSpan(spans(), "postgres-datastore commitPush");
      assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(commit.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 0);
      assertEquals(
        spans().some((s) => s.name === "PostgreSQL commitPushTransaction"),
        false,
        "an empty manifest must not open a transaction",
      );
    });
  });
});

Deno.test("a failing statement marks both the query and the sync span", async () => {
  await withSpans(async (spans) => {
    await withCache(async (cachePath) => {
      class PgError extends Error {
        override name = "PostgresError";
      }
      const { sql } = fakeSql({
        failOn: {
          match: "SELECT path, hash, deleted_at, updated_at",
          error: new PgError("relation does not exist"),
        },
      });
      const svc = createSyncService(sql, FILES_TABLE, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      let threw = false;
      try {
        await svc.pushChanged();
      } catch {
        threw = true;
      }
      assert(threw, "the query failure must propagate");

      const query = findSpan(spans(), "PostgreSQL fetchRemoteManifest");
      assertEquals(query.status.code, 2);
      assertEquals(query.attributes[Attr.ERROR_TYPE], "PostgresError");
      assertEquals(query.events.some((e) => e.name === "exception"), true);
      // The failure propagates to the enclosing operation rather than being
      // recorded only at the leaf.
      const push = findSpan(spans(), "postgres-datastore pushChanged");
      assertEquals(push.status.code, 2);
      assertEquals(push.attributes[Attr.ERROR_TYPE], "PostgresError");
    });
  });
});

Deno.test("retryable records a retry event on the active span", async () => {
  await withSpans(async (spans) => {
    class Serialization extends Error {
      code = "40001";
      override name = "PostgresError";
    }
    let calls = 0;
    const value = await withSpan("test parent", {}, async () => {
      return await retryable(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Serialization("conflict"));
        return Promise.resolve("ok");
      }, { baseDelayMs: 1 });
    });
    assertEquals(value, "ok");
    assertEquals(calls, 2);

    const parent = findSpan(spans(), "test parent");
    const retry = parent.events.find((e) => e.name === "retry");
    assertExists(retry, "expected a retry event on the enclosing span");
    assertEquals(retry.attributes?.["retry.attempt"], 1);
    assertEquals(retry.attributes?.["retry.reason"], "retryable_error");
    assertEquals(retry.attributes?.["error.type"], "PostgresError");
  });
});

Deno.test("withSpan records status, exception, and error type on throw", async () => {
  await withSpans(async (spans) => {
    class Boom extends Error {
      constructor() {
        super("boom");
        this.name = "BoomError";
      }
    }
    let threw = false;
    try {
      await withSpan("failing", {}, () => Promise.reject(new Boom()));
    } catch {
      threw = true;
    }
    assert(threw, "withSpan must rethrow");

    const span = findSpan(spans(), "failing");
    assertEquals(span.status.code, 2);
    assertEquals(span.status.message, "boom");
    assertEquals(span.attributes[Attr.ERROR_TYPE], "BoomError");
    assertEquals(span.events.filter((e) => e.name === "exception").length, 1);
  });
});

Deno.test("withSpan wraps a non-Error rejection without losing it", async () => {
  await withSpans(async (spans) => {
    let caught: unknown;
    try {
      await withSpan("string-reject", {}, () => Promise.reject("nope"));
    } catch (err) {
      caught = err;
    }
    assertEquals(caught, "nope");
    const span = findSpan(spans(), "string-reject");
    assertEquals(span.status.code, 2);
    assertEquals(span.attributes[Attr.ERROR_TYPE], "Error");
  });
});

Deno.test("sync operations succeed with no TracerProvider registered", async () => {
  // withSpans is deliberately not used here: the global API stays in its
  // default no-op state, which is how the extension runs outside a traced host.
  assertEquals(trace.getActiveSpan(), undefined);
  await withCache(async (cachePath) => {
    const { sql, statements } = fakeSql({
      rows: [
        { match: "SELECT now()::text", rows: [{ ts: "2026-07-25 00:00:00" }] },
      ],
    });
    const svc = createSyncService(sql, FILES_TABLE, cachePath);
    await seedFile(cachePath, "data/m/i/a.json", "a");
    assertEquals(await svc.pushChanged(), 1);
    assertEquals(await svc.pullChanged(), 0);
    assert(statements.length > 0, "statements should still have executed");
  });
});

// ---------------------------------------------------------------------------
// Lock spans need real SQL semantics (ON CONFLICT, RETURNING, row counts), so
// they follow the same POSTGRES_TEST_URL gate as integration_test.ts.
// ---------------------------------------------------------------------------

function lockConfig(schema: string) {
  return {
    connectionString: TEST_URL!,
    schema,
    ssl: "require" as const,
  };
}

function testSchema(): string {
  return `swamp_otel_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

Deno.test({
  name: "integration: lock acquire and release spans",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withSpans(async (spans) => {
      const schema = testSchema();
      const provider = datastore.createProvider(lockConfig(schema));
      const lock = provider.createLock("/repo", { lockKey: "uncontended" });
      await lock.acquire();
      await lock.release();

      const acquire = findSpan(spans(), "postgres-datastore lock acquire");
      assertEquals(acquire.attributes[Attr.LOCK_KEY], "uncontended");
      assertEquals(acquire.attributes[Attr.LOCK_CONTENDED], false);
      assertEquals(acquire.attributes[Attr.LOCK_TTL_MS], 30_000);
      assertEquals(acquire.attributes[Attr.LOCK_TIMEOUT_MS], 60_000);
      assertExists(acquire.attributes[Attr.LOCK_WAIT_DURATION_MS]);

      const insert = findSpan(spans(), "PostgreSQL acquireLock");
      assertEquals(insert.attributes[Attr.DB_OPERATION], "INSERT");
      assertEquals(insert.attributes[Attr.DB_COLLECTION], `${schema}.locks`);
      assertEquals(parentIdOf(insert), acquire.spanContext().spanId);

      const release = findSpan(spans(), "postgres-datastore lock release");
      assertEquals(release.attributes[Attr.LOCK_KEY], "uncontended");
      findSpan(spans(), "PostgreSQL releaseLock");
      findSpan(spans(), "postgres-datastore ensureInfrastructure");
    });
  },
});

Deno.test({
  name:
    "integration: lock acquire span records contention and error on timeout",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withSpans(async (spans) => {
      const schema = testSchema();
      const provider = datastore.createProvider(lockConfig(schema));
      const held = provider.createLock("/repo", { lockKey: "contended" });
      await held.acquire();
      try {
        const loser = provider.createLock("/repo", {
          lockKey: "contended",
          maxWaitMs: 120,
          retryIntervalMs: 20,
        });
        let threw = false;
        try {
          await loser.acquire();
        } catch {
          threw = true;
        }
        assert(threw, "second acquire should have timed out");
      } finally {
        await held.release();
      }

      const failed = spans()
        .filter((s) => s.name === "postgres-datastore lock acquire")
        .find((s) => s.attributes[Attr.LOCK_CONTENDED] === true);
      assertExists(failed, "expected a contended acquire span");
      assertEquals(failed.status.code, 2);
      assertEquals(failed.attributes[Attr.ERROR_TYPE], "Error");
      assertEquals(failed.events.some((e) => e.name === "exception"), true);
      assertExists(failed.attributes[Attr.LOCK_WAIT_DURATION_MS]);
      const retry = failed.events.find((e) => e.name === "retry");
      assertExists(retry, "expected a lock_contended retry event");
      assertEquals(retry.attributes?.["retry.reason"], "lock_contended");
    });
  },
});

Deno.test({
  name: "integration: withLock, inspect, and forceRelease spans",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withSpans(async (spans) => {
      const schema = testSchema();
      const provider = datastore.createProvider(lockConfig(schema));
      const lock = provider.createLock("/repo", { lockKey: "wrapped" });
      await lock.withLock(() => Promise.resolve("done"));

      const outer = findSpan(spans(), "postgres-datastore lock withLock");
      const acquire = findSpan(spans(), "postgres-datastore lock acquire");
      const release = findSpan(spans(), "postgres-datastore lock release");
      assertEquals(parentIdOf(acquire), outer.spanContext().spanId);
      assertEquals(parentIdOf(release), outer.spanContext().spanId);

      const held = provider.createLock("/repo", { lockKey: "inspected" });
      await held.acquire();
      const info = await held.inspect();
      assertExists(info?.nonce);
      assertEquals(await held.forceRelease(info.nonce), true);

      const inspect = findSpan(spans(), "postgres-datastore lock inspect");
      const holder = inspect.attributes[Attr.LOCK_HOLDER];
      assert(
        typeof holder === "string" && holder.includes("pid "),
        `expected a holder attribute, got ${holder}`,
      );
      findSpan(spans(), "PostgreSQL inspectLock");
      const forced = findSpan(spans(), "postgres-datastore lock forceRelease");
      assertEquals(forced.attributes[Attr.LOCK_KEY], "inspected");
      findSpan(spans(), "PostgreSQL forceReleaseLock");
    });
  },
});

Deno.test({
  name: "integration: heartbeat is deliberately not instrumented",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withSpans(async (spans) => {
      const schema = testSchema();
      const provider = datastore.createProvider(lockConfig(schema));
      const lock = provider.createLock("/repo", { lockKey: "beating" });
      await lock.acquire();
      try {
        assertEquals(await lock.heartbeat(), true);
      } finally {
        await lock.release();
      }

      // Periodic renewals would swamp the trace of any long-held lock.
      assertEquals(
        spans().some((s) => s.name.includes("heartbeat")),
        false,
        `unexpected heartbeat span in [${namesOf(spans())}]`,
      );
    });
  },
});

Deno.test({
  name: "integration: verifier emits a server version span",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withSpans(async (spans) => {
      const schema = testSchema();
      const provider = datastore.createProvider(lockConfig(schema));
      const health = await provider.createVerifier().verify();
      assertEquals(health.healthy, true);

      const version = findSpan(spans(), "PostgreSQL serverVersion");
      assertEquals(version.attributes[Attr.DB_OPERATION], "SELECT");
      findSpan(spans(), "PostgreSQL createSchema");
      findSpan(spans(), "PostgreSQL createLocksTable");
    });
  },
});
