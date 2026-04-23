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

function mockSns(handler: (command: unknown) => unknown): () => void {
  const original = SNSClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  SNSClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    SNSClient.prototype.send = original;
  };
}

function mockBoth(
  cwHandler: (command: unknown) => unknown,
  snsHandler: (command: unknown) => unknown,
): () => void {
  const restoreCw = mockCloudWatch(cwHandler);
  const restoreSns = mockSns(snsHandler);
  return () => {
    restoreCw();
    restoreSns();
  };
}

function cmdName(cmd: unknown): string {
  return (cmd as { constructor: { name: string } }).constructor.name;
}

// =============================================================================
// Test Data
// =============================================================================

const now = new Date();
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

function makeAlarm(overrides: Record<string, unknown> = {}) {
  return {
    AlarmName: "test-alarm",
    Namespace: "AWS/EC2",
    MetricName: "CPUUtilization",
    StateValue: "OK",
    StateUpdatedTimestamp: daysAgo(1),
    ActionsEnabled: true,
    AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
    Dimensions: [{ Name: "InstanceId", Value: "i-123" }],
    ...overrides,
  };
}

function defaultCwHandler(alarm: Record<string, unknown>) {
  return (cmd: unknown) => {
    const name = cmdName(cmd);
    if (name === "DescribeAlarmsCommand") {
      return { MetricAlarms: [alarm] };
    }
    if (name === "DescribeAlarmHistoryCommand") {
      return { AlarmHistoryItems: [] };
    }
    if (name === "GetMetricStatisticsCommand") {
      return {
        Datapoints: [{ Timestamp: new Date(), SampleCount: 10 }],
      };
    }
    return {};
  };
}

function defaultSnsHandler() {
  return (_cmd: unknown) => ({
    Subscriptions: [{ Protocol: "email" }, { Protocol: "lambda" }],
  });
}

function createCtx() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: {
      id: "test-id",
      name: "alarm-inv",
      version: 1,
      tags: {},
    },
  });
}

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
// classify() verdict tests (via investigate method)
// =============================================================================

Deno.test({
  name: "investigate: healthy alarm — OK, has actions, has metric data",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const alarm = makeAlarm({ StateValue: "OK" });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "alarm_detail");
      const data = resources[0].data as { verdict: string };
      assertEquals(data.verdict, "healthy");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: orphaned alarm — INSUFFICIENT_DATA > 365 days",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "INSUFFICIENT_DATA",
      StateUpdatedTimestamp: daysAgo(400),
    });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdict: string };
      assertEquals(data.verdict, "orphaned");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: silent alarm — ALARM with no actions enabled",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "ALARM",
      StateUpdatedTimestamp: daysAgo(5),
      ActionsEnabled: false,
      AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
    });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdict: string };
      assertEquals(data.verdict, "silent");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: silent alarm — ALARM with empty actions array",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "ALARM",
      StateUpdatedTimestamp: daysAgo(5),
      ActionsEnabled: true,
      AlarmActions: [],
    });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdict: string };
      assertEquals(data.verdict, "silent");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: silent when ActionsEnabled is undefined (fail-closed)",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "ALARM",
      StateUpdatedTimestamp: daysAgo(5),
      ActionsEnabled: undefined,
      AlarmActions: ["arn:aws:sns:us-east-1:123:alerts"],
    });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        verdict: string;
        hasAlarmActions: boolean;
      };
      assertEquals(data.verdict, "silent");
      assertEquals(data.hasAlarmActions, false);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: stale alarm — ALARM > 180 days",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "ALARM",
      StateUpdatedTimestamp: daysAgo(200),
    });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdict: string };
      assertEquals(data.verdict, "stale");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: noisy alarm — > 5 state changes in 7 days",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "OK",
      StateUpdatedTimestamp: daysAgo(1),
    });
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm] };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        // Return 8 state changes
        return {
          AlarmHistoryItems: Array.from({ length: 8 }, (_, i) => ({
            AlarmName: "test-alarm",
            Timestamp: daysAgo(i),
            HistoryItemType: "StateUpdate",
          })),
        };
      }
      if (name === "GetMetricStatisticsCommand") {
        return { Datapoints: [{ Timestamp: new Date(), SampleCount: 5 }] };
      }
      return {};
    };
    const restore = mockBoth(cwHandler, defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        verdict: string;
        verdictReason: string;
      };
      assertEquals(data.verdict, "noisy");
      assertEquals(data.verdictReason.includes("8"), true);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: noisy verdictReason notes cap at 100",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      StateValue: "OK",
      StateUpdatedTimestamp: daysAgo(1),
    });
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm] };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return {
          AlarmHistoryItems: Array.from({ length: 100 }, (_, i) => ({
            AlarmName: "test-alarm",
            Timestamp: daysAgo(i % 7),
            HistoryItemType: "StateUpdate",
          })),
        };
      }
      if (name === "GetMetricStatisticsCommand") {
        return { Datapoints: [{ Timestamp: new Date(), SampleCount: 5 }] };
      }
      return {};
    };
    const restore = mockBoth(cwHandler, defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdictReason: string };
      assertEquals(data.verdictReason.includes("capped at 100"), true);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "investigate: unknown verdict — no pattern matched",
  sanitizeResources: false,
  fn: async () => {
    // INSUFFICIENT_DATA but only 30 days — not orphaned
    const alarm = makeAlarm({
      StateValue: "INSUFFICIENT_DATA",
      StateUpdatedTimestamp: daysAgo(30),
    });
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm] };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return { AlarmHistoryItems: [] };
      }
      if (name === "GetMetricStatisticsCommand") {
        return { Datapoints: [] };
      }
      return {};
    };
    const restore = mockBoth(cwHandler, defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as { verdict: string };
      assertEquals(data.verdict, "unknown");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// investigate error handling
// =============================================================================

Deno.test({
  name: "investigate: throws when alarm not found",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockBoth(
      () => ({ MetricAlarms: [] }),
      defaultSnsHandler(),
    );
    try {
      const { context } = createCtx();
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
// investigate: SNS enrichment
// =============================================================================

Deno.test({
  name: "investigate: resolves SNS topic subscriptions",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({ StateValue: "OK" });
    const restore = mockBoth(defaultCwHandler(alarm), defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.investigate.execute(
        { alarmName: "test-alarm" },
        context as unknown as Parameters<
          typeof model.methods.investigate.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        sns_topics: Array<{
          arn: string;
          subscriptionCount: number;
          protocols: string[];
        }>;
      };
      assertEquals(data.sns_topics.length, 1);
      assertEquals(data.sns_topics[0].subscriptionCount, 2);
      assertEquals(data.sns_topics[0].protocols.includes("email"), true);
      assertEquals(data.sns_topics[0].protocols.includes("lambda"), true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// triage method tests
// =============================================================================

Deno.test({
  name: "triage: processes multiple alarms and writes summary",
  sanitizeResources: false,
  fn: async () => {
    const alarmOk = makeAlarm({ AlarmName: "ok-alarm", StateValue: "OK" });
    const alarmBad = makeAlarm({
      AlarmName: "bad-alarm",
      StateValue: "ALARM",
      StateUpdatedTimestamp: daysAgo(200),
    });
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarmOk, alarmBad] };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return { AlarmHistoryItems: [] };
      }
      if (name === "GetMetricStatisticsCommand") {
        return {
          Datapoints: [{ Timestamp: new Date(), SampleCount: 5 }],
        };
      }
      return {};
    };
    const restore = mockBoth(cwHandler, defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      const result = await model.methods.triage.execute(
        { limit: 100, stateFilter: undefined },
        context as unknown as Parameters<
          typeof model.methods.triage.execute
        >[1],
      );
      // 2 alarm_detail + 1 triage_summary
      assertEquals(result.dataHandles.length, 3);

      const resources = getWrittenResources();
      const details = resources.filter((r) => r.specName === "alarm_detail");
      const summaries = resources.filter(
        (r) => r.specName === "triage_summary",
      );
      assertEquals(details.length, 2);
      assertEquals(summaries.length, 1);

      const summary = summaries[0].data as {
        total: number;
        byVerdict: Record<string, number>;
        byState: Record<string, number>;
      };
      assertEquals(summary.total, 2);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "triage: index suffix prevents name collisions",
  sanitizeResources: false,
  fn: async () => {
    // Two alarms that sanitize to the same base name
    const alarm1 = makeAlarm({ AlarmName: "my/alarm", StateValue: "OK" });
    const alarm2 = makeAlarm({ AlarmName: "my-alarm", StateValue: "OK" });
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm1, alarm2] };
      }
      if (name === "DescribeAlarmHistoryCommand") {
        return { AlarmHistoryItems: [] };
      }
      if (name === "GetMetricStatisticsCommand") {
        return {
          Datapoints: [{ Timestamp: new Date(), SampleCount: 5 }],
        };
      }
      return {};
    };
    const restore = mockBoth(cwHandler, defaultSnsHandler());
    try {
      const { context, getWrittenResources } = createCtx();
      await model.methods.triage.execute(
        { limit: 100, stateFilter: undefined },
        context as unknown as Parameters<
          typeof model.methods.triage.execute
        >[1],
      );
      const details = getWrittenResources().filter(
        (r) => r.specName === "alarm_detail",
      );
      assertEquals(details.length, 2);
      // Instance names should differ due to index suffix
      const names = details.map((r) => r.name);
      assertEquals(names[0] !== names[1], true);
      assertEquals(names[0], "my-alarm-0");
      assertEquals(names[1], "my-alarm-1");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "triage: enrichment failure produces degraded record",
  sanitizeResources: false,
  fn: async () => {
    const alarm = makeAlarm({
      AlarmName: "fail-alarm",
      StateValue: "OK",
    });
    let callCount = 0;
    const cwHandler = (cmd: unknown) => {
      const name = cmdName(cmd);
      if (name === "DescribeAlarmsCommand") {
        return { MetricAlarms: [alarm] };
      }
      // Fail on first non-DescribeAlarms call to trigger enrichment error
      callCount++;
      if (callCount <= 3) {
        throw new Error("Simulated API failure");
      }
      return {};
    };
    const restore = mockBoth(cwHandler, () => {
      throw new Error("SNS failure");
    });
    try {
      const { context, getWrittenResources } = createCtx();
      const result = await model.methods.triage.execute(
        { limit: 100, stateFilter: undefined },
        context as unknown as Parameters<
          typeof model.methods.triage.execute
        >[1],
      );
      // Should still produce handles (degraded record + summary)
      assertEquals(result.dataHandles.length, 2);

      const details = getWrittenResources().filter(
        (r) => r.specName === "alarm_detail",
      );
      assertEquals(details.length, 1);
      const data = details[0].data as {
        verdict: string;
        verdictReason: string;
      };
      assertEquals(data.verdict, "unknown");
      assertEquals(data.verdictReason.includes("Enrichment failed"), true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// triage: limit validation
// =============================================================================

Deno.test("triage: rejects limit=0 via Zod schema", () => {
  const schema = model.methods.triage.arguments;
  const result = schema.safeParse({ limit: 0 });
  assertEquals(result.success, false);
});

Deno.test("triage: rejects negative limit via Zod schema", () => {
  const schema = model.methods.triage.arguments;
  const result = schema.safeParse({ limit: -1 });
  assertEquals(result.success, false);
});

Deno.test("triage: rejects non-integer limit via Zod schema", () => {
  const schema = model.methods.triage.arguments;
  const result = schema.safeParse({ limit: 3.5 });
  assertEquals(result.success, false);
});
