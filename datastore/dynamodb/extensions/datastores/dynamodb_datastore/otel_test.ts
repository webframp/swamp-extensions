// ABOUTME: Asserts the OpenTelemetry spans emitted by the DynamoDB datastore —
// ABOUTME: names, attributes, error status, retry events, and parent/child
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
import { DynamoDBClient } from "npm:@aws-sdk/client-dynamodb@3.1094.0";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1094.0";

import { createSyncService } from "./sync.ts";
import { createDynamoLock } from "./lock.ts";
import { datastore } from "./mod.ts";
import { retryable } from "./_lib/retry.ts";
import {
  Attr,
  instrumentClient,
  operationName,
  withSpan,
} from "./_lib/tracing.ts";
import { FakeDynamoTable, installFakeDynamo } from "./_lib/fake_dynamo.ts";

const TABLE_NAME = "swamp-test-table";
const MAX_CHUNK_BYTES = 64;

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
    ctx: {
      doc: DynamoDBDocumentClient;
      cachePath: string;
      table: FakeDynamoTable;
    },
  ) => Promise<void>,
): Promise<void> {
  const table = new FakeDynamoTable();
  const restore = installFakeDynamo(
    DynamoDBDocumentClient,
    DynamoDBClient,
    table,
  );
  const cachePath = await Deno.makeTempDir();
  try {
    const client = new DynamoDBClient({ region: "us-east-1" });
    const doc = DynamoDBDocumentClient.from(client);
    await fn({ doc, cachePath, table });
  } finally {
    restore();
    await Deno.remove(cachePath, { recursive: true });
  }
}

function sync(doc: DynamoDBDocumentClient, cachePath: string) {
  return createSyncService(
    doc,
    TABLE_NAME,
    cachePath,
    MAX_CHUNK_BYTES,
    () => Promise.resolve(),
  );
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

Deno.test("operationName maps SDK command classes to wire operations", () => {
  assertEquals(
    operationName(new PutCommand({ TableName: "t", Item: {} })),
    "PutItem",
  );
  assertEquals(
    operationName(new QueryCommand({ TableName: "t" })),
    "Query",
  );
  // Unmapped commands fall back to the class name minus the Command suffix.
  class SomethingNewCommand {}
  assertEquals(operationName(new SomethingNewCommand()), "SomethingNew");
  assertEquals(operationName(undefined), "Unknown");
});

Deno.test("instrumentClient records response metadata, capacity, and counts", async () => {
  await withSpans(async (spans) => {
    const stub = {
      send(_cmd: unknown) {
        return Promise.resolve({
          $metadata: { httpStatusCode: 200, requestId: "REQ-123" },
          ConsumedCapacity: { CapacityUnits: 3.5 },
          Count: 7,
          ScannedCount: 9,
        });
      },
    };
    const traced = instrumentClient(stub);
    await traced.send(
      new QueryCommand({ TableName: TABLE_NAME, IndexName: "gsi1" }),
    );

    const span = findSpan(spans(), "DynamoDB Query");
    assertEquals(span.attributes[Attr.RPC_SYSTEM], "aws-api");
    assertEquals(span.attributes[Attr.RPC_SERVICE], "DynamoDB");
    assertEquals(span.attributes[Attr.RPC_METHOD], "Query");
    assertEquals(span.attributes[Attr.AWS_DYNAMODB_TABLE_NAMES], [TABLE_NAME]);
    assertEquals(span.attributes[Attr.AWS_DYNAMODB_INDEX_NAME], "gsi1");
    assertEquals(span.attributes[Attr.HTTP_RESPONSE_STATUS_CODE], 200);
    assertEquals(span.attributes[Attr.AWS_REQUEST_ID], "REQ-123");
    assertEquals(span.attributes[Attr.AWS_DYNAMODB_CONSUMED_CAPACITY], 3.5);
    assertEquals(span.attributes[Attr.AWS_DYNAMODB_COUNT], 7);
    assertEquals(span.attributes[Attr.AWS_DYNAMODB_SCANNED_COUNT], 9);
  });
});

Deno.test("instrumentClient records SDK failures on the span", async () => {
  await withSpans(async (spans) => {
    class ThrottlingException extends Error {
      override name = "ThrottlingException";
    }
    const stub = {
      send(_cmd: unknown): Promise<unknown> {
        return Promise.reject(new ThrottlingException("slow down"));
      },
    };
    const traced = instrumentClient(stub);
    let threw = false;
    try {
      await traced.send(new PutCommand({ TableName: TABLE_NAME, Item: {} }));
    } catch {
      threw = true;
    }
    assert(threw, "the SDK error must propagate");

    const span = findSpan(spans(), "DynamoDB PutItem");
    assertEquals(span.status.code, 2);
    assertEquals(span.attributes[Attr.ERROR_TYPE], "ThrottlingException");
    assertEquals(span.events.some((e) => e.name === "exception"), true);
  });
});

Deno.test("instrumentClient passes non-send properties straight through", () => {
  const stub = {
    send: () => Promise.resolve({}),
    config: { region: "eu-west-1" },
  };
  const traced = instrumentClient(stub);
  assertEquals(traced.config.region, "eu-west-1");
});

Deno.test("item writes emit one span per SDK call under the sync span", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      const relPath = "data/model/inst/a.json";
      await seedFile(cachePath, relPath, "hello");
      await svc.markDirty({ relPath });
      await svc.pushChanged();

      const push = findSpan(spans(), "dynamodb-datastore pushChanged");
      const writes = spans().filter((s) =>
        s.name === "DynamoDB BatchWriteItem"
      );
      assert(
        writes.length > 0,
        `expected BatchWriteItem spans in [${namesOf(spans())}]`,
      );
      assertEquals(
        writes[0].attributes[Attr.RPC_METHOD],
        "BatchWriteItem",
      );
      // Every client span shares the push's trace.
      for (const w of writes) {
        assertEquals(w.spanContext().traceId, push.spanContext().traceId);
      }
      assertEquals(parentIdOf(push), undefined);
    });
  });
});

Deno.test("pushChanged span reports files pushed, deleted, and fast path", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await seedFile(cachePath, "data/m/i/b.json", "b");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.markDirty({ relPath: "data/m/i/b.json" });
      await svc.pushChanged();
      // A missing sidecar reads as bulkInvalidated, so the fast path is only
      // reachable after a push has cleared that flag.
      assertEquals(await svc.pushChanged(), 0);

      const pushes = spans().filter((s) =>
        s.name === "dynamodb-datastore pushChanged"
      );
      assertEquals(pushes.length, 2);
      assertEquals(pushes[0].attributes[Attr.DATASTORE_FILES_PUSHED], 2);
      assertEquals(pushes[0].attributes[Attr.DATASTORE_FILES_DELETED], 0);
      assertEquals(pushes[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pushes[1].attributes[Attr.DATASTORE_FILES_PUSHED], 0);
    });
  });
});

Deno.test("pullChanged span reports the watermark fast path", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      await svc.pushChanged();
      await svc.pullChanged();
      await svc.pullChanged();

      const pulls = spans().filter((s) =>
        s.name === "dynamodb-datastore pullChanged"
      );
      assertEquals(pulls.length, 2);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_SCOPED], false);
      assertEquals(pulls[0].attributes[Attr.DATASTORE_METADATA_ONLY], false);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(pulls[1].attributes[Attr.DATASTORE_FILES_PULLED], 0);
    });
  });
});

Deno.test("scoped pullChanged span records datastore.scoped", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      await svc.pullChanged({
        context: { models: [{ modelType: "m", modelId: "i" }] },
      });

      const pull = findSpan(spans(), "dynamodb-datastore pullChanged");
      assertEquals(pull.attributes[Attr.DATASTORE_SCOPED], true);
    });
  });
});

Deno.test("hydrateFile span records file, chunks, and outcome", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      const relPath = "data/m/i/a.json";
      // Longer than MAX_CHUNK_BYTES so chunkCount is greater than one.
      await seedFile(cachePath, relPath, "x".repeat(200));
      await svc.markDirty({ relPath });
      await svc.pushChanged();

      const other = await Deno.makeTempDir();
      try {
        const svc2 = sync(doc, other);
        assertEquals(await svc2.hydrateFile!(relPath), true);
        assertEquals(await svc2.hydrateFile!("data/m/i/missing.json"), false);
        assertEquals(await svc2.hydrateFile!("../escape.json"), false);
      } finally {
        await Deno.remove(other, { recursive: true });
      }

      const hydrations = spans().filter((s) =>
        s.name === "dynamodb-datastore hydrateFile"
      );
      assertEquals(hydrations.length, 3);
      assertEquals(hydrations[0].attributes[Attr.DATASTORE_FILE], relPath);
      assertEquals(hydrations[0].attributes[Attr.DATASTORE_HYDRATED], true);
      assert(
        (hydrations[0].attributes[Attr.DATASTORE_CHUNKS] as number) > 1,
        "expected a multi-chunk file",
      );
      assertEquals(hydrations[1].attributes[Attr.DATASTORE_HYDRATED], false);
      // Traversal is rejected before any SDK call, so no chunk count is set.
      assertEquals(hydrations[2].attributes[Attr.DATASTORE_HYDRATED], false);
      assertEquals(hydrations[2].attributes[Attr.DATASTORE_CHUNKS], undefined);
    });
  });
});

Deno.test("preparePush and commitPush spans report planned work", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      await seedFile(cachePath, "data/m/i/a.json", "a");
      await svc.markDirty({ relPath: "data/m/i/a.json" });
      const manifest = await svc.preparePush();
      await svc.commitPush(manifest);

      const prepare = findSpan(spans(), "dynamodb-datastore preparePush");
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 1);
      assertEquals(prepare.attributes[Attr.DATASTORE_FILES_PLANNED_DELETE], 0);

      const commit = findSpan(spans(), "dynamodb-datastore commitPush");
      assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
      assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
    });
  });
});

Deno.test("commitPush of an empty manifest reports the fast path", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc, cachePath }) => {
      const svc = sync(doc, cachePath);
      await svc.pushChanged(); // clears bulkInvalidated
      const manifest = await svc.preparePush();
      assertEquals(await svc.commitPush(manifest), 0);

      const commit = findSpan(spans(), "dynamodb-datastore commitPush");
      assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
      assertEquals(commit.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH], 0);
    });
  });
});

Deno.test("lock acquire span records wait duration and no contention", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc }) => {
      const lock = createDynamoLock(doc, TABLE_NAME, "/repo", {
        lockKey: "uncontended",
      });
      await lock.acquire();
      await lock.release();

      const acquire = findSpan(spans(), "dynamodb-datastore lock acquire");
      assertEquals(acquire.attributes[Attr.LOCK_KEY], "uncontended");
      assertEquals(acquire.attributes[Attr.LOCK_CONTENDED], false);
      assertEquals(acquire.attributes[Attr.LOCK_TTL_MS], 30_000);
      assertEquals(acquire.attributes[Attr.LOCK_TIMEOUT_MS], 60_000);
      assertExists(acquire.attributes[Attr.LOCK_WAIT_DURATION_MS]);
      findSpan(spans(), "DynamoDB PutItem");

      const release = findSpan(spans(), "dynamodb-datastore lock release");
      assertEquals(release.attributes[Attr.LOCK_KEY], "uncontended");
      findSpan(spans(), "DynamoDB DeleteItem");
    });
  });
});

Deno.test("lock acquire span records contention, retry, and error on timeout", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc }) => {
      const held = createDynamoLock(doc, TABLE_NAME, "/repo", {
        lockKey: "contended",
      });
      await held.acquire();
      try {
        const loser = createDynamoLock(doc, TABLE_NAME, "/repo", {
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

      const failed = spans()
        .filter((s) => s.name === "dynamodb-datastore lock acquire")
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
  });
});

Deno.test("withLock span wraps acquire and release as children", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc }) => {
      const lock = createDynamoLock(doc, TABLE_NAME, "/repo", {
        lockKey: "wrapped",
      });
      await lock.withLock(() => Promise.resolve("done"));

      const outer = findSpan(spans(), "dynamodb-datastore lock withLock");
      const acquire = findSpan(spans(), "dynamodb-datastore lock acquire");
      const release = findSpan(spans(), "dynamodb-datastore lock release");
      assertEquals(parentIdOf(acquire), outer.spanContext().spanId);
      assertEquals(parentIdOf(release), outer.spanContext().spanId);
    });
  });
});

Deno.test("lock inspect and forceRelease emit spans", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc }) => {
      const lock = createDynamoLock(doc, TABLE_NAME, "/repo", {
        lockKey: "inspected",
      });
      await lock.acquire();
      const info = await lock.inspect();
      assertExists(info?.nonce);
      assertEquals(await lock.forceRelease(info.nonce), true);

      const inspect = findSpan(spans(), "dynamodb-datastore lock inspect");
      assertEquals(inspect.attributes[Attr.LOCK_KEY], "inspected");
      const holder = inspect.attributes[Attr.LOCK_HOLDER];
      assert(
        typeof holder === "string" && holder.includes("pid "),
        `expected a holder attribute, got ${holder}`,
      );
      findSpan(spans(), "DynamoDB GetItem");

      const forced = findSpan(spans(), "dynamodb-datastore lock forceRelease");
      assertEquals(forced.attributes[Attr.LOCK_KEY], "inspected");
    });
  });
});

Deno.test("heartbeat is deliberately not instrumented", async () => {
  await withSpans(async (spans) => {
    await withHarness(async ({ doc }) => {
      const lock = createDynamoLock(doc, TABLE_NAME, "/repo", {
        lockKey: "beating",
      });
      await lock.acquire();
      try {
        assertEquals(await lock.heartbeat(), true);
      } finally {
        await lock.release();
      }

      // The renewal round trip is visible at the client layer, but there is no
      // lock-level heartbeat span — periodic renewals would swamp the trace.
      assertEquals(
        spans().some((s) => s.name.includes("lock heartbeat")),
        false,
        `unexpected heartbeat span in [${namesOf(spans())}]`,
      );
      findSpan(spans(), "DynamoDB UpdateItem");
    });
  });
});

Deno.test("control-plane DescribeTable on the base client is instrumented", async () => {
  await withSpans(async (spans) => {
    const table = new FakeDynamoTable();
    const restore = installFakeDynamo(
      DynamoDBDocumentClient,
      DynamoDBClient,
      table,
    );
    try {
      const provider = datastore.createProvider({
        tableName: TABLE_NAME,
        region: "us-east-1",
      });
      const health = await provider.createVerifier().verify();
      assertEquals(health.healthy, true);
    } finally {
      restore();
    }

    // DescribeTable never goes through the document client, so this span only
    // appears if the base client is wrapped too.
    const describe = findSpan(spans(), "DynamoDB DescribeTable");
    assertEquals(describe.attributes[Attr.RPC_METHOD], "DescribeTable");
  });
});

Deno.test("retryable records a retry event on the active span", async () => {
  await withSpans(async (spans) => {
    class ThrottlingException extends Error {
      override name = "ThrottlingException";
    }
    let calls = 0;
    const value = await withSpan("test parent", {}, async () => {
      return await retryable(() => {
        calls++;
        if (calls === 1) return Promise.reject(new ThrottlingException("slow"));
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
    assertEquals(retry.attributes?.["error.type"], "ThrottlingException");
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

Deno.test("operations succeed with no TracerProvider registered", async () => {
  // withSpans is deliberately not used here: the global API stays in its
  // default no-op state, which is how the extension runs outside a traced host.
  assertEquals(trace.getActiveSpan(), undefined);
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    const relPath = "data/m/i/a.json";
    await seedFile(cachePath, relPath, "a");
    await svc.markDirty({ relPath });
    assertEquals(await svc.pushChanged(), 1);
    assertEquals(await svc.pullChanged(), 0);

    const lock = createDynamoLock(doc, TABLE_NAME, "/repo", {
      lockKey: "no-provider",
    });
    await lock.acquire();
    await lock.release();
  });
});
