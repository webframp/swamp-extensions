// Azure OpenAI Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./openai_usage.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

const FAKE_TENANT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const FAKE_CLIENT_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const FAKE_SECRET = "test-client-secret-value";
const FAKE_SUB = "c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f";

const DEFAULT_GLOBAL_ARGS = {
  subscriptions: [FAKE_SUB],
  tenantId: FAKE_TENANT,
  clientId: FAKE_CLIENT_ID,
  clientSecret: FAKE_SECRET,
};

type FetchHandler = (
  url: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>;

function createMockFetchFn(handler: FetchHandler): typeof fetch {
  return handler as typeof fetch;
}

/** Standard token response. */
function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: "mock-azure-token", expires_in: 3600 }),
    { status: 200 },
  );
}

/** ARM resource list response. */
function resourceListResponse(
  resources: Array<{
    name: string;
    location: string;
    kind: string;
    resourceGroup: string;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      value: resources.map((r) => ({
        name: r.name,
        location: r.location,
        kind: r.kind,
        id:
          `/subscriptions/${FAKE_SUB}/resourceGroups/${r.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${r.name}`,
      })),
    }),
    { status: 200 },
  );
}

/** Azure Monitor metrics response (aggregate). */
function metricsResponse(promptTokens: number, genTokens: number): Response {
  return new Response(
    JSON.stringify({
      value: [
        {
          name: { value: "ProcessedPromptTokens" },
          timeseries: [{ data: [{ total: promptTokens }] }],
        },
        {
          name: { value: "GeneratedTokens" },
          timeseries: [{ data: [{ total: genTokens }] }],
        },
      ],
    }),
    { status: 200 },
  );
}

/** Azure Monitor metrics response with deployment dimension. */
function deploymentMetricsResponse(
  deployments: Array<{
    name: string;
    promptTokens: number;
    generatedTokens: number;
  }>,
): Response {
  const value = [
    {
      name: { value: "ProcessedPromptTokens" },
      timeseries: deployments.map((d) => ({
        metadatavalues: [
          { name: { value: "modeldeploymentname" }, value: d.name },
        ],
        data: [{ total: d.promptTokens }],
      })),
    },
    {
      name: { value: "GeneratedTokens" },
      timeseries: deployments.map((d) => ({
        metadatavalues: [
          { name: { value: "modeldeploymentname" }, value: d.name },
        ],
        data: [{ total: d.generatedTokens }],
      })),
    },
  ];
  return new Response(JSON.stringify({ value }), { status: 200 });
}

// =============================================================================
// Type aliases
// =============================================================================

type ScanContext = Parameters<
  typeof model.methods.scan_subscriptions.execute
>[1];
type ListContext = Parameters<
  typeof model.methods.list_ai_resources.execute
>[1];

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/azure/openai-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments requires subscriptions, tenantId, clientId, clientSecret", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("model globalArguments rejects invalid UUID subscriptions", () => {
  const result = model.globalArguments.safeParse({
    ...DEFAULT_GLOBAL_ARGS,
    subscriptions: ["not-a-uuid"],
  });
  assertEquals(result.success, false);
});

Deno.test("model globalArguments accepts valid input", () => {
  const parsed = model.globalArguments.parse(DEFAULT_GLOBAL_ARGS);
  assertEquals(parsed.subscriptions, [FAKE_SUB]);
  assertEquals(parsed.tenantId, FAKE_TENANT);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
  assertEquals("resource_list" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_subscriptions" in model.methods, true);
  assertEquals("list_ai_resources" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_subscriptions rejects days=0", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_subscriptions accepts days=1", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_subscriptions rejects days=91", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({ days: 91 });
  assertEquals(result.success, false);
});

Deno.test("scan_subscriptions defaults days to 30", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

// =============================================================================
// Auth Tests
// =============================================================================

Deno.test("scan_subscriptions fails on token exchange error", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) {
      return new Response(
        JSON.stringify({ error: "invalid_client" }),
        { status: 401 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const { context } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  await assertRejects(
    () =>
      model.methods.scan_subscriptions.execute(
        { days: 7 },
        { ...context, fetchFn: mockFetch } as unknown as ScanContext,
      ),
    Error,
    "Azure token exchange failed",
  );
});

// =============================================================================
// scan_subscriptions Tests
// =============================================================================

Deno.test("scan_subscriptions discovers resources and returns metrics", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "my-openai",
          resourceGroup: "rg-ai",
          location: "eastus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics") && u.includes("filter")) {
      return deploymentMetricsResponse([
        { name: "gpt-4o", promptTokens: 5000, generatedTokens: 2000 },
      ]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      return metricsResponse(5000, 2000);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  const result = await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "scan_results");

  const data = resources[0].data as {
    resources: Array<{
      resourceName: string;
      totalTokens: number;
      deployments: Array<{ deploymentName: string }>;
    }>;
    totals: { totalTokens: number; promptTokens: number };
    truncated: boolean;
  };

  assertEquals(data.resources.length, 1);
  assertEquals(data.resources[0].resourceName, "my-openai");
  assertEquals(data.resources[0].totalTokens, 7000);
  assertEquals(data.resources[0].deployments[0].deploymentName, "gpt-4o");
  assertEquals(data.totals.promptTokens, 5000);
  assertEquals(data.totals.totalTokens, 7000);
  assertEquals(data.truncated, false);
});

Deno.test("scan_subscriptions handles empty subscription gracefully", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  const result = await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  assertExists(result.dataHandles);
  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<unknown>;
    totals: { totalTokens: number };
  };
  assertEquals(data.resources.length, 0);
  assertEquals(data.totals.totalTokens, 0);
});

Deno.test("scan_subscriptions skips zero-usage resources", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "idle-resource",
          resourceGroup: "rg",
          location: "westus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      return metricsResponse(0, 0);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { resources: Array<unknown> };
  assertEquals(data.resources.length, 0);
});

Deno.test("scan_subscriptions handles metric API failure per resource", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "good-res",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
        {
          name: "bad-res",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      if (u.includes("bad-res")) {
        return new Response("Internal Error", { status: 500 });
      }
      if (u.includes("filter")) {
        return deploymentMetricsResponse([]);
      }
      return metricsResponse(1000, 500);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: DEFAULT_GLOBAL_ARGS,
      definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
    });

  await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<{ resourceName: string }>;
    truncated: boolean;
  };

  assertEquals(data.resources.length, 1);
  assertEquals(data.resources[0].resourceName, "good-res");
  assertEquals(data.truncated, true);

  const warns = getLogsByLevel("warning");
  assertEquals(warns.length >= 1, true);
});

Deno.test("scan_subscriptions handles deployment breakdown failure", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "res1",
          resourceGroup: "rg",
          location: "eastus",
          kind: "AIServices",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics") && u.includes("filter")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (u.includes("microsoft.insights/metrics")) {
      return metricsResponse(3000, 1000);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: DEFAULT_GLOBAL_ARGS,
      definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
    });

  await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<{
      totalTokens: number;
      deployments: Array<unknown>;
    }>;
  };

  assertEquals(data.resources.length, 1);
  assertEquals(data.resources[0].totalTokens, 4000);
  assertEquals(data.resources[0].deployments.length, 0);

  const warns = getLogsByLevel("warning");
  assertEquals(warns.length >= 1, true);
});

// =============================================================================
// list_ai_resources Tests
// =============================================================================

Deno.test("list_ai_resources discovers resources across subscriptions", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "oai-prod",
          resourceGroup: "rg-prod",
          location: "eastus2",
          kind: "OpenAI",
        },
        {
          name: "ais-dev",
          resourceGroup: "rg-dev",
          location: "westus",
          kind: "AIServices",
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  const result = await model.methods.list_ai_resources.execute(
    {} as Record<string, never>,
    { ...context, fetchFn: mockFetch } as unknown as ListContext,
  );

  assertExists(result.dataHandles);
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "resource_list");
  assertEquals(resources[0].name, "discovery");

  const data = resources[0].data as {
    resources: Array<{
      resourceName: string;
      resourceGroup: string;
      kind: string;
    }>;
  };

  assertEquals(data.resources.length, 2);
  assertEquals(data.resources[0].resourceName, "oai-prod");
  assertEquals(data.resources[0].resourceGroup, "rg-prod");
  assertEquals(data.resources[1].kind, "AIServices");
});

Deno.test("list_ai_resources handles subscription failure gracefully", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: DEFAULT_GLOBAL_ARGS,
      definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
    });

  await model.methods.list_ai_resources.execute(
    {} as Record<string, never>,
    { ...context, fetchFn: mockFetch } as unknown as ListContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { resources: Array<unknown> };
  assertEquals(data.resources.length, 0);

  const warns = getLogsByLevel("warning");
  assertEquals(warns.length, 1);
});

// =============================================================================
// Edge Cases
// =============================================================================

Deno.test("resources are sorted by totalTokens descending", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "small-res",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
        {
          name: "big-res",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      if (u.includes("small-res")) {
        if (u.includes("filter")) return deploymentMetricsResponse([]);
        return metricsResponse(100, 50);
      }
      if (u.includes("big-res")) {
        if (u.includes("filter")) return deploymentMetricsResponse([]);
        return metricsResponse(9000, 5000);
      }
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<{ resourceName: string; totalTokens: number }>;
  };

  assertEquals(data.resources[0].resourceName, "big-res");
  assertEquals(data.resources[0].totalTokens, 14000);
  assertEquals(data.resources[1].resourceName, "small-res");
  assertEquals(data.resources[1].totalTokens, 150);
});

Deno.test("multiple deployments are correctly aggregated", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "multi-deploy",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics") && u.includes("filter")) {
      return deploymentMetricsResponse([
        { name: "gpt-4o", promptTokens: 3000, generatedTokens: 1000 },
        { name: "gpt-4o-mini", promptTokens: 2000, generatedTokens: 500 },
      ]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      return metricsResponse(5000, 1500);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  await model.methods.scan_subscriptions.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<{
      deployments: Array<{
        deploymentName: string;
        totalTokens: number;
      }>;
    }>;
  };

  assertEquals(data.resources[0].deployments.length, 2);
  assertEquals(data.resources[0].deployments[0].deploymentName, "gpt-4o");
  assertEquals(data.resources[0].deployments[0].totalTokens, 4000);
  assertEquals(data.resources[0].deployments[1].deploymentName, "gpt-4o-mini");
  assertEquals(data.resources[0].deployments[1].totalTokens, 2500);
});

Deno.test("multi-day metrics are summed across data points", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("login.microsoftonline.com")) return tokenResponse();
    if (u.includes("Microsoft.CognitiveServices/accounts?")) {
      return resourceListResponse([
        {
          name: "daily-res",
          resourceGroup: "rg",
          location: "eastus",
          kind: "OpenAI",
        },
      ]);
    }
    if (u.includes("microsoft.insights/metrics") && u.includes("filter")) {
      return deploymentMetricsResponse([]);
    }
    if (u.includes("microsoft.insights/metrics")) {
      // Multiple daily data points
      return new Response(
        JSON.stringify({
          value: [
            {
              name: { value: "ProcessedPromptTokens" },
              timeseries: [
                { data: [{ total: 1000 }, { total: 2000 }, { total: 3000 }] },
              ],
            },
            {
              name: { value: "GeneratedTokens" },
              timeseries: [
                { data: [{ total: 500 }, { total: 700 }, { total: 800 }] },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    definition: { id: "t", name: "azure-ai", version: 1, tags: {} },
  });

  await model.methods.scan_subscriptions.execute(
    { days: 3 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    resources: Array<{ promptTokens: number; generatedTokens: number }>;
  };

  assertEquals(data.resources[0].promptTokens, 6000); // 1000 + 2000 + 3000
  assertEquals(data.resources[0].generatedTokens, 2000); // 500 + 700 + 800
});
