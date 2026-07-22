import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { assertDatastoreExportConformance } from "jsr:@systeminit/swamp-testing@0.20260504.10";
import { DynamoDBClient } from "npm:@aws-sdk/client-dynamodb@3.1091.0";
import { DynamoDBDocumentClient } from "npm:@aws-sdk/lib-dynamodb@3.1091.0";
import { datastore } from "./mod.ts";
import { FakeDynamoTable, installFakeDynamo } from "./_lib/fake_dynamo.ts";

const VALID_CONFIG = { tableName: "swamp-test-table", region: "us-east-1" };

Deno.test("datastore export has required fields", () => {
  assertDatastoreExportConformance(datastore, {
    validConfigs: [VALID_CONFIG, {}],
    invalidConfigs: [
      { tableName: "x" }, // below the 3-char minimum
      { tableName: "has spaces" },
      { endpoint: "not-a-url" },
    ],
  });
  assertEquals(datastore.type, "@webframp/dynamodb-datastore");
  assertExists(datastore.name);
  assertExists(datastore.description);
});

Deno.test("configSchema applies documented defaults", () => {
  const parsed = datastore.configSchema.parse({});
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.tableName, "swamp-datastore");
  assertEquals(parsed.autoCreateTable, false);
  assertEquals(parsed.maxChunkBytes, 256 * 1024);
});

Deno.test("configSchema rejects maxChunkBytes above the 300KB ceiling", () => {
  const result = datastore.configSchema.safeParse({
    ...VALID_CONFIG,
    maxChunkBytes: 400 * 1024,
  });
  assertEquals(result.success, false);
});

Deno.test("configSchema rejects a non-http(s) endpoint", () => {
  const result = datastore.configSchema.safeParse({
    ...VALID_CONFIG,
    endpoint: "ftp://localhost:8000",
  });
  assertEquals(result.success, false);
});

function withFakeDynamo<T>(
  fn: (table: FakeDynamoTable) => Promise<T>,
): Promise<T> {
  const table = new FakeDynamoTable();
  const restore = installFakeDynamo(
    DynamoDBDocumentClient,
    DynamoDBClient,
    table,
  );
  return fn(table).finally(restore);
}

Deno.test("lock acquire/inspect/release round-trip", async () => {
  await withFakeDynamo(async () => {
    const provider = datastore.createProvider(VALID_CONFIG);
    const lock = provider.createLock("/test/path", {
      ttlMs: 5_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    const info = await lock.inspect();
    assertExists(info);
    assertExists(info!.nonce);
    await lock.release();
    const afterRelease = await lock.inspect();
    assertEquals(afterRelease, null);
  });
});

Deno.test("withLock releases even when the callback throws", async () => {
  await withFakeDynamo(async () => {
    const provider = datastore.createProvider(VALID_CONFIG);
    const lock = provider.createLock("/test/withlock", {
      ttlMs: 5_000,
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

Deno.test("second acquire times out while the first holder's lock is live", async () => {
  await withFakeDynamo(async () => {
    const provider = datastore.createProvider(VALID_CONFIG);
    const lock1 = provider.createLock("/test/contention", {
      ttlMs: 10_000,
      retryIntervalMs: 20,
      maxWaitMs: 500,
    });
    const lock2 = provider.createLock("/test/contention", {
      ttlMs: 10_000,
      retryIntervalMs: 20,
      maxWaitMs: 200,
    });
    await lock1.acquire();
    await assertRejects(() => lock2.acquire(), Error, "Lock timeout");
    await lock1.release();
  });
});

Deno.test("acquire succeeds over an expired (stale) lock without waiting for TTL sweep", async () => {
  await withFakeDynamo(async (table) => {
    const provider = datastore.createProvider(VALID_CONFIG);
    // Hand-insert an already-expired lock item — simulates a crashed holder;
    // acquire() must succeed via the client-computed staleness check, not TTL.
    table.items.set("LOCK#/test/stale LOCK", {
      pk: "LOCK#/test/stale",
      sk: "LOCK",
      holder: "dead@host",
      hostname: "host",
      pid: 1,
      acquiredAt: new Date(0).toISOString(),
      acquiredAtMs: 0,
      ttlMs: 1_000,
      expiresAtMs: 1_000, // long past
      nonce: "dead-nonce",
      ttl: 1,
    });

    const lock = provider.createLock("/test/stale", {
      ttlMs: 5_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    const info = await lock.inspect();
    assertExists(info);
    assertEquals(info!.holder !== "dead@host", true);
    await lock.release();
  });
});

Deno.test("heartbeat fails after forceRelease invalidates the nonce", async () => {
  await withFakeDynamo(async () => {
    const provider = datastore.createProvider(VALID_CONFIG);
    const lock = provider.createLock("/test/force", {
      ttlMs: 5_000,
      retryIntervalMs: 50,
      maxWaitMs: 1_000,
    });
    await lock.acquire();
    const info = await lock.inspect();
    const wrongResult = await lock.forceRelease("not-the-nonce");
    assertEquals(wrongResult, false);
    const correctResult = await lock.forceRelease(info!.nonce!);
    assertEquals(correctResult, true);
    assertEquals(await lock.heartbeat(), false);
  });
});

Deno.test("verifier reports healthy against an active table", async () => {
  await withFakeDynamo(async () => {
    const provider = datastore.createProvider(VALID_CONFIG);
    const result = await provider.createVerifier().verify();
    assertEquals(result.healthy, true);
    assertEquals(result.datastoreType, "@webframp/dynamodb-datastore");
  });
});

Deno.test("verifier reports unhealthy when the table is missing", async () => {
  await withFakeDynamo(async (table) => {
    table.tableStatus = "MISSING";
    const provider = datastore.createProvider(VALID_CONFIG);
    const result = await provider.createVerifier().verify();
    assertEquals(result.healthy, false);
  });
});

Deno.test("resolveDatastorePath returns a dynamodb:// URI", async () => {
  await withFakeDynamo((): Promise<void> => {
    const provider = datastore.createProvider(VALID_CONFIG);
    assertEquals(
      provider.resolveDatastorePath("/repo"),
      "dynamodb://swamp-test-table",
    );
    return Promise.resolve();
  });
});
