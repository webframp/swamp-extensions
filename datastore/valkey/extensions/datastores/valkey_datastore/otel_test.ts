// ABOUTME: Asserts the OpenTelemetry spans emitted by the Valkey datastore —
// ABOUTME: names, attributes, error status, retry events, and parent/child
// ABOUTME: nesting — plus that everything still works with no TracerProvider.

import { assert, assertEquals, assertExists } from "@std/assert";
import { context, trace } from "npm:@opentelemetry/api@1.9.0";
import { AsyncLocalStorageContextManager } from "npm:@opentelemetry/context-async-hooks@2.10.0";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@2.10.0";

import { datastore } from "./mod.ts";
import {
  Attr,
  commandSpan,
  pipelineSpan,
  recordPipelineResults,
  withSpan,
} from "./_lib/tracing.ts";

const VALKEY_URL = Deno.env.get("VALKEY_TEST_URL") ?? "redis://localhost:6380";

function testConfig(prefix: string) {
  return {
    url: VALKEY_URL,
    prefix,
    db: 0,
    connectTimeoutMs: 5_000,
    maxRetriesPerRequest: 1,
  };
}

function uniquePrefix(): string {
  return `swamp-otel-${crypto.randomUUID().slice(0, 8)}`;
}

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
    // InMemorySpanExporter.export defers its result callback with a zero-delay
    // setTimeout. Draining those before the test ends keeps Deno's test
    // sanitizer from reporting them as leaked timers.
    await provider.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
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

// ---------------------------------------------------------------------------
// Helper unit tests — no Valkey connection required.
// ---------------------------------------------------------------------------

Deno.test("commandSpan records system, operation, and key", async () => {
  await withSpans(async (spans) => {
    await commandSpan("GET", "swamp:seq", () => Promise.resolve("1"));

    const span = findSpan(spans(), "Valkey GET");
    assertEquals(span.attributes[Attr.DB_SYSTEM], "valkey");
    assertEquals(span.attributes[Attr.DB_OPERATION], "GET");
    assertEquals(span.attributes[Attr.VALKEY_KEY], "swamp:seq");
  });
});

Deno.test("commandSpan omits the key attribute when there is none", async () => {
  await withSpans(async (spans) => {
    await commandSpan("PING", undefined, () => Promise.resolve("PONG"));

    const span = findSpan(spans(), "Valkey PING");
    assertEquals(span.attributes[Attr.VALKEY_KEY], undefined);
  });
});

Deno.test("commandSpan never records the value being written", async () => {
  await withSpans(async (spans) => {
    const secretish = "file content that must not be traced";
    await commandSpan(
      "SET",
      "swamp:blob:a",
      () => Promise.resolve(secretish),
    );

    // Blob values are file content and the connection URL holds a password;
    // neither may become an attribute.
    const span = findSpan(spans(), "Valkey SET");
    const serialized = JSON.stringify(span.attributes);
    assertEquals(serialized.includes("file content"), false);
    assertEquals(
      Object.keys(span.attributes).sort(),
      [
        Attr.DB_OPERATION,
        Attr.DB_SYSTEM,
        Attr.VALKEY_KEY,
      ].sort(),
    );
  });
});

Deno.test("pipelineSpan records the batched command count", async () => {
  await withSpans(async (spans) => {
    await pipelineSpan("writeFiles", 150, () => Promise.resolve([]));

    const span = findSpan(spans(), "Valkey pipeline writeFiles");
    assertEquals(span.attributes[Attr.DB_OPERATION], "PIPELINE");
    assertEquals(span.attributes[Attr.VALKEY_PIPELINE_COMMANDS], 150);
  });
});

Deno.test("recordPipelineResults marks a partially failed pipeline", async () => {
  await withSpans(async (spans) => {
    class ReplyError extends Error {
      override name = "ReplyError";
    }
    await pipelineSpan("writeFiles", 3, (span) => {
      // exec() resolves with per-command errors; it does not reject.
      recordPipelineResults(span, [
        [null, "OK"],
        [new ReplyError("WRONGTYPE"), null],
        [null, "OK"],
      ]);
      return Promise.resolve();
    });

    const span = findSpan(spans(), "Valkey pipeline writeFiles");
    assertEquals(span.attributes[Attr.VALKEY_PIPELINE_FAILED], 1);
    assertEquals(
      span.status.code,
      2,
      "a batch with a failed command must not report success",
    );
    assertEquals(span.attributes[Attr.ERROR_TYPE], "ReplyError");
  });
});

Deno.test("recordPipelineResults leaves a fully successful pipeline green", async () => {
  await withSpans(async (spans) => {
    await pipelineSpan("writeFiles", 2, (span) => {
      recordPipelineResults(span, [[null, "OK"], [null, "OK"]]);
      return Promise.resolve();
    });

    const span = findSpan(spans(), "Valkey pipeline writeFiles");
    assertEquals(span.attributes[Attr.VALKEY_PIPELINE_FAILED], 0);
    assertEquals(span.status.code, 0);
    assertEquals(span.attributes[Attr.ERROR_TYPE], undefined);
  });
});

Deno.test("recordPipelineResults treats a null result as an aborted pipeline", async () => {
  await withSpans(async (spans) => {
    await pipelineSpan("fetchMetadata", 5, (span) => {
      recordPipelineResults(span, null);
      return Promise.resolve();
    });

    const span = findSpan(spans(), "Valkey pipeline fetchMetadata");
    assertEquals(span.status.code, 2);
    assertEquals(span.attributes[Attr.ERROR_TYPE], "PipelineAborted");
  });
});

Deno.test("commandSpan records failures on the span", async () => {
  await withSpans(async (spans) => {
    class ReplyError extends Error {
      override name = "ReplyError";
    }
    let threw = false;
    try {
      await commandSpan(
        "EVAL",
        "swamp:lock",
        () => Promise.reject(new ReplyError("NOSCRIPT")),
      );
    } catch {
      threw = true;
    }
    assert(threw, "the command error must propagate");

    const span = findSpan(spans(), "Valkey EVAL");
    assertEquals(span.status.code, 2);
    assertEquals(span.attributes[Attr.ERROR_TYPE], "ReplyError");
    assertEquals(span.events.some((e) => e.name === "exception"), true);
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

// ---------------------------------------------------------------------------
// Behavioural tests against a live Valkey, matching mod_test.ts.
// ---------------------------------------------------------------------------

Deno.test({
  name: "lock acquire and release spans",
  fn: async () => {
    await withSpans(async (spans) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const lock = provider.createLock("/repo", { lockKey: "uncontended" });
      await lock.acquire();
      await lock.release();

      const acquire = findSpan(spans(), "valkey-datastore lock acquire");
      assertEquals(acquire.attributes[Attr.LOCK_CONTENDED], false);
      assertEquals(acquire.attributes[Attr.LOCK_TTL_MS], 30_000);
      assertEquals(acquire.attributes[Attr.LOCK_TIMEOUT_MS], 60_000);
      assertExists(acquire.attributes[Attr.LOCK_WAIT_DURATION_MS]);
      assertExists(acquire.attributes[Attr.LOCK_KEY]);

      const set = findSpan(spans(), "Valkey SET");
      assertEquals(parentIdOf(set), acquire.spanContext().spanId);

      const release = findSpan(spans(), "valkey-datastore lock release");
      assertExists(release.attributes[Attr.LOCK_KEY]);
      const evalSpan = findSpan(spans(), "Valkey EVAL");
      assertEquals(parentIdOf(evalSpan), release.spanContext().spanId);
    });
  },
});

Deno.test({
  name: "lock acquire span records contention, retry, and error on timeout",
  fn: async () => {
    await withSpans(async (spans) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const held = provider.createLock("/repo", { lockKey: "contended" });
      await held.acquire();
      try {
        const loser = provider.createLock("/repo", {
          lockKey: "contended",
          maxWaitMs: 80,
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
        .filter((s) => s.name === "valkey-datastore lock acquire")
        .find((s) => s.attributes[Attr.LOCK_CONTENDED] === true);
      assertExists(failed, "expected a contended acquire span");
      assertEquals(failed.status.code, 2);
      assertEquals(failed.attributes[Attr.ERROR_TYPE], "Error");
      assertEquals(failed.events.some((e) => e.name === "exception"), true);
      assertExists(failed.attributes[Attr.LOCK_WAIT_DURATION_MS]);
      const retry = failed.events.find((e) => e.name === "retry");
      assertExists(retry, "expected a lock_contended retry event");
      assertEquals(retry.attributes?.["retry.reason"], "lock_contended");
      assertEquals(retry.attributes?.["retry.attempt"], 1);
    });
  },
});

Deno.test({
  name: "withLock, inspect, and forceRelease spans",
  fn: async () => {
    await withSpans(async (spans) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const lock = provider.createLock("/repo", { lockKey: "wrapped" });
      await lock.withLock(() => Promise.resolve("done"));

      const outer = findSpan(spans(), "valkey-datastore lock withLock");
      const acquire = findSpan(spans(), "valkey-datastore lock acquire");
      const release = findSpan(spans(), "valkey-datastore lock release");
      assertEquals(parentIdOf(acquire), outer.spanContext().spanId);
      assertEquals(parentIdOf(release), outer.spanContext().spanId);

      const held = provider.createLock("/repo", { lockKey: "inspected" });
      await held.acquire();
      const info = await held.inspect();
      assertExists(info?.nonce);
      assertEquals(await held.forceRelease(info.nonce), true);

      const inspect = findSpan(spans(), "valkey-datastore lock inspect");
      const holder = inspect.attributes[Attr.LOCK_HOLDER];
      assert(
        typeof holder === "string" && holder.includes("pid "),
        `expected a holder attribute, got ${holder}`,
      );
      findSpan(spans(), "Valkey GET");
      findSpan(spans(), "valkey-datastore lock forceRelease");
    });
  },
});

Deno.test({
  name: "heartbeat renewal is deliberately not instrumented",
  fn: async () => {
    await withSpans(async (spans) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const lock = provider.createLock("/repo", { lockKey: "beating" });
      await lock.acquire();
      await lock.release();

      // Periodic renewals would swamp the trace of any long-held lock.
      assertEquals(
        spans().some((s) => s.name.includes("heartbeat")),
        false,
        `unexpected heartbeat span in [${namesOf(spans())}]`,
      );
      assertEquals(
        spans().some((s) => s.name === "Valkey PEXPIRE"),
        false,
        "the renewal PEXPIRE must not be instrumented",
      );
    });
  },
});

Deno.test({
  name: "pushChanged span reports files pushed and pipeline batches",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await seedFile(cachePath, "data/m/i/a.json", "a");
        await seedFile(cachePath, "data/m/i/b.json", "b");
        await svc.pushChanged();

        const push = findSpan(spans(), "valkey-datastore pushChanged");
        assertEquals(push.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
        // `changes` counts writes and deletes together, so files_pushed must
        // not be derived from it.
        assertEquals(push.attributes[Attr.DATASTORE_FILES_PUSHED], 2);
        assertEquals(push.attributes[Attr.DATASTORE_FILES_DELETED], 0);
        assertEquals(parentIdOf(push), undefined);

        // Three commands per file, batched into a single flush.
        const pipe = findSpan(spans(), "Valkey pipeline writeFiles");
        assertEquals(pipe.attributes[Attr.VALKEY_PIPELINE_COMMANDS], 6);
        assertEquals(pipe.spanContext().traceId, push.spanContext().traceId);
        findSpan(spans(), "Valkey INCR");
      });
    });
  },
});

Deno.test({
  name: "pushChanged span reports the no-dirty-paths fast path",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        // A missing sidecar reads as bulkInvalidated, so the fast path is only
        // reachable after a push has cleared that flag.
        await seedFile(cachePath, "data/m/i/a.json", "a");
        await svc.pushChanged();
        assertEquals(await svc.pushChanged(), 0);

        const pushes = spans().filter((s) =>
          s.name === "valkey-datastore pushChanged"
        );
        assertEquals(pushes.length, 2);
        assertEquals(pushes[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
        assertEquals(pushes[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
        assertEquals(pushes[1].attributes[Attr.DATASTORE_FILES_PUSHED], 0);
      });
    });
  },
});

Deno.test({
  name: "pullChanged span reports the sequence fast path and path count",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await seedFile(cachePath, "data/m/i/a.json", "a");
        await svc.pushChanged();
        await svc.pullChanged();
        await svc.pullChanged();

        const pulls = spans().filter((s) =>
          s.name === "valkey-datastore pullChanged"
        );
        assertEquals(pulls.length, 2);
        assertEquals(pulls[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
        assertEquals(pulls[0].attributes[Attr.DATASTORE_SCOPED], false);
        assertEquals(
          pulls[0].attributes[Attr.DATASTORE_METADATA_ONLY],
          false,
        );
        assertEquals(pulls[0].attributes[Attr.DATASTORE_PATHS], 1);
        assertEquals(pulls[0].attributes[Attr.DATASTORE_TRUNCATED], false);
        assertExists(pulls[0].attributes[Attr.DATASTORE_SEQ]);
        assertEquals(pulls[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
        assertEquals(pulls[1].attributes[Attr.DATASTORE_FILES_PULLED], 0);
        // The fast path short-circuits before scanning the path index.
        assertEquals(pulls[1].attributes[Attr.DATASTORE_PATHS], undefined);

        findSpan(spans(), "Valkey ZRANGEBYLEX");
      });
    });
  },
});

Deno.test({
  name: "scoped pullChanged span records datastore.scoped",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await svc.pullChanged({
          context: { models: [{ modelType: "m", modelId: "i" }] },
        });

        const pull = findSpan(spans(), "valkey-datastore pullChanged");
        assertEquals(pull.attributes[Attr.DATASTORE_SCOPED], true);
      });
    });
  },
});

Deno.test({
  name: "hydrateFile span records the file and hydration outcome",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const prefix = uniquePrefix();
        const provider = datastore.createProvider(testConfig(prefix));
        const svc = provider.createSyncService!("/repo", cachePath);
        const relPath = "data/m/i/a.json";
        await seedFile(cachePath, relPath, "a");
        await svc.pushChanged();

        await withCache(async (other) => {
          const svc2 = provider.createSyncService!("/repo", other);
          assertEquals(await svc2.hydrateFile!(relPath), true);
          assertEquals(await svc2.hydrateFile!("data/m/i/missing.json"), false);
          assertEquals(await svc2.hydrateFile!("../escape.json"), false);
        });

        const hydrations = spans().filter((s) =>
          s.name === "valkey-datastore hydrateFile"
        );
        assertEquals(hydrations.length, 3);
        assertEquals(hydrations[0].attributes[Attr.DATASTORE_FILE], relPath);
        assertEquals(hydrations[0].attributes[Attr.DATASTORE_HYDRATED], true);
        assertEquals(hydrations[1].attributes[Attr.DATASTORE_HYDRATED], false);
        assertEquals(hydrations[2].attributes[Attr.DATASTORE_HYDRATED], false);
        // Traversal is rejected before any command runs.
        assertEquals(
          hydrations[2].spanContext().spanId !== "",
          true,
        );
        findSpan(spans(), "Valkey GET");
      });
    });
  },
});

Deno.test({
  name: "preparePush and commitPush spans report planned work",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await seedFile(cachePath, "data/m/i/a.json", "a");
        const manifest = await svc.preparePush();
        await svc.commitPush(manifest);

        const prepare = findSpan(spans(), "valkey-datastore preparePush");
        assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 1);
        assertEquals(
          prepare.attributes[Attr.DATASTORE_FILES_PLANNED_DELETE],
          0,
        );

        const commit = findSpan(spans(), "valkey-datastore commitPush");
        assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
        assertEquals(commit.attributes[Attr.DATASTORE_FILES_DELETED], 0);
        assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      });
    });
  },
});

Deno.test({
  name: "commitPush of an empty manifest reports the fast path",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await svc.pushChanged(); // clears bulkInvalidated
        const manifest = await svc.preparePush();
        assertEquals(await svc.commitPush(manifest), 0);

        const commit = findSpan(spans(), "valkey-datastore commitPush");
        assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
        assertEquals(
          spans().some((s) => s.name === "Valkey pipeline writeFiles"),
          false,
          "an empty manifest must not flush a pipeline",
        );
      });
    });
  },
});

Deno.test({
  name: "tombstones are reported as files_deleted, not files_pushed",
  fn: async () => {
    await withSpans(async (spans) => {
      await withCache(async (cachePath) => {
        const provider = datastore.createProvider(testConfig(uniquePrefix()));
        const svc = provider.createSyncService!("/repo", cachePath);
        await seedFile(cachePath, "data/m/i/a.json", "a");
        await seedFile(cachePath, "data/m/i/b.json", "b");
        await svc.pushChanged();

        // Remove one file and force a full walk so the deletion is detected.
        await Deno.remove(`${cachePath}/data/m/i/b.json`);
        await svc.markDirty();
        await svc.pushChanged();

        const pushes = spans().filter((s) =>
          s.name === "valkey-datastore pushChanged"
        );
        const second = pushes[pushes.length - 1];
        assertEquals(second.attributes[Attr.DATASTORE_FILES_DELETED], 1);
        assertEquals(second.attributes[Attr.DATASTORE_FILES_PUSHED], 0);
        findSpan(spans(), "Valkey pipeline deleteFiles");
      });
    });
  },
});

Deno.test({
  name: "verifier emits PING and INFO spans",
  fn: async () => {
    await withSpans(async (spans) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const health = await provider.createVerifier().verify();
      assertEquals(health.healthy, true);

      const ping = findSpan(spans(), "Valkey PING");
      assertEquals(ping.attributes[Attr.DB_OPERATION], "PING");
      findSpan(spans(), "Valkey INFO");
    });
  },
});

Deno.test({
  name: "operations succeed with no TracerProvider registered",
  fn: async () => {
    // withSpans is deliberately not used here: the global API stays in its
    // default no-op state, which is how the extension runs outside a traced
    // host.
    assertEquals(trace.getActiveSpan(), undefined);
    await withCache(async (cachePath) => {
      const provider = datastore.createProvider(testConfig(uniquePrefix()));
      const svc = provider.createSyncService!("/repo", cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      assertEquals(await svc.pushChanged(), 1);
      assertEquals(await svc.pullChanged(), 0);

      const lock = provider.createLock("/repo", { lockKey: "no-provider" });
      await lock.acquire();
      await lock.release();
    });
  },
});
