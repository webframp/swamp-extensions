// Cloudflare DNS Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./dns.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("dns model: has correct type", () => {
  assertEquals(model.type, "@webframp/cloudflare/dns");
});

Deno.test("dns model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("dns model: has globalArguments with apiToken and zoneId", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.apiToken);
  assertExists(shape.zoneId);
});

Deno.test("dns model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.records);
  assertExists(model.resources.record);
});

Deno.test("dns model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.list);
  assertExists(model.methods.get);
  assertExists(model.methods.create);
  assertExists(model.methods.update);
  assertExists(model.methods.delete);
  assertExists(model.methods.export);
});

Deno.test("dns model: has files spec for export", () => {
  assertExists(model.files);
  assertExists(model.files.export);
  assertEquals(model.files.export.contentType, "text/plain");
});

Deno.test("dns model: list method has correct arguments schema", () => {
  const listArgs = model.methods.list.arguments;
  assertExists(listArgs);
  const shape = listArgs.shape;
  assertExists(shape.type);
  assertExists(shape.name);
});

Deno.test("dns model: create method has correct arguments schema", () => {
  const createArgs = model.methods.create.arguments;
  assertExists(createArgs);
  const shape = createArgs.shape;
  assertExists(shape.type);
  assertExists(shape.name);
  assertExists(shape.content);
  assertExists(shape.ttl);
  assertExists(shape.proxied);
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
  name: "dns model: list method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockRecords = [
      {
        id: "rec-123",
        zone_id: "zone-1",
        zone_name: "example.com",
        name: "www.example.com",
        type: "A",
        content: "192.0.2.1",
        proxiable: true,
        proxied: true,
        ttl: 1,
        locked: false,
        created_on: "2024-01-01T00:00:00Z",
        modified_on: "2024-01-02T00:00:00Z",
      },
    ];

    const { url, server } = startMockCfServer({
      "/dns_records": mockRecords,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-dns", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.list.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list.execute>[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "records");
      assertEquals(resources[0].name, "main");

      const data = resources[0].data as { records: typeof mockRecords };
      assertEquals(data.records.length, 1);
      assertEquals(data.records[0].name, "www.example.com");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "dns model: get method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockRecord = {
      id: "rec-456",
      zone_id: "zone-1",
      zone_name: "example.com",
      name: "api.example.com",
      type: "CNAME",
      content: "proxy.example.com",
      proxiable: true,
      proxied: false,
      ttl: 300,
      locked: false,
      created_on: "2024-01-01T00:00:00Z",
      modified_on: "2024-01-02T00:00:00Z",
    };

    const { url, server } = startMockCfServer({
      "/dns_records/rec-456": mockRecord,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-dns", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.get.execute(
        { recordId: "rec-456" },
        context as unknown as Parameters<typeof model.methods.get.execute>[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "record");
      assertEquals(resources[0].name, "rec-456");

      const data = resources[0].data as typeof mockRecord;
      assertEquals(data.name, "api.example.com");
      assertEquals(data.type, "CNAME");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "dns model: create method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockRecord = {
      id: "rec-789",
      zone_id: "zone-1",
      zone_name: "example.com",
      name: "new.example.com",
      type: "A",
      content: "192.0.2.10",
      proxiable: true,
      proxied: true,
      ttl: 1,
      locked: false,
      created_on: "2024-01-03T00:00:00Z",
      modified_on: "2024-01-03T00:00:00Z",
    };

    const { url, server } = startMockCfServer({
      "/dns_records": mockRecord,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-dns", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.create.execute(
        {
          type: "A",
          name: "new",
          content: "192.0.2.10",
          ttl: 1,
          proxied: true,
        },
        context as unknown as Parameters<
          typeof model.methods.create.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "record");
      assertEquals(resources[0].name, "rec-789");

      const data = resources[0].data as typeof mockRecord;
      assertEquals(data.content, "192.0.2.10");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "dns model: delete method returns empty handles",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer({
      "/dns_records/rec-del": { id: "rec-del" },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-dns", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.delete.execute(
        { recordId: "rec-del" },
        context as unknown as Parameters<
          typeof model.methods.delete.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 0);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
