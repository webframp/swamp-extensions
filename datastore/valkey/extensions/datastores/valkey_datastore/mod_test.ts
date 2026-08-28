import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { assertDatastoreExportConformance } from "@systeminit/swamp-testing";
import type { Redis } from "npm:ioredis@6.0.0";
import {
  createSyncService,
  createValkeyLock,
  createValkeyVerifier,
  datastore,
} from "./mod.ts";
import { FakeValkey } from "./_lib/fake_valkey.ts";

const TEST_PREFIX = "swamp-test";

/** Build a fresh in-memory Valkey typed as the ioredis client the code expects. */
function fakeRedis(): { fake: FakeValkey; redis: Redis } {
  const fake = new FakeValkey();
  return { fake, redis: fake as unknown as Redis };
}

// ── Export + config contract (hermetic) ─────────────────────────────────────

Deno.test("datastore export conforms to the datastore provider contract", () => {
  assertDatastoreExportConformance(datastore, {
    validConfigs: [
      { url: "redis://localhost:6379" },
      { url: "rediss://host:6379", tls: true },
    ],
    invalidConfigs: [
      {}, // url is required
      { url: "" }, // url must be non-empty
      { url: "redis://localhost", db: 16 }, // db out of range
    ],
  });
  assertEquals(datastore.type, "@webframp/valkey-datastore");
  assertExists(datastore.name);
  assertExists(datastore.description);
});

Deno.test("config schema applies documented defaults", () => {
  const result = datastore.configSchema.parse({
    url: "redis://localhost:6379",
  });
  assertEquals(result.prefix, "swamp");
  assertEquals(result.db, 0);
  assertEquals(result.tls, false);
  assertEquals(result.connectTimeoutMs, 10_000);
  assertEquals(result.maxRetriesPerRequest, 3);
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

Deno.test("createProvider returns the full provider shape", () => {
  const provider = datastore.createProvider({
    url: "redis://localhost:6379",
    prefix: TEST_PREFIX,
  });
  assertEquals(typeof provider.createLock, "function");
  assertEquals(typeof provider.createVerifier, "function");
  assertEquals(typeof provider.createSyncService, "function");
  assertEquals(typeof provider.resolveDatastorePath, "function");
  assertEquals(typeof provider.resolveCachePath, "function");
});

Deno.test("resolveDatastorePath is deterministic", () => {
  const provider = datastore.createProvider({
    url: "redis://localhost:6379",
    prefix: TEST_PREFIX,
  });
  const a = provider.resolveDatastorePath("/repo");
  const b = provider.resolveDatastorePath("/repo");
  assertEquals(a, b);
  assertEquals(a, `valkey://${TEST_PREFIX}`);
});

Deno.test("resolveCachePath returns undefined", () => {
  const provider = datastore.createProvider({
    url: "redis://localhost:6379",
    prefix: TEST_PREFIX,
  });
  assertEquals(provider.resolveCachePath!("/repo"), undefined);
});

// ── Verifier (hermetic via injected fake) ────────────────────────────────────

Deno.test("verifier reports healthy against a responsive backend", async () => {
  const { redis } = fakeRedis();
  const verifier = createValkeyVerifier(redis, TEST_PREFIX, 0);
  const result = await verifier.verify();
  assertEquals(result.healthy, true);
  assertEquals(result.message, "OK");
  assertEquals(result.datastoreType, "@webframp/valkey-datastore");
  assertEquals(typeof result.latencyMs, "number");
  assertEquals(result.details?.prefix, TEST_PREFIX);
  // Lock the INFO-parse contract: the version must be extracted from the
  // `(redis|valkey)_version:` line, not left as "unknown".
  assertEquals(result.details?.version, "7.4.0");
});

Deno.test("verifier reports unhealthy when the backend errors", async () => {
  const fake = new FakeValkey();
  // Simulate a dead connection: PING rejects.
  (fake as unknown as { ping: () => Promise<string> }).ping = () =>
    Promise.reject(new Error("connection refused"));
  const verifier = createValkeyVerifier(
    fake as unknown as Redis,
    "bad",
    0,
  );
  const result = await verifier.verify();
  assertEquals(result.healthy, false);
  assertEquals(result.datastoreType, "@webframp/valkey-datastore");
});

// ── Lock (hermetic via injected fake) ────────────────────────────────────────

Deno.test({
  name: "lock acquire and release",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(redis, TEST_PREFIX, "/test/lock", {
      ttlMs: 5_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();
    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(typeof info!.nonce, "string");
    assertEquals(typeof info!.holder, "string");

    await lock.release();
    assertEquals(await lock.inspect(), null);
  },
});

Deno.test({
  name: "lock withLock releases on success",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(
      redis,
      TEST_PREFIX,
      "/test/withlock-success",
      {
        ttlMs: 5_000,
        maxWaitMs: 5_000,
      },
    );

    const result = await lock.withLock(async () => {
      assertEquals(await lock.inspect() !== null, true);
      return 42;
    });
    assertEquals(result, 42);
    assertEquals(await lock.inspect(), null);
  },
});

Deno.test({
  name: "lock withLock releases on error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(redis, TEST_PREFIX, "/test/withlock-error", {
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

    assertEquals(await lock.inspect(), null);
  },
});

Deno.test({
  name: "lock forceRelease with correct nonce",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(redis, TEST_PREFIX, "/test/force-release", {
      ttlMs: 10_000,
      maxWaitMs: 5_000,
    });

    await lock.acquire();
    const info = await lock.inspect();
    const nonce = info!.nonce!;

    assertEquals(await lock.forceRelease(nonce), true);
    assertEquals(await lock.inspect(), null);
  },
});

Deno.test({
  name: "lock forceRelease with wrong nonce fails",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(
      redis,
      TEST_PREFIX,
      "/test/force-release-wrong",
      { ttlMs: 10_000, maxWaitMs: 5_000 },
    );

    await lock.acquire();

    assertEquals(await lock.forceRelease("wrong-nonce"), false);
    assertEquals(await lock.inspect() !== null, true);

    await lock.release();
  },
});

Deno.test({
  name: "lock release is idempotent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const lock = createValkeyLock(
      redis,
      TEST_PREFIX,
      "/test/release-idempotent",
      { ttlMs: 5_000, maxWaitMs: 5_000 },
    );

    await lock.acquire();
    await lock.release();
    await lock.release(); // second release must not throw
  },
});

Deno.test({
  name: "second acquire is blocked while the lock is held (NX contention)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const held = createValkeyLock(redis, TEST_PREFIX, "/test/contended", {
      ttlMs: 30_000,
      maxWaitMs: 30_000,
    });
    const loser = createValkeyLock(redis, TEST_PREFIX, "/test/contended", {
      ttlMs: 30_000,
      maxWaitMs: 300, // short wait so the test finishes fast
      retryIntervalMs: 100,
    });

    await held.acquire();
    try {
      await assertRejects(() => loser.acquire(), Error, "Lock timeout");
    } finally {
      await held.release();
    }
  },
});

// ── Sync service (hermetic via injected fake) ────────────────────────────────

Deno.test("sync service reports its capabilities", () => {
  const { redis } = fakeRedis();
  const sync = createSyncService(redis, TEST_PREFIX, "/tmp/valkey-cache");
  const caps = sync.capabilities!();
  assertEquals(caps.scopedSync, true);
  assertEquals(caps.lazyHydration, true);
  assertEquals(caps.twoPhaseSync, true);
});

Deno.test({
  name: "pushChanged then pullChanged round-trips a file through the backend",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const dir = await Deno.makeTempDir({ prefix: "valkey-sync-src-" });
    const dest = await Deno.makeTempDir({ prefix: "valkey-sync-dst-" });
    try {
      // Write a file into a datastore subdir and push it.
      await Deno.mkdir(`${dir}/data`, { recursive: true });
      await Deno.writeTextFile(`${dir}/data/hello.txt`, "world");

      const push = createSyncService(redis, TEST_PREFIX, dir);
      await push.markDirty({ relPath: "data/hello.txt" });
      const pushed = await push.pushChanged();
      assertEquals(pushed, 1);

      // A fresh cache pulls the same file back out.
      const pull = createSyncService(redis, TEST_PREFIX, dest);
      const pulled = await pull.pullChanged();
      assertEquals(pulled, 1);
      assertEquals(await Deno.readTextFile(`${dest}/data/hello.txt`), "world");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(dest, { recursive: true });
    }
  },
});

Deno.test({
  name: "pushChanged via full walk (bulkInvalidated) round-trips a file",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { redis } = fakeRedis();
    const dir = await Deno.makeTempDir({ prefix: "valkey-walk-src-" });
    const dest = await Deno.makeTempDir({ prefix: "valkey-walk-dst-" });
    try {
      await Deno.mkdir(`${dir}/data`, { recursive: true });
      await Deno.writeTextFile(`${dir}/data/walk.txt`, "swamp");

      // markDirty() with no relPath sets bulkInvalidated, forcing
      // collectFullWalkDiff — the branch that scans allPaths()/ZRANGEBYSCORE
      // over the full range rather than a single dirty path.
      const push = createSyncService(redis, TEST_PREFIX, dir);
      await push.markDirty();
      assertEquals(await push.pushChanged(), 1);

      const pull = createSyncService(redis, TEST_PREFIX, dest);
      assertEquals(await pull.pullChanged(), 1);
      assertEquals(await Deno.readTextFile(`${dest}/data/walk.txt`), "swamp");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(dest, { recursive: true });
    }
  },
});
