import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { assertDatastoreExportConformance } from "jsr:@systeminit/swamp-testing@0.20260504.10";
import { createBlobLock } from "./lock.ts";
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
      await assertRejects(
        () => lock.acquire(),
        Error,
        "simulated transient network error",
      );

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
