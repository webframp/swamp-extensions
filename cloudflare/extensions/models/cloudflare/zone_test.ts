// Cloudflare Zone Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./zone.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("zone model: has correct type", () => {
  assertEquals(model.type, "@webframp/cloudflare/zone");
});

Deno.test("zone model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("zone model: has globalArguments with apiToken", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.apiToken);
});

Deno.test("zone model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.zones);
  assertExists(model.resources.zone);
  assertExists(model.resources.settings);
});

Deno.test("zone model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.list);
  assertExists(model.methods.get);
  assertExists(model.methods.get_settings);
  assertExists(model.methods.update_setting);
  assertExists(model.methods.pause);
  assertExists(model.methods.unpause);
});

Deno.test("zone model: list method has correct arguments schema", () => {
  const listArgs = model.methods.list.arguments;
  assertExists(listArgs);
  const shape = listArgs.shape;
  assertExists(shape.status);
});

Deno.test("zone model: get method has correct arguments schema", () => {
  const getArgs = model.methods.get.arguments;
  assertExists(getArgs);
  const shape = getArgs.shape;
  assertExists(shape.zoneId);
});

// ---------------------------------------------------------------------------
// Mock Cloudflare API Server
// ---------------------------------------------------------------------------

function startMockCfServer(
  responses: Record<string, unknown>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Match against expected paths
    for (const [pattern, result] of Object.entries(responses)) {
      if (path.includes(pattern)) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result,
          result_info: Array.isArray(result)
            ? {
              page: 1,
              per_page: 50,
              total_count: (result as unknown[]).length,
              total_pages: 1,
            }
            : undefined,
        });
      }
    }

    return Response.json({
      success: false,
      errors: [{ code: 404, message: "Not found" }],
      messages: [],
      result: null,
    });
  });

  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

/** Install fetch mock that redirects Cloudflare API calls to local server */
function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string" ? input : input.toString();
    const newUrl = reqUrl.replace(
      "https://api.cloudflare.com/client/v4",
      mockUrl,
    );
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "zone model: list method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockZones = [
      {
        id: "zone-123",
        name: "example.com",
        status: "active",
        paused: false,
        type: "full",
        development_mode: 0,
        name_servers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
        account: { id: "acct-1", name: "Test Account" },
        created_on: "2024-01-01T00:00:00Z",
        modified_on: "2024-01-02T00:00:00Z",
      },
    ];

    const { url, server } = startMockCfServer({
      "/zones": mockZones,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token" },
        definition: { id: "test-id", name: "test-zone", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.list.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list.execute>[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "zones");
      assertEquals(resources[0].name, "main");

      const data = resources[0].data as { zones: typeof mockZones };
      assertEquals(data.zones.length, 1);
      assertEquals(data.zones[0].name, "example.com");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "zone model: get method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockZone = {
      id: "zone-456",
      name: "test.com",
      status: "active",
      paused: false,
      type: "full",
      development_mode: 0,
      name_servers: ["ns1.cloudflare.com"],
      account: { id: "acct-1", name: "Test Account" },
      created_on: "2024-01-01T00:00:00Z",
      modified_on: "2024-01-02T00:00:00Z",
    };

    const { url, server } = startMockCfServer({
      "/zones/zone-456": mockZone,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token" },
        definition: { id: "test-id", name: "test-zone", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.get.execute(
        { zoneId: "zone-456" },
        context as unknown as Parameters<typeof model.methods.get.execute>[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "zone");
      assertEquals(resources[0].name, "zone-456");

      const data = resources[0].data as typeof mockZone;
      assertEquals(data.name, "test.com");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "zone model: pause method sets paused to true",
  sanitizeResources: false,
  fn: async () => {
    const mockZone = {
      id: "zone-789",
      name: "pause-test.com",
      status: "active",
      paused: true,
      type: "full",
      development_mode: 0,
      name_servers: ["ns1.cloudflare.com"],
      account: { id: "acct-1", name: "Test Account" },
      created_on: "2024-01-01T00:00:00Z",
      modified_on: "2024-01-02T00:00:00Z",
    };

    const { url, server } = startMockCfServer({
      "/zones/zone-789": mockZone,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token" },
        definition: { id: "test-id", name: "test-zone", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.pause.execute(
        { zoneId: "zone-789" },
        context as unknown as Parameters<typeof model.methods.pause.execute>[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as typeof mockZone;
      assertEquals(data.paused, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "zone model: get_settings method fetches settings",
  sanitizeResources: false,
  fn: async () => {
    const mockZone = { name: "settings-test.com" };
    const mockSettings = [
      { id: "ssl", value: "full" },
      { id: "cache_level", value: "aggressive" },
    ];

    const { url, server } = startMockCfServer({
      "/zones/zone-set/settings": mockSettings,
      "/zones/zone-set": mockZone,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token" },
        definition: { id: "test-id", name: "test-zone", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.get_settings.execute(
        { zoneId: "zone-set" },
        context as unknown as Parameters<
          typeof model.methods.get_settings.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "settings");

      const data = resources[0].data as {
        settings: Record<string, unknown>;
      };
      assertEquals(data.settings.ssl, "full");
      assertEquals(data.settings.cache_level, "aggressive");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
