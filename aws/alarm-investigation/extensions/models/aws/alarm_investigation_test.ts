// AWS CloudWatch Alarm Investigation Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { SNSClient } from "npm:@aws-sdk/client-sns@3.1010.0";
import { model } from "./alarm_investigation.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

function mockClients(
  cwHandler: (command: unknown) => unknown,
  snsHandler?: (command: unknown) => unknown,
): () => void {
  const origCw = CloudWatchClient.prototype.send;
  const origSns = SNSClient.prototype.send;

  // deno-lint-ignore no-explicit-any
  CloudWatchClient.prototype.send = function (_cmd: any) {
    return Promise.resolve(cwHandler(_cmd));
  } as typeof origCw;

  // deno-lint-ignore no-explicit-any
  SNSClient.prototype.send = function (_cmd: any) {
    return Promise.resolve((snsHandler ?? (() => ({})))(_cmd));
  } as typeof origSns;

  return () => {
    CloudWatchClient.prototype.send = origCw;
    SNSClient.prototype.send = origSns;
  };
}

// =============================================================================
// Test Data
// =============================================================================

const healthyAlarm = {
  AlarmName: "healthy-alarm",
  StateValue: "OK",
  StateUpdatedTimestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  Namespace: "AWS/EC2",
  MetricName: "CPUUtilization",
  Dimensions: [{ Name: "InstanceId", Value: "i-123" }],
  ActionsEnabled: true,
  AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
};

const staleAlarm = {
  AlarmName: "stale-alarm",
  StateValue: "ALARM",
  StateUpdatedTimestamp: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
  Namespace: "AWS/EC2",
  MetricName: "DiskUsage",
  Dimensions: [],
  ActionsEnabled: true,
  AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
};

const silentAlarm = {
  AlarmName: "silent-alarm",
  StateValue: "ALARM",
  StateUpdatedTimestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  Namespace: "AWS/EC2",
  MetricName: "NetworkIn",
  Dimensions: [],
  ActionsEnabled: false,
  AlarmActions: [],
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/alarm-investigation");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments defaults region to us-east-1", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertEquals("alarm_detail" in model.resources, true);
  assertEquals("triage_summary" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("investigate" in model.methods, true);
  assertEquals("triage" in model.methods, true);
});

// =============================================================================
// investigate Tests
// =============================================================================

Deno.test({
  name: "investigate writes alarm_detail with healthy verdict",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(
      (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "DescribeAlarmsCommand") {
          return { MetricAlarms: [healthyAlarm] };
        }
        if (name === "DescribeAlarmHistoryCommand") {
          return { AlarmHistoryItems: [{ HistoryItemType: "StateUpdate" }] };
        }
        if (name === "GetMetricStatisticsCommand") {
          return {
            Datapoints: [
              { Timestamp: new Date(), SampleCount: 10 },
              { Timestamp: new Date(Date.now() - 3600000), SampleCount: 8 },
            ],
          };
        }
        return {};
      },
      () => ({ Subscriptions: [{ Protocol: "email" }] }),
    );
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "alarm-investigation",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.investigate.execute(
        { alarmName: "healthy-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_detail");
      assertEquals(resources[0].name, "healthy-alarm");

      const data = resources[0].data as {
        alarmName: string;
        verdict: string;
        state: string;
      };
      assertEquals(data.alarmName, "healthy-alarm");
      assertEquals(data.verdict, "healthy");
      assertEquals(data.state, "OK");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate throws when alarm not found",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(() => ({ MetricAlarms: [] }));
    try {
      const { context } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "alarm-investigation",
          version: 1,
          tags: {},
        },
      });

      await assertRejects(
        () =>
          model.methods.investigate.execute(
            { alarmName: "nonexistent" },
            context as unknown as Parameters<
              typeof model.methods.investigate.execute
            >[1],
          ),
        Error,
        "Alarm not found",
      );
    } finally {
      restore();
    }
  },
});

// =============================================================================
// triage Tests
// =============================================================================

Deno.test({
  name: "triage writes alarm_detail per alarm plus triage_summary",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(
      (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "DescribeAlarmsCommand") {
          return {
            MetricAlarms: [healthyAlarm, staleAlarm, silentAlarm],
            NextToken: undefined,
          };
        }
        if (name === "DescribeAlarmHistoryCommand") {
          return { AlarmHistoryItems: [] };
        }
        if (name === "GetMetricStatisticsCommand") {
          return {
            Datapoints: [
              { Timestamp: new Date(), SampleCount: 5 },
            ],
          };
        }
        return {};
      },
      () => ({ Subscriptions: [{ Protocol: "email" }] }),
    );
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "alarm-investigation",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.triage.execute(
        { limit: 100, stateFilter: undefined },
        context as unknown as Parameters<
          typeof model.methods.triage.execute
        >[1],
      );

      // 3 alarm_detail + 1 triage_summary
      assertEquals(result.dataHandles.length, 4);

      const resources = getWrittenResources();
      assertEquals(resources.length, 4);

      const summary = resources.find((r) => r.specName === "triage_summary");
      assertEquals(summary !== undefined, true);

      const summaryData = summary!.data as {
        total: number;
        byVerdict: Record<string, number>;
        byState: Record<string, number>;
      };
      assertEquals(summaryData.total, 3);
    } finally {
      restore();
    }
  },
});
