// AWS Cost Explorer Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CostExplorerClient } from "npm:@aws-sdk/client-cost-explorer@3.1104.0";
import { model } from "./cost_explorer.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockCostExplorer(handler: (command: unknown) => unknown): () => void {
  const original = CostExplorerClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  CostExplorerClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    CostExplorerClient.prototype.send = original;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: { id: "test-id", name: "aws-costs", version: 1, tags: {} },
  });
}

// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/cost-explorer");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines costs resource", () => {
  assertEquals("costs" in model.resources, true);
});

Deno.test("model defines all expected methods", () => {
  assertEquals("get_cost_by_service" in model.methods, true);
  assertEquals("get_cost_by_usage_type" in model.methods, true);
  assertEquals("get_cost_trend" in model.methods, true);
  assertEquals("get_top_cost_drivers" in model.methods, true);
  assertEquals("get_cost_comparison" in model.methods, true);
});

// =============================================================================
// get_cost_by_service Tests
// =============================================================================

Deno.test({
  name: "get_cost_by_service breaks down spend by service with percentages",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [{
        Groups: [
          {
            Keys: ["Amazon EC2"],
            Metrics: {
              UnblendedCost: { Amount: "150.00", Unit: "USD" },
            },
          },
          {
            Keys: ["Amazon S3"],
            Metrics: {
              UnblendedCost: { Amount: "50.00", Unit: "USD" },
            },
          },
        ],
      }],
    }));
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_by_service.execute(
        { days: 30 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costs");
      assertEquals(resources[0].name, "by-service-30d");

      const data = resources[0].data as {
        region: string;
        queryType: string;
        data: Array<{
          service: string;
          amount: number;
          unit: string;
          percentage: number;
        }>;
      };
      assertEquals(data.region, "us-east-1");
      assertEquals(data.queryType, "cost_by_service");
      assertEquals(data.data.length, 2);

      // Sorted by amount descending
      assertEquals(data.data[0].service, "Amazon EC2");
      assertEquals(data.data[0].amount, 150);
      assertEquals(data.data[0].percentage, 75);

      assertEquals(data.data[1].service, "Amazon S3");
      assertEquals(data.data[1].amount, 50);
      assertEquals(data.data[1].percentage, 25);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_cost_by_usage_type Tests
// =============================================================================

Deno.test({
  name: "get_cost_by_usage_type breaks down service spend by usage type",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [{
        Groups: [
          {
            Keys: ["USW2-BoxUsage:t3.medium"],
            Metrics: {
              UnblendedCost: { Amount: "80.00", Unit: "USD" },
            },
          },
          {
            Keys: ["USW2-EBS:VolumeUsage"],
            Metrics: {
              UnblendedCost: { Amount: "20.00", Unit: "USD" },
            },
          },
        ],
      }],
    }));
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_by_usage_type.execute(
        { service: "Amazon EC2", days: 30 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costs");
      assertEquals(resources[0].name, "by-usage-type-30d");

      const data = resources[0].data as {
        queryType: string;
        data: Array<{
          usageType: string;
          amount: number;
          unit: string;
        }>;
      };
      assertEquals(data.queryType, "cost_by_usage_type");
      assertEquals(data.data.length, 2);

      // Sorted by amount descending
      assertEquals(data.data[0].usageType, "USW2-BoxUsage:t3.medium");
      assertEquals(data.data[0].amount, 80);
      assertEquals(data.data[1].usageType, "USW2-EBS:VolumeUsage");
      assertEquals(data.data[1].amount, 20);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_cost_trend Tests
// =============================================================================

Deno.test({
  name: "get_cost_trend detects increasing trend when second half is higher",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-09" },
          Total: { UnblendedCost: { Amount: "10.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-10" },
          Total: { UnblendedCost: { Amount: "11.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-11" },
          Total: { UnblendedCost: { Amount: "12.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-12" },
          Total: { UnblendedCost: { Amount: "20.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-13" },
          Total: { UnblendedCost: { Amount: "22.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-14" },
          Total: { UnblendedCost: { Amount: "25.00" } },
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_trend.execute(
        { days: 6 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costs");

      const data = resources[0].data as {
        queryType: string;
        data: {
          dataPoints: Array<{ date: string; amount: number }>;
          trend: string;
          totalCost: number;
        };
      };
      assertEquals(data.queryType, "cost_trend");
      assertEquals(data.data.dataPoints.length, 6);
      assertEquals(data.data.trend, "increasing");
      // 10 + 11 + 12 + 20 + 22 + 25 = 100
      assertEquals(data.data.totalCost, 100);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_trend detects stable trend when change is within 10%",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-09" },
          Total: { UnblendedCost: { Amount: "10.00" } },
        },
        {
          TimePeriod: { Start: "2026-04-10" },
          Total: { UnblendedCost: { Amount: "10.50" } },
        },
        {
          TimePeriod: { Start: "2026-04-11" },
          Total: { UnblendedCost: { Amount: "9.80" } },
        },
        {
          TimePeriod: { Start: "2026-04-12" },
          Total: { UnblendedCost: { Amount: "10.20" } },
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_trend.execute(
        { days: 4 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      const data = resources[0].data as {
        data: { trend: string };
      };
      assertEquals(data.data.trend, "stable");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_top_cost_drivers Tests
// =============================================================================

Deno.test({
  name: "get_top_cost_drivers returns limited results sorted by amount",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [{
        Groups: [
          {
            Keys: ["Amazon EC2", "BoxUsage:t3.medium"],
            Metrics: {
              UnblendedCost: { Amount: "100.00", Unit: "USD" },
            },
          },
          {
            Keys: ["Amazon S3", "TimedStorage-ByteHrs"],
            Metrics: {
              UnblendedCost: { Amount: "30.00", Unit: "USD" },
            },
          },
          {
            Keys: ["Amazon EC2", "EBS:VolumeUsage"],
            Metrics: {
              UnblendedCost: { Amount: "50.00", Unit: "USD" },
            },
          },
        ],
      }],
    }));
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_top_cost_drivers.execute(
        { days: 30, limit: 2 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costs");

      const data = resources[0].data as {
        queryType: string;
        data: Array<{
          service: string;
          usageType: string;
          amount: number;
          unit: string;
        }>;
      };
      assertEquals(data.queryType, "top_cost_drivers");
      assertEquals(data.data.length, 2);

      // Top 2 sorted by amount descending
      assertEquals(data.data[0].service, "Amazon EC2");
      assertEquals(data.data[0].usageType, "BoxUsage:t3.medium");
      assertEquals(data.data[0].amount, 100);

      assertEquals(data.data[1].service, "Amazon EC2");
      assertEquals(data.data[1].usageType, "EBS:VolumeUsage");
      assertEquals(data.data[1].amount, 50);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_cost_comparison Tests
// =============================================================================

Deno.test({
  name: "get_cost_comparison calculates deltas between periods",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    let callCount = 0;
    const restore = mockCostExplorer(() => {
      callCount++;
      if (callCount === 1) {
        // Current period
        return {
          ResultsByTime: [{
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: {
                  UnblendedCost: { Amount: "200.00", Unit: "USD" },
                },
              },
              {
                Keys: ["Amazon S3"],
                Metrics: {
                  UnblendedCost: { Amount: "50.00", Unit: "USD" },
                },
              },
            ],
          }],
        };
      }
      // Previous period
      return {
        ResultsByTime: [{
          Groups: [
            {
              Keys: ["Amazon EC2"],
              Metrics: {
                UnblendedCost: { Amount: "150.00", Unit: "USD" },
              },
            },
            {
              Keys: ["Amazon S3"],
              Metrics: {
                UnblendedCost: { Amount: "60.00", Unit: "USD" },
              },
            },
          ],
        }],
      };
    });
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_comparison.execute(
        { days: 30 },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costs");

      const data = resources[0].data as {
        queryType: string;
        data: {
          currentPeriod: { total: number };
          previousPeriod: { total: number };
          totalDelta: number;
          totalDeltaPercent: number;
          services: Array<{
            service: string;
            currentAmount: number;
            previousAmount: number;
            delta: number;
            deltaPercent: number;
          }>;
        };
      };
      assertEquals(data.queryType, "cost_comparison");
      assertEquals(data.data.currentPeriod.total, 250);
      assertEquals(data.data.previousPeriod.total, 210);
      assertEquals(data.data.totalDelta, 40);

      // Services sorted by absolute delta descending
      assertEquals(data.data.services.length, 2);

      // EC2: current=200, previous=150, delta=+50 (largest absolute delta)
      const ec2 = data.data.services.find((s) => s.service === "Amazon EC2")!;
      assertEquals(ec2.currentAmount, 200);
      assertEquals(ec2.previousAmount, 150);
      assertEquals(ec2.delta, 50);

      // S3: current=50, previous=60, delta=-10
      const s3 = data.data.services.find((s) => s.service === "Amazon S3")!;
      assertEquals(s3.currentAmount, 50);
      assertEquals(s3.previousAmount, 60);
      assertEquals(s3.delta, -10);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// upgradeAttributes Tests (2026.08.10.1 — totalCost backfill)
// =============================================================================

const upgradeHandler = model.upgrades[model.upgrades.length - 1];

Deno.test("upgrade 2026.08.10.1: backfills totalCost for cost_trend resource", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: {
      dataPoints: [
        { date: "2026-08-01", amount: 10.5 },
        { date: "2026-08-02", amount: 20.25 },
        { date: "2026-08-03", amount: 5.0 },
      ],
      trend: "decreasing",
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgradeHandler.upgradeAttributes(old);
  const data = result.data as { totalCost: number; dataPoints: unknown[] };
  // 10.5 + 20.25 + 5.0 = 35.75
  assertEquals(data.totalCost, 35.75);
});

Deno.test("upgrade 2026.08.10.1: skips non-cost_trend resources", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_by_service",
    data: {
      services: [{ service: "EC2", amount: 100 }],
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgradeHandler.upgradeAttributes(old);
  const data = result.data as Record<string, unknown>;
  assertEquals("totalCost" in data, false);
});

Deno.test("upgrade 2026.08.10.1: idempotent — does not overwrite existing totalCost", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: {
      dataPoints: [
        { date: "2026-08-01", amount: 10 },
        { date: "2026-08-02", amount: 20 },
      ],
      trend: "stable",
      totalCost: 99.99, // pre-existing value
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgradeHandler.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
  assertEquals(data.totalCost, 99.99); // should NOT be overwritten
});

Deno.test("upgrade 2026.08.10.1: handles empty dataPoints", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: {
      dataPoints: [],
      trend: "stable",
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgradeHandler.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
  assertEquals(data.totalCost, 0);
});

Deno.test("upgrade 2026.08.10.1: handles NaN amount gracefully", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: {
      dataPoints: [
        { date: "2026-08-01", amount: 10 },
        { date: "2026-08-02", amount: NaN },
        { date: "2026-08-03", amount: 5 },
      ],
      trend: "stable",
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgradeHandler.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
  assertEquals(data.totalCost, 15); // NaN skipped, 10 + 5 = 15
});
