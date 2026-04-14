// AWS CloudWatch Alarms Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { model } from "./alarms.ts";

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
// Test Data
// =============================================================================

const alarm1 = {
  AlarmName: "high-cpu",
  AlarmArn: "arn:aws:cloudwatch:us-east-1:123:alarm:high-cpu",
  AlarmDescription: "CPU above 80%",
  StateValue: "ALARM",
  StateReason: "Threshold Crossed",
  StateUpdatedTimestamp: new Date("2026-01-01T00:00:00Z"),
  MetricName: "CPUUtilization",
  Namespace: "AWS/EC2",
  Threshold: 80,
  ComparisonOperator: "GreaterThanThreshold",
  EvaluationPeriods: 3,
  Dimensions: [{ Name: "InstanceId", Value: "i-123" }],
  ActionsEnabled: true,
  AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
};

const alarm2 = {
  AlarmName: "low-disk",
  AlarmArn: "arn:aws:cloudwatch:us-east-1:123:alarm:low-disk",
  StateValue: "OK",
  MetricName: "DiskSpace",
  Namespace: "Custom",
  Dimensions: [],
  ActionsEnabled: false,
  AlarmActions: [],
};

const historyItem = {
  AlarmName: "high-cpu",
  Timestamp: new Date("2026-01-01T00:00:00Z"),
  HistoryItemType: "StateUpdate",
  HistorySummary: "Alarm updated",
  HistoryData: JSON.stringify({
    oldState: { stateValue: "OK" },
    newState: { stateValue: "ALARM" },
  }),
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/alarms");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertEquals("alarm_list" in model.resources, true);
  assertEquals("alarm_history" in model.resources, true);
  assertEquals("alarm_summary" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("list_alarms" in model.methods, true);
  assertEquals("get_active" in model.methods, true);
  assertEquals("get_history" in model.methods, true);
  assertEquals("get_summary" in model.methods, true);
});

// =============================================================================
// list_alarms Tests
// =============================================================================

Deno.test({
  name: "list_alarms returns all alarms and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      MetricAlarms: [alarm1, alarm2],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-alarms", version: 1, tags: {} },
      });

      const result = await model.methods.list_alarms.execute(
        { stateValue: undefined, alarmNamePrefix: undefined, limit: 100 },
        context as unknown as Parameters<
          typeof model.methods.list_alarms.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_list");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        alarms: Array<{
          alarmName: string;
          stateValue: string;
          alarmArn: string | null;
          alarmDescription: string | null;
          metricName: string | null;
          namespace: string | null;
          threshold: number | null;
          comparisonOperator: string | null;
          evaluationPeriods: number | null;
          dimensions: Array<{ name: string; value: string }>;
          actionsEnabled: boolean;
          alarmActions: string[];
        }>;
        count: number;
        stateFilter: string | null;
      };
      assertEquals(data.count, 2);
      assertEquals(data.alarms.length, 2);
      assertEquals(data.stateFilter, null);

      // Verify first alarm mapping
      const first = data.alarms[0];
      assertEquals(first.alarmName, "high-cpu");
      assertEquals(
        first.alarmArn,
        "arn:aws:cloudwatch:us-east-1:123:alarm:high-cpu",
      );
      assertEquals(first.alarmDescription, "CPU above 80%");
      assertEquals(first.stateValue, "ALARM");
      assertEquals(first.metricName, "CPUUtilization");
      assertEquals(first.namespace, "AWS/EC2");
      assertEquals(first.threshold, 80);
      assertEquals(first.comparisonOperator, "GreaterThanThreshold");
      assertEquals(first.evaluationPeriods, 3);
      assertEquals(first.dimensions.length, 1);
      assertEquals(first.dimensions[0].name, "InstanceId");
      assertEquals(first.dimensions[0].value, "i-123");
      assertEquals(first.actionsEnabled, true);
      assertEquals(first.alarmActions.length, 1);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_active Tests
// =============================================================================

Deno.test({
  name: "get_active returns only ALARM state alarms",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      MetricAlarms: [alarm1],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-alarms", version: 1, tags: {} },
      });

      const result = await model.methods.get_active.execute(
        { limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.get_active.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_list");
      assertEquals(resources[0].name, "active");

      const data = resources[0].data as {
        alarms: Array<{ alarmName: string }>;
        count: number;
        stateFilter: string;
      };
      assertEquals(data.count, 1);
      assertEquals(data.stateFilter, "ALARM");
      assertEquals(data.alarms[0].alarmName, "high-cpu");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_history Tests
// =============================================================================

Deno.test({
  name: "get_history returns alarm history entries",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      AlarmHistoryItems: [historyItem],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-alarms", version: 1, tags: {} },
      });

      const result = await model.methods.get_history.execute(
        {
          alarmName: undefined,
          historyItemType: undefined,
          startTime: "24h",
          endTime: undefined,
          limit: 100,
        },
        context as unknown as Parameters<
          typeof model.methods.get_history.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_history");
      assertEquals(resources[0].name, "history-all");

      const data = resources[0].data as {
        entries: Array<{
          alarmName: string;
          timestamp: string;
          historyItemType: string;
          historySummary: string;
          historyData: string | null;
        }>;
        count: number;
      };
      assertEquals(data.count, 1);
      assertEquals(data.entries.length, 1);
      assertEquals(data.entries[0].alarmName, "high-cpu");
      assertEquals(data.entries[0].historyItemType, "StateUpdate");
      assertEquals(data.entries[0].historySummary, "Alarm updated");
      assertEquals(data.entries[0].timestamp, "2026-01-01T00:00:00.000Z");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_summary Tests
// =============================================================================

Deno.test({
  name: "get_summary returns alarm state counts and recent changes",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch((cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm1, alarm2], NextToken: undefined };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return { AlarmHistoryItems: [historyItem], NextToken: undefined };
      }
      return {};
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-alarms", version: 1, tags: {} },
      });

      const result = await model.methods.get_summary.execute(
        { startTime: undefined, historyHours: 6 },
        context as unknown as Parameters<
          typeof model.methods.get_summary.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_summary");
      assertEquals(resources[0].name, "summary");

      const data = resources[0].data as {
        total: number;
        inAlarm: number;
        ok: number;
        insufficientData: number;
        byNamespace: Record<string, number>;
        recentStateChanges: Array<{
          alarmName: string;
          previousState: string;
          currentState: string;
        }>;
      };
      assertEquals(data.total, 2);
      assertEquals(data.inAlarm, 1);
      assertEquals(data.ok, 1);
      assertEquals(data.insufficientData, 0);
      assertEquals(data.byNamespace["AWS/EC2"], 1);
      assertEquals(data.byNamespace["Custom"], 1);
      assertEquals(data.recentStateChanges.length, 1);
      assertEquals(data.recentStateChanges[0].alarmName, "high-cpu");
      assertEquals(data.recentStateChanges[0].previousState, "OK");
      assertEquals(data.recentStateChanges[0].currentState, "ALARM");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_summary with startTime override executes successfully",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch((cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm1], NextToken: undefined };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return { AlarmHistoryItems: [], NextToken: undefined };
      }
      return {};
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-alarms", version: 1, tags: {} },
      });

      const result = await model.methods.get_summary.execute(
        { startTime: "2h", historyHours: 6 },
        context as unknown as Parameters<
          typeof model.methods.get_summary.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_summary");
    } finally {
      restore();
    }
  },
});
