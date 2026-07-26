// ABOUTME: Asserts the OpenTelemetry spans emitted by the GitLab datastore —
// ABOUTME: names, attributes, error status, retry events, and parent/child
// ABOUTME: nesting — plus that everything still works with no TracerProvider.
// SPDX-License-Identifier: Apache-2.0

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
import { Attr, withSpan } from "./_lib/tracing.ts";

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

interface MockGitLab {
  server: Deno.HttpServer;
  port: number;
  states: Map<string, Uint8Array>;
  locks: Map<string, unknown>;
  /** Set to a status code to make the next state GET fail with it. */
  failNextStateGet?: number;
}

function createMockGitLabServer(): MockGitLab {
  const states = new Map<string, Uint8Array>();
  const locks = new Map<string, unknown>();
  const mock: Partial<MockGitLab> = { states, locks };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.match(/\/api\/v4\/projects\/[^/]+$/) && req.method === "GET") {
      return Response.json({
        id: 123,
        name: "test-project",
        path_with_namespace: "group/test-project",
      });
    }

    if (path === "/api/graphql" && req.method === "POST") {
      const stateList = Array.from(states.keys()).map((name) => ({ name }));
      return Response.json({
        data: { project: { terraformStates: { nodes: stateList } } },
      });
    }

    const stateMatch = path.match(
      /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)$/,
    );
    if (stateMatch) {
      const stateName = decodeURIComponent(stateMatch[1]);

      if (req.method === "GET") {
        if (mock.failNextStateGet) {
          const status = mock.failNextStateGet;
          mock.failNextStateGet = undefined;
          return new Response("boom", { status });
        }
        const content = states.get(stateName);
        if (!content) return new Response(null, { status: 404 });
        return new Response(new TextDecoder().decode(content), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST") {
        const body = new Uint8Array(await req.arrayBuffer());
        states.set(stateName, body);
        return new Response(null, { status: 200 });
      }

      if (req.method === "DELETE") {
        states.delete(stateName);
        return new Response(null, { status: 200 });
      }
    }

    const lockMatch = path.match(
      /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)\/lock$/,
    );
    if (lockMatch) {
      const stateName = decodeURIComponent(lockMatch[1]);

      if (req.method === "GET") {
        const lockInfo = locks.get(stateName);
        if (!lockInfo) return new Response(null, { status: 404 });
        return Response.json(lockInfo);
      }

      if (req.method === "POST") {
        if (locks.has(stateName)) {
          return Response.json(locks.get(stateName), { status: 409 });
        }
        const lockInfo = await req.json();
        locks.set(stateName, lockInfo);
        return Response.json(lockInfo, { status: 200 });
      }

      if (req.method === "DELETE") {
        const providedInfo = await req.json();
        const existingLock = locks.get(stateName) as { ID: string } | undefined;
        if (!existingLock) return new Response(null, { status: 404 });
        if (existingLock.ID !== providedInfo.ID) {
          return new Response(null, { status: 409 });
        }
        locks.delete(stateName);
        return new Response(null, { status: 200 });
      }
    }

    return new Response(null, { status: 404 });
  };

  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  mock.server = server;
  mock.port = addr.port;
  return mock as MockGitLab;
}

function providerFor(mock: MockGitLab) {
  return datastore.createProvider({
    projectId: "123",
    token: "glpat-must-not-be-traced",
    baseUrl: `http://localhost:${mock.port}`,
  });
}

async function withMock(fn: (mock: MockGitLab) => Promise<void>) {
  const mock = createMockGitLabServer();
  try {
    await fn(mock);
  } finally {
    await mock.server.shutdown();
  }
}

async function withCache(fn: (cachePath: string) => Promise<void>) {
  const cachePath = await Deno.makeTempDir();
  try {
    await fn(cachePath);
  } finally {
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

Deno.test({
  name: "API span carries op, method, project, host, and status",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        const health = await providerFor(mock).createVerifier().verify();
        assertEquals(health.healthy, true);

        const span = findSpan(spans(), "GitLab healthCheck");
        assertEquals(span.attributes[Attr.RPC_SYSTEM], "gitlab");
        assertEquals(span.attributes[Attr.RPC_SERVICE], "GitLab");
        assertEquals(span.attributes[Attr.RPC_METHOD], "healthCheck");
        assertEquals(span.attributes[Attr.HTTP_REQUEST_METHOD], "GET");
        assertEquals(span.attributes[Attr.GITLAB_PROJECT_ID], "123");
        assertEquals(
          span.attributes[Attr.SERVER_ADDRESS],
          `localhost:${mock.port}`,
        );
        assertEquals(span.attributes[Attr.HTTP_RESPONSE_STATUS_CODE], 200);
        // healthCheck is not state-scoped.
        assertEquals(span.attributes[Attr.GITLAB_STATE_NAME], undefined);
      });
    });
  },
});

Deno.test({
  name: "API spans never record the access token",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await providerFor(mock).createVerifier().verify();

        // Every request sends a PRIVATE-TOKEN header. It must not appear in
        // any attribute, on any span.
        const serialized = JSON.stringify(spans().map((s) => s.attributes));
        assertEquals(serialized.includes("glpat-"), false);
        assertEquals(serialized.toLowerCase().includes("private-token"), false);
      });
    });
  },
});

Deno.test({
  name: "state operations record the state name",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          await seedFile(cachePath, "data/m/i/a.json", "hello");
          await svc.pushChanged();

          const put = findSpan(spans(), "GitLab putState");
          assertEquals(
            put.attributes[Attr.GITLAB_STATE_NAME],
            "swamp--data--m--i--a.json",
          );
          assertEquals(put.attributes[Attr.HTTP_REQUEST_METHOD], "POST");
          // putState pre-reads the current serial as a separate request, so
          // that round trip gets its own span rather than hiding inside the
          // write.
          const read = findSpan(spans(), "GitLab readStateSerial");
          assertEquals(read.attributes[Attr.HTTP_REQUEST_METHOD], "GET");
        });
      });
    });
  },
});

Deno.test({
  name: "API spans nest under the enclosing sync span",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          await svc.pullChanged();

          const pull = findSpan(spans(), "gitlab-datastore pullChanged");
          const list = findSpan(spans(), "GitLab listStates");
          assertEquals(parentIdOf(list), pull.spanContext().spanId);
          assertEquals(parentIdOf(pull), undefined);
          // A numeric project ID forces the project-path lookup first.
          const project = findSpan(spans(), "GitLab getProject");
          assertEquals(parentIdOf(project), pull.spanContext().spanId);
        });
      });
    });
  },
});

Deno.test({
  name: "pullChanged span reports states listed and files pulled",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const provider = providerFor(mock);
          const svc = provider.createSyncService!("/repo", cachePath);
          await seedFile(cachePath, "data/m/i/a.json", "a");
          await seedFile(cachePath, "data/m/i/b.json", "b");
          await svc.pushChanged();

          await withCache(async (other) => {
            const svc2 = provider.createSyncService!("/repo", other);
            assertEquals(await svc2.pullChanged(), 2);
          });

          const pulls = spans().filter((s) =>
            s.name === "gitlab-datastore pullChanged"
          );
          const pull = pulls[pulls.length - 1];
          assertEquals(pull.attributes[Attr.DATASTORE_STATES], 2);
          assertEquals(pull.attributes[Attr.DATASTORE_FILES_PULLED], 2);
          assertEquals(pull.attributes[Attr.DATASTORE_SCOPED], false);
          assertEquals(pull.attributes[Attr.DATASTORE_METADATA_ONLY], false);
        });
      });
    });
  },
});

Deno.test({
  name: "scoped pullChanged span records datastore.scoped",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          await svc.pullChanged({
            context: { models: [{ modelType: "m", modelId: "i" }] },
          });

          const pull = findSpan(spans(), "gitlab-datastore pullChanged");
          assertEquals(pull.attributes[Attr.DATASTORE_SCOPED], true);
        });
      });
    });
  },
});

Deno.test({
  name: "pushChanged span reports files pushed and the dirty-path mode",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          await seedFile(cachePath, "data/m/i/a.json", "a");
          await seedFile(cachePath, "data/m/i/b.json", "b");
          // No dirty paths recorded yet, so this is a full walk.
          await svc.pushChanged();

          const first = findSpan(spans(), "gitlab-datastore pushChanged");
          assertEquals(first.attributes[Attr.DATASTORE_FILES_PUSHED], 2);
          assertEquals(first.attributes[Attr.DATASTORE_FILES_DELETED], 0);
          assertEquals(
            first.attributes[Attr.DATASTORE_DIRTY_PATH_MODE],
            false,
          );
          // This method has no short-circuit, so it must not claim one — in
          // the sibling extensions fast_path_hit means "no work was done".
          assertEquals(
            first.attributes[Attr.DATASTORE_FAST_PATH_HIT],
            undefined,
          );

          // Now mark one path dirty so the second push takes the dirty-path
          // route rather than walking the tree.
          await seedFile(cachePath, "data/m/i/a.json", "a-changed");
          await svc.markDirty({ relPath: "data/m/i/a.json" });
          await svc.pushChanged();

          const pushes = spans().filter((s) =>
            s.name === "gitlab-datastore pushChanged"
          );
          const second = pushes[pushes.length - 1];
          assertEquals(second.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
          // Dirty-path mode still uploaded a file, so this is emphatically not
          // a fast path.
          assertEquals(
            second.attributes[Attr.DATASTORE_DIRTY_PATH_MODE],
            true,
          );
          assertEquals(
            second.attributes[Attr.DATASTORE_FAST_PATH_HIT],
            undefined,
          );
        });
      });
    });
  },
});

Deno.test({
  name: "hydrateFile span records the file and hydration outcome",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const provider = providerFor(mock);
          const svc = provider.createSyncService!("/repo", cachePath);
          const relPath = "data/m/i/a.json";
          await seedFile(cachePath, relPath, "a");
          await svc.pushChanged();

          await withCache(async (other) => {
            const svc2 = provider.createSyncService!("/repo", other);
            assertEquals(await svc2.hydrateFile!(relPath), true);
            assertEquals(
              await svc2.hydrateFile!("data/m/i/missing.json"),
              false,
            );
            assertEquals(await svc2.hydrateFile!("../escape.json"), false);
          });

          const hydrations = spans().filter((s) =>
            s.name === "gitlab-datastore hydrateFile"
          );
          assertEquals(hydrations.length, 3);
          assertEquals(hydrations[0].attributes[Attr.DATASTORE_FILE], relPath);
          assertEquals(hydrations[0].attributes[Attr.DATASTORE_HYDRATED], true);
          assertEquals(
            hydrations[1].attributes[Attr.DATASTORE_HYDRATED],
            false,
          );
          assertEquals(
            hydrations[2].attributes[Attr.DATASTORE_HYDRATED],
            false,
          );
        });
      });
    });
  },
});

Deno.test({
  name: "preparePush and commitPush spans report planned work",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          await seedFile(cachePath, "data/m/i/a.json", "a");
          const manifest = await svc.preparePush();
          assertEquals(await svc.commitPush(manifest), 1);

          const prepare = findSpan(spans(), "gitlab-datastore preparePush");
          assertEquals(
            prepare.attributes[Attr.DATASTORE_FILES_PLANNED_PUSH],
            1,
          );

          const commit = findSpan(spans(), "gitlab-datastore commitPush");
          assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 1);
          assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], false);
        });
      });
    });
  },
});

Deno.test({
  name: "commitPush of an empty manifest reports the fast path",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const svc = providerFor(mock).createSyncService!("/repo", cachePath);
          const manifest = await svc.preparePush();
          assertEquals(await svc.commitPush(manifest), 0);

          const commit = findSpan(spans(), "gitlab-datastore commitPush");
          assertEquals(commit.attributes[Attr.DATASTORE_FAST_PATH_HIT], true);
          assertEquals(commit.attributes[Attr.DATASTORE_FILES_PUSHED], 0);
          assertEquals(
            spans().some((s) => s.name === "GitLab putState"),
            false,
            "an empty manifest must not upload anything",
          );
        });
      });
    });
  },
});

Deno.test({
  name: "lock acquire and release spans",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        const lock = providerFor(mock).createLock("/repo", { ttlMs: 5_000 });
        await lock.acquire();
        await lock.release();

        const acquire = findSpan(spans(), "gitlab-datastore lock acquire");
        assertEquals(acquire.attributes[Attr.LOCK_CONTENDED], false);
        assertEquals(acquire.attributes[Attr.LOCK_TTL_MS], 5_000);
        assertEquals(acquire.attributes[Attr.LOCK_TIMEOUT_MS], 60_000);
        assertExists(acquire.attributes[Attr.LOCK_WAIT_DURATION_MS]);
        assertExists(acquire.attributes[Attr.LOCK_KEY]);

        const lockCall = findSpan(spans(), "GitLab lock");
        assertEquals(parentIdOf(lockCall), acquire.spanContext().spanId);

        const release = findSpan(spans(), "gitlab-datastore lock release");
        const unlock = findSpan(spans(), "GitLab unlock");
        assertEquals(parentIdOf(unlock), release.spanContext().spanId);
      });
    });
  },
});

Deno.test({
  name: "lock acquire span records contention, holder, retry, and error",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        const provider = providerFor(mock);
        const held = provider.createLock("/repo", { ttlMs: 60_000 });
        await held.acquire();
        try {
          const loser = provider.createLock("/repo", {
            ttlMs: 60_000,
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
          .filter((s) => s.name === "gitlab-datastore lock acquire")
          .find((s) => s.attributes[Attr.LOCK_CONTENDED] === true);
        assertExists(failed, "expected a contended acquire span");
        assertEquals(failed.status.code, 2);
        assertEquals(failed.attributes[Attr.ERROR_TYPE], "Error");
        assertEquals(failed.events.some((e) => e.name === "exception"), true);
        assertExists(failed.attributes[Attr.LOCK_WAIT_DURATION_MS]);
        assertExists(failed.attributes[Attr.LOCK_HOLDER]);
        const retry = failed.events.find((e) => e.name === "retry");
        assertExists(retry, "expected a lock_contended retry event");
        assertEquals(retry.attributes?.["retry.reason"], "lock_contended");
      });
    });
  },
});

Deno.test({
  name: "inspect and forceRelease spans",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        const provider = providerFor(mock);
        const lock = provider.createLock("/repo", { ttlMs: 5_000 });
        await lock.acquire();
        const info = await lock.inspect();
        assertExists(info?.nonce);
        assertEquals(await lock.forceRelease(info.nonce), true);

        const inspect = findSpan(spans(), "gitlab-datastore lock inspect");
        assertExists(inspect.attributes[Attr.LOCK_HOLDER]);
        findSpan(spans(), "GitLab getLockInfo");
        findSpan(spans(), "gitlab-datastore lock forceRelease");
        // forceRelease on this object's own lock must stop its heartbeat too,
        // or the interval outlives a lock it no longer holds.
        assertEquals(await lock.inspect(), null);
      });
    });
  },
});

Deno.test({
  name: "withLock span wraps acquire and release as children",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        const lock = providerFor(mock).createLock("/repo", { ttlMs: 5_000 });
        await lock.withLock(() => Promise.resolve("done"));

        const outer = findSpan(spans(), "gitlab-datastore lock withLock");
        const acquire = findSpan(spans(), "gitlab-datastore lock acquire");
        const release = findSpan(spans(), "gitlab-datastore lock release");
        assertEquals(parentIdOf(acquire), outer.spanContext().spanId);
        assertEquals(parentIdOf(release), outer.spanContext().spanId);
      });
    });
  },
});

Deno.test({
  name: "a failing API call marks both the request and the sync span",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const provider = providerFor(mock);
          const svc = provider.createSyncService!("/repo", cachePath);
          const relPath = "data/m/i/a.json";
          await seedFile(cachePath, relPath, "a");
          await svc.pushChanged();

          await withCache(async (other) => {
            const svc2 = provider.createSyncService!("/repo", other);
            mock.failNextStateGet = 500;
            let threw = false;
            try {
              await svc2.hydrateFile!(relPath);
            } catch {
              threw = true;
            }
            assert(threw, "the API failure must propagate");
          });

          // The request span records the 500 and the error; the enclosing
          // hydrateFile span is marked too rather than reporting success.
          const failedRequest = spans()
            .filter((s) => s.name === "GitLab getState")
            .find((s) => s.attributes[Attr.HTTP_RESPONSE_STATUS_CODE] === 500);
          assertExists(failedRequest, "expected a 500 getState span");
          assertEquals(failedRequest.status.code, 2);
          // The status code is the error type for HTTP failures — there is no
          // exception to take a name from, because the client inspects the
          // response rather than throwing.
          assertEquals(failedRequest.attributes[Attr.ERROR_TYPE], "500");

          const hydrate = spans()
            .filter((s) => s.name === "gitlab-datastore hydrateFile")
            .find((s) => s.status.code === 2);
          assertExists(hydrate, "expected hydrateFile to be marked failed");
        });
      });
    });
  },
});

Deno.test({
  name: "expected non-2xx statuses do not mark the span as an error",
  fn: async () => {
    await withSpans(async (spans) => {
      await withMock(async (mock) => {
        await withCache(async (cachePath) => {
          const provider = providerFor(mock);
          const svc = provider.createSyncService!("/repo", cachePath);
          // Absent state: getState returns 404 and hydrateFile returns false.
          assertEquals(await svc.hydrateFile!("data/m/i/absent.json"), false);

          const get = findSpan(spans(), "GitLab getState");
          assertEquals(get.attributes[Attr.HTTP_RESPONSE_STATUS_CODE], 404);
          assertEquals(
            get.status.code,
            0,
            "a 404 is 'no such state', not a failure",
          );
          assertEquals(get.attributes[Attr.ERROR_TYPE], undefined);

          // Contended lock: the 409 from GitLab is normal contention.
          const held = provider.createLock("/repo", { ttlMs: 60_000 });
          await held.acquire();
          try {
            const loser = provider.createLock("/repo", {
              ttlMs: 60_000,
              maxWaitMs: 40,
              retryIntervalMs: 20,
            });
            try {
              await loser.acquire();
            } catch { /* expected timeout */ }
          } finally {
            await held.release();
          }

          const conflicted = spans()
            .filter((s) => s.name === "GitLab lock")
            .find((s) => s.attributes[Attr.HTTP_RESPONSE_STATUS_CODE] === 409);
          assertExists(conflicted, "expected a 409 lock span");
          assertEquals(conflicted.status.code, 0);
          assertEquals(conflicted.attributes[Attr.ERROR_TYPE], undefined);
        });
      });
    });
  },
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

Deno.test({
  name: "operations succeed with no TracerProvider registered",
  fn: async () => {
    // withSpans is deliberately not used here: the global API stays in its
    // default no-op state, which is how the extension runs outside a traced
    // host.
    assertEquals(trace.getActiveSpan(), undefined);
    await withMock(async (mock) => {
      await withCache(async (cachePath) => {
        const provider = providerFor(mock);
        const svc = provider.createSyncService!("/repo", cachePath);
        await seedFile(cachePath, "data/m/i/a.json", "a");
        assertEquals(await svc.pushChanged(), 1);

        const lock = provider.createLock("/repo", { ttlMs: 5_000 });
        await lock.acquire();
        await lock.release();
      });
    });
  },
});
