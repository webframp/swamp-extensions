// GitLab Datastore Extension Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "@std/assert";
import { datastore } from "./mod.ts";

// Helper to wrap content in Terraform state format (matching the implementation)
function wrapInTerraformState(content: string): string {
  const base64Content = btoa(content);
  return JSON.stringify({
    version: 4,
    terraform_version: "1.0.0",
    serial: 1,
    lineage: "5d2f7c99-7164-446d-8b5c-2a59991546cf",
    outputs: {},
    resources: [{
      type: "swamp_data",
      name: "content",
      provider: 'provider["swamp.club/swamp/data"]',
      instances: [{
        attributes: {
          data: base64Content,
        },
      }],
    }],
  });
}

// Helper to extract content from Terraform state format
function unwrapFromTerraformState(stateJson: string): string | null {
  const state = JSON.parse(stateJson);
  const resource = state.resources?.find(
    (r: { type: string }) => r.type === "swamp_data",
  );
  if (!resource?.instances?.[0]?.attributes?.data) {
    return null;
  }
  return atob(resource.instances[0].attributes.data);
}

// Mock GitLab API server for testing
function createMockGitLabServer(): {
  server: Deno.HttpServer;
  port: number;
  states: Map<string, Uint8Array>;
  locks: Map<string, unknown>;
} {
  const states = new Map<string, Uint8Array>();
  const locks = new Map<string, unknown>();

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check - project info
    if (path.match(/\/api\/v4\/projects\/[^/]+$/) && req.method === "GET") {
      return Response.json({ id: 123, name: "test-project" });
    }

    // GraphQL endpoint for listing states
    if (path === "/api/graphql" && req.method === "POST") {
      const stateList = Array.from(states.keys()).map((name) => ({ name }));
      return Response.json({
        data: {
          project: {
            terraformStates: {
              nodes: stateList,
            },
          },
        },
      });
    }

    // List states (REST - kept for compatibility)
    if (
      path.match(/\/api\/v4\/projects\/[^/]+\/terraform\/state$/) &&
      req.method === "GET"
    ) {
      const stateList = Array.from(states.keys()).map((name) => ({ name }));
      return Response.json(stateList);
    }

    // State operations
    const stateMatch = path.match(
      /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)$/,
    );
    if (stateMatch) {
      const stateName = decodeURIComponent(stateMatch[1]);

      if (req.method === "GET") {
        const content = states.get(stateName);
        if (!content) {
          return new Response(null, { status: 404 });
        }
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

    // Lock operations
    const lockMatch = path.match(
      /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)\/lock$/,
    );
    if (lockMatch) {
      const stateName = decodeURIComponent(lockMatch[1]);

      if (req.method === "GET") {
        const lockInfo = locks.get(stateName);
        if (!lockInfo) {
          return new Response(null, { status: 404 });
        }
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
        const existingLock = locks.get(stateName) as
          | { ID: string }
          | undefined;

        if (!existingLock) {
          return new Response(null, { status: 404 });
        }

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

  return { server, port: addr.port, states, locks };
}

Deno.test("datastore export has required fields", () => {
  assertExists(datastore.type);
  assertExists(datastore.name);
  assertExists(datastore.description);
  assertExists(datastore.configSchema);
  assertExists(datastore.createProvider);

  assertEquals(datastore.type, "@webframp/gitlab-datastore");
  assertEquals(datastore.name, "GitLab Datastore");
});

Deno.test("config schema validates required fields", () => {
  // Valid config
  const validConfig = {
    projectId: "123",
    token: "glpat-xxxx",
  };
  const parsed = datastore.configSchema.parse(validConfig);
  assertEquals(parsed.projectId, "123");
  assertEquals(parsed.baseUrl, "https://gitlab.com");
  assertEquals(parsed.statePrefix, "swamp");

  // Invalid - missing projectId
  let threw = false;
  try {
    datastore.configSchema.parse({ token: "glpat-xxxx" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  // Invalid - missing token
  threw = false;
  try {
    datastore.configSchema.parse({ projectId: "123" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("createProvider returns DatastoreProvider", () => {
  const provider = datastore.createProvider({
    projectId: "123",
    token: "glpat-xxxx",
  });

  assertExists(provider.createLock);
  assertExists(provider.createVerifier);
  assertExists(provider.createSyncService);
  assertExists(provider.resolveDatastorePath);
  assertExists(provider.resolveCachePath);
});

Deno.test("resolveDatastorePath returns logical URI", () => {
  const provider = datastore.createProvider({
    projectId: "123",
    token: "glpat-xxxx",
  });

  const path = provider.resolveDatastorePath("/repo");
  assertEquals(path, "gitlab://123/swamp");
});

Deno.test("resolveCachePath returns undefined for XDG standard", () => {
  const provider = datastore.createProvider({
    projectId: "123",
    token: "glpat-xxxx",
  });

  const path = provider.resolveCachePath!("/repo");
  assertEquals(path, undefined);
});

Deno.test({
  name: "verifier reports healthy when API accessible",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const verifier = provider.createVerifier();
      const result = await verifier.verify();

      assertEquals(result.healthy, true);
      assertEquals(result.message, "OK");
      assertEquals(result.datastoreType, "@webframp/gitlab-datastore");
      assertExists(result.latencyMs);
    } finally {
      await mock.server.shutdown();
    }
  },
});

Deno.test({
  name: "lock acquire and release",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const lock = provider.createLock("/test/path", {
        ttlMs: 5000,
        retryIntervalMs: 100,
        maxWaitMs: 1000,
      });

      // Should be able to acquire
      await lock.acquire();

      // Should have lock info
      const info = await lock.inspect();
      assertExists(info);
      assertExists(info!.nonce);

      // Should be able to release
      await lock.release();

      // Should be no lock after release
      const afterRelease = await lock.inspect();
      assertEquals(afterRelease, null);
    } finally {
      await mock.server.shutdown();
    }
  },
});

Deno.test({
  name: "lock withLock executes function",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const lock = provider.createLock("/test/path", {
        ttlMs: 5000,
        retryIntervalMs: 100,
        maxWaitMs: 1000,
      });

      let executed = false;
      const result = await lock.withLock(() => {
        executed = true;
        return Promise.resolve("result");
      });

      assertEquals(executed, true);
      assertEquals(result, "result");

      // Lock should be released
      const info = await lock.inspect();
      assertEquals(info, null);
    } finally {
      await mock.server.shutdown();
    }
  },
});

Deno.test({
  name: "lock forceRelease with correct nonce",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mock = createMockGitLabServer();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const lock = provider.createLock("/test/path", {
        ttlMs: 5000,
        retryIntervalMs: 100,
        maxWaitMs: 1000,
      });

      await lock.acquire();
      const info = await lock.inspect();
      assertExists(info);

      // Force release with correct nonce
      const released = await lock.forceRelease(info!.nonce!);
      assertEquals(released, true);

      // Lock should be gone
      const afterRelease = await lock.inspect();
      assertEquals(afterRelease, null);
    } finally {
      await mock.server.shutdown();
    }
  },
});

Deno.test({
  name: "lock forceRelease with wrong nonce fails",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const lock = provider.createLock("/test/path", {
        ttlMs: 5000,
        retryIntervalMs: 100,
        maxWaitMs: 1000,
      });

      await lock.acquire();

      // Force release with wrong nonce
      const released = await lock.forceRelease("wrong-nonce");
      assertEquals(released, false);

      // Lock should still be held
      const info = await lock.inspect();
      assertExists(info);

      // Clean up
      await lock.release();
    } finally {
      await mock.server.shutdown();
    }
  },
});

Deno.test({
  name: "sync service has markDirty method that does not throw",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      // markDirty must exist and not throw
      await syncService.markDirty();
      await syncService.markDirty({ relPath: "data/test/v1/raw" });
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "sync service pulls states to local cache",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Pre-populate mock with Terraform-state-wrapped data
      const wrappedData = wrapInTerraformState('{"test": "data"}');
      mock.states.set(
        "swamp--data--test.json",
        new TextEncoder().encode(wrappedData),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const count = await syncService.pullChanged();

      assertEquals(count, 1);

      // Verify file was created
      const content = await Deno.readTextFile(`${tempDir}/data/test.json`);
      assertEquals(content, '{"test": "data"}');
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "sync service pushes local files to states",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Create a local file
      await Deno.mkdir(`${tempDir}/models`, { recursive: true });
      await Deno.writeTextFile(
        `${tempDir}/models/test.yaml`,
        "name: test",
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const count = await syncService.pushChanged();

      assertEquals(count, 1);

      // Verify state was created (wrapped in Terraform state format)
      const state = mock.states.get("swamp--models--test.yaml");
      assertExists(state);
      const unwrapped = unwrapFromTerraformState(
        new TextDecoder().decode(state),
      );
      assertEquals(unwrapped, "name: test");
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "sync service advertises scopedSync and lazyHydration capabilities",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const caps = syncService.capabilities!();
      assertEquals(caps.scopedSync, true);
      assertEquals(caps.lazyHydration, true);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "scoped pull only downloads states matching context.models",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Populate mock with states for two different models
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));
      mock.states.set(
        "swamp--data--mytype--model-1--result--1--raw",
        wrap("content-1"),
      );
      mock.states.set(
        "swamp--data--mytype--model-1--result--1--metadata.yaml",
        wrap("version: 1"),
      );
      mock.states.set(
        "swamp--data--mytype--model-2--result--1--raw",
        wrap("content-2"),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // Scoped pull for model-1 only
      const count = await syncService.pullChanged({
        context: { models: [{ modelType: "mytype", modelId: "model-1" }] },
      });

      assertEquals(count, 2); // raw + metadata for model-1
      // model-2 file should NOT exist
      let model2Exists = true;
      try {
        await Deno.stat(`${tempDir}/data/mytype/model-2/result/1/raw`);
      } catch {
        model2Exists = false;
      }
      assertEquals(model2Exists, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "scoped push only uploads files matching context.models",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Create local files for two models
      await Deno.mkdir(`${tempDir}/data/mytype/model-1/result/1`, {
        recursive: true,
      });
      await Deno.writeTextFile(
        `${tempDir}/data/mytype/model-1/result/1/raw`,
        "content-1",
      );
      await Deno.mkdir(`${tempDir}/data/mytype/model-2/result/1`, {
        recursive: true,
      });
      await Deno.writeTextFile(
        `${tempDir}/data/mytype/model-2/result/1/raw`,
        "content-2",
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // Scoped push for model-1 only
      const count = await syncService.pushChanged({
        context: { models: [{ modelType: "mytype", modelId: "model-1" }] },
      });

      assertEquals(count, 1);
      // model-1 state should exist
      assertEquals(
        mock.states.has("swamp--data--mytype--model-1--result--1--raw"),
        true,
      );
      // model-2 state should NOT exist
      assertEquals(
        mock.states.has("swamp--data--mytype--model-2--result--1--raw"),
        false,
      );
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "unscoped pull downloads all states",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));
      mock.states.set("swamp--data--a--b--1--raw", wrap("a"));
      mock.states.set("swamp--data--c--d--1--raw", wrap("b"));

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const count = await syncService.pullChanged();

      assertEquals(count, 2);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "metadataOnly pull skips raw files but creates parent dirs",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));
      mock.states.set(
        "swamp--data--mytype--m1--result--1--raw",
        wrap("big content"),
      );
      mock.states.set(
        "swamp--data--mytype--m1--result--1--metadata.yaml",
        wrap("version: 1"),
      );
      mock.states.set(
        "swamp--data--mytype--m1--result--2--raw",
        wrap("more content"),
      );
      mock.states.set(
        "swamp--outputs--workflow-1.yaml",
        wrap("output: done"),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const count = await syncService.pullChanged({ metadataOnly: true });

      // Should download metadata.yaml + outputs, skip raw files
      assertEquals(count, 2); // metadata.yaml + outputs

      // metadata.yaml should exist
      const meta = await Deno.readTextFile(
        `${tempDir}/data/mytype/m1/result/1/metadata.yaml`,
      );
      assertEquals(meta, "version: 1");

      // raw files should NOT exist
      let rawExists = true;
      try {
        await Deno.stat(`${tempDir}/data/mytype/m1/result/1/raw`);
      } catch {
        rawExists = false;
      }
      assertEquals(rawExists, false);

      // But parent dir for raw should exist (for catalog walker)
      const dirInfo = await Deno.stat(`${tempDir}/data/mytype/m1/result/1`);
      assertEquals(dirInfo.isDirectory, true);

      // Parent dir for version 2 raw should also exist
      const dir2Info = await Deno.stat(`${tempDir}/data/mytype/m1/result/2`);
      assertEquals(dir2Info.isDirectory, true);

      // outputs (outside data/) should be downloaded fully
      const output = await Deno.readTextFile(
        `${tempDir}/outputs/workflow-1.yaml`,
      );
      assertEquals(output, "output: done");
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "metadataOnly pull sets lazyPullActive in sync state",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));
      mock.states.set(
        "swamp--data--t--m--d--1--metadata.yaml",
        wrap("v: 1"),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      await syncService.pullChanged({ metadataOnly: true });

      // Sync state should show lazyPullActive
      const stateJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const state = JSON.parse(stateJson);
      assertEquals(state.lazyPullActive, true);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "full unscoped pull clears lazyPullActive",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Pre-set lazyPullActive
      await Deno.writeTextFile(
        `${tempDir}/.datastore-sync-state.json`,
        JSON.stringify({ lazyPullActive: true }),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      await syncService.pullChanged(); // full unscoped pull

      const stateJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const state = JSON.parse(stateJson);
      assertEquals(state.lazyPullActive, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "hydrateFile downloads single file atomically",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));
      mock.states.set(
        "swamp--data--mytype--m1--result--1--raw",
        wrap("hydrated content"),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const result = await syncService.hydrateFile!(
        "data/mytype/m1/result/1/raw",
      );

      assertEquals(result, true);
      const content = await Deno.readTextFile(
        `${tempDir}/data/mytype/m1/result/1/raw`,
      );
      assertEquals(content, "hydrated content");
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "hydrateFile returns false for non-existent state",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const result = await syncService.hydrateFile!(
        "data/mytype/m1/result/99/raw",
      );

      assertEquals(result, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "push after lazy pull does not tombstone un-hydrated files",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const wrap = (s: string) =>
        new TextEncoder().encode(wrapInTerraformState(s));

      // Remote has raw content for model-1
      mock.states.set(
        "swamp--data--t--model-1--d--1--raw",
        wrap("original"),
      );
      mock.states.set(
        "swamp--data--t--model-1--d--1--metadata.yaml",
        wrap("v: 1"),
      );

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // Lazy pull — raw not downloaded
      await syncService.pullChanged({ metadataOnly: true });

      // Create new local data (simulating a model run)
      await Deno.mkdir(`${tempDir}/data/t/model-1/new/1`, { recursive: true });
      await Deno.writeTextFile(
        `${tempDir}/data/t/model-1/new/1/raw`,
        "new content",
      );

      // Push — should upload new file, NOT delete the original remote raw
      await syncService.pushChanged();

      // Original remote state should still exist
      assertEquals(
        mock.states.has("swamp--data--t--model-1--d--1--raw"),
        true,
      );
      // New state should be uploaded
      assertEquals(
        mock.states.has("swamp--data--t--model-1--new--1--raw"),
        true,
      );
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "markDirty tracks paths in sync state",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      await syncService.markDirty({ relPath: "data/t/m/d/1/raw" });
      await syncService.markDirty({ relPath: "data/t/m/d/2/raw" });

      const stateJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const state = JSON.parse(stateJson);
      assertEquals(state.dirtyPaths.length, 2);
      assertEquals(state.dirtyPaths[0], "data/t/m/d/1/raw");
      assertEquals(state.dirtyPaths[1], "data/t/m/d/2/raw");
      assertEquals(state.dirtyOverflow, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "pushChanged uses dirty paths instead of full walk",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      // Create two files
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "content-1");
      await Deno.mkdir(`${tempDir}/data/t/m/d/2`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/2/raw`, "content-2");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // Mark only one file dirty
      await syncService.markDirty({ relPath: "data/t/m/d/1/raw" });

      const count = await syncService.pushChanged();

      // Only the dirty file should be pushed
      assertEquals(count, 1);
      assertEquals(mock.states.has("swamp--data--t--m--d--1--raw"), true);
      assertEquals(mock.states.has("swamp--data--t--m--d--2--raw"), false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "pushChanged skips unchanged files via hash",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "same content");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // First push — uploads the file
      const count1 = await syncService.pushChanged();
      assertEquals(count1, 1);

      // Clear the remote to detect if second push re-uploads
      mock.states.clear();

      // Second push — same content, should skip via hash
      const count2 = await syncService.pushChanged();
      assertEquals(count2, 0);
      assertEquals(mock.states.size, 0); // nothing re-uploaded
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "pushChanged clears dirty state after success",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "content");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      await syncService.markDirty({ relPath: "data/t/m/d/1/raw" });
      await syncService.pushChanged();

      const stateJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const state = JSON.parse(stateJson);
      assertEquals(state.dirtyPaths.length, 0);
      assertEquals(state.dirtyOverflow, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

// --- Two-phase sync tests ---

Deno.test({
  name: "preparePush uploads nothing to remote",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "local content");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      await syncService.preparePush();

      // Nothing should have been uploaded to the remote
      assertEquals(mock.states.size, 0);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "commitPush uploads manifest entries",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "two-phase content");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);
      const manifest = await syncService.preparePush();

      // Nothing uploaded yet
      assertEquals(mock.states.size, 0);

      const count = await syncService.commitPush(manifest);

      // Now the file should be on the remote
      assertEquals(count, 1);
      assertEquals(mock.states.has("swamp--data--t--m--d--1--raw"), true);

      const uploaded = mock.states.get("swamp--data--t--m--d--1--raw");
      assertExists(uploaded);
      const unwrapped = unwrapFromTerraformState(
        new TextDecoder().decode(uploaded),
      );
      assertEquals(unwrapped, "two-phase content");
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "round-trip parity with pushChanged",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir1 = await Deno.makeTempDir();
    const tempDir2 = await Deno.makeTempDir();

    try {
      // Same files in both temp dirs
      const fileContent = "parity-test-content";
      await Deno.mkdir(`${tempDir1}/models`, { recursive: true });
      await Deno.writeTextFile(`${tempDir1}/models/a.yaml`, fileContent);
      await Deno.mkdir(`${tempDir2}/models`, { recursive: true });
      await Deno.writeTextFile(`${tempDir2}/models/a.yaml`, fileContent);

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      // Two-phase sync
      const syncService1 = provider.createSyncService!(tempDir1, tempDir1);
      const manifest = await syncService1.preparePush();
      const twoPhaseCount = await syncService1.commitPush(manifest);

      // Capture remote state after two-phase
      const twoPhaseState = new Map(mock.states);

      // Clear remote for pushChanged comparison
      mock.states.clear();

      // Single-phase pushChanged
      const syncService2 = provider.createSyncService!(tempDir2, tempDir2);
      const singlePhaseCount = await syncService2.pushChanged();

      // Same count
      assertEquals(twoPhaseCount, singlePhaseCount);

      // Same remote state keys
      const twoPhaseKeys = Array.from(twoPhaseState.keys()).sort();
      const singlePhaseKeys = Array.from(mock.states.keys()).sort();
      assertEquals(twoPhaseKeys, singlePhaseKeys);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir1, { recursive: true });
      await Deno.remove(tempDir2, { recursive: true });
    }
  },
});

Deno.test({
  name: "preparePush returns empty manifest for no changes",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.mkdir(`${tempDir}/data/t/m/d/1`, { recursive: true });
      await Deno.writeTextFile(`${tempDir}/data/t/m/d/1/raw`, "stable content");

      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // First push to establish hashes
      await syncService.pushChanged();

      // preparePush again with same content — should produce empty manifest
      const manifest = await syncService.preparePush();

      // Cast to inspect internals (test-only)
      const internal = manifest as unknown as {
        entries: Array<{ relPath: string }>;
      };
      assertEquals(internal.entries.length, 0);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "commitPush with empty manifest still clears dirty state",
  sanitizeResources: false,
  fn: async () => {
    const mock = createMockGitLabServer();
    const tempDir = await Deno.makeTempDir();

    try {
      const provider = datastore.createProvider({
        projectId: "123",
        token: "test-token",
        baseUrl: `http://localhost:${mock.port}`,
      });

      const syncService = provider.createSyncService!(tempDir, tempDir);

      // Mark a path dirty that doesn't actually exist on disk
      await syncService.markDirty({ relPath: "data/t/m/d/99/raw" });

      // Verify dirty state is set
      const beforeJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const before = JSON.parse(beforeJson);
      assertEquals(before.dirtyPaths.length, 1);

      // preparePush — file doesn't exist so manifest will be empty
      const manifest = await syncService.preparePush();

      // commitPush with empty manifest
      const count = await syncService.commitPush(manifest);
      assertEquals(count, 0);

      // Dirty state should be cleared
      const afterJson = await Deno.readTextFile(
        `${tempDir}/.datastore-sync-state.json`,
      );
      const after = JSON.parse(afterJson);
      assertEquals(after.dirtyPaths.length, 0);
      assertEquals(after.dirtyOverflow, false);
    } finally {
      await mock.server.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
