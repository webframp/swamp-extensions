// Cloudflare Worker Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./worker.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("worker model: has correct type", () => {
  assertEquals(model.type, "@webframp/cloudflare/worker");
});

Deno.test("worker model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("worker model: has globalArguments with apiToken and accountId", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.apiToken);
  assertExists(shape.accountId);
});

Deno.test("worker model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.scripts);
  assertExists(model.resources.script);
  assertExists(model.resources.routes);
  assertExists(model.resources.deployment);
});

Deno.test("worker model: has files spec for source", () => {
  assertExists(model.files);
  assertExists(model.files.source);
  assertEquals(model.files.source.contentType, "application/javascript");
});

Deno.test("worker model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.list_scripts);
  assertExists(model.methods.get_script);
  assertExists(model.methods.deploy);
  assertExists(model.methods.delete_script);
  assertExists(model.methods.list_routes);
  assertExists(model.methods.create_route);
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
        // For script content download, return plain text
        if (pattern.includes("/content")) {
          return new Response(result as string, {
            headers: { "Content-Type": "application/javascript" },
          });
        }
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
  name: "worker model: list_scripts method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockScripts = [
      {
        id: "my-worker",
        created_on: "2024-01-01T00:00:00Z",
        modified_on: "2024-01-02T00:00:00Z",
        etag: "abc123",
        usage_model: "bundled",
        handlers: ["fetch"],
      },
    ];

    const { url, server } = startMockCfServer({
      "/workers/scripts": mockScripts,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", accountId: "acct-1" },
        definition: {
          id: "test-id",
          name: "test-worker",
          version: 1,
          tags: {},
        },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.list_scripts.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_scripts.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "scripts");
      assertEquals(resources[0].name, "main");

      const data = resources[0].data as { scripts: typeof mockScripts };
      assertEquals(data.scripts.length, 1);
      assertEquals(data.scripts[0].id, "my-worker");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "worker model: get_script method executes and writes resource and file",
  sanitizeResources: false,
  fn: async () => {
    const mockScript = {
      id: "api-worker",
      created_on: "2024-01-01T00:00:00Z",
      modified_on: "2024-01-02T00:00:00Z",
      etag: "def456",
      usage_model: "unbound",
      handlers: ["fetch", "scheduled"],
    };

    const { url, server } = startMockCfServer({
      "/workers/scripts/api-worker": mockScript,
      "/content":
        "export default { fetch(req) { return new Response('OK'); } }",
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources, getWrittenFiles } =
        createModelTestContext({
          globalArgs: { apiToken: "test-token", accountId: "acct-1" },
          definition: {
            id: "test-id",
            name: "test-worker",
            version: 1,
            tags: {},
          },
        });

      // Cast needed because model defines inline context type
      const result = await model.methods.get_script.execute(
        { scriptName: "api-worker" },
        context as unknown as Parameters<
          typeof model.methods.get_script.execute
        >[1],
      );

      // Should return 2 handles: metadata resource + source file
      assertEquals(result.dataHandles.length, 2);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "script");
      assertEquals(resources[0].name, "api-worker");

      const data = resources[0].data as typeof mockScript;
      assertEquals(data.id, "api-worker");

      // Check the source file was written
      const files = getWrittenFiles();
      assertEquals(files.length, 1);
      assertEquals(files[0].specName, "source");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "worker model: delete_script method returns empty handles",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer({
      "/workers/scripts/del-worker": null,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context } = createModelTestContext({
        globalArgs: { apiToken: "test-token", accountId: "acct-1" },
        definition: {
          id: "test-id",
          name: "test-worker",
          version: 1,
          tags: {},
        },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.delete_script.execute(
        { scriptName: "del-worker" },
        context as unknown as Parameters<
          typeof model.methods.delete_script.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 0);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
