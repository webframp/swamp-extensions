// ABOUTME: Asserts the OpenTelemetry spans emitted by the Azure Blob datastore
// ABOUTME: — names, attributes, error status, retry events, and parent/child
// ABOUTME: nesting — plus that everything still works with no TracerProvider.

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { context, trace } from "npm:@opentelemetry/api@1.9.0";
import { AsyncLocalStorageContextManager } from "npm:@opentelemetry/context-async-hooks@2.10.0";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@2.10.0";

import { BlobClient } from "./rest_client.ts";
import { createSyncService } from "./sync.ts";
import { createBlobLock } from "./lock.ts";
import { retryableRequest } from "./_lib/retry.ts";
import { Attr, withSpan } from "./_lib/tracing.ts";
import {
  createMockAzureServer,
  type MockAzureServer,
} from "./_lib/mock_server.ts";

const CONTAINER = "swamp-datastore";
const PREFIX = "swamp";

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

async function withHarness(
  fn: (
    ctx: { client: BlobClient; cachePath: string; mock: MockAzureServer },
  ) => Promise<void>,
  /** Optional short-circuit, used to inject synthetic failure statuses. */
  intercept?: (method: string, url: URL) => Response | undefined,
): Promise<void> {
  const mock = createMockAzureServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ??
      "GET";
    const injected = intercept?.(method, url);
    if (injected) return Promise.resolve(injected);
    const rewritten =
      `http://localhost:${mock.port}${url.pathname}${url.search}`;
    return originalFetch(rewritten, input instanceof Request ? input : init);
  }) as typeof fetch;

  const client = BlobClient.fromAuth({
    mode: "sharedKey",
    accountName: "test",
    accountKey: "c3VwZXJzZWNyZXQ=",
    endpointSuffix: "core.windows.net",
  });
  const cachePath = await Deno.makeTempDir();
  try {
    await fn({ client, cachePath, mock });
  } finally {
    globalThis.fetch = originalFetch;
    await mock.server.shutdown();
    await Deno.remove(cachePath, { recursive: true });
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

Deno.test("client span carries container, blob key, status, and op name", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      const relPath = "data/model/inst/a.json";
      await seedFile(cachePath, relPath, "hello");
      await svc.markDirty({ relPath });
      assertEquals(await svc.pushChanged(), 1);

      // putBlob is the op name threaded through BlobRequestOptions.op — a
      // span named "Azure Blob PUT" would mean the op never reached the span.
      const put = findSpan(spans(), "Azure Blob putBlob");
      assertEquals(put.attributes[Attr.RPC_SYSTEM], "azure-blob-storage");
      assertEquals(put.attributes[Attr.RPC_SERVICE], "Blob");
      assertEquals(put.attributes[Attr.RPC_METHOD], "putBlob");
      assertEquals(put.attributes[Attr.HTTP_REQUEST_METHOD], "PUT");
      assertEquals(put.attributes[Attr.AZURE_BLOB_CONTAINER], CONTAINER);
      assertEquals(
        put.attributes[Attr.AZURE_BLOB_KEY],
        `${PREFIX}/${relPath}`,
      );
      assertEquals(put.attributes[Attr.HTTP_RESPONSE_STATUS_CODE], 201);
      assertExists(put.attributes[Attr.HTTP_RESPONSE_BODY_SIZE]);
    });
  });
});

Deno.test("container-scoped request records no blob key", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await svc.pullChanged();

      const list = findSpan(spans(), "Azure Blob listBlobs");
      assertEquals(list.attributes[Attr.AZURE_BLOB_CONTAINER], CONTAINER);
      assertEquals(list.attributes[Attr.AZURE_BLOB_KEY], undefined);
    });
  });
});

Deno.test("client span is a child of the enclosing sync span", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await svc.pullChanged();

      const pull = findSpan(spans(), "azure-blob-datastore pullChanged");
      const list = findSpan(spans(), "azure-blob-datastore listIndexShards");
      const blobs = findSpan(spans(), "Azure Blob listBlobs");
      assertEquals(parentIdOf(blobs), list.spanContext().spanId);
      // listIndexShards runs under queryAllFileMeta, which runs under
      // pullChanged — so the whole chain shares one trace.
      assertEquals(
        blobs.spanContext().traceId,
        pull.spanContext().traceId,
      );
      assertEquals(parentIdOf(pull), undefined);
    });
  });
});

Deno.test("pushChanged span reports files pushed and deleted", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await seedFile(cachePath, "data/m/i/b.json", "b");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.markDirty({ relPath: "data/m/i/b.json" });
      await svc.pushChanged();

      const push = findSpan(spans(), "azure-blob-datastore pushChanged");
      assertEquals(push.attributes[Attr.DATASTORE_FILES_PUSHED], 2);
      assertEquals(push.attributes[Attr.DATASTORE_FILES_DELETED], 0);
      assertEquals(push.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
    });
  });
});

Deno.test("pushChanged span reports the no-dirty-paths fast path", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      // A missing sidecar reads as bulkInvalidated, so the fast path is only
      // reachable after a push has cleared that flag.
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.pushChanged();
      assertEquals(await svc.pushChanged(), 0);

      const pushes = spans().filter((s) =>
        s.name === "azure-blob-datastore pushChanged"
      );
      assertEquals(pushes.length, 2);
      assertEquals(pushes[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FILES_PUSHED], 0);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FILES_DELETED], 0);
    });
  });
});

Deno.test("pullChanged span reports the watermark fast path", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.pushChanged();
      // First pull records lastPulledAt; the second short-circuits on the
      // watermark comparison without walking the index.
      await svc.pullChanged();
      await svc.pullChanged();

      const pulls = spans().filter((s) =>
        s.name === "azure-blob-datastore pullChanged"
      );
      assertEquals(pulls.length, 2);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FILES_PULLED], 0);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_SCOPED], false);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_METADATA_ONLY], false);
    });
  });
});

Deno.test("hydrateFile span records the file and hydration outcome", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      const relPath = "data/m/i/a.json";
      await seedFile(cachePath, relPath, "a");
      await svc.markDirty({ relPath });
      await svc.pushChanged();

      const other = await Deno.makeTempDir();
      try {
        const svc2 = createSyncService(client, CONTAINER, PREFIX, other);
        assertEquals(await svc2.hydrateFile!(relPath), true);
        assertEquals(await svc2.hydrateFile!("data/m/i/missing.json"), false);
      } finally {
        await Deno.remove(other, { recursive: true });
      }

      const hydrations = spans().filter((s) =>
        s.name === "azure-blob-datastore hydrateFile"
      );
      assertEquals(hydrations.length, 2);
      assertEquals(hydrations[0].attributes[Attr.DATASTORE_FILE], relPath);
      assertEquals(hydrations[0].attributes[Attr.DATASTORE_HYDRATED], true);
      assertExists(hydrations[0].attributes[Attr.DATASTORE_SHARD]);
      assertEquals(hydrations[1].attributes[Attr.DATASTORE_HYDRATED], false);
    });
  });
});

Deno.test("preparePush and commitPush spans report planned work", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      const manifest = await svc.preparePush();
      await svc.commitPush(manifest);

      const prepare = findSpan(spans(), "azure-blob-datastore preparePush");
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 1);
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_DELETE], 0);

      const commit = findSpan(spans(), "azure-blob-datastore commitPush");
      assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
      assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
    });
  });
});

Deno.test("lock acquire span records wait duration and no contention", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "uncontended",
      });
      await lock.acquire();
      await lock.release();

      const acquire = findSpan(spans(), "azure-blob-datastore lock acquire");
      assertEquals(acquire.attributes[Attr.LOCK_KEY], "uncontended");
      assertEquals(acquire.attributes[Attr.LOCK_CONTENDED], false);
      assertEquals(acquire.attributes[Attr.LOCK_TTL_MS], 30_000);
      assertEquals(acquire.attributes[Attr.LOCK_TIMEOUT_MS], 60_000);
      assertExists(acquire.attributes[Attr.LOCK_WAIT_DURATION_MS]);

      const release = findSpan(spans(), "azure-blob-datastore lock release");
      assertEquals(release.attributes[Attr.LOCK_KEY], "uncontended");
    });
  });
});

Deno.test("lock acquire span records contention and error on timeout", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const held = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "contended",
      });
      await held.acquire();
      try {
        const loser = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
          lockKey: "contended",
          maxWaitMs: 60,
          retryIntervalMs: 10,
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

      const acquires = spans().filter((s) =>
        s.name === "azure-blob-datastore lock acquire"
      );
      const failed = acquires.find((s) =>
        s.attributes[Attr.LOCK_CONTENDED] === true
      );
      assertExists(failed, "expected a contended acquire span");
      // status code 2 is ERROR
      assertEquals(failed.status.code, 2);
      assertEquals(failed.attributes[Attr.ERROR_TYPE], "Error");
      assertEquals(failed.events.some((e) => e.name === "exception"), true);
      assertExists(failed.attributes[Attr.LOCK_WAIT_DURATION_MS]);
      // The 409 backoff loop records its own retry events.
      assertEquals(failed.events.some((e) => e.name === "retry"), true);
    });
  });
});

Deno.test("withLock span wraps acquire and release as children", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "wrapped",
      });
      await lock.withLock(() => Promise.resolve("done"));

      const outer = findSpan(spans(), "azure-blob-datastore lock withLock");
      const acquire = findSpan(spans(), "azure-blob-datastore lock acquire");
      const release = findSpan(spans(), "azure-blob-datastore lock release");
      assertEquals(parentIdOf(acquire), outer.spanContext().spanId);
      assertEquals(parentIdOf(release), outer.spanContext().spanId);
    });
  });
});

Deno.test("lock inspect span records the holder", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "inspected",
      });
      await lock.acquire();
      try {
        assertExists(await lock.inspect());
      } finally {
        await lock.release();
      }

      const inspect = findSpan(spans(), "azure-blob-datastore lock inspect");
      assertEquals(inspect.attributes[Attr.LOCK_KEY], "inspected");
      const holder = inspect.attributes[Attr.LOCK_HOLDER];
      assert(
        typeof holder === "string" && holder.includes("pid "),
        `expected a holder attribute, got ${holder}`,
      );
      findSpan(spans(), "Azure Blob getLockMetadata");
    });
  });
});

Deno.test("forceRelease emits its own span", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "forced",
      });
      await lock.acquire();
      const info = await lock.inspect();
      assertExists(info?.nonce);
      assertEquals(await lock.forceRelease(info.nonce), true);

      const forced = findSpan(
        spans(),
        "azure-blob-datastore lock forceRelease",
      );
      assertEquals(forced.attributes[Attr.LOCK_KEY], "forced");
    });
  });
});

Deno.test("heartbeat is deliberately not instrumented", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ client }) => {
      const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
        lockKey: "beating",
      });
      await lock.acquire();
      try {
        assertEquals(await lock.heartbeat(), true);
      } finally {
        await lock.release();
      }

      // The renew round trip is visible at the client layer, but there is no
      // lock-level heartbeat span — periodic renewals would swamp the trace.
      assertEquals(
        spans().some((s) => s.name.includes("lock heartbeat")),
        false,
        `unexpected heartbeat span in [${namesOf(spans())}]`,
      );
      findSpan(spans(), "Azure Blob lease.renew");
    });
  });
});

Deno.test("retryableRequest records a retry event on the active span", async () => {
  await withSpans(async (spans) => {
    let calls = 0;
    const result = await withSpan("test parent", {}, async () => {
      return await retryableRequest(() => {
        calls++;
        return Promise.resolve({ status: calls === 1 ? 503 : 200 });
      }, { baseDelayMs: 1 });
    });
    assertEquals(result.status, 200);
    assertEquals(calls, 2);

    const parent = findSpan(spans(), "test parent");
    const retry = parent.events.find((e) => e.name === "retry");
    assertExists(retry, "expected a retry event on the enclosing span");
    assertEquals(retry.attributes?.["retry.attempt"], 1);
    assertEquals(retry.attributes?.["retry.reason"], "retryable_status");
    assertEquals(retry.attributes?.["http.response.status_code"], 503);
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
    // The original value must propagate unchanged — only the span sees the
    // wrapped Error.
    assertEquals(caught, "nope");
    const span = findSpan(spans(), "string-reject");
    assertEquals(span.status.code, 2);
    assertEquals(span.status.message, "nope");
    assertEquals(span.attributes[Attr.ERROR_TYPE], "Error");
  });
});

Deno.test("updateShard records an etag_conflict retry event on 412", async () => {
  await withSpans(async (spans) => {
    let injected = 0;
    await withHarness(async ({ client, cachePath }) => {
      const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.pushChanged();
      assertEquals(injected, 1, "expected one synthetic 412");

      // The ETag conflict loop inside updateShard is independent of
      // retryableRequest, so it records its own retry event.
      const update = findSpan(spans(), "azure-blob-datastore updateShard");
      const retry = update.events.find((e) => e.name === "retry");
      assertExists(retry, "expected an etag_conflict retry event");
      assertEquals(retry.attributes?.["retry.reason"], "etag_conflict");
      assertEquals(retry.attributes?.["retry.attempt"], 1);
      assertEquals(retry.attributes?.["http.response.status_code"], 412);
      assertEquals(update.status.code, 0, "the retry must still succeed");
      assertExists(update.attributes[Attr.DATASTORE_SHARD]);
    }, (method, url) => {
      if (method === "PUT" && url.pathname.includes("/_index/")) {
        if (injected === 0) {
          injected++;
          return new Response("ConditionNotMet", { status: 412 });
        }
      }
      return undefined;
    });
  });
});

Deno.test("operations succeed with no TracerProvider registered", async () => {
  // withSpans is deliberately not used here: the global API stays in its
  // default no-op state, which is how the extension runs outside a traced host.
  assertEquals(trace.getActiveSpan(), undefined);
  await withHarness(async ({ client, cachePath }) => {
    const svc = createSyncService(client, CONTAINER, PREFIX, cachePath);
    const relPath = "data/m/i/a.json";
    await seedFile(cachePath, relPath, "a");
    await svc.markDirty({ relPath });
    assertEquals(await svc.pushChanged(), 1);
    assertEquals(await svc.pullChanged(), 0);

    const lock = createBlobLock(client, CONTAINER, PREFIX, "/repo", {
      lockKey: "no-provider",
    });
    await lock.acquire();
    await lock.release();
  });
});
