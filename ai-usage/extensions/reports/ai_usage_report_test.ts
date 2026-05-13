// AI Usage Report Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { report } from "./ai_usage_report.ts";

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

function createReportContext(storedData: StoredData = {}) {
  return {
    dataRepository: {
      findBySpec: (modelName: string, specName: string) => {
        const modelData = storedData[modelName];
        if (!modelData) return Promise.resolve([]);
        return Promise.resolve(modelData[specName] || []);
      },
    },
  };
}

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("report has correct name", () => {
  assertEquals(report.name, "@webframp/ai-usage-report");
});

Deno.test("report scope is workflow", () => {
  assertEquals(report.scope, "workflow");
});

Deno.test("report has labels", () => {
  assertEquals(report.labels.includes("finops"), true);
});

// =============================================================================
// Execute Tests
// =============================================================================

Deno.test({
  name: "report renders coverage table with all providers unconfigured",
  fn: async () => {
    const context = createReportContext({});
    const result = await report.execute(context);

    assertExists(result.markdown);
    assertExists(result.json);
    assertStringIncludes(result.markdown, "# AI Token Usage Report");
    assertStringIncludes(result.markdown, "Provider Coverage");
    assertStringIncludes(result.markdown, "Not configured");
  },
});

Deno.test({
  name: "report renders AWS section when data exists",
  fn: async () => {
    const context = createReportContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
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
                  inputTokens: 30000,
                  outputTokens: 20000,
                  models: [
                    { modelId: "claude-3-sonnet", totalTokens: 50000 },
                  ],
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await report.execute(context);

    assertStringIncludes(result.markdown, "## AWS Bedrock");
    assertStringIncludes(result.markdown, "50,000");
    assertStringIncludes(result.markdown, "Active");
    assertEquals(
      (result.json as { grandTotals: { totalTokens: number } }).grandTotals
        .totalTokens,
      50000,
    );
  },
});

Deno.test({
  name: "report renders GCP section when data exists",
  fn: async () => {
    const context = createReportContext({
      "vertex-usage": {
        "scan_results": [
          {
            attributes: {
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
                  inputTokens: 10000,
                  outputTokens: 5000,
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await report.execute(context);

    assertStringIncludes(result.markdown, "## GCP Vertex AI");
    assertStringIncludes(result.markdown, "15,000");
  },
});

Deno.test({
  name: "report renders Azure section when data exists",
  fn: async () => {
    const context = createReportContext({
      "azure-ai-usage": {
        "scan_results": [
          {
            attributes: {
              totals: {
                promptTokens: 8000,
                generatedTokens: 3000,
                totalTokens: 11000,
                promptTokensPerMinute: 0.2,
                generatedTokensPerMinute: 0.1,
              },
              resources: [
                {
                  resourceName: "my-openai",
                  totalTokens: 11000,
                  promptTokens: 8000,
                  generatedTokens: 3000,
                },
              ],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await report.execute(context);

    assertStringIncludes(result.markdown, "## Azure OpenAI");
    assertStringIncludes(result.markdown, "11,000");
  },
});

Deno.test({
  name: "report grand totals sum all providers",
  fn: async () => {
    const context = createReportContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
              totals: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                inputTokensPerMinute: 0.01,
                outputTokensPerMinute: 0.005,
              },
              accounts: [],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
      "vertex-usage": {
        "scan_results": [
          {
            attributes: {
              totals: {
                inputTokens: 200,
                outputTokens: 100,
                totalTokens: 300,
                inputTokensPerMinute: 0.02,
                outputTokensPerMinute: 0.01,
              },
              projects: [],
            },
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });

    const result = await report.execute(context);
    const json = result.json as {
      grandTotals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };

    assertEquals(json.grandTotals.inputTokens, 300);
    assertEquals(json.grandTotals.outputTokens, 150);
    assertEquals(json.grandTotals.totalTokens, 450);
  },
});

Deno.test({
  name: "report picks latest record by updatedAt",
  fn: async () => {
    const context = createReportContext({
      "bedrock-usage": {
        "scan_results": [
          {
            attributes: {
              totals: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                inputTokensPerMinute: 0.01,
                outputTokensPerMinute: 0.005,
              },
              accounts: [],
            },
            updatedAt: "2026-04-01T00:00:00Z",
          },
          {
            attributes: {
              totals: {
                inputTokens: 9000,
                outputTokens: 1000,
                totalTokens: 10000,
                inputTokensPerMinute: 0.2,
                outputTokensPerMinute: 0.02,
              },
              accounts: [],
            },
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    });

    const result = await report.execute(context);
    const json = result.json as {
      grandTotals: { totalTokens: number };
    };

    assertEquals(json.grandTotals.totalTokens, 10000);
  },
});
