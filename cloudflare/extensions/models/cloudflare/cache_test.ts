// Cloudflare Cache Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./cache.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("cache model: has correct type", () => {
  assertEquals(model.type, "@webframp/cloudflare/cache");
});

Deno.test("cache model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("cache model: has globalArguments with apiToken and zoneId", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.apiToken);
  assertExists(shape.zoneId);
});

Deno.test("cache model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.purge);
  assertExists(model.resources.settings);
  assertExists(model.resources.analytics);
});

Deno.test("cache model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.purge_all);
  assertExists(model.methods.purge_urls);
  assertExists(model.methods.purge_tags);
  assertExists(model.methods.purge_prefixes);
  assertExists(model.methods.get_settings);
  assertExists(model.methods.set_cache_level);
  assertExists(model.methods.toggle_dev_mode);
});

Deno.test("cache model: purge_urls method has correct arguments schema", () => {
  const args = model.methods.purge_urls.arguments;
  assertExists(args);
  const shape = args.shape;
  assertExists(shape.urls);
});

Deno.test("cache model: set_cache_level method has correct arguments schema", () => {
  const args = model.methods.set_cache_level.arguments;
  assertExists(args);
  const shape = args.shape;
  assertExists(shape.level);
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
  name: "cache model: purge_all method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer({
      "/purge_cache": { id: "purge-123" },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-cache", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.purge_all.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.purge_all.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "purge");
      assertEquals(resources[0].name, "latest");

      const data = resources[0].data as { purgeType: string };
      assertEquals(data.purgeType, "everything");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cache model: purge_urls method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer({
      "/purge_cache": { id: "purge-456" },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-cache", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.purge_urls.execute(
        { urls: ["https://example.com/page1", "https://example.com/page2"] },
        context as unknown as Parameters<
          typeof model.methods.purge_urls.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "purge");

      const data = resources[0].data as {
        purgeType: string;
        details: { urls: string[] };
      };
      assertEquals(data.purgeType, "urls");
      assertEquals(data.details.urls.length, 2);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cache model: get_settings method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockSettings = [
      { id: "cache_level", value: "aggressive" },
      { id: "browser_cache_ttl", value: 14400 },
      { id: "development_mode", value: 0 },
    ];

    const { url, server } = startMockCfServer({
      "/settings": mockSettings,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-cache", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.get_settings.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_settings.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "settings");
      assertEquals(resources[0].name, "main");

      const data = resources[0].data as {
        cacheLevel: string;
        browserCacheTtl: number;
      };
      assertEquals(data.cacheLevel, "aggressive");
      assertEquals(data.browserCacheTtl, 14400);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "cache model: toggle_dev_mode method executes",
  sanitizeResources: false,
  fn: async () => {
    const mockSettings = [
      { id: "cache_level", value: "aggressive" },
      { id: "development_mode", value: 1 },
    ];

    const { url, server } = startMockCfServer({
      "/development_mode": { id: "development_mode", value: "on" },
      "/settings": mockSettings,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-cache", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.toggle_dev_mode.execute(
        { enabled: true },
        context as unknown as Parameters<
          typeof model.methods.toggle_dev_mode.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "settings");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
