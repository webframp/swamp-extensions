// AWS Cost Estimate Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { PricingClient } from "npm:@aws-sdk/client-pricing@3.1010.0";
import { model } from "./cost_estimate.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockPricing(handler: (command: unknown) => unknown): () => void {
  const original = PricingClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  PricingClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    PricingClient.prototype.send = original;
  };
}

// =============================================================================
// Test Data
// =============================================================================

function makePriceResponse(hourlyRate: string) {
  return {
    PriceList: [
      JSON.stringify({
        product: { attributes: { instanceType: "t3.medium" } },
        terms: {
          OnDemand: {
            "term-abc": {
              priceDimensions: {
                "dim-xyz": {
                  pricePerUnit: { USD: hourlyRate },
                },
              },
            },
          },
        },
      }),
    ],
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/cost-estimate");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test(
  "model globalArguments has pricingRegion defaulting to us-east-1",
  () => {
    const parsed = model.globalArguments.parse({});
    assertEquals(parsed.pricingRegion, "us-east-1");
  },
);

Deno.test("model defines expected resources", () => {
  assertEquals("estimate" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("estimate_ec2" in model.methods, true);
  assertEquals("estimate_rds" in model.methods, true);
  assertEquals("estimate_from_spec" in model.methods, true);
});

// =============================================================================
// estimate_ec2 Tests
// =============================================================================

Deno.test({
  name: "estimate_ec2 computes monthly costs and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => makePriceResponse("0.0416"));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { pricingRegion: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-cost-estimate",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.estimate_ec2.execute(
        {
          inventory: [
            {
              instanceId: "i-web1",
              instanceType: "t3.medium",
              availabilityZone: "us-east-1a",
              platform: null,
              tags: { Name: "web" },
            },
            {
              instanceId: "i-web2",
              instanceType: "t3.medium",
              availabilityZone: "us-east-1b",
              platform: null,
            },
          ],
        },
        context as unknown as Parameters<
          typeof model.methods.estimate_ec2.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "estimate");
      assertEquals(resources[0].name, "ec2");

      const data = resources[0].data as {
        resourceType: string;
        items: Array<{
          instanceId: string;
          instanceType: string;
          hourlyRate: number;
          monthlyEstimate: number;
          tags: Record<string, string>;
        }>;
        totalMonthly: number;
        currency: string;
      };

      assertEquals(data.resourceType, "ec2");
      assertEquals(data.currency, "USD");
      assertEquals(data.items.length, 2);

      // hourlyRate = 0.0416, monthly = 0.0416 * 730 = 30.368
      const expectedMonthly = 0.0416 * 730;
      assertEquals(data.items[0].hourlyRate, 0.0416);
      assertEquals(
        Math.abs(data.items[0].monthlyEstimate - expectedMonthly) < 0.01,
        true,
      );
      assertEquals(data.items[0].tags, { Name: "web" });
      assertEquals(data.items[1].tags, {});

      // totalMonthly = 2 * 30.368 = 60.736
      assertEquals(
        Math.abs(data.totalMonthly - expectedMonthly * 2) < 0.01,
        true,
      );
    } finally {
      restore();
    }
  },
});

// =============================================================================
// estimate_rds Tests
// =============================================================================

Deno.test({
  name: "estimate_rds computes monthly costs with storage and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => makePriceResponse("0.171"));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { pricingRegion: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-cost-estimate",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.estimate_rds.execute(
        {
          inventory: [
            {
              dbInstanceId: "mydb",
              dbInstanceClass: "db.t3.medium",
              engine: "postgres",
              availabilityZone: "us-east-1a",
              multiAz: false,
              allocatedStorage: 100,
            },
          ],
          storageRatePerGb: 0.115,
        },
        context as unknown as Parameters<
          typeof model.methods.estimate_rds.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "estimate");
      assertEquals(resources[0].name, "rds");

      const data = resources[0].data as {
        resourceType: string;
        items: Array<{
          dbInstanceId: string;
          dbInstanceClass: string;
          engine: string;
          storageGb: number;
          hourlyRate: number;
          monthlyEstimate: number;
        }>;
        totalMonthly: number;
        currency: string;
      };

      assertEquals(data.resourceType, "rds");
      assertEquals(data.items.length, 1);

      const item = data.items[0];
      assertEquals(item.dbInstanceId, "mydb");
      assertEquals(item.storageGb, 100);
      assertEquals(item.hourlyRate, 0.171);

      // compute = 0.171 * 730 = 124.83, storage = 100 * 0.115 = 11.5
      // total = 136.33
      const expectedCompute = 0.171 * 730;
      const expectedStorage = 100 * 0.115;
      const expectedTotal = expectedCompute + expectedStorage;
      assertEquals(
        Math.abs(item.monthlyEstimate - expectedTotal) < 0.01,
        true,
      );
      assertEquals(
        Math.abs(data.totalMonthly - expectedTotal) < 0.01,
        true,
      );
    } finally {
      restore();
    }
  },
});

// =============================================================================
// estimate_from_spec Tests
// =============================================================================

Deno.test({
  name: "estimate_from_spec computes costs for planned EC2 instances",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => makePriceResponse("0.0416"));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { pricingRegion: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-cost-estimate",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.estimate_from_spec.execute(
        {
          ec2Instances: [
            {
              name: "web",
              instanceType: "t3.medium",
              region: "us-east-1",
              platform: "linux" as const,
              count: 2,
            },
          ],
        },
        context as unknown as Parameters<
          typeof model.methods.estimate_from_spec.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "estimate");
      assertEquals(resources[0].name, "spec");

      const data = resources[0].data as {
        resourceType: string;
        items: Array<{
          name: string;
          type: string;
          count: number;
          hourlyRate: number;
          monthlyPerUnit: number;
          monthlyTotal: number;
        }>;
        totalMonthly: number;
      };

      assertEquals(data.resourceType, "spec");
      assertEquals(data.items.length, 1);
      assertEquals(data.items[0].name, "web");
      assertEquals(data.items[0].count, 2);
      assertEquals(data.items[0].hourlyRate, 0.0416);

      // monthlyTotal = 2 * (0.0416 * 730) = 60.736
      const expectedTotal = 2 * (0.0416 * 730);
      assertEquals(
        Math.abs(data.items[0].monthlyTotal - expectedTotal) < 0.01,
        true,
      );
      assertEquals(
        Math.abs(data.totalMonthly - expectedTotal) < 0.01,
        true,
      );
    } finally {
      restore();
    }
  },
});
