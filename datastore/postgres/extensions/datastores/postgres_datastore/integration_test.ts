// ABOUTME: Integration tests for postgres-datastore against a real Aurora Serverless v2
// ABOUTME: instance. Requires POSTGRES_TEST_URL env var. Tests concurrency and transactions.

import { assertEquals, assertRejects } from "@std/assert";
import postgres from "npm:postgres@3.4.7";
import { createSyncService } from "./sync.ts";
import { datastore } from "./mod.ts";

const TEST_URL = Deno.env.get("POSTGRES_TEST_URL");

function skipUnlessIntegration(): void {
  if (!TEST_URL) {
    throw new Deno.errors.NotSupported(
      "Skipped: POSTGRES_TEST_URL not set",
    );
  }
}

function testSchema(): string {
  return `swamp_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function setupSchema(
  sql: postgres.Sql,
  schema: string,
): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`
    CREATE TABLE ${schema}.files (
      path       TEXT PRIMARY KEY,
      hash       TEXT NOT NULL,
      size       BIGINT NOT NULL,
      content    BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ
    )
  `);
  await sql.unsafe(`
    CREATE INDEX idx_${schema}_files_updated_at
    ON ${schema}.files (updated_at)
  `);
  await sql.unsafe(`
    CREATE TABLE ${schema}.sync_state (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    CREATE TABLE ${schema}.locks (
      key         TEXT PRIMARY KEY,
      holder      TEXT NOT NULL,
      hostname    TEXT NOT NULL,
      pid         INTEGER NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ttl_ms      INTEGER NOT NULL,
      nonce       TEXT NOT NULL
    )
  `);
}

async function teardownSchema(
  sql: postgres.Sql,
  schema: string,
): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

Deno.test({
  name: "integration: sync push and pull round-trip",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cacheA = await Deno.makeTempDir();
    const cacheB = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const syncA = createSyncService(sql, filesTable, cacheA);
      const syncB = createSyncService(sql, filesTable, cacheB);

      // User A writes a file and pushes
      await Deno.mkdir(`${cacheA}/data/test-model/m1`, { recursive: true });
      await Deno.writeTextFile(
        `${cacheA}/data/test-model/m1/raw`,
        "hello from A",
      );
      await syncA.markDirty({ relPath: "data/test-model/m1/raw" });
      const pushed = await syncA.pushChanged();
      assertEquals(pushed, 1);

      // User B pulls and sees A's file
      const pulled = await syncB.pullChanged();
      assertEquals(pulled, 1);
      const content = await Deno.readTextFile(
        `${cacheB}/data/test-model/m1/raw`,
      );
      assertEquals(content, "hello from A");
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cacheA, { recursive: true });
      await Deno.remove(cacheB, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: push is atomic — all-or-nothing",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cache = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const sync = createSyncService(sql, filesTable, cache);

      // Write multiple files
      for (let i = 0; i < 5; i++) {
        await Deno.mkdir(`${cache}/data/model/item${i}`, { recursive: true });
        await Deno.writeTextFile(
          `${cache}/data/model/item${i}/raw`,
          `content-${i}`,
        );
      }
      await sync.markDirty();
      const pushed = await sync.pushChanged();
      assertEquals(pushed, 5);

      // Verify all 5 are in the DB
      const [countRow] = await sql.unsafe(
        `SELECT count(*) as c FROM ${filesTable} WHERE deleted_at IS NULL`,
      );
      assertEquals(Number(countRow.c), 5);

      // Verify sync_state watermark was updated
      const [stateRow] = await sql.unsafe(
        `SELECT value FROM ${schema}.sync_state WHERE key = 'last_pushed_at'`,
      );
      assertEquals(stateRow !== undefined, true);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cache, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: concurrent pushes from two users don't lose data",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cacheA = await Deno.makeTempDir();
    const cacheB = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const syncA = createSyncService(sql, filesTable, cacheA);
      const syncB = createSyncService(sql, filesTable, cacheB);

      // Both users write different files
      await Deno.mkdir(`${cacheA}/data/modelA/item`, { recursive: true });
      await Deno.writeTextFile(`${cacheA}/data/modelA/item/raw`, "from-A");
      await syncA.markDirty({ relPath: "data/modelA/item/raw" });

      await Deno.mkdir(`${cacheB}/data/modelB/item`, { recursive: true });
      await Deno.writeTextFile(`${cacheB}/data/modelB/item/raw`, "from-B");
      await syncB.markDirty({ relPath: "data/modelB/item/raw" });

      // Push concurrently
      const [resultA, resultB] = await Promise.all([
        syncA.pushChanged(),
        syncB.pushChanged(),
      ]);

      assertEquals(resultA, 1);
      assertEquals(resultB, 1);

      // Both files should exist in the DB
      const rows = await sql.unsafe(
        `SELECT path FROM ${filesTable} WHERE deleted_at IS NULL ORDER BY path`,
      );
      assertEquals(rows.length, 2);
      assertEquals(rows[0].path, "data/modelA/item/raw");
      assertEquals(rows[1].path, "data/modelB/item/raw");
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cacheA, { recursive: true });
      await Deno.remove(cacheB, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: concurrent push of same file — last writer wins",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cacheA = await Deno.makeTempDir();
    const cacheB = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const syncA = createSyncService(sql, filesTable, cacheA);
      const syncB = createSyncService(sql, filesTable, cacheB);

      // Both write to the same path
      await Deno.mkdir(`${cacheA}/data/shared/item`, { recursive: true });
      await Deno.writeTextFile(`${cacheA}/data/shared/item/raw`, "version-A");
      await syncA.markDirty({ relPath: "data/shared/item/raw" });

      await Deno.mkdir(`${cacheB}/data/shared/item`, { recursive: true });
      await Deno.writeTextFile(`${cacheB}/data/shared/item/raw`, "version-B");
      await syncB.markDirty({ relPath: "data/shared/item/raw" });

      // Push concurrently — both should succeed (ON CONFLICT handles it)
      await Promise.all([
        syncA.pushChanged(),
        syncB.pushChanged(),
      ]);

      // Should have exactly one row (not duplicate)
      const [countRow] = await sql.unsafe(
        `SELECT count(*) as c FROM ${filesTable} WHERE path = 'data/shared/item/raw' AND deleted_at IS NULL`,
      );
      assertEquals(Number(countRow.c), 1);

      // Content is one of the two versions (last writer wins)
      const [row] = await sql.unsafe(
        `SELECT content FROM ${filesTable} WHERE path = 'data/shared/item/raw'`,
      );
      const content = new TextDecoder().decode(row.content as Uint8Array);
      assertEquals(
        content === "version-A" || content === "version-B",
        true,
        `Unexpected content: ${content}`,
      );
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cacheA, { recursive: true });
      await Deno.remove(cacheB, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: lock acquire and release",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });

    try {
      await setupSchema(sql, schema);
      const provider = datastore.createProvider({
        connectionString: TEST_URL!,
        schema,
        ssl: "require",
      });

      const lock = provider.createLock("test/path", {
        ttlMs: 5000,
        maxWaitMs: 3000,
      });

      // Acquire should succeed
      await lock.acquire();
      const info = await lock.inspect();
      assertEquals(info !== null, true);
      assertEquals(info!.ttlMs, 5000);

      // Release should succeed
      await lock.release();
      const after = await lock.inspect();
      assertEquals(after, null);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: lock contention — second acquire waits then times out",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });

    try {
      await setupSchema(sql, schema);
      const provider = datastore.createProvider({
        connectionString: TEST_URL!,
        schema,
        ssl: "require",
      });

      const lockA = provider.createLock("contended/key", {
        ttlMs: 10000,
        maxWaitMs: 2000,
        retryIntervalMs: 200,
      });
      const lockB = provider.createLock("contended/key", {
        ttlMs: 10000,
        maxWaitMs: 2000,
        retryIntervalMs: 200,
      });

      // A acquires
      await lockA.acquire();

      // B should timeout trying to acquire
      await assertRejects(
        () => lockB.acquire(),
        Error,
        "Lock timeout",
      );

      // After A releases, a new lock should succeed
      await lockA.release();
      const lockC = provider.createLock("contended/key", {
        ttlMs: 5000,
        maxWaitMs: 2000,
      });
      await lockC.acquire();
      await lockC.release();
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: lock abort signal cancels acquisition",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });

    try {
      await setupSchema(sql, schema);
      const provider = datastore.createProvider({
        connectionString: TEST_URL!,
        schema,
        ssl: "require",
      });

      // First lock holds
      const lockA = provider.createLock("abort/key", {
        ttlMs: 30000,
        maxWaitMs: 30000,
      });
      await lockA.acquire();

      // Second lock tries with abort signal
      const controller = new AbortController();
      const lockB = provider.createLock("abort/key", {
        ttlMs: 30000,
        maxWaitMs: 30000,
        retryIntervalMs: 500,
        signal: controller.signal,
      });

      // Abort after 500ms
      setTimeout(() => controller.abort(), 500);

      await assertRejects(
        () => lockB.acquire(),
        DOMException,
      );

      await lockA.release();
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: tombstone — delete propagates to other users",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cacheA = await Deno.makeTempDir();
    const cacheB = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const syncA = createSyncService(sql, filesTable, cacheA);
      const syncB = createSyncService(sql, filesTable, cacheB);

      // User A pushes a file
      await Deno.mkdir(`${cacheA}/data/model/item`, { recursive: true });
      await Deno.writeTextFile(`${cacheA}/data/model/item/raw`, "exists");
      await syncA.markDirty({ relPath: "data/model/item/raw" });
      await syncA.pushChanged();

      // User A pulls to establish lastPulledAt watermark (required for tombstoning)
      await syncA.pullChanged();

      // User B pulls — file exists
      await syncB.pullChanged();
      const exists = await Deno.stat(`${cacheB}/data/model/item/raw`).then(
        () => true,
        () => false,
      );
      assertEquals(exists, true);

      // User A deletes the file locally and pushes — tombstone is generated
      // because the file exists in remote, not locally, and updatedAt <= watermark
      await Deno.remove(`${cacheA}/data/model/item/raw`);
      await syncA.markDirty({ relPath: "data/model/item" });
      await syncA.pushChanged();

      // Verify tombstone in DB
      const [row] = await sql.unsafe(
        `SELECT deleted_at FROM ${filesTable} WHERE path = 'data/model/item/raw'`,
      );
      assertEquals(row.deleted_at !== null, true);

      // User B pulls — file should be deleted
      await syncB.pullChanged();
      const gone = await Deno.stat(`${cacheB}/data/model/item/raw`).then(
        () => false,
        () => true,
      );
      assertEquals(gone, true);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cacheA, { recursive: true });
      await Deno.remove(cacheB, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: hydrateFile fetches single file on demand",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cacheA = await Deno.makeTempDir();
    const cacheB = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const syncA = createSyncService(sql, filesTable, cacheA);
      const syncB = createSyncService(sql, filesTable, cacheB);

      // User A pushes a file
      await Deno.mkdir(`${cacheA}/data/model/item`, { recursive: true });
      await Deno.writeTextFile(
        `${cacheA}/data/model/item/raw`,
        "hydrate-me",
      );
      await syncA.markDirty({ relPath: "data/model/item/raw" });
      await syncA.pushChanged();

      // User B hydrates just that file (without full pull)
      const hydrated = await syncB.hydrateFile!("data/model/item/raw");
      assertEquals(hydrated, true);

      const content = await Deno.readTextFile(
        `${cacheB}/data/model/item/raw`,
      );
      assertEquals(content, "hydrate-me");

      // Hydrate non-existent path returns false
      const missing = await syncB.hydrateFile!("data/nope/missing/raw");
      assertEquals(missing, false);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cacheA, { recursive: true });
      await Deno.remove(cacheB, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: large batch push (50 files) in single transaction",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cache = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const sync = createSyncService(sql, filesTable, cache);

      // Write 50 files
      for (let i = 0; i < 50; i++) {
        await Deno.mkdir(`${cache}/data/batch/item${i}`, { recursive: true });
        await Deno.writeTextFile(
          `${cache}/data/batch/item${i}/raw`,
          `batch-content-${i}-${"x".repeat(100)}`,
        );
      }
      await sync.markDirty();
      const pushed = await sync.pushChanged();
      assertEquals(pushed, 50);

      // Verify all persisted
      const [countRow] = await sql.unsafe(
        `SELECT count(*) as c FROM ${filesTable} WHERE deleted_at IS NULL`,
      );
      assertEquals(Number(countRow.c), 50);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cache, { recursive: true });
    }
  },
});

Deno.test({
  name: "integration: verifier reports healthy on real connection",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });

    try {
      await setupSchema(sql, schema);
      const provider = datastore.createProvider({
        connectionString: TEST_URL!,
        schema,
        ssl: "require",
      });

      const result = await provider.createVerifier().verify();
      assertEquals(result.healthy, true);
      assertEquals(result.message, "OK");
      assertEquals(result.datastoreType, "@webframp/postgres-datastore");
      assertEquals(typeof result.latencyMs, "number");
      assertEquals(result.details?.schema, schema);
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: lock heartbeat renews TTL under contention",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });

    try {
      await setupSchema(sql, schema);
      const provider = datastore.createProvider({
        connectionString: TEST_URL!,
        schema,
        ssl: "require",
      });

      // Short TTL so heartbeat must fire to keep the lock alive
      const lockA = provider.createLock("heartbeat/key", {
        ttlMs: 2000,
        maxWaitMs: 10000,
      });
      await lockA.acquire();

      // Wait longer than TTL — heartbeat should have renewed it
      await new Promise((r) => setTimeout(r, 3000));

      // Lock should still be held (not expired)
      const info = await lockA.inspect();
      assertEquals(info !== null, true);

      // Another lock trying to acquire should fail (lock is still held)
      const lockB = provider.createLock("heartbeat/key", {
        ttlMs: 2000,
        maxWaitMs: 1000,
        retryIntervalMs: 200,
      });
      await assertRejects(
        () => lockB.acquire(),
        Error,
        "Lock timeout",
      );

      await lockA.release();
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: push failure preserves dirty state for retry",
  ignore: !TEST_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    skipUnlessIntegration();
    const schema = testSchema();
    const sql = postgres(TEST_URL!, { ssl: "require" });
    const cache = await Deno.makeTempDir();

    try {
      await setupSchema(sql, schema);
      const filesTable = `${schema}.files`;
      const sync = createSyncService(sql, filesTable, cache);

      // Do an initial no-op push to set schemaEnsured = true in the closure
      await sync.pushChanged();

      // Write a file and mark dirty
      await Deno.mkdir(`${cache}/data/model/item`, { recursive: true });
      await Deno.writeTextFile(`${cache}/data/model/item/raw`, "test-content");
      await sync.markDirty({ relPath: "data/model/item/raw" });

      // Rename the files table so queries against it fail (schemaEnsured
      // is already true so ensureSchema won't recreate it)
      await sql.unsafe(`ALTER TABLE ${filesTable} RENAME TO files_broken`);

      // Push should fail
      let pushFailed = false;
      try {
        await sync.pushChanged();
      } catch {
        pushFailed = true;
      }
      assertEquals(pushFailed, true);

      // Restore table and retry — dirty state should still be intact
      await sql.unsafe(
        `ALTER TABLE ${schema}.files_broken RENAME TO files`,
      );

      // Retry push — should succeed because dirty state was preserved
      const pushed = await sync.pushChanged();
      assertEquals(pushed, 1);

      // Verify file is in DB
      const [row] = await sql.unsafe(
        `SELECT path FROM ${filesTable} WHERE path = 'data/model/item/raw' AND deleted_at IS NULL`,
      );
      assertEquals(row.path, "data/model/item/raw");
    } finally {
      await teardownSchema(sql, schema);
      await sql.end();
      await Deno.remove(cache, { recursive: true });
    }
  },
});
