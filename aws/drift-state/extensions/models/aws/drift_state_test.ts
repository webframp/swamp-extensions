// AWS Drift State Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./drift_state.ts";

// =============================================================================
// Type aliases
// =============================================================================

type ComputeContext = Parameters<typeof model.methods.compute_drift.execute>[1];
type BaselineContext = Parameters<typeof model.methods.set_baseline.execute>[1];
type DriftedContext = Parameters<typeof model.methods.get_drifted.execute>[1];
type TimelineContext = Parameters<
  typeof model.methods.get_drift_timeline.execute
>[1];
type VelocityContext = Parameters<
  typeof model.methods.get_drift_velocity.execute
>[1];

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

type StoredResources = Record<string, Record<string, unknown>>;

function createDriftContext(
  storedData: StoredData = {},
  storedResources: StoredResources = {},
) {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "drift-state", version: 1, tags: {} },
  });

  const patched = context as unknown as Record<string, unknown>;
  patched.dataRepository = {
    findBySpec: (modelName: string, specName: string) => {
      const modelData = storedData[modelName];
      if (!modelData) {
        return Promise.reject(new Error(`Model ${modelName} not found`));
      }
      return Promise.resolve(modelData[specName] || []);
    },
  };

  patched.readResource = (instance: string) => {
    const data = storedResources[instance];
    if (data) return Promise.resolve({ attributes: data });
    return Promise.resolve(null);
  };

  return { context: patched, getWrittenResources };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/drift-state");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments accepts empty object", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(typeof parsed, "object");
});

Deno.test("model defines expected resources", () => {
  assertEquals("driftResult" in model.resources, true);
  assertEquals("baseline" in model.resources, true);
  assertEquals("timeline" in model.resources, true);
  assertEquals("drifted" in model.resources, true);
  assertEquals("velocity" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("compute_drift" in model.methods, true);
  assertEquals("set_baseline" in model.methods, true);
  assertEquals("get_drifted" in model.methods, true);
  assertEquals("get_drift_timeline" in model.methods, true);
  assertEquals("get_drift_velocity" in model.methods, true);
  assertEquals("refresh" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("compute_drift defaults staleThresholdMinutes to 1440", () => {
  const schema = model.methods.compute_drift.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.staleThresholdMinutes, 1440);
    assertEquals(result.data.adoptModelName, "aws-adopt");
    assertEquals(result.data.inventoryModelName, "aws-inventory");
    assertEquals(result.data.terraformModelName, "terraform");
  }
});

Deno.test("compute_drift accepts source filter", () => {
  const schema = model.methods.compute_drift.arguments;
  const result = schema.safeParse({ sources: ["adopt"] });
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.sources, ["adopt"]);
});

Deno.test("set_baseline defaults source to all", () => {
  const schema = model.methods.set_baseline.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.source, "all");
});

Deno.test("get_drift_timeline requires canonicalId", () => {
  const schema = model.methods.get_drift_timeline.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("get_drift_timeline defaults limit to 50", () => {
  const schema = model.methods.get_drift_timeline.arguments;
  const result = schema.safeParse({ canonicalId: "arn:test" });
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.limit, 50);
});

// =============================================================================
// compute_drift Tests
// =============================================================================

Deno.test({
  name: "compute_drift: no upstream data marks all sources unavailable",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({});

    const result = await model.methods.compute_drift.execute(
      {
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: {
        unavailableSources: string[];
        totalResources: number;
      };
    };
    assertEquals(data.summary.unavailableSources.length, 3);
    assertEquals(data.summary.totalResources, 0);
  },
});

Deno.test({
  name: "compute_drift: no baseline marks resources as unknown",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "aws-adopt": {
        "discovery": [
          {
            attributes: {
              vpcs: [
                {
                  vpcId: "vpc-123",
                  cidrBlock: "10.0.0.0/16",
                  state: "available",
                },
              ],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: { unknown: number; totalResources: number };
      resources: Array<{ driftStatus: string; canonicalId: string }>;
    };
    assertEquals(data.summary.totalResources, 1);
    assertEquals(data.summary.unknown, 1);
    assertEquals(data.resources[0].driftStatus, "unknown");
  },
});

Deno.test({
  name: "compute_drift: identical baseline and current produces in_sync",
  fn: async () => {
    const vpcSnapshot = {
      vpcId: "vpc-123",
      cidrBlock: "10.0.0.0/16",
      state: "available",
    };

    const { context, getWrittenResources } = createDriftContext(
      {
        "aws-adopt": {
          "discovery": [
            {
              attributes: { vpcs: [vpcSnapshot] },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
      {
        adopt: {
          setAt: "2026-06-26T00:00:00Z",
          source: "adopt",
          entries: [
            {
              canonicalId: "adopt:AWS::EC2::VPC:vpc-123",
              resourceType: "AWS::EC2::VPC",
              snapshot: vpcSnapshot,
            },
          ],
        },
      },
    );

    const result = await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: { inSync: number; drifted: number; driftRate: number };
      resources: Array<{ driftStatus: string }>;
    };
    assertEquals(data.summary.inSync, 1);
    assertEquals(data.summary.drifted, 0);
    assertEquals(data.summary.driftRate, 0);
    assertEquals(data.resources[0].driftStatus, "in_sync");
  },
});

Deno.test({
  name: "compute_drift: field-level drift reports correct changed attributes",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {
        "aws-adopt": {
          "discovery": [
            {
              attributes: {
                vpcs: [
                  {
                    vpcId: "vpc-123",
                    cidrBlock: "10.0.0.0/16",
                    state: "available",
                  },
                ],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
      {
        adopt: {
          setAt: "2026-06-26T00:00:00Z",
          source: "adopt",
          entries: [
            {
              canonicalId: "adopt:AWS::EC2::VPC:vpc-123",
              resourceType: "AWS::EC2::VPC",
              snapshot: {
                vpcId: "vpc-123",
                cidrBlock: "10.0.0.0/8",
                state: "available",
              },
            },
          ],
        },
      },
    );

    const result = await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: { drifted: number; driftRate: number };
      resources: Array<{
        driftStatus: string;
        changedAttributes: Array<{
          path: string;
          baseline: unknown;
          current: unknown;
        }>;
      }>;
    };
    assertEquals(data.summary.drifted, 1);
    assertEquals(data.summary.driftRate, 1);
    assertEquals(data.resources[0].driftStatus, "drifted");
    assertEquals(data.resources[0].changedAttributes.length, 1);
    assertEquals(data.resources[0].changedAttributes[0].path, "cidrBlock");
    assertEquals(data.resources[0].changedAttributes[0].baseline, "10.0.0.0/8");
    assertEquals(
      data.resources[0].changedAttributes[0].current,
      "10.0.0.0/16",
    );
  },
});

Deno.test({
  name:
    "compute_drift: missing resource (in baseline not in current) is drifted",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {
        "aws-adopt": {
          "discovery": [
            {
              attributes: { vpcs: [] },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
      {
        adopt: {
          setAt: "2026-06-26T00:00:00Z",
          source: "adopt",
          entries: [
            {
              canonicalId: "adopt:AWS::EC2::VPC:vpc-gone",
              resourceType: "AWS::EC2::VPC",
              snapshot: { vpcId: "vpc-gone", cidrBlock: "10.0.0.0/16" },
            },
          ],
        },
      },
    );

    const result = await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      resources: Array<{
        canonicalId: string;
        driftStatus: string;
        changedAttributes: Array<{ path: string }>;
      }>;
    };
    const missing = data.resources.find((r) =>
      r.canonicalId === "adopt:AWS::EC2::VPC:vpc-gone"
    );
    assertExists(missing);
    assertEquals(missing.driftStatus, "drifted");
    assertEquals(missing.changedAttributes[0].path, "_resource");
  },
});

Deno.test({
  name: "compute_drift: stale source is flagged",
  fn: async () => {
    const oldDate = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { context, getWrittenResources } = createDriftContext({
      "aws-adopt": {
        "discovery": [
          {
            attributes: { vpcs: [] },
            updatedAt: oldDate,
          },
        ],
      },
    });

    const result = await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: { staleSources: string[] };
    };
    assertEquals(data.summary.staleSources.includes("adopt"), true);
  },
});

Deno.test({
  name: "compute_drift: source filter processes only specified sources",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "aws-adopt": {
        "discovery": [
          {
            attributes: {
              vpcs: [{ vpcId: "vpc-1", cidrBlock: "10.0.0.0/16" }],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
      "aws-inventory": {
        "scan": [
          {
            attributes: {
              ec2: [{ arn: "arn:aws:ec2:us-east-1:123:instance/i-abc" }],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      resources: Array<{ detectionSource: string }>;
    };
    // Only adopt resources should be present
    for (const r of data.resources) {
      assertEquals(r.detectionSource, "adopt");
    }
  },
});

Deno.test({
  name:
    "compute_drift: canonicalJson stability - key reordering produces no false drift",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {
        "aws-adopt": {
          "discovery": [
            {
              attributes: {
                vpcs: [
                  {
                    state: "available",
                    vpcId: "vpc-123",
                    cidrBlock: "10.0.0.0/16",
                  },
                ],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
      {
        adopt: {
          setAt: "2026-06-26T00:00:00Z",
          source: "adopt",
          entries: [
            {
              canonicalId: "adopt:AWS::EC2::VPC:vpc-123",
              resourceType: "AWS::EC2::VPC",
              // Same data, different key order
              snapshot: {
                cidrBlock: "10.0.0.0/16",
                vpcId: "vpc-123",
                state: "available",
              },
            },
          ],
        },
      },
    );

    await model.methods.compute_drift.execute(
      {
        sources: ["adopt"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      summary: { inSync: number; drifted: number };
    };
    assertEquals(data.summary.inSync, 1);
    assertEquals(data.summary.drifted, 0);
  },
});

// =============================================================================
// set_baseline Tests
// =============================================================================

Deno.test({
  name: "set_baseline: stores normalized snapshots from upstream",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "aws-adopt": {
        "discovery": [
          {
            attributes: {
              vpcs: [
                {
                  vpcId: "vpc-abc",
                  cidrBlock: "10.0.0.0/16",
                  state: "available",
                },
              ],
              subnets: [
                {
                  subnetId: "subnet-1",
                  vpcId: "vpc-abc",
                  cidrBlock: "10.0.1.0/24",
                },
              ],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.set_baseline.execute(
      {
        source: "adopt",
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
      },
      context as unknown as BaselineContext,
    );

    assertExists(result.dataHandles);
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    const baseline = resources.find((r) =>
      r.specName === "baseline" && r.name === "adopt"
    );
    assertExists(baseline);

    const data = baseline.data as {
      source: string;
      entries: Array<{ canonicalId: string; resourceType: string }>;
    };
    assertEquals(data.source, "adopt");
    assertEquals(data.entries.length, 2);
  },
});

Deno.test({
  name: "set_baseline: source=all baselines all available sources",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "aws-adopt": {
        "discovery": [
          {
            attributes: { vpcs: [{ vpcId: "vpc-1" }] },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
      "aws-inventory": {
        "scan": [
          {
            attributes: {
              ec2: [{ arn: "arn:aws:ec2:us-east-1:123:instance/i-1" }],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    const result = await model.methods.set_baseline.execute(
      {
        source: "all",
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
      },
      context as unknown as BaselineContext,
    );

    // Two baselines written (adopt + inventory), terraform has no data
    assertExists(result.dataHandles);
    assertEquals(result.dataHandles.length, 2);

    const resources = getWrittenResources();
    const adoptBaseline = resources.find((r) =>
      r.specName === "baseline" && r.name === "adopt"
    );
    const inventoryBaseline = resources.find((r) =>
      r.specName === "baseline" && r.name === "inventory"
    );
    assertExists(adoptBaseline);
    assertExists(inventoryBaseline);
  },
});

// =============================================================================
// get_drifted Tests
// =============================================================================

Deno.test({
  name: "get_drifted: returns empty when no drift result exists",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({});

    const result = await model.methods.get_drifted.execute(
      {},
      context as unknown as DriftedContext,
    );

    assertExists(result.dataHandles);
    const resources = getWrittenResources();
    const drifted = resources.find((r) => r.specName === "drifted");
    assertExists(drifted);
    const data = drifted.data as { resources: unknown[] };
    assertEquals(data.resources.length, 0);
  },
});

Deno.test({
  name: "get_drifted: filters by resourceType",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {},
      {
        latest: {
          computedAt: "2026-06-27T10:00:00Z",
          summary: {},
          resources: [
            {
              canonicalId: "a",
              resourceType: "AWS::EC2::VPC",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: "2026-06-27T10:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
            {
              canonicalId: "b",
              resourceType: "AWS::EC2::Subnet",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: "2026-06-27T10:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
            {
              canonicalId: "c",
              resourceType: "AWS::EC2::VPC",
              driftStatus: "in_sync",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: null,
              lastChecked: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
    );

    await model.methods.get_drifted.execute(
      { resourceType: "AWS::EC2::VPC" },
      context as unknown as DriftedContext,
    );

    const resources = getWrittenResources();
    const drifted = resources.find((r) => r.specName === "drifted");
    assertExists(drifted);
    const data = drifted.data as {
      resources: Array<{ canonicalId: string }>;
    };
    assertEquals(data.resources.length, 1);
    assertEquals(data.resources[0].canonicalId, "a");
  },
});

Deno.test({
  name: "get_drifted: filters by source",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {},
      {
        latest: {
          computedAt: "2026-06-27T10:00:00Z",
          summary: {},
          resources: [
            {
              canonicalId: "a",
              resourceType: "AWS::EC2::VPC",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: "2026-06-27T10:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
            {
              canonicalId: "b",
              resourceType: "AWS::EC2::Instance",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "inventory",
              firstDriftDetected: "2026-06-27T10:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
    );

    await model.methods.get_drifted.execute(
      { source: "inventory" },
      context as unknown as DriftedContext,
    );

    const resources = getWrittenResources();
    const drifted = resources.find((r) => r.specName === "drifted");
    assertExists(drifted);
    const data = drifted.data as {
      resources: Array<{ canonicalId: string }>;
    };
    assertEquals(data.resources.length, 1);
    assertEquals(data.resources[0].canonicalId, "b");
  },
});

// =============================================================================
// get_drift_timeline Tests
// =============================================================================

Deno.test({
  name: "get_drift_timeline: returns empty for unknown resource",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({});

    await model.methods.get_drift_timeline.execute(
      { canonicalId: "arn:nonexistent", limit: 50 },
      context as unknown as TimelineContext,
    );

    const resources = getWrittenResources();
    const timeline = resources.find((r) => r.specName === "timeline");
    assertExists(timeline);
    const data = timeline.data as { events: unknown[] };
    assertEquals(data.events.length, 0);
  },
});

Deno.test({
  name: "get_drift_timeline: returns events most recent first",
  fn: async () => {
    // We need to know the hash of "arn:test" to store the timeline
    // The hash function: simple djb2-like, take abs, base36, slice 8
    const canonicalId = "arn:test";
    let hash = 0;
    for (let i = 0; i < canonicalId.length; i++) {
      hash = ((hash << 5) - hash + canonicalId.charCodeAt(i)) | 0;
    }
    const instanceName = `timeline-${Math.abs(hash).toString(36).slice(0, 8)}`;

    const { context, getWrittenResources } = createDriftContext(
      {},
      {
        [instanceName]: {
          canonicalId: "arn:test",
          events: [
            {
              timestamp: "2026-06-25T00:00:00Z",
              status: "in_sync",
              changedAttributes: [],
            },
            {
              timestamp: "2026-06-26T00:00:00Z",
              status: "drifted",
              changedAttributes: ["cidrBlock"],
            },
            {
              timestamp: "2026-06-27T00:00:00Z",
              status: "in_sync",
              changedAttributes: [],
            },
          ],
        },
      },
    );

    await model.methods.get_drift_timeline.execute(
      { canonicalId: "arn:test", limit: 50 },
      context as unknown as TimelineContext,
    );

    const resources = getWrittenResources();
    const timeline = resources.find((r) => r.specName === "timeline");
    assertExists(timeline);
    const data = timeline.data as {
      events: Array<{ timestamp: string; status: string }>;
    };
    assertEquals(data.events.length, 3);
    assertEquals(data.events[0].timestamp, "2026-06-27T00:00:00Z");
    assertEquals(data.events[2].timestamp, "2026-06-25T00:00:00Z");
  },
});

Deno.test({
  name: "get_drift_timeline: respects limit parameter",
  fn: async () => {
    const canonicalId = "arn:limited";
    let hash = 0;
    for (let i = 0; i < canonicalId.length; i++) {
      hash = ((hash << 5) - hash + canonicalId.charCodeAt(i)) | 0;
    }
    const instanceName = `timeline-${Math.abs(hash).toString(36).slice(0, 8)}`;

    const events = Array.from({ length: 10 }, (_, i) => ({
      timestamp: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      status: i % 2 === 0 ? "in_sync" : "drifted",
      changedAttributes: [],
    }));

    const { context, getWrittenResources } = createDriftContext(
      {},
      { [instanceName]: { canonicalId, events } },
    );

    await model.methods.get_drift_timeline.execute(
      { canonicalId, limit: 3 },
      context as unknown as TimelineContext,
    );

    const resources = getWrittenResources();
    const timeline = resources.find((r) => r.specName === "timeline");
    assertExists(timeline);
    const data = timeline.data as { events: unknown[] };
    assertEquals(data.events.length, 3);
  },
});

// =============================================================================
// get_drift_velocity Tests
// =============================================================================

Deno.test({
  name: "get_drift_velocity: returns zeros when no drift result exists",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({});

    await model.methods.get_drift_velocity.execute(
      { windowDays: 30 },
      context as unknown as VelocityContext,
    );

    const resources = getWrittenResources();
    const velocity = resources.find((r) => r.specName === "velocity");
    assertExists(velocity);
    const data = velocity.data as {
      byResourceType: Record<string, unknown>;
      byTimeWindow: { last24h: number; last7d: number; last30d: number };
    };
    assertEquals(Object.keys(data.byResourceType).length, 0);
    assertEquals(data.byTimeWindow.last24h, 0);
  },
});

Deno.test({
  name: "get_drift_velocity: computes correct rates by resource type",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext(
      {},
      {
        latest: {
          computedAt: "2026-06-27T10:00:00Z",
          summary: {},
          resources: [
            {
              canonicalId: "a",
              resourceType: "AWS::EC2::VPC",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: "2026-06-27T09:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
            {
              canonicalId: "b",
              resourceType: "AWS::EC2::VPC",
              driftStatus: "in_sync",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: null,
              lastChecked: "2026-06-27T10:00:00Z",
            },
            {
              canonicalId: "c",
              resourceType: "AWS::EC2::Subnet",
              driftStatus: "drifted",
              changedAttributes: [],
              detectionSource: "adopt",
              firstDriftDetected: "2026-06-22T00:00:00Z",
              lastChecked: "2026-06-27T10:00:00Z",
            },
          ],
        },
      },
    );

    await model.methods.get_drift_velocity.execute(
      { windowDays: 30 },
      context as unknown as VelocityContext,
    );

    const resources = getWrittenResources();
    const velocity = resources.find((r) => r.specName === "velocity");
    assertExists(velocity);
    const data = velocity.data as {
      byResourceType: Record<
        string,
        { driftRate: number; driftedCount: number; totalCount: number }
      >;
      byTimeWindow: { last24h: number; last7d: number; last30d: number };
    };

    assertEquals(data.byResourceType["AWS::EC2::VPC"].driftedCount, 1);
    assertEquals(data.byResourceType["AWS::EC2::VPC"].totalCount, 2);
    assertEquals(data.byResourceType["AWS::EC2::VPC"].driftRate, 0.5);
    assertEquals(data.byResourceType["AWS::EC2::Subnet"].driftRate, 1);
    assertEquals(data.byTimeWindow.last24h, 1);
    assertEquals(data.byTimeWindow.last7d, 2);
  },
});

// =============================================================================
// Inventory normalization
// =============================================================================

Deno.test({
  name: "compute_drift: inventory resources normalized with ARN",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "aws-inventory": {
        "scan": [
          {
            attributes: {
              ec2: [
                {
                  arn: "arn:aws:ec2:us-east-1:123456:instance/i-abc123",
                  instanceId: "i-abc123",
                  instanceType: "t3.medium",
                },
              ],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    await model.methods.compute_drift.execute(
      {
        sources: ["inventory"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      resources: Array<{ canonicalId: string; resourceType: string }>;
    };
    assertEquals(data.resources.length, 1);
    assertEquals(
      data.resources[0].canonicalId,
      "arn:aws:ec2:us-east-1:123456:instance/i-abc123",
    );
    assertEquals(data.resources[0].resourceType, "AWS::EC2::Instance");
  },
});

// =============================================================================
// Terraform normalization
// =============================================================================

Deno.test({
  name: "compute_drift: terraform resources normalized with ARN from values",
  fn: async () => {
    const { context, getWrittenResources } = createDriftContext({
      "terraform": {
        "read_state": [
          {
            attributes: {
              resources: [
                {
                  type: "aws_vpc",
                  address: "aws_vpc.main",
                  values: {
                    arn: "arn:aws:ec2:us-east-1:123456:vpc/vpc-tf123",
                    id: "vpc-tf123",
                    cidr_block: "10.0.0.0/16",
                  },
                },
              ],
            },
            updatedAt: "2026-06-27T10:00:00Z",
          },
        ],
      },
    });

    await model.methods.compute_drift.execute(
      {
        sources: ["terraform"],
        adoptModelName: "aws-adopt",
        inventoryModelName: "aws-inventory",
        terraformModelName: "terraform",
        staleThresholdMinutes: 1440,
      },
      context as unknown as ComputeContext,
    );

    const resources = getWrittenResources();
    const driftResult = resources.find((r) => r.specName === "driftResult");
    assertExists(driftResult);

    const data = driftResult.data as {
      resources: Array<{ canonicalId: string; resourceType: string }>;
    };
    assertEquals(data.resources.length, 1);
    assertEquals(
      data.resources[0].canonicalId,
      "arn:aws:ec2:us-east-1:123456:vpc/vpc-tf123",
    );
    assertEquals(data.resources[0].resourceType, "aws_vpc");
  },
});
