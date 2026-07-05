import { assertEquals, assertRejects } from "@std/assert";
import { datastore } from "./mod.ts";

const VALKEY_URL = Deno.env.get("VALKEY_TEST_URL") ?? "redis://localhost:6380";
const TEST_PREFIX = `swamp-test-${crypto.randomUUID().slice(0, 8)}`;

function testConfig() {
  return {
    url: VALKEY_URL,
    prefix: TEST_PREFIX,
    db: 0,
    connectTimeoutMs: 5_000,
    maxRetriesPerRequest: 1,
  };
}

Deno.test("datastore export shape", () => {
  assertEquals(datastore.type, "@webframp/valkey-datastore");
  assertEquals(typeof datastore.name, "string");
  assertEquals(typeof datastore.description, "string");
  assertEquals(typeof datastore.configSchema, "object");
  assertEquals(typeof datastore.createProvider, "function");
});

Deno.test("config schema accepts valid config", () => {
  const result = datastore.configSchema.safeParse({
    url: "redis://localhost:6379",
  });
  assertEquals(result.success, true);
});

Deno.test("config schema applies defaults", () => {
  const result = datastore.configSchema.parse({
    url: "redis://localhost:6379",
  });
  assertEquals(result.prefix, "swamp");
  assertEquals(result.db, 0);
  assertEquals(result.tls, false);
  assertEquals(result.connectTimeoutMs, 10_000);
  assertEquals(result.maxRetriesPerRequest, 3);
});

Deno.test("config schema rejects empty url", () => {
  const result = datastore.configSchema.safeParse({ url: "" });
  assertEquals(result.success, false);
});

Deno.test("config schema rejects missing url", () => {
  const result = datastore.configSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("config schema rejects invalid db", () => {
  const result = datastore.configSchema.safeParse({
    url: "redis://localhost",
    db: 16,
  });
  assertEquals(result.success, false);
});

Deno.test("config schema accepts TLS variants", () => {
  const boolResult = datastore.configSchema.safeParse({
    url: "rediss://host:6379",
    tls: true,
  });
  assertEquals(boolResult.success, true);

  const objResult = datastore.configSchema.safeParse({
    url: "rediss://host:6379",
    tls: { ca: "/path/to/ca.pem", rejectUnauthorized: true },
  });
  assertEquals(objResult.success, true);
});

Deno.test("createProvider returns provider shape", () => {
  const provider = datastore.createProvider(testConfig());
  assertEquals(typeof provider.createLock, "function");
  assertEquals(typeof provider.createVerifier, "function");
  assertEquals(typeof provider.createSyncService, "function");
  assertEquals(typeof provider.resolveDatastorePath, "function");
  assertEquals(typeof provider.resolveCachePath, "function");
});

Deno.test("resolveDatastorePath is deterministic", () => {
  const provider = datastore.createProvider(testConfig());
  const a = provider.resolveDatastorePath("/repo");
  const b = provider.resolveDatastorePath("/repo");
  assertEquals(a, b);
  assertEquals(a, `valkey://${TEST_PREFIX}`);
});

Deno.test("resolveCachePath returns undefined", () => {
  const provider = datastore.createProvider(testConfig());
  const result = provider.resolveCachePath!("/repo");
  assertEquals(result, undefined);
});

Deno.test({
  name: "verifier reports healthy against live Valkey",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const verifier = provider.createVerifier();
    const result = await verifier.verify();
    assertEquals(result.healthy, true);
    assertEquals(result.message, "OK");
    assertEquals(result.datastoreType, "@webframp/valkey-datastore");
    assertEquals(typeof result.latencyMs, "number");
    assertEquals(result.details?.prefix, TEST_PREFIX);
  },
});

Deno.test({
  name: "verifier reports unhealthy on bad connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider({
      url: "redis://localhost:59999",
      prefix: "bad",
      connectTimeoutMs: 1_000,
      maxRetriesPerRequest: 0,
    });
    const verifier = provider.createVerifier();
    const result = await verifier.verify();
    assertEquals(result.healthy, false);
    assertEquals(result.datastoreType, "@webframp/valkey-datastore");
  },
});

Deno.test({
  name: "lock acquire and release",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/lock", {
      ttlMs: 5_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();
    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(typeof info!.nonce, "string");
    assertEquals(typeof info!.holder, "string");

    await lock.release();
    const afterRelease = await lock.inspect();
    assertEquals(afterRelease, null);
  },
});

Deno.test({
  name: "lock withLock releases on success",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/withlock-success", {
      ttlMs: 5_000,
      maxWaitMs: 5_000,
    });

    const result = await lock.withLock(async () => {
      const held = await lock.inspect();
      assertEquals(held !== null, true);
      return 42;
    });
    assertEquals(result, 42);

    const after = await lock.inspect();
    assertEquals(after, null);
  },
});

Deno.test({
  name: "lock withLock releases on error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/withlock-error", {
      ttlMs: 5_000,
      maxWaitMs: 5_000,
    });

    await assertRejects(
      () =>
        lock.withLock(() => {
          throw new Error("test error");
        }),
      Error,
      "test error",
    );

    const after = await lock.inspect();
    assertEquals(after, null);
  },
});

Deno.test({
  name: "lock forceRelease with correct nonce",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/force-release", {
      ttlMs: 10_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();
    const info = await lock.inspect();
    const nonce = info!.nonce!;

    // Force release with correct nonce
    const released = await lock.forceRelease(nonce);
    assertEquals(released, true);

    const after = await lock.inspect();
    assertEquals(after, null);
  },
});

Deno.test({
  name: "lock forceRelease with wrong nonce fails",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/force-release-wrong", {
      ttlMs: 10_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();

    const released = await lock.forceRelease("wrong-nonce");
    assertEquals(released, false);

    const stillHeld = await lock.inspect();
    assertEquals(stillHeld !== null, true);

    await lock.release();
  },
});

Deno.test({
  name: "lock release is idempotent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider(testConfig());
    const lock = provider.createLock("/test/release-idempotent", {
      ttlMs: 5_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();
    await lock.release();
    await lock.release(); // second release should not throw
  },
});

Deno.test({
  name: "sync service has correct capabilities",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const provider = datastore.createProvider(testConfig());
    const sync = provider.createSyncService!("/repo", "/tmp/cache");
    const caps = sync.capabilities!();
    assertEquals(caps.scopedSync, true);
    assertEquals(caps.lazyHydration, true);
    assertEquals(caps.twoPhaseSync, true);
  },
});
