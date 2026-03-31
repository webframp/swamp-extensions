// Cloudflare WAF Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./waf.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("waf model: has correct type", () => {
  assertEquals(model.type, "@webframp/cloudflare/waf");
});

Deno.test("waf model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("waf model: has globalArguments with apiToken and zoneId", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.apiToken);
  assertExists(shape.zoneId);
});

Deno.test("waf model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.rules);
  assertExists(model.resources.rule);
  assertExists(model.resources.packages);
  assertExists(model.resources.events);
});

Deno.test("waf model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.list_rules);
  assertExists(model.methods.create_rule);
  assertExists(model.methods.delete_rule);
  assertExists(model.methods.list_packages);
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
  name: "waf model: list_rules method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockRules = [
      {
        id: "rule-123",
        paused: false,
        description: "Block bad bots",
        action: "block",
        priority: 1,
        filter: {
          id: "filter-1",
          expression: "(cf.client.bot)",
          paused: false,
        },
        created_on: "2024-01-01T00:00:00Z",
        modified_on: "2024-01-02T00:00:00Z",
      },
    ];

    const { url, server } = startMockCfServer({
      "/firewall/rules": mockRules,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-waf", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.list_rules.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_rules.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "rules");
      assertEquals(resources[0].name, "main");

      const data = resources[0].data as { rules: typeof mockRules };
      assertEquals(data.rules.length, 1);
      assertEquals(data.rules[0].description, "Block bad bots");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "waf model: list_packages method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockPackages = [
      {
        id: "pkg-123",
        name: "OWASP ModSecurity Core Rule Set",
        description: "Core rule set for web application security",
        zone_id: "zone-1",
        detection_mode: "traditional",
        sensitivity: "medium",
        action_mode: "challenge",
      },
    ];

    const { url, server } = startMockCfServer({
      "/firewall/waf/packages": mockPackages,
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-waf", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.list_packages.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_packages.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "packages");

      const data = resources[0].data as { packages: typeof mockPackages };
      assertEquals(data.packages.length, 1);
      assertEquals(data.packages[0].name, "OWASP ModSecurity Core Rule Set");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "waf model: create_rule method executes and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const mockFilter = [{ id: "filter-new" }];
    const mockRule = {
      id: "rule-new",
      paused: false,
      description: "New test rule",
      action: "challenge",
      filter: {
        id: "filter-new",
        expression: "(ip.src eq 1.2.3.4)",
        paused: false,
      },
      created_on: "2024-01-03T00:00:00Z",
      modified_on: "2024-01-03T00:00:00Z",
    };

    const { url, server } = startMockCfServer({
      "/filters": mockFilter,
      "/firewall/rules": [mockRule],
    });
    const uninstall = installFetchMock(url);

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-waf", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.create_rule.execute(
        {
          expression: "(ip.src eq 1.2.3.4)",
          action: "challenge",
          description: "New test rule",
          paused: false,
        },
        context as unknown as Parameters<
          typeof model.methods.create_rule.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "rule");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "waf model: delete_rule method returns empty handles",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockCfServer({
      "/firewall/rules/rule-del": { id: "rule-del" },
    });
    const uninstall = installFetchMock(url);

    try {
      const { context } = createModelTestContext({
        globalArgs: { apiToken: "test-token", zoneId: "zone-1" },
        definition: { id: "test-id", name: "test-waf", version: 1, tags: {} },
      });

      // Cast needed because model defines inline context type
      const result = await model.methods.delete_rule.execute(
        { ruleId: "rule-del" },
        context as unknown as Parameters<
          typeof model.methods.delete_rule.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 0);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
