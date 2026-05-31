// ABOUTME: Unit tests for sidecar dirty tracking, sync service contract,
// ABOUTME: and datastore provider interface conformance.

import { assertEquals, assertExists } from "@std/assert";
import { Sidecar } from "./sidecar.ts";
import { datastore } from "./mod.ts";

Deno.test("sidecar: fresh state has bulkInvalidated true", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    const state = await sidecar.read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, []);
    assertEquals(state.lastPulledAt, null);
    assertEquals(state.lazyPullActive, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: recordDirty with relPath adds to dirtyPaths", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    await sidecar.recordDirty("data/t/m/d/1/raw");
    await sidecar.recordDirty("data/t/m/d/2/raw");
    const state = await sidecar.read();
    assertEquals(state.dirtyPaths.length, 2);
    assertEquals(state.dirtyPaths[0], "data/t/m/d/1/raw");
    assertEquals(state.dirtyPaths[1], "data/t/m/d/2/raw");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: recordDirty without relPath sets bulkInvalidated", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    // Clear the initial bulkInvalidated
    await sidecar.clearDirty();
    let state = await sidecar.read();
    assertEquals(state.bulkInvalidated, false);

    await sidecar.recordDirty(undefined);
    state = await sidecar.read();
    assertEquals(state.bulkInvalidated, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: rejects path traversal in recordDirty", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    await sidecar.recordDirty("../../etc/passwd");
    const state = await sidecar.read();
    // Should not contain the traversal path
    assertEquals(
      state.dirtyPaths.filter((p) => p.includes("..")).length,
      0,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: clearDirty resets paths and bulkInvalidated", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    await sidecar.recordDirty("data/t/m/d/1/raw");
    await sidecar.clearDirty();
    const state = await sidecar.read();
    assertEquals(state.dirtyPaths, []);
    assertEquals(state.bulkInvalidated, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: setLastPulledAt persists watermark", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    await sidecar.setLastPulledAt("2026-05-25T00:00:00.000Z");
    const state = await sidecar.read();
    assertEquals(state.lastPulledAt, "2026-05-25T00:00:00.000Z");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: setLazyPullActive persists flag", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    await sidecar.setLazyPullActive(true);
    let state = await sidecar.read();
    assertEquals(state.lazyPullActive, true);

    await sidecar.setLazyPullActive(false);
    state = await sidecar.read();
    assertEquals(state.lazyPullActive, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: corrupt JSON falls back to bulkInvalidated", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/.datastore-sync-state.json`,
      "not valid json{{{",
    );
    const sidecar = new Sidecar(tempDir);
    const state = await sidecar.read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: filters traversal paths from deserialized state", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/.datastore-sync-state.json`,
      JSON.stringify({
        version: 1,
        dirtyPaths: ["good/path", "../../bad/path", "also/good"],
        bulkInvalidated: false,
        lastPulledAt: null,
        lazyPullActive: false,
      }),
    );
    const sidecar = new Sidecar(tempDir);
    const state = await sidecar.read();
    assertEquals(state.dirtyPaths, ["good/path", "also/good"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sidecar: dirty paths cap triggers bulkInvalidated", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sidecar = new Sidecar(tempDir);
    // Clear initial bulkInvalidated
    await sidecar.clearDirty();

    // Fill to cap
    for (let i = 0; i < 200; i++) {
      await sidecar.recordDirty(`data/t/m/d/${i}/raw`);
    }
    let state = await sidecar.read();
    assertEquals(state.dirtyPaths.length, 200);
    assertEquals(state.bulkInvalidated, false);

    // One more triggers bulk invalidation instead of growing the list
    await sidecar.recordDirty("data/t/m/d/overflow/raw");
    state = await sidecar.read();
    assertEquals(state.bulkInvalidated, true);
    // dirtyPaths stays at 200 (not 201) — the overflow path is not added
    assertEquals(state.dirtyPaths.length, 200);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createProvider includes createSyncService", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://user:pass@localhost:5432/swamp",
    ssl: "disable",
  });

  assertExists(provider.createSyncService);
});

Deno.test("resolveCachePath returns undefined", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://user:pass@localhost:5432/swamp",
    ssl: "disable",
  });

  assertEquals(provider.resolveCachePath!("/repo"), undefined);
});

Deno.test({
  name: "createSyncService returns sync service with all methods",
  sanitizeResources: false,
  fn: () => {
    const provider = datastore.createProvider({
      connectionString: "postgres://user:pass@localhost:5432/swamp",
      ssl: "disable",
    });

    const syncService = provider.createSyncService!("/repo", "/tmp/cache");
    assertExists(syncService.pullChanged);
    assertExists(syncService.pushChanged);
    assertExists(syncService.markDirty);
    assertExists(syncService.capabilities);
    assertExists(syncService.hydrateFile);

    const caps = syncService.capabilities!();
    assertEquals(caps.scopedSync, true);
    assertEquals(caps.lazyHydration, true);
  },
});
