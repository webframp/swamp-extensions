// Azure OpenAI Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./openai_usage.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

const OriginalCommand = Deno.Command;
type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  class MockCommand {
    #cmd: string;
    #args: string[];
    constructor(
      cmd: string,
      options: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = options.args ?? [];
    }
    output() {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success ? new Uint8Array() : encoder.encode("failed"),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

// =============================================================================
// Type aliases
// =============================================================================

type ScanContext = Parameters<
  typeof model.methods.scan_subscriptions.execute
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

Deno.test("model globalArguments requires subscriptions array", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("model globalArguments accepts subscriptions array", () => {
  const parsed = model.globalArguments.parse({
    subscriptions: ["sub-123"],
  });
  assertEquals(parsed.subscriptions, ["sub-123"]);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
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

Deno.test("scan_subscriptions defaults days to 30", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

// =============================================================================
// Execute-level Tests
// =============================================================================

Deno.test({
  name: "scan_subscriptions discovers resources and returns metrics",
  sanitizeResources: false,
  fn: async () => {
    await withMockedCommand(
      (cmd, args) => {
        if (cmd !== "az") return { stdout: "", success: false };

        // List AI resources
        if (args.includes("account") && args.includes("list")) {
          return {
            stdout: JSON.stringify([
              {
                name: "my-openai",
                resourceGroup: "rg-ai",
                location: "eastus",
                kind: "OpenAI",
              },
            ]),
            success: true,
          };
        }

        // Monitor metrics - check if dimension query
        if (args.includes("metrics") && args.includes("list")) {
          if (args.includes("--dimension")) {
            // Per-deployment breakdown
            return {
              stdout: JSON.stringify({
                value: [
                  {
                    name: { value: "ProcessedPromptTokens" },
                    timeseries: [
                      {
                        metadatavalues: [
                          {
                            name: { value: "modeldeploymentname" },
                            value: "gpt-4o",
                          },
                        ],
                        data: [{ total: 5000 }],
                      },
                    ],
                  },
                  {
                    name: { value: "GeneratedTokens" },
                    timeseries: [
                      {
                        metadatavalues: [
                          {
                            name: { value: "modeldeploymentname" },
                            value: "gpt-4o",
                          },
                        ],
                        data: [{ total: 2000 }],
                      },
                    ],
                  },
                ],
              }),
              success: true,
            };
          }
          // Aggregate metrics
          return {
            stdout: JSON.stringify({
              value: [
                {
                  name: { value: "ProcessedPromptTokens" },
                  timeseries: [{ data: [{ total: 5000 }] }],
                },
                {
                  name: { value: "GeneratedTokens" },
                  timeseries: [{ data: [{ total: 2000 }] }],
                },
              ],
            }),
            success: true,
          };
        }

        return { stdout: "[]", success: true };
      },
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: { subscriptions: ["sub-abc-123"] },
          definition: {
            id: "test-id",
            name: "azure-ai-usage",
            version: 1,
            tags: {},
          },
        });

        const result = await model.methods.scan_subscriptions.execute(
          { days: 7 },
          context as unknown as ScanContext,
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
        };

        assertEquals(data.resources.length, 1);
        assertEquals(data.resources[0].resourceName, "my-openai");
        assertEquals(data.resources[0].totalTokens, 7000);
        assertEquals(data.resources[0].deployments[0].deploymentName, "gpt-4o");
        assertEquals(data.totals.promptTokens, 5000);
        assertEquals(data.totals.totalTokens, 7000);
      },
    );
  },
});

Deno.test({
  name: "scan_subscriptions handles empty subscription gracefully",
  sanitizeResources: false,
  fn: async () => {
    await withMockedCommand(
      (cmd, args) => {
        if (cmd !== "az") return { stdout: "", success: false };
        if (args.includes("account") && args.includes("list")) {
          return { stdout: "[]", success: true };
        }
        return { stdout: "[]", success: true };
      },
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: { subscriptions: ["empty-sub"] },
          definition: {
            id: "test-id",
            name: "azure-ai-usage",
            version: 1,
            tags: {},
          },
        });

        const result = await model.methods.scan_subscriptions.execute(
          { days: 7 },
          context as unknown as ScanContext,
        );

        assertExists(result.dataHandles);
        const resources = getWrittenResources();
        const data = resources[0].data as {
          resources: Array<unknown>;
          totals: { totalTokens: number };
        };
        assertEquals(data.resources.length, 0);
        assertEquals(data.totals.totalTokens, 0);
      },
    );
  },
});
