// AWS Cost Explorer Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { CostExplorerClient } from "npm:@aws-sdk/client-cost-explorer@3.1139.0";
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

Deno.test("model defines per-query-type resource specs", () => {
  assertEquals("costTrend" in model.resources, true);
  assertEquals("costByService" in model.resources, true);
  assertEquals("costByUsageType" in model.resources, true);
  assertEquals("costDrivers" in model.resources, true);
  assertEquals("costComparison" in model.resources, true);
  assertEquals("costForPeriod" in model.resources, true);
});

Deno.test("model defines all expected methods", () => {
  assertEquals("get_cost_by_service" in model.methods, true);
  assertEquals("get_cost_by_usage_type" in model.methods, true);
  assertEquals("get_cost_trend" in model.methods, true);
  assertEquals("get_top_cost_drivers" in model.methods, true);
  assertEquals("get_cost_comparison" in model.methods, true);
  assertEquals("get_cost_for_period" in model.methods, true);
});

// =============================================================================
// get_cost_by_service Tests
// =============================================================================

Deno.test({
  name: "get_cost_by_service breaks down spend by service with percentages",
  sanitizeResources: false,
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
      assertEquals(resources[0].specName, "costByService");
      assertEquals(resources[0].name, "30d");

      const data = resources[0].data as {
        services: Array<{
          service: string;
          amount: number;
          unit: string;
          percentage: number;
        }>;
        totalCost: number;
        days: number;
        fetchedAt: string;
      };
      assertEquals(data.days, 30);
      assertEquals(data.totalCost, 200);
      assertEquals(data.services.length, 2);

      // Sorted by amount descending
      assertEquals(data.services[0].service, "Amazon EC2");
      assertEquals(data.services[0].amount, 150);
      assertEquals(data.services[0].percentage, 75);

      assertEquals(data.services[1].service, "Amazon S3");
      assertEquals(data.services[1].amount, 50);
      assertEquals(data.services[1].percentage, 25);
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
  sanitizeResources: false,
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
      assertEquals(resources[0].specName, "costByUsageType");
      assertEquals(resources[0].name, "30d");

      const data = resources[0].data as {
        service: string;
        usageTypes: Array<{
          usageType: string;
          amount: number;
          unit: string;
        }>;
        totalCost: number;
        days: number;
        fetchedAt: string;
      };
      assertEquals(data.service, "Amazon EC2");
      assertEquals(data.days, 30);
      assertEquals(data.usageTypes.length, 2);

      // Sorted by amount descending
      assertEquals(data.usageTypes[0].usageType, "USW2-BoxUsage:t3.medium");
      assertEquals(data.usageTypes[0].amount, 80);
      assertEquals(data.usageTypes[1].usageType, "USW2-EBS:VolumeUsage");
      assertEquals(data.usageTypes[1].amount, 20);
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
  sanitizeResources: false,
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
      assertEquals(resources[0].specName, "costTrend");
      assertEquals(resources[0].name, "6d");

      const data = resources[0].data as {
        dataPoints: Array<{ date: string; amount: number }>;
        trend: string;
        totalCost: number;
        days: number;
        fetchedAt: string;
      };
      assertEquals(data.dataPoints.length, 6);
      assertEquals(data.trend, "increasing");
      assertEquals(data.days, 6);
      // 10 + 11 + 12 + 20 + 22 + 25 = 100
      assertEquals(data.totalCost, 100);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_trend detects stable trend when change is within 10%",
  sanitizeResources: false,
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

      await model.methods.get_cost_trend.execute(
        { days: 4 },
        context as ExecuteContext,
      );

      const resources = getWrittenResources();
      const data = resources[0].data as { trend: string };
      assertEquals(data.trend, "stable");
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
  sanitizeResources: false,
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
      assertEquals(resources[0].specName, "costDrivers");
      assertEquals(resources[0].name, "30d");

      const data = resources[0].data as {
        drivers: Array<{
          service: string;
          usageType: string;
          amount: number;
          unit: string;
        }>;
        totalCost: number;
        days: number;
        fetchedAt: string;
      };
      assertEquals(data.drivers.length, 2);
      assertEquals(data.days, 30);

      // Top 2 sorted by amount descending
      assertEquals(data.drivers[0].service, "Amazon EC2");
      assertEquals(data.drivers[0].usageType, "BoxUsage:t3.medium");
      assertEquals(data.drivers[0].amount, 100);

      assertEquals(data.drivers[1].service, "Amazon EC2");
      assertEquals(data.drivers[1].usageType, "EBS:VolumeUsage");
      assertEquals(data.drivers[1].amount, 50);
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
  sanitizeResources: false,
  fn: async () => {
    let callCount = 0;
    const restore = mockCostExplorer(() => {
      callCount++;
      if (callCount === 1) {
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
      assertEquals(resources[0].specName, "costComparison");
      assertEquals(resources[0].name, "30d");

      const data = resources[0].data as {
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
        days: number;
        fetchedAt: string;
      };
      assertEquals(data.currentPeriod.total, 250);
      assertEquals(data.previousPeriod.total, 210);
      assertEquals(data.totalDelta, 40);
      assertEquals(data.days, 30);

      assertEquals(data.services.length, 2);

      const ec2 = data.services.find((s) => s.service === "Amazon EC2")!;
      assertEquals(ec2.currentAmount, 200);
      assertEquals(ec2.previousAmount, 150);
      assertEquals(ec2.delta, 50);

      const s3 = data.services.find((s) => s.service === "Amazon S3")!;
      assertEquals(s3.currentAmount, 50);
      assertEquals(s3.previousAmount, 60);
      assertEquals(s3.delta, -10);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// upgradeAttributes Tests
// =============================================================================

// The 2026.08.10.1 upgrade (index 2) backfills totalCost for old cost_trend
// resources that used the envelope shape.
const upgrade_08_10 = model.upgrades[2];

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

  const result = upgrade_08_10.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
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

  const result = upgrade_08_10.upgradeAttributes(old);
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
      totalCost: 99.99,
    },
    fetchedAt: "2026-08-04T00:00:00Z",
  };

  const result = upgrade_08_10.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
  assertEquals(data.totalCost, 99.99);
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

  const result = upgrade_08_10.upgradeAttributes(old);
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

  const result = upgrade_08_10.upgradeAttributes(old);
  const data = result.data as { totalCost: number };
  assertEquals(data.totalCost, 15);
});

// The 2026.08.13.1 upgrade (index 3) flattens the envelope shape to per-spec output.
const upgrade_08_13 = model.upgrades[3];

Deno.test("upgrade 2026.08.13.1: flattens cost_trend envelope to top-level fields", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: {
      dataPoints: [{ date: "2026-08-01", amount: 50 }],
      trend: "stable",
      totalCost: 50,
    },
    fetchedAt: "2026-08-13T00:00:00Z",
  };

  const result = upgrade_08_13.upgradeAttributes(old);
  assertEquals(result.dataPoints, [{ date: "2026-08-01", amount: 50 }]);
  assertEquals(result.trend, "stable");
  assertEquals(result.totalCost, 50);
  assertEquals(result.days, 7);
  assertEquals(result.fetchedAt, "2026-08-13T00:00:00Z");
  assertEquals("queryType" in result, false);
  assertEquals("region" in result, false);
});

Deno.test("upgrade 2026.08.13.1: flattens cost_by_service envelope", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_by_service",
    data: [
      { service: "EC2", amount: 100, unit: "USD", percentage: 66.67 },
      { service: "S3", amount: 50, unit: "USD", percentage: 33.33 },
    ],
    fetchedAt: "2026-08-13T00:00:00Z",
  };

  const result = upgrade_08_13.upgradeAttributes(old);
  assertEquals(result.services, old.data);
  assertEquals(result.totalCost, 150);
  assertEquals(result.days, 30);
  assertEquals(result.fetchedAt, "2026-08-13T00:00:00Z");
});

Deno.test("upgrade 2026.08.13.1: passes through non-envelope data unchanged", () => {
  const alreadyFlat = {
    dataPoints: [{ date: "2026-08-01", amount: 10 }],
    trend: "stable",
    totalCost: 10,
    days: 7,
    fetchedAt: "2026-08-13T00:00:00Z",
  };

  const result = upgrade_08_13.upgradeAttributes(alreadyFlat);
  assertEquals(result, alreadyFlat);
});

Deno.test("upgrade 2026.08.13.1: handles null data gracefully", () => {
  const old = {
    region: "us-east-1",
    queryType: "cost_trend",
    data: null,
    fetchedAt: "2026-08-13T00:00:00Z",
  };

  const result = upgrade_08_13.upgradeAttributes(old);
  assertEquals(result, old); // returned unchanged
});

// =============================================================================
// get_cost_for_period Tests
// =============================================================================

Deno.test({
  name:
    "get_cost_for_period: filtered service groups by usage type and sums total",
  sanitizeResources: false,
  fn: async () => {
    // Capture the command the method sends so we can assert the API wiring.
    let captured: { input?: Record<string, unknown> } = {};
    const restore = mockCostExplorer((command) => {
      captured = command as { input?: Record<string, unknown> };
      return {
        ResultsByTime: [{
          Groups: [
            {
              Keys: ["MP:usage_fee-Units"],
              Metrics: { UnblendedCost: { Amount: "35595.94", Unit: "USD" } },
            },
            {
              Keys: ["MP:c4e_usage_based_seat_day-Units"],
              Metrics: { UnblendedCost: { Amount: "0", Unit: "USD" } },
            },
          ],
        }],
      };
    });
    try {
      const { context, getWrittenResources } = makeContext();

      const result = await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-10-01",
          service: "Claude Enterprise",
          granularity: "MONTHLY",
        },
        context as ExecuteContext,
      );

      assertEquals(result.dataHandles.length, 1);

      // API wiring: explicit period, SERVICE filter, GroupBy USAGE_TYPE.
      const input = captured.input as {
        TimePeriod: { Start: string; End: string };
        Granularity: string;
        Filter?: { Dimensions?: { Key: string; Values: string[] } };
        GroupBy: Array<{ Type: string; Key: string }>;
      };
      assertEquals(input.TimePeriod, {
        Start: "2026-09-01",
        End: "2026-10-01",
      });
      assertEquals(input.Granularity, "MONTHLY");
      assertEquals(input.Filter?.Dimensions?.Key, "SERVICE");
      assertEquals(input.Filter?.Dimensions?.Values, ["Claude Enterprise"]);
      assertEquals(input.GroupBy[0].Key, "USAGE_TYPE");

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "costForPeriod");
      // Instance key includes period AND service so filtered/unfiltered and
      // different months never clobber each other.
      assertEquals(
        resources[0].name,
        "2026-09-01_2026-10-01_Claude Enterprise",
      );

      const data = resources[0].data as {
        service: string | null;
        start: string;
        end: string;
        granularity: string;
        groups: Array<{ key: string; amount: number; unit: string }>;
        totalCost: number;
      };
      assertEquals(data.service, "Claude Enterprise");
      assertEquals(data.start, "2026-09-01");
      assertEquals(data.end, "2026-10-01");
      assertEquals(data.granularity, "MONTHLY");
      assertEquals(data.totalCost, 35595.94);
      // Sorted by amount descending; zero-dollar seat line retained.
      assertEquals(data.groups.length, 2);
      assertEquals(data.groups[0].key, "MP:usage_fee-Units");
      assertEquals(data.groups[0].amount, 35595.94);
      assertEquals(data.groups[1].key, "MP:c4e_usage_based_seat_day-Units");
      assertEquals(data.groups[1].amount, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_for_period: unfiltered groups by service with no filter",
  sanitizeResources: false,
  fn: async () => {
    let captured: { input?: Record<string, unknown> } = {};
    const restore = mockCostExplorer((command) => {
      captured = command as { input?: Record<string, unknown> };
      return {
        ResultsByTime: [{
          Groups: [
            {
              Keys: ["Claude Enterprise"],
              Metrics: { UnblendedCost: { Amount: "35595.94", Unit: "USD" } },
            },
            {
              Keys: ["AmazonCloudWatch"],
              Metrics: { UnblendedCost: { Amount: "100.00", Unit: "USD" } },
            },
          ],
        }],
      };
    });
    try {
      const { context, getWrittenResources } = makeContext();

      await model.methods.get_cost_for_period.execute(
        { start: "2026-09-01", end: "2026-10-01", granularity: "MONTHLY" },
        context as ExecuteContext,
      );

      const input = captured.input as {
        Filter?: unknown;
        GroupBy: Array<{ Type: string; Key: string }>;
      };
      // No service => no Filter, group by SERVICE.
      assertEquals(input.Filter, undefined);
      assertEquals(input.GroupBy[0].Key, "SERVICE");

      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "costForPeriod");
      // Instance key omits the service suffix when unfiltered.
      assertEquals(resources[0].name, "2026-09-01_2026-10-01");

      const data = resources[0].data as {
        service: string | null;
        groups: Array<{ key: string; amount: number }>;
        totalCost: number;
      };
      assertEquals(data.service, null);
      assertEquals(data.totalCost, 35695.94);
      assertEquals(data.groups[0].key, "Claude Enterprise");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_for_period: aggregates groups across DAILY time buckets",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      // Same usage type appears in two daily buckets; must sum, not duplicate.
      ResultsByTime: [
        {
          Groups: [{
            Keys: ["MP:usage_fee-Units"],
            Metrics: { UnblendedCost: { Amount: "1000.00", Unit: "USD" } },
          }],
        },
        {
          Groups: [{
            Keys: ["MP:usage_fee-Units"],
            Metrics: { UnblendedCost: { Amount: "250.50", Unit: "USD" } },
          }],
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-09-03",
          service: "Claude Enterprise",
          granularity: "DAILY",
        },
        context as ExecuteContext,
      );
      const data = getWrittenResources()[0].data as {
        groups: Array<{ key: string; amount: number }>;
        totalCost: number;
      };
      assertEquals(data.groups.length, 1);
      assertEquals(data.groups[0].amount, 1250.5);
      assertEquals(data.totalCost, 1250.5);
    } finally {
      restore();
    }
  },
});

Deno.test("get_cost_for_period: rejects malformed start date", async () => {
  // No client should be created; the throw happens before any API call.
  await assertRejects(
    () =>
      model.methods.get_cost_for_period.execute(
        { start: "2026/09/01", end: "2026-10-01", granularity: "MONTHLY" },
        makeContext().context as ExecuteContext,
      ),
    Error,
    "start must be a YYYY-MM-DD date",
  );
});

Deno.test("get_cost_for_period: rejects impossible calendar date", async () => {
  await assertRejects(
    () =>
      model.methods.get_cost_for_period.execute(
        { start: "2026-02-30", end: "2026-03-05", granularity: "MONTHLY" },
        makeContext().context as ExecuteContext,
      ),
    Error,
    "not a valid calendar date",
  );
});

Deno.test("get_cost_for_period: rejects end on or before start", async () => {
  await assertRejects(
    () =>
      model.methods.get_cost_for_period.execute(
        { start: "2026-10-01", end: "2026-10-01", granularity: "MONTHLY" },
        makeContext().context as ExecuteContext,
      ),
    Error,
    "must be strictly after start",
  );
});

Deno.test("get_cost_for_period: rejects a far-future end date", async () => {
  await assertRejects(
    () =>
      model.methods.get_cost_for_period.execute(
        { start: "2026-09-01", end: "2099-01-01", granularity: "MONTHLY" },
        makeContext().context as ExecuteContext,
      ),
    Error,
    "in the future beyond",
  );
});

Deno.test({
  name: "get_cost_for_period: empty results yield zero total and no groups",
  sanitizeResources: false,
  fn: async () => {
    // CE returns a bucket with no groups (e.g. a service with no spend in
    // the window). Must be a truthful zero, not a crash.
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [{ Groups: [] }],
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-10-01",
          service: "Nonexistent Service",
          granularity: "MONTHLY",
        },
        context as ExecuteContext,
      );
      const data = getWrittenResources()[0].data as {
        groups: unknown[];
        totalCost: number;
        service: string | null;
      };
      assertEquals(data.groups.length, 0);
      assertEquals(data.totalCost, 0);
      assertEquals(data.service, "Nonexistent Service");
    } finally {
      restore();
    }
  },
});

Deno.test("get_cost_for_period: rejects malformed end date", async () => {
  // Guards against a regression that validates start but not end.
  await assertRejects(
    () =>
      model.methods.get_cost_for_period.execute(
        { start: "2026-09-01", end: "2026-10-32", granularity: "MONTHLY" },
        makeContext().context as ExecuteContext,
      ),
    Error,
    "not a valid calendar date",
  );
});

Deno.test({
  name: "get_cost_for_period: follows NextPageToken and sums across pages",
  sanitizeResources: false,
  fn: async () => {
    // First send returns a token; second returns none. Same key on both
    // pages must sum; truncated must be false (we exhausted the pages).
    const pages = [
      {
        NextPageToken: "page2",
        ResultsByTime: [{
          Groups: [{
            Keys: ["MP:usage_fee-Units"],
            Metrics: { UnblendedCost: { Amount: "20000.00", Unit: "USD" } },
          }],
        }],
      },
      {
        ResultsByTime: [{
          Groups: [{
            Keys: ["MP:usage_fee-Units"],
            Metrics: { UnblendedCost: { Amount: "15595.94", Unit: "USD" } },
          }],
        }],
      },
    ];
    let call = 0;
    const sentTokens: Array<string | undefined> = [];
    const restore = mockCostExplorer((command) => {
      const input = (command as { input: { NextPageToken?: string } }).input;
      sentTokens.push(input.NextPageToken);
      return pages[call++];
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-10-01",
          service: "Claude Enterprise",
          granularity: "MONTHLY",
        },
        context as ExecuteContext,
      );
      // First call carries no token; second carries the token from page 1.
      assertEquals(sentTokens, [undefined, "page2"]);

      const data = getWrittenResources()[0].data as {
        groups: Array<{ key: string; amount: number }>;
        totalCost: number;
        truncated: boolean;
      };
      assertEquals(data.groups.length, 1);
      assertEquals(data.groups[0].amount, 35595.94);
      assertEquals(data.totalCost, 35595.94);
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_for_period: single page sets truncated false",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCostExplorer(() => ({
      ResultsByTime: [{
        Groups: [{
          Keys: ["MP:usage_fee-Units"],
          Metrics: { UnblendedCost: { Amount: "100.00", Unit: "USD" } },
        }],
      }],
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-10-01",
          service: "Claude Enterprise",
          granularity: "MONTHLY",
        },
        context as ExecuteContext,
      );
      const data = getWrittenResources()[0].data as { truncated: boolean };
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_cost_for_period: hits page cap and marks truncated true",
  sanitizeResources: false,
  fn: async () => {
    // A response that always returns a NextPageToken must terminate at the
    // 50-page cap with truncated=true (never an infinite loop).
    let sends = 0;
    const restore = mockCostExplorer(() => {
      sends++;
      return {
        NextPageToken: `page-${sends}`,
        ResultsByTime: [{
          Groups: [{
            Keys: ["MP:usage_fee-Units"],
            Metrics: { UnblendedCost: { Amount: "1.00", Unit: "USD" } },
          }],
        }],
      };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_cost_for_period.execute(
        {
          start: "2026-09-01",
          end: "2026-10-01",
          service: "Claude Enterprise",
          granularity: "MONTHLY",
        },
        context as ExecuteContext,
      );
      // Exactly 50 pages read, then stopped by the cap.
      assertEquals(sends, 50);
      const data = getWrittenResources()[0].data as {
        truncated: boolean;
        totalCost: number;
      };
      assertEquals(data.truncated, true);
      // 50 pages × $1.00 of the same usage type, summed.
      assertEquals(data.totalCost, 50);
    } finally {
      restore();
    }
  },
});
