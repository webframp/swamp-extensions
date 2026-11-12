import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { assertDatastoreExportConformance } from "@swamp-club/swamp-testing";
import { createBlobLock, LOCK_REQUEST_TIMEOUT_MS } from "./lock.ts";
import { BlobClient } from "./rest_client.ts";
import { datastore } from "./mod.ts";
import {
  createMockAzureServer,
  type MockAzureServer,
} from "./_lib/mock_server.ts";

const VALID_CONFIG = {
  auth: {
    mode: "connectionString",
    connectionString: "AccountName=test;AccountKey=c3VwZXJzZWNyZXQ=",
  },
  container: "swamp-datastore",
};

Deno.test("datastore export has required fields", () => {
  assertDatastoreExportConformance(datastore, {
    validConfigs: [VALID_CONFIG],
    invalidConfigs: [
      {},
      {
        auth: { mode: "connectionString", connectionString: "" },
        container: "swamp-datastore",
      },
      { auth: VALID_CONFIG.auth, container: "x" }, // below 3-char minimum
      { auth: VALID_CONFIG.auth, container: "Has-Upper-Case" },
      {
        auth: { mode: "sharedKey", accountName: "acct" },
        container: "swamp-datastore",
      }, // missing accountKey
    ],
  });
  assertEquals(datastore.type, "@webframp/azure-blob-datastore");
  assertExists(datastore.name);
  assertExists(datastore.description);
});

Deno.test("configSchema applies documented defaults", () => {
  const parsed = datastore.configSchema.parse(VALID_CONFIG);
  assertEquals(parsed.prefix, "swamp");
});

Deno.test("configSchema rejects a container name with consecutive hyphens", () => {
  const result = datastore.configSchema.safeParse({
    ...VALID_CONFIG,
    container: "swamp--datastore",
  });
  assertEquals(result.success, false);
});

Deno.test("configSchema accepts all three auth modes", () => {
  const modes = [
    {
      mode: "connectionString",
      connectionString: "AccountName=a;AccountKey=c3VwZXJzZWNyZXQ=",
    },
    {
      mode: "sharedKey",
      accountName: "myaccount",
      accountKey: "c3VwZXJzZWNyZXQ=",
    },
    {
      mode: "servicePrincipal",
      accountName: "myaccount",
      tenantId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      clientSecret: "secret",
    },
  ];
  for (const auth of modes) {
    const result = datastore.configSchema.safeParse({
      auth,
      container: "swamp-datastore",
    });
    assertEquals(result.success, true, JSON.stringify(auth));
  }
});

Deno.test("resolveDatastorePath returns an azblob:// URI", () => {
  const provider = datastore.createProvider(VALID_CONFIG);
  assertEquals(
    provider.resolveDatastorePath("/repo"),
    "azblob://swamp-datastore/swamp",
  );
});

/** Monkey-patches the global fetch to redirect all requests to the mock
 * server, regardless of the (fake) account hostname the client targets —
 * mirrors the DynamoDB extension's prototype.send patching, adapted to fetch. */
function withMockServer<T>(
  fn: (ctx: { mock: MockAzureServer; container: string }) => Promise<T>,
): Promise<T> {
  const mock = createMockAzureServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const rewritten =
      `http://localhost:${mock.port}${url.pathname}${url.search}`;
    return originalFetch(rewritten, input instanceof Request ? input : init);
  }) as typeof fetch;

  return fn({ mock, container: "swamp-datastore" }).finally(() => {
    globalThis.fetch = originalFetch;
    return mock.server.shutdown();
  });
}

Deno.test("lock acquire/inspect/release round-trip", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, container, "swamp", "/test/path", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    const info = await lock.inspect();
    assertExists(info);
    assertExists(info!.nonce);
    await lock.release();
    assertEquals(await lock.inspect(), null);
  });
});

Deno.test("a lock path can be acquired again after release (blob deleted on release)", async () => {
  await withMockServer(async ({ container, mock }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const opts = { ttlMs: 15_000, retryIntervalMs: 50, maxWaitMs: 1_000 };
    const first = createBlobLock(
      client,
      container,
      "swamp",
      "/test/reuse",
      opts,
    );
    await first.acquire();
    await first.release();
    // release() deletes the lock blob so _locks/ does not accumulate orphans.
    assertEquals(mock.blobs.size, 0);
    const second = createBlobLock(
      client,
      container,
      "swamp",
      "/test/reuse",
      opts,
    );
    await second.acquire();
    assertExists(await second.inspect());
    await second.release();
    await second.acquire();
    await second.release();
  });
});

/** Wraps the (already mock-redirected) fetch so `beforeLeaseAcquire` runs
 * ahead of every lease-acquire request, simulating a concurrent release()
 * deleting the lock blob between ensureBlobExists() and the lease request. */
function beforeEachLeaseAcquire(hook: () => void): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (
      url.searchParams.get("comp") === "lease" &&
      headers.get("x-ms-lease-action") === "acquire"
    ) hook();
    return inner(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = inner;
  };
}

Deno.test("acquire re-creates the lock blob when it is deleted before the lease request", async () => {
  await withMockServer(async ({ container, mock }) => {
    let deletions = 0;
    const restore = beforeEachLeaseAcquire(() => {
      if (deletions++ === 0) mock.blobs.clear();
    });
    try {
      const client = BlobClient.fromAuth({
        mode: "sharedKey",
        accountName: "test",
        accountKey: "c3VwZXJzZWNyZXQ=",
        endpointSuffix: "core.windows.net",
      });
      const lock = createBlobLock(client, container, "swamp", "/test/gone", {
        ttlMs: 15_000,
        retryIntervalMs: 50,
        maxWaitMs: 1_000,
      });
      await lock.acquire();
      assertExists(await lock.inspect());
      await lock.release();
    } finally {
      restore();
    }
    assertEquals(deletions, 2, "one 404, then one successful retry");
  });
});

Deno.test("acquire gives up after 5 consecutive blob re-creations", async () => {
  await withMockServer(async ({ container, mock }) => {
    let leaseRequests = 0;
    const restore = beforeEachLeaseAcquire(() => {
      leaseRequests++;
      mock.blobs.clear();
    });
    try {
      const client = BlobClient.fromAuth({
        mode: "sharedKey",
        accountName: "test",
        accountKey: "c3VwZXJzZWNyZXQ=",
        endpointSuffix: "core.windows.net",
      });
      const lock = createBlobLock(client, container, "swamp", "/test/loop", {
        ttlMs: 15_000,
        retryIntervalMs: 50,
        maxWaitMs: 5_000,
      });
      await assertRejects(() => lock.acquire(), Error, "(404)");
    } finally {
      restore();
    }
    assertEquals(leaseRequests, 6, "initial attempt plus 5 re-creations");
  });
});

Deno.test("a lease conflict resets the re-creation budget so patient waiters do not fail early", async () => {
  await withMockServer(async ({ container, mock }) => {
    let n = 0;
    const restore = beforeEachLeaseAcquire(() => {
      n++;
      const key = [...mock.blobs.keys()][0];
      if (n <= 5) {
        mock.blobs.clear(); // five consecutive 404s: budget exhausted
      } else if (n === 6) {
        // Blob exists again; a foreign holder owns the lease -> 409 -> reset.
        mock.blobs.get(key)!.leaseState = "leased";
        mock.blobs.get(key)!.leaseId = "foreign";
      } else if (n === 7) {
        // Handover: foreign holder deletes the blob. Without the reset this
        // would be the 6th 404 and acquire() would throw.
        mock.blobs.clear();
      }
    });
    try {
      const client = BlobClient.fromAuth({
        mode: "sharedKey",
        accountName: "test",
        accountKey: "c3VwZXJzZWNyZXQ=",
        endpointSuffix: "core.windows.net",
      });
      const lock = createBlobLock(client, container, "swamp", "/test/budget", {
        ttlMs: 15_000,
        retryIntervalMs: 20,
        maxWaitMs: 5_000,
      });
      await lock.acquire();
      assertExists(await lock.inspect());
      await lock.release();
    } finally {
      restore();
    }
    assertEquals(n, 8);
  });
});

Deno.test("a waiting holder takes over when the first releases and deletes the lock blob", async () => {
  await withMockServer(async ({ container, mock }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const opts = { ttlMs: 15_000, retryIntervalMs: 20, maxWaitMs: 5_000 };
    const first = createBlobLock(
      client,
      container,
      "swamp",
      "/test/hand",
      opts,
    );
    const second = createBlobLock(
      client,
      container,
      "swamp",
      "/test/hand",
      opts,
    );
    await first.acquire();
    const waiting = second.acquire();
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(mock.blobs.size, 1);
    await first.release();
    await waiting;
    const info = await second.inspect();
    assertExists(info);
    assertEquals(await first.heartbeat(), false);
    await second.release();
    assertEquals(mock.blobs.size, 0);
  });
});

Deno.test("forceRelease with a stale lease ID leaves an unleased blob alone and returns false", async () => {
  await withMockServer(async ({ container, mock }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const opts = { ttlMs: 15_000, retryIntervalMs: 20, maxWaitMs: 1_000 };
    const holder = createBlobLock(
      client,
      container,
      "swamp",
      "/test/stale",
      opts,
    );
    await holder.acquire();
    const nonce = (await holder.inspect())!.nonce!;
    // Lease lapses on Azure's side; the blob stays, unleased.
    const key = [...mock.blobs.keys()][0];
    mock.blobs.get(key)!.leaseState = "available";
    mock.blobs.get(key)!.leaseId = undefined;
    const admin = createBlobLock(
      client,
      container,
      "swamp",
      "/test/stale",
      opts,
    );
    assertEquals(await admin.forceRelease(nonce), false);
    assertEquals(
      mock.blobs.size,
      1,
      "a blob nobody leases must not be deleted",
    );
  });
});

Deno.test("release falls back to a plain lease release when the blob delete is refused", async () => {
  await withMockServer(async ({ container, mock }) => {
    const inner = globalThis.fetch;
    // A SAS token without delete permission answers DELETE with 403.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(
          new Response("AuthorizationFailure", { status: 403 }),
        );
      }
      return inner(input, init);
    }) as typeof fetch;
    try {
      const client = BlobClient.fromAuth({
        mode: "sharedKey",
        accountName: "test",
        accountKey: "c3VwZXJzZWNyZXQ=",
        endpointSuffix: "core.windows.net",
      });
      const opts = { ttlMs: 15_000, retryIntervalMs: 20, maxWaitMs: 300 };
      const first = createBlobLock(
        client,
        container,
        "swamp",
        "/test/nodel",
        opts,
      );
      await first.acquire();
      await first.release();
      assertEquals(mock.blobs.size, 1, "blob stays when delete is refused");
      // The lease must be free: a second holder acquires without waiting.
      const second = createBlobLock(
        client,
        container,
        "swamp",
        "/test/nodel",
        opts,
      );
      await second.acquire();
      await second.release();
    } finally {
      globalThis.fetch = inner;
    }
  });
});

Deno.test("acquire still fails on a 409 that is not BlobAlreadyExists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("<Code>ContainerBeingDeleted</Code>", {
        status: 409,
        headers: { "x-ms-error-code": "ContainerBeingDeleted" },
      }),
    )) as typeof fetch;
  try {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, "swamp-datastore", "swamp", "/test/x", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 500,
    });
    await assertRejects(
      () => lock.acquire(),
      Error,
      "Failed to create lock blob",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("withLock releases even when the callback throws", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, container, "swamp", "/test/withlock", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await assertRejects(
      () => lock.withLock(() => Promise.reject(new Error("boom"))),
      Error,
      "boom",
    );
    assertEquals(await lock.inspect(), null);
  });
});

Deno.test("second acquire times out while the first holder's lease is live", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock1 = createBlobLock(
      client,
      container,
      "swamp",
      "/test/contention",
      {
        ttlMs: 15_000,
        retryIntervalMs: 20,
        maxWaitMs: 500,
      },
    );
    const lock2 = createBlobLock(
      client,
      container,
      "swamp",
      "/test/contention",
      {
        ttlMs: 15_000,
        retryIntervalMs: 20,
        maxWaitMs: 200,
      },
    );
    await lock1.acquire();
    await assertRejects(() => lock2.acquire(), Error, "Lock timeout");
    await lock1.release();
  });
});

Deno.test("forceRelease returns false for the wrong nonce, true for the correct one", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, container, "swamp", "/test/force", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    const info = await lock.inspect();
    assertEquals(await lock.forceRelease("not-the-nonce"), false);
    assertEquals(await lock.forceRelease(info!.nonce!), true);
  });
});

Deno.test("heartbeat renews the lease; fails after release", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, container, "swamp", "/test/heartbeat", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    assertEquals(await lock.heartbeat(), true);
    assertEquals(await lock.heartbeat(), true);
    await lock.release();
    assertEquals(await lock.heartbeat(), false);
  });
});

Deno.test("verifier reports healthy against a reachable container, unhealthy on network error", async () => {
  await withMockServer(async () => {
    const healthy = await datastore.createProvider(VALID_CONFIG)
      .createVerifier()
      .verify();
    assertEquals(healthy.healthy, true);
    assertEquals(healthy.datastoreType, "@webframp/azure-blob-datastore");

    // BlobClient captures `fetch` at construction time (via a default
    // parameter), so the provider must be recreated *after* the override for
    // the new client to pick up the throwing stub.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network unreachable");
    }) as typeof fetch;
    try {
      const unhealthy = await datastore.createProvider(VALID_CONFIG)
        .createVerifier()
        .verify();
      assertEquals(unhealthy.healthy, false);
      // The message must name the failed operation and container, not just
      // repeat the raw fetch error, so an operator can tell which container
      // check failed without re-running with tracing enabled.
      assertStringIncludes(unhealthy.message, "getContainerProperties");
      assertStringIncludes(unhealthy.message, VALID_CONFIG.container);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("acquire() is retryable after a failure in the post-acquire metadata write, and doesn't leave an orphaned lease", async () => {
  await withMockServer(async ({ container }) => {
    // Install the failure-injecting wrapper BEFORE constructing the client —
    // BlobClient captures `fetch` as a default-parameter value at
    // construction time, so a client built earlier would keep using the
    // mock-redirecting fetch and never see this override.
    const mockRedirectFetch = globalThis.fetch;
    let failNext = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (failNext && url.searchParams.get("comp") === "metadata") {
        failNext = false;
        return Promise.reject(new Error("simulated transient network error"));
      }
      return mockRedirectFetch(input, init);
    }) as typeof fetch;

    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(client, container, "swamp", "/test/wedge", {
      ttlMs: 15_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });

    try {
      failNext = true;
      const err = await assertRejects(
        () => lock.acquire(),
        Error,
        "simulated transient network error",
      );
      // The error must also name the operation and blob path that was in
      // flight, not just repeat the raw network error, so an operator can
      // tell which lock's metadata write failed.
      assertStringIncludes((err as Error).message, "setLockMetadata");
      assertStringIncludes((err as Error).message, "wedge");

      // The failed acquire() must not have left this instance wedged...
      await lock.acquire();
      assertExists(await lock.inspect());
      await lock.release();
    } finally {
      globalThis.fetch = mockRedirectFetch;
    }
  });
});

Deno.test("forceRelease on the holding instance clears local state so it can re-acquire", async () => {
  await withMockServer(async ({ container }) => {
    const client = BlobClient.fromAuth({
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    });
    const lock = createBlobLock(
      client,
      container,
      "swamp",
      "/test/self-force",
      {
        ttlMs: 15_000,
        retryIntervalMs: 50,
        maxWaitMs: 1_000,
      },
    );
    await lock.acquire();
    const info = await lock.inspect();
    assertEquals(await lock.forceRelease(info!.nonce!), true);

    // Must be able to re-acquire on the SAME instance without "already acquired".
    await lock.acquire();
    await lock.release();
  });
});

const STALLING_FETCH = ((_u: string | URL | Request, init?: RequestInit) => {
  stalledCalls++;
  return new Promise<Response>((_res, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
    init?.signal?.addEventListener(
      "abort",
      () => reject(init.signal!.reason),
      { once: true },
    );
  });
}) as typeof fetch;
let stalledCalls = 0;

Deno.test("a lock request that times out is wrapped with its operation and path, and is not retried", async () => {
  stalledCalls = 0;
  const client = BlobClient.fromAuth(
    {
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    },
    STALLING_FETCH,
    20,
  );
  const lock = createBlobLock(client, "c", "swamp", "/test/stall", {
    maxWaitMs: 1_000,
  });
  const err = await assertRejects(() => lock.inspect()) as Error;
  assertEquals(stalledCalls, 1);
  assertEquals(err.message.includes("/c/swamp/_locks/"), true);
  assertEquals((err.cause as DOMException).name, "TimeoutError");
});

Deno.test("a caller abort through a lock request is not wrapped", async () => {
  const controllerFetch =
    (() =>
      Promise.reject(new DOMException("stop", "AbortError"))) as typeof fetch;
  const client = BlobClient.fromAuth({
    mode: "sharedKey",
    accountName: "test",
    accountKey: "c3VwZXJzZWNyZXQ=",
    endpointSuffix: "core.windows.net",
  }, controllerFetch);
  const lock = createBlobLock(client, "c", "swamp", "/test/abort");
  const err = await assertRejects(() => lock.inspect());
  assertEquals((err as DOMException).name, "AbortError");
});

Deno.test("acquire() makes a single attempt when its first request times out", async () => {
  stalledCalls = 0;
  const client = BlobClient.fromAuth(
    {
      mode: "sharedKey",
      accountName: "test",
      accountKey: "c3VwZXJzZWNyZXQ=",
      endpointSuffix: "core.windows.net",
    },
    STALLING_FETCH,
    20,
  );
  const lock = createBlobLock(client, "c", "swamp", "/test/acq", {
    maxWaitMs: 1_000,
  });
  const err = await assertRejects(() => lock.acquire()) as Error;
  assertEquals(stalledCalls, 1);
  assertEquals((err.cause as DOMException).name, "TimeoutError");
});

Deno.test("lock requests arm a LOCK_REQUEST_TIMEOUT_MS deadline even on a client with a longer base", async () => {
  const armed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const patched = (fn: () => void, ms?: number) => {
    if (ms !== undefined && ms >= 1_000) armed.push(ms);
    return realSetTimeout(fn, ms);
  };
  globalThis.setTimeout = patched as unknown as typeof setTimeout;
  try {
    const ok = (() =>
      Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    const client = BlobClient.fromAuth(
      {
        mode: "sharedKey",
        accountName: "test",
        accountKey: "c3VwZXJzZWNyZXQ=",
        endpointSuffix: "core.windows.net",
      },
      ok,
      120_000,
    );
    const lock = createBlobLock(client, "c", "swamp", "/test/dl");
    await lock.inspect();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assertEquals(armed.includes(LOCK_REQUEST_TIMEOUT_MS), true);
  assertEquals(armed.includes(120_000), false);
});
