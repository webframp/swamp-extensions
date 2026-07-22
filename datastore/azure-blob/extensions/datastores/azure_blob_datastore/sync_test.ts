import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { BlobClient } from "./rest_client.ts";
import { createSyncService } from "./sync.ts";
import {
  createMockAzureServer,
  type MockAzureServer,
} from "./_lib/mock_server.ts";

const CONTAINER = "swamp-datastore";
const PREFIX = "swamp";

async function withHarness(
  fn: (
    ctx: { client: BlobClient; cachePath: string; mock: MockAzureServer },
  ) => Promise<void>,
): Promise<void> {
  const mock = createMockAzureServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
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

function sync(client: BlobClient, cachePath: string) {
  return createSyncService(client, CONTAINER, PREFIX, cachePath);
}

Deno.test("push then pull round-trips a file", async () => {
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
    const relPath = "data/model/instance/big.json";
    const content = new TextEncoder().encode("x".repeat(2000));

    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(`${cachePath}/${relPath}`, content);
    await svc.markDirty({ relPath });
    const pushed = await svc.pushChanged();
    assertEquals(pushed, 1);

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = sync(client, cachePath2);
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
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
    assertEquals(await svc.pushChanged(), 0);
  });
});

Deno.test("tombstone: deleting a local file and pushing removes it remotely, then pull deletes the local copy elsewhere", async () => {
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
    const relPath = "data/model/instance/gone.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("hi"),
    );
    await svc.markDirty();
    await svc.pushChanged();
    // The pushing client must also pull once to establish its own watermark —
    // tombstone detection is gated on lastPulledAt (see collectDiff).
    await svc.pullChanged();

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = sync(client, cachePath2);
      await svc2.pullChanged();
      assertExists(await Deno.stat(`${cachePath2}/${relPath}`));

      await Deno.remove(`${cachePath}/${relPath}`);
      await svc.markDirty();
      await svc.pushChanged();

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
  await withHarness(async ({ client, cachePath }) => {
    const relPath = "data/model/instance/two-phase.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("two-phase"),
    );

    const svc = sync(client, cachePath);
    await svc.markDirty({ relPath });
    const manifest = await svc.preparePush();
    const changes = await svc.commitPush(manifest);
    assertEquals(changes, 1);

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = sync(client, cachePath2);
      await svc2.pullChanged();
      const bytes = await Deno.readFile(`${cachePath2}/${relPath}`);
      assertEquals(new TextDecoder().decode(bytes), "two-phase");
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("scoped pull via context.models only fetches matching paths", async () => {
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
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
      const svc2 = sync(client, cachePath2);
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
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
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
      const svc2 = sync(client, cachePath2);
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
  await withHarness(({ client, cachePath }): Promise<void> => {
    const svc = sync(client, cachePath);
    assertEquals(svc.capabilities!(), {
      scopedSync: true,
      lazyHydration: true,
      twoPhaseSync: true,
    });
    return Promise.resolve();
  });
});

Deno.test("two files landing in the same shard bucket both survive the read-modify-write index update", async () => {
  await withHarness(async ({ client, cachePath }) => {
    // Brute-force two relPaths whose shard key (first byte of sha256) collides,
    // to actually exercise the shard's read-modify-write merge logic — proves
    // the second updateShard() doesn't clobber the first file's index entry.
    async function shardOf(relPath: string): Promise<string> {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(relPath),
      );
      return Array.from(new Uint8Array(digest).slice(0, 1))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    const pathA = "data/model/instance/candidate-0.json";
    let pathB = "";
    const shardA = await shardOf(pathA);
    for (let i = 1; i < 5000; i++) {
      const candidate = `data/model/instance/candidate-${i}.json`;
      if (await shardOf(candidate) === shardA) {
        pathB = candidate;
        break;
      }
    }
    if (!pathB) {
      // Extremely unlikely with 5000 candidates against 256 shards, but don't
      // fail the suite over a birthday-problem miss — fall back to two paths
      // and just assert both round-trip (weaker, but never flaky).
      pathB = "data/model/instance/candidate-fallback.json";
    }

    const svc = sync(client, cachePath);
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${pathA}`,
      new TextEncoder().encode("A"),
    );
    await Deno.writeFile(
      `${cachePath}/${pathB}`,
      new TextEncoder().encode("B"),
    );
    await svc.markDirty();
    const pushed = await svc.pushChanged();
    assertEquals(pushed, 2);

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = sync(client, cachePath2);
      const pulled = await svc2.pullChanged();
      assertEquals(pulled, 2);
      assertEquals(
        new TextDecoder().decode(await Deno.readFile(`${cachePath2}/${pathA}`)),
        "A",
      );
      assertEquals(
        new TextDecoder().decode(await Deno.readFile(`${cachePath2}/${pathB}`)),
        "B",
      );
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});

Deno.test("metadataOnly pull skips downloading content bytes", async () => {
  await withHarness(async ({ client, cachePath }) => {
    const svc = sync(client, cachePath);
    const relPath = "data/model/instance/lazy-meta.json";
    await Deno.mkdir(`${cachePath}/data/model/instance`, { recursive: true });
    await Deno.writeFile(
      `${cachePath}/${relPath}`,
      new TextEncoder().encode("content"),
    );
    await svc.markDirty({ relPath });
    await svc.pushChanged();

    const cachePath2 = await Deno.makeTempDir();
    try {
      const svc2 = sync(client, cachePath2);
      const pulled = await svc2.pullChanged({ metadataOnly: true });
      // Nothing counted as "changed" — metadataOnly must not download bytes.
      assertEquals(pulled, 0);
      let contentWritten = true;
      try {
        await Deno.stat(`${cachePath2}/${relPath}`);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) contentWritten = false;
        else throw err;
      }
      assertEquals(contentWritten, false);

      // hydrateFile can still fetch it on demand afterward.
      const found = await svc2.hydrateFile!(relPath);
      assertEquals(found, true);
      const bytes = await Deno.readFile(`${cachePath2}/${relPath}`);
      assertEquals(new TextDecoder().decode(bytes), "content");
    } finally {
      await Deno.remove(cachePath2, { recursive: true });
    }
  });
});
