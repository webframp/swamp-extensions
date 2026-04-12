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

Deno.test("resolveDatastorePath returns cache path", () => {
  const provider = datastore.createProvider({
    projectId: "123",
    token: "glpat-xxxx",
  });

  const path = provider.resolveDatastorePath("/repo");
  assertEquals(path, "/repo/.swamp/gitlab-cache");
});

Deno.test("resolveCachePath returns cache path", () => {
  const provider = datastore.createProvider({
    projectId: "123",
    token: "glpat-xxxx",
  });

  const path = provider.resolveCachePath!("/repo");
  assertEquals(path, "/repo/.swamp/gitlab-cache");
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
