// AWS Bedrock Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { model } from "./bedrock_usage.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockCloudWatch(handler: (command: unknown) => unknown): () => void {
  const original = CloudWatchClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  CloudWatchClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    CloudWatchClient.prototype.send = original;
  };
}

// =============================================================================
// Type aliases
// =============================================================================

type ScanContext = Parameters<typeof model.methods.scan_accounts.execute>[1];

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/bedrock-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments defaults profiles to ['default']", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.profiles, ["default"]);
  assertEquals(parsed.regions, ["us-east-1", "us-west-2"]);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
  assertEquals("active_models" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_accounts" in model.methods, true);
  assertEquals("get_token_usage" in model.methods, true);
  assertEquals("list_active_models" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_accounts rejects days=0", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_accounts accepts days=1", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_accounts defaults days to 30", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

Deno.test("get_token_usage rejects days=0", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

// =============================================================================
// Execute-level Tests
// =============================================================================

Deno.test({
  name: "scan_accounts returns metrics for 2 models",
  sanitizeResources: false,
  fn: async () => {
    // deno-lint-ignore no-explicit-any
    const restore = mockCloudWatch((command: any) => {
      const name = command.constructor?.name || "";
      if (name === "ListMetricsCommand") {
        return {
          Metrics: [
            {
              Namespace: "AWS/Bedrock",
              MetricName: "InputTokenCount",
              Dimensions: [
                { Name: "ModelId", Value: "anthropic.claude-3-sonnet" },
              ],
            },
            {
              Namespace: "AWS/Bedrock",
              MetricName: "InputTokenCount",
              Dimensions: [
                { Name: "ModelId", Value: "amazon.titan-text-express" },
              ],
            },
          ],
          NextToken: undefined,
        };
      }
      // GetMetricDataCommand
      return {
        MetricDataResults: [
          { Id: "input_tokens", Values: [5000, 3000] },
          { Id: "output_tokens", Values: [2000, 1000] },
          { Id: "invocations", Values: [100] },
        ],
      };
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], regions: ["us-east-1"] },
        definition: {
          id: "test-id",
          name: "bedrock-usage",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.scan_accounts.execute(
        { days: 7 },
        context as unknown as ScanContext,
      );

      assertExists(result.dataHandles);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "scan_results");

      const data = resources[0].data as {
        accounts: Array<{
          profile: string;
          models: Array<{ modelId: string; totalTokens: number }>;
          totalTokens: number;
        }>;
        totals: { totalTokens: number };
      };

      assertEquals(data.accounts.length, 1);
      assertEquals(data.accounts[0].profile, "default");
      assertEquals(data.accounts[0].models.length, 2);
      assertEquals(data.totals.totalTokens, data.accounts[0].totalTokens);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "scan_accounts skips regions with no usage",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Metrics: [],
      NextToken: undefined,
      MetricDataResults: [
        { Id: "input_tokens", Values: [] },
        { Id: "output_tokens", Values: [] },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], regions: ["us-east-1"] },
        definition: {
          id: "test-id",
          name: "bedrock-usage",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.scan_accounts.execute(
        { days: 7 },
        context as unknown as ScanContext,
      );

      assertExists(result.dataHandles);
      const resources = getWrittenResources();
      const data = resources[0].data as {
        accounts: Array<unknown>;
        totals: { totalTokens: number };
      };
      assertEquals(data.accounts.length, 0);
      assertEquals(data.totals.totalTokens, 0);
    } finally {
      restore();
    }
  },
});
