// AI Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./ai_usage.ts";

// =============================================================================
// Type aliases
// =============================================================================

type StatusContext = Parameters<typeof model.methods.status.execute>[1];
type GenerateContext = Parameters<typeof model.methods.generate.execute>[1];

// =============================================================================
// Mock Helper
// =============================================================================

type StoredData = Record<
  string,
  Record<
    string,
    Array<{ attributes: Record<string, unknown>; updatedAt?: string }>
  >
>;

/**
 * Mocks the real `context.dataRepository` shape: `findAllForModel` returns
 * metadata only (name, version, tags), `getContent` returns raw bytes for a
 * given (modelType, modelId, name, version). There is no `findBySpec` on the
 * method-execution context — that's a modeling mistake this test factory
 * used to bake in, matching the model's own bug.
 */
function createAiUsageContext(storedData: StoredData = {}) {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "ai-usage", version: 1, tags: {} },
  });

  // Patch dataRepository onto the context
  const patched = context as unknown as Record<string, unknown>;
  patched.dataRepository = {
    findAllForModel: (_modelType: string, modelId: string) => {
      const modelData = storedData[modelId];
      if (!modelData) return Promise.resolve([]);
      const entries: Array<
        {
          name: string;
          version: number;
          tags: Record<string, string>;
          createdAt?: string;
        }
      > = [];
      for (const [specName, items] of Object.entries(modelData)) {
        items.forEach((item, i) => {
          entries.push({
            name: `${specName}-${i}`,
            version: 1,
            tags: { specName },
            createdAt: item.updatedAt,
          });
        });
      }
      return Promise.resolve(entries);
    },
    getContent: (
      _modelType: string,
      modelId: string,
      dataName: string,
    ) => {
      const modelData = storedData[modelId];
      if (!modelData) return Promise.resolve(null);
      for (const [specName, items] of Object.entries(modelData)) {
        const idx = items.findIndex((_, i) => `${specName}-${i}` === dataName);
        if (idx !== -1) {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify(items[idx].attributes)),
          );
        }
      }
      return Promise.resolve(null);
    },
  };

  return { context: patched, getWrittenResources };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/ai-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments accepts empty object", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(typeof parsed, "object");
});

Deno.test("model defines expected resources", () => {
  assertEquals("status" in model.resources, true);
  assertEquals("report" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("status" in model.methods, true);
  assertEquals("generate" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("generate rejects days=0", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("generate accepts days=1", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("generate defaults days to 30", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

// =============================================================================
// Status Method Tests
// =============================================================================

Deno.test({
  name: "status detects configured providers via dataRepository",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
              scannedAt: "2026-05-01T00:00:00Z",
              totals: { totalTokens: 50000 },
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.status.execute(
      {} as Record<string, never>,
      context as unknown as StatusContext,
    );

    assertExists(result.dataHandles);
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "status");

    const data = resources[0].data as {
      providers: Array<{
        provider: string;
        configured: boolean;
        extensionType: string;
        totalTokens: number | null;
        setup: { command: string; permissions: string[]; authNotes: string };
      }>;
      configuredCount: number;
    };

    assertEquals(data.configuredCount, 1);
    const bedrock = data.providers.find((p) => p.provider === "AWS Bedrock");
    assertExists(bedrock);
    assertEquals(bedrock.configured, true);
    assertEquals(bedrock.totalTokens, 50000);
    // Configured providers have blanked setup guidance
    assertEquals(bedrock.setup.command, "");
    assertEquals(bedrock.setup.permissions.length, 0);
  },
});

Deno.test({
  name: "status returns setup guidance for unconfigured providers",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({});

    await model.methods.status.execute(
      {} as Record<string, never>,
      context as unknown as StatusContext,
    );

    const resources = getWrittenResources();
    const data = resources[0].data as {
      providers: Array<{
        provider: string;
        configured: boolean;
        extensionType: string;
        setup: { command: string; permissions: string[]; authNotes: string };
      }>;
    };

    const gcp = data.providers.find((p) => p.provider === "GCP Vertex AI");
    assertExists(gcp);
    assertEquals(gcp.configured, false);
    assertEquals(gcp.extensionType, "@webframp/gcp/vertex-usage");
    // Should include actual permissions
    assertEquals(
      gcp.setup.permissions.includes("monitoring.timeSeries.list"),
      true,
    );
    // Command should mention serviceAccountJson
    assertEquals(gcp.setup.command.includes("serviceAccountJson"), true);
    // authNotes should describe the mechanism
    assertEquals(gcp.setup.authNotes.includes("service account"), true);

    const azure = data.providers.find((p) => p.provider === "Azure OpenAI");
    assertExists(azure);
    assertEquals(azure.configured, false);
    assertEquals(
      azure.setup.permissions.includes("Microsoft.Insights/metrics/read"),
      true,
    );
    assertEquals(azure.setup.command.includes("tenantId"), true);
    assertEquals(azure.setup.command.includes("clientId"), true);
    assertEquals(azure.setup.command.includes("clientSecret"), true);

    const aws = data.providers.find((p) => p.provider === "AWS Bedrock");
    assertExists(aws);
    assertEquals(aws.configured, false);
    assertEquals(
      aws.setup.permissions.includes("cloudwatch:GetMetricData"),
      true,
    );
  },
});

Deno.test({
  name: "status picks latest by updatedAt when multiple results exist",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
              scannedAt: "2026-04-01T00:00:00Z",
              totals: { totalTokens: 10000 },
            },
            updatedAt: "2026-04-01T00:00:00Z",
          },
          {
            attributes: {
              scannedAt: "2026-05-10T00:00:00Z",
              totals: { totalTokens: 99000 },
            },
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.status.execute(
      {} as Record<string, never>,
      context as unknown as StatusContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const data = resources[0].data as {
      providers: Array<{
        provider: string;
        totalTokens: number | null;
      }>;
    };

    const bedrock = data.providers.find((p) => p.provider === "AWS Bedrock");
    assertEquals(bedrock?.totalTokens, 99000);
  },
});

Deno.test({
  name: "status handles all providers unconfigured",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({});

    const result = await model.methods.status.execute(
      {} as Record<string, never>,
      context as unknown as StatusContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const data = resources[0].data as {
      configuredCount: number;
      totalProviders: number;
    };
    assertEquals(data.configuredCount, 0);
    assertEquals(data.totalProviders, 3);
  },
});

// =============================================================================
// Generate Method Tests
// =============================================================================

Deno.test({
  name: "generate produces unified report from provider data",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
              scannedAt: "2026-05-01T00:00:00Z",
              totals: {
                inputTokens: 30000,
                outputTokens: 20000,
                totalTokens: 50000,
                inputTokensPerMinute: 0.7,
                outputTokensPerMinute: 0.5,
              },
              accounts: [
                {
                  profile: "prod",
                  totalTokens: 50000,
                  models: [
                    {
                      modelId: "anthropic.claude-3-sonnet",
                      totalTokens: 50000,
                    },
                  ],
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
      "vertex-usage": {
        "scan_results": [
          {
            attributes: {
              scannedAt: "2026-05-01T00:00:00Z",
              totals: {
                inputTokens: 10000,
                outputTokens: 5000,
                totalTokens: 15000,
                inputTokensPerMinute: 0.2,
                outputTokensPerMinute: 0.1,
              },
              projects: [
                {
                  project: "my-gcp",
                  totalTokens: 15000,
                  models: [
                    { modelId: "gemini-1.5-pro", totalTokens: 15000 },
                  ],
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.generate.execute(
      { days: 30 },
      context as unknown as GenerateContext,
    );

    assertExists(result.dataHandles);
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    assertEquals(resources[0].specName, "report");

    const data = resources[0].data as {
      providers: Array<{ name: string; totalTokens: number }>;
      grandTotals: { totalTokens: number };
      coverage: Array<{
        provider: string;
        configured: boolean;
        extensionType: string;
        setup: { command: string; permissions: string[]; authNotes: string };
      }>;
      highlights: string[];
    };

    assertEquals(data.providers.length, 2);
    assertEquals(data.grandTotals.totalTokens, 65000);
    assertEquals(
      data.coverage.filter((c) => c.configured).length,
      2,
    );
    const azure = data.coverage.find((c) => c.provider === "Azure OpenAI");
    assertEquals(azure?.configured, false);
    // Unconfigured providers in report coverage should have setup guidance
    assertExists(azure?.setup.command);
    assertEquals(azure!.setup.permissions.length > 0, true);
  },
});

Deno.test({
  name: "generate handles Azure field mapping (promptTokens/generatedTokens)",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({
      "azure-ai-usage": {
        "scan_results": [
          {
            attributes: {
              scannedAt: "2026-05-01T00:00:00Z",
              totals: {
                promptTokens: 40000,
                generatedTokens: 10000,
                totalTokens: 50000,
                promptTokensPerMinute: 0.9,
                generatedTokensPerMinute: 0.2,
              },
              resources: [
                {
                  resourceName: "my-openai-east",
                  totalTokens: 50000,
                  deployments: [
                    { deploymentName: "gpt-4o", totalTokens: 50000 },
                  ],
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.generate.execute(
      { days: 30 },
      context as unknown as GenerateContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const data = resources[0].data as {
      providers: Array<{
        name: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        topAccounts: Array<{ name: string }>;
        topModels: Array<{ modelId: string }>;
      }>;
      grandTotals: { inputTokens: number; outputTokens: number };
    };

    assertEquals(data.providers.length, 1);
    assertEquals(data.providers[0].name, "Azure OpenAI");
    assertEquals(data.providers[0].inputTokens, 40000);
    assertEquals(data.providers[0].outputTokens, 10000);
    assertEquals(data.providers[0].totalTokens, 50000);
    assertEquals(data.providers[0].topAccounts[0].name, "my-openai-east");
    assertEquals(data.providers[0].topModels[0].modelId, "gpt-4o");
    assertEquals(data.grandTotals.inputTokens, 40000);
    assertEquals(data.grandTotals.outputTokens, 10000);
  },
});

Deno.test({
  name: "generate handles all providers unconfigured gracefully",
  fn: async () => {
    const { context, getWrittenResources } = createAiUsageContext({});

    const result = await model.methods.generate.execute(
      { days: 7 },
      context as unknown as GenerateContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const data = resources[0].data as {
      providers: Array<{ name: string }>;
      grandTotals: { totalTokens: number };
      coverage: Array<{ configured: boolean }>;
      days: number;
      periodMinutes: number;
    };

    assertEquals(data.providers.length, 0);
    assertEquals(data.grandTotals.totalTokens, 0);
    assertEquals(data.coverage.length, 3);
    assertEquals(data.coverage.every((c) => !c.configured), true);
    assertEquals(data.days, 7);
    assertEquals(data.periodMinutes, 7 * 24 * 60);
  },
});
