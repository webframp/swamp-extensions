import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { DynamoDBClient } from "npm:@aws-sdk/client-dynamodb@3.1091.0";
import { DynamoDBDocumentClient } from "npm:@aws-sdk/lib-dynamodb@3.1091.0";
import { createSyncService } from "./sync.ts";
import { FakeDynamoTable, installFakeDynamo } from "./_lib/fake_dynamo.ts";

const TABLE_NAME = "swamp-test-table";
const MAX_CHUNK_BYTES = 64; // tiny, so multi-chunk behavior is exercised cheaply

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

Deno.test("push then pull round-trips a file larger than one chunk", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    const relPath = "data/model/instance/big.json";
    const content = new TextEncoder().encode("x".repeat(200)); // > MAX_CHUNK_BYTES

    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(`${cachePath}/${relPath}`, content);
    await svc.markDirty({ relPath });
    const pushed = await svc.pushChanged();
    assertEquals(pushed, 1);

    // Simulate a second checkout pulling into an empty cache.
    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = createSyncService(
        doc,
        TABLE_NAME,
        cachePath2,
        MAX_CHUNK_BYTES,
        () => Promise.resolve(),
      );
      const pulled = await svc2.pullChanged();
      assertEquals(pulled, 1);
      const roundTripped = await Deno.readFile(`${cachePath2}/${relPath}`);
      assertEquals(roundTripped, content);
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("pushChanged is a no-op when nothing is dirty", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    assertEquals(await svc.pushChanged(), 0);
  });
});

Deno.test("tombstone: deleting a local file and pushing removes it remotely, then pull deletes the local copy elsewhere", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    const relPath = "data/model/instance/gone.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("hi"),
    );
    await svc.markDirty();
    await svc.pushChanged();
    // The pushing client must also pull once, to establish its own watermark —
    // tombstone detection is gated on lastPulledAt (see collectDiff), so a client
    // that has never pulled can't safely infer "this path used to exist remotely."
    await svc.pullChanged();

    // Second client pulls it down first, establishing a watermark.
    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = createSyncService(
        doc,
        TABLE_NAME,
        cachePath2,
        MAX_CHUNK_BYTES,
        () => Promise.resolve(),
      );
      await svc2.pullChanged();
      assertExists(await Deno.stat(`${cachePath2}/${relPath}`));

      // Original client deletes the file locally and pushes a bulk-invalidated diff.
      await Deno.remove(`${cachePath}/${relPath}`);
      await svc.markDirty();
      await svc.pushChanged();

      // Second client's next pull must remove its local copy.
      await svc2.pullChanged();
      let removed = false;
      try {
        await Deno.stat(`${cachePath2}/${relPath}`);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) removed = true;
        else throw err;
      }
      assertEquals(removed, true);
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("preparePush/commitPush two-phase produces the same result as pushChanged", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const relPath = "data/model/instance/two-phase.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("two-phase"),
    );

    const svc = sync(doc, cachePath);
    await svc.markDirty({ relPath });
    const manifest = await svc.preparePush();
    const changes = await svc.commitPush(manifest);
    assertEquals(changes, 1);

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = createSyncService(
        doc,
        TABLE_NAME,
        cachePath2,
        MAX_CHUNK_BYTES,
        () => Promise.resolve(),
      );
      await svc2.pullChanged();
      const bytes = await Deno.readFile(`${cachePath2}/${relPath}`);
      assertEquals(new TextDecoder().decode(bytes), "two-phase");
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("scoped pull via context.models only fetches matching paths", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    await Deno.mkdir(`${cachePath}/data/widget/a`, { recursive: true });
    await Deno.mkdir(`${cachePath}/data/widget/b`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/data/widget/a/state.json`,
      new TextEncoder().encode("a"),
    );
    await Deno.writeFile(
      `${cachePath}/data/widget/b/state.json`,
      new TextEncoder().encode("b"),
    );
    await svc.markDirty();
    await svc.pushChanged();

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = createSyncService(
        doc,
        TABLE_NAME,
        cachePath2,
        MAX_CHUNK_BYTES,
        () => Promise.resolve(),
      );
      await svc2.pullChanged({
        context: { models: [{ modelType: "widget", modelId: "a" }] },
      });
      assertExists(await Deno.stat(`${cachePath2}/data/widget/a/state.json`));
      let missingB = false;
      try {
        await Deno.stat(`${cachePath2}/data/widget/b/state.json`);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) missingB = true;
        else throw err;
      }
      assertEquals(missingB, true);
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("hydrateFile fetches a single path on demand", async () => {
  await withHarness(async ({ doc, cachePath }) => {
    const svc = sync(doc, cachePath);
    const relPath = "data/model/instance/lazy.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("lazy"),
    );
    await svc.markDirty({ relPath });
    await svc.pushChanged();

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = createSyncService(
        doc,
        TABLE_NAME,
        cachePath2,
        MAX_CHUNK_BYTES,
        () => Promise.resolve(),
      );
      const found = await svc2.hydrateFile!(relPath);
      assertEquals(found, true);
      const bytes = await Deno.readFile(`${cachePath2}/${relPath}`);
      assertEquals(new TextDecoder().decode(bytes), "lazy");
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("capabilities reports scoped sync, lazy hydration, and two-phase sync", async () => {
  await withHarness(({ doc, cachePath }): Promise<void> => {
    const svc = sync(doc, cachePath);
    assertEquals(svc.capabilities!(), {
      scopedSync: true,
      lazyHydration: true,
      twoPhaseSync: true,
    });
    return Promise.resolve();
  });
});

Deno.test("overwriting a file with fewer chunks cleans up the stale trailing chunks", async () => {
  await withHarness(async ({ doc, cachePath, table }) => {
    const svc = sync(doc, cachePath);
    const relPath = "data/model/instance/shrink.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });

    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("x".repeat(200)),
    );
    await svc.markDirty({ relPath });
    await svc.pushChanged();
    const chunkCountBefore = [...table.items.keys()].filter((k) =>
      k.startsWith(`FILE#${relPath} CHUNK#`)
    ).length;
    assertEquals(chunkCountBefore > 1, true);

    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("short"),
    );
    await svc.markDirty({ relPath });
    await svc.pushChanged();
    const chunkCountAfter = [...table.items.keys()].filter((k) =>
      k.startsWith(`FILE#${relPath} CHUNK#`)
    ).length;
    assertEquals(chunkCountAfter, 1);
  });
});
