// AWS CloudWatch Metrics Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertGreater } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { model } from "./metrics.ts";

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
// Type alias for context casting
// =============================================================================

type ListMetricsContext = Parameters<
  typeof model.methods.list_metrics.execute
>[1];
type GetDataContext = Parameters<typeof model.methods.get_data.execute>[1];
type AnalyzeContext = Parameters<typeof model.methods.analyze.execute>[1];
type GetEc2CpuContext = Parameters<
  typeof model.methods.get_ec2_cpu.execute
>[1];
type GetLambdaContext = Parameters<
  typeof model.methods.get_lambda_metrics.execute
>[1];

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type", () => {
  assertEquals(model.type, "@webframp/aws/metrics");
});

Deno.test("model has a version string", () => {
  assertExists(model.version);
  assertEquals(typeof model.version, "string");
});

Deno.test("model defines expected resources", () => {
  assertEquals("metric_list" in model.resources, true);
  assertEquals("metric_data" in model.resources, true);
  assertEquals("metric_analysis" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("list_metrics" in model.methods, true);
  assertEquals("get_data" in model.methods, true);
  assertEquals("analyze" in model.methods, true);
  assertEquals("get_ec2_cpu" in model.methods, true);
  assertEquals("get_lambda_metrics" in model.methods, true);
});

// =============================================================================
// list_metrics Tests
// =============================================================================

Deno.test({
  name: "list_metrics returns discovered metrics",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Metrics: [
        {
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: "i-123" }],
        },
        {
          Namespace: "AWS/Lambda",
          MetricName: "Duration",
          Dimensions: [{ Name: "FunctionName", Value: "my-func" }],
        },
      ],
      NextToken: undefined,
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.list_metrics.execute(
        { namespace: "AWS/EC2", limit: 100 },
        context as unknown as ListMetricsContext,
      );

      assertExists(result.dataHandles);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "metric_list");
      assertEquals(resources[0].name, "ns-AWS-EC2");

      const data = resources[0].data as {
        namespace: string;
        metrics: Array<{
          namespace: string;
          metricName: string;
          dimensions: Array<{ name: string; value: string }>;
        }>;
        count: number;
      };
      assertEquals(data.namespace, "AWS/EC2");
      assertEquals(data.count, 2);
      assertEquals(data.metrics[0].namespace, "AWS/EC2");
      assertEquals(data.metrics[0].metricName, "CPUUtilization");
      assertEquals(data.metrics[0].dimensions[0].name, "InstanceId");
      assertEquals(data.metrics[1].namespace, "AWS/Lambda");
      assertEquals(data.metrics[1].metricName, "Duration");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_metrics without namespace uses 'all' instance name",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Metrics: [],
      NextToken: undefined,
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      await model.methods.list_metrics.execute(
        { limit: 100 },
        context as unknown as ListMetricsContext,
      );

      const resources = getWrittenResources();
      assertEquals(resources[0].name, "all");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_data Tests
// =============================================================================

Deno.test({
  name: "get_data returns sorted datapoints",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Datapoints: [
        {
          Timestamp: new Date("2026-04-14T01:00:00Z"),
          Average: 12,
          Sum: 12,
          Minimum: 8,
          Maximum: 16,
          SampleCount: 1,
          Unit: "Percent",
        },
        {
          Timestamp: new Date("2026-04-14T00:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
          Unit: "Percent",
        },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_data.execute(
        {
          namespace: "AWS/EC2",
          metricName: "CPUUtilization",
          dimensions: [{ name: "InstanceId", value: "i-123" }],
          statistic: "Average",
          startTime: "2026-04-14T00:00:00Z",
          endTime: "2026-04-14T02:00:00Z",
        },
        context as unknown as GetDataContext,
      );

      assertExists(result.dataHandles);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "metric_data");

      const data = resources[0].data as {
        metric: { namespace: string; metricName: string };
        statistic: string;
        datapoints: Array<{
          timestamp: string;
          value: number;
          unit: string | null;
        }>;
      };
      assertEquals(data.metric.namespace, "AWS/EC2");
      assertEquals(data.metric.metricName, "CPUUtilization");
      assertEquals(data.statistic, "Average");
      assertEquals(data.datapoints.length, 2);
      // Verify sorted by timestamp (earliest first)
      assertEquals(data.datapoints[0].value, 10);
      assertEquals(data.datapoints[1].value, 12);
      assertEquals(data.datapoints[0].unit, "Percent");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// analyze Tests
// =============================================================================

Deno.test({
  name: "analyze detects anomalies beyond threshold",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    // 6 datapoints: five stable at 10, one outlier at 100
    // mean = (10*5 + 100)/6 = 150/6 = 25
    // variance = (15^2 * 5 + 75^2) / 6 = (1125 + 5625)/6 = 1125
    // stdDev = sqrt(1125) = 33.54
    // deviation for 100 = |100-25|/33.54 = 2.236 > 2
    const restore = mockCloudWatch(() => ({
      Datapoints: [
        {
          Timestamp: new Date("2026-04-14T00:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T01:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T02:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T03:00:00Z"),
          Average: 100,
          Sum: 100,
          Minimum: 95,
          Maximum: 105,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T04:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T05:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 5,
          Maximum: 15,
          SampleCount: 1,
        },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      await model.methods.analyze.execute(
        {
          namespace: "AWS/EC2",
          metricName: "CPUUtilization",
          dimensions: [{ name: "InstanceId", value: "i-123" }],
          statistic: "Average",
          startTime: "2026-04-14T00:00:00Z",
          endTime: "2026-04-14T06:00:00Z",
          anomalyThreshold: 2,
        },
        context as unknown as AnalyzeContext,
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "metric_analysis");

      const data = resources[0].data as {
        summary: {
          min: number;
          max: number;
          avg: number;
          count: number;
        };
        anomalies: Array<{
          timestamp: string;
          value: number;
          deviation: number;
        }>;
      };

      assertEquals(data.summary.min, 10);
      assertEquals(data.summary.max, 100);
      assertEquals(data.summary.count, 6);
      assertGreater(data.anomalies.length, 0);
      // The outlier at value 100 should be the anomaly
      assertEquals(data.anomalies[0].value, 100);
      assertGreater(data.anomalies[0].deviation, 2);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "analyze returns stable trend and no anomalies for uniform data",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Datapoints: [
        {
          Timestamp: new Date("2026-04-14T00:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 10,
          Maximum: 10,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T01:00:00Z"),
          Average: 10.1,
          Sum: 10.1,
          Minimum: 10.1,
          Maximum: 10.1,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T02:00:00Z"),
          Average: 9.9,
          Sum: 9.9,
          Minimum: 9.9,
          Maximum: 9.9,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T03:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 10,
          Maximum: 10,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T04:00:00Z"),
          Average: 10.1,
          Sum: 10.1,
          Minimum: 10.1,
          Maximum: 10.1,
          SampleCount: 1,
        },
        {
          Timestamp: new Date("2026-04-14T05:00:00Z"),
          Average: 10,
          Sum: 10,
          Minimum: 10,
          Maximum: 10,
          SampleCount: 1,
        },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      await model.methods.analyze.execute(
        {
          namespace: "AWS/EC2",
          metricName: "CPUUtilization",
          dimensions: [],
          statistic: "Average",
          startTime: "2026-04-14T00:00:00Z",
          endTime: "2026-04-14T06:00:00Z",
          anomalyThreshold: 2,
        },
        context as unknown as AnalyzeContext,
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        trend: string;
        anomalies: Array<unknown>;
      };

      assertEquals(data.trend, "stable");
      assertEquals(data.anomalies.length, 0);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_ec2_cpu Tests
// =============================================================================

Deno.test({
  name: "get_ec2_cpu writes metric_data resource for instance",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      Datapoints: [
        {
          Timestamp: new Date("2026-04-14T00:00:00Z"),
          Average: 25.5,
          Maximum: 40.0,
          Unit: "Percent",
        },
        {
          Timestamp: new Date("2026-04-14T00:05:00Z"),
          Average: 30.2,
          Maximum: 45.0,
          Unit: "Percent",
        },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_ec2_cpu.execute(
        { instanceId: "i-abc123", startTime: "1h" },
        context as unknown as GetEc2CpuContext,
      );

      assertExists(result.dataHandles);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "metric_data");
      assertEquals(resources[0].name, "ec2-cpu-i-abc123");

      const data = resources[0].data as {
        metric: {
          namespace: string;
          metricName: string;
          dimensions: Array<{ name: string; value: string }>;
        };
        datapoints: Array<{
          timestamp: string;
          value: number;
          unit: string;
        }>;
      };
      assertEquals(data.metric.namespace, "AWS/EC2");
      assertEquals(data.metric.metricName, "CPUUtilization");
      assertEquals(data.metric.dimensions[0].value, "i-abc123");
      assertEquals(data.datapoints.length, 2);
      // Sorted by timestamp, first point's average value
      assertEquals(data.datapoints[0].value, 25.5);
      assertEquals(data.datapoints[1].value, 30.2);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_lambda_metrics Tests
// =============================================================================

Deno.test({
  name: "get_lambda_metrics writes metric_data with lambda results",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockCloudWatch(() => ({
      MetricDataResults: [
        {
          Id: "invocations",
          Timestamps: [
            new Date("2026-04-14T00:00:00Z"),
            new Date("2026-04-14T00:05:00Z"),
          ],
          Values: [100, 150],
        },
        {
          Id: "errors",
          Timestamps: [
            new Date("2026-04-14T00:00:00Z"),
            new Date("2026-04-14T00:05:00Z"),
          ],
          Values: [2, 0],
        },
        {
          Id: "duration",
          Timestamps: [
            new Date("2026-04-14T00:00:00Z"),
            new Date("2026-04-14T00:05:00Z"),
          ],
          Values: [250.5, 300.1],
        },
        {
          Id: "throttles",
          Timestamps: [
            new Date("2026-04-14T00:00:00Z"),
            new Date("2026-04-14T00:05:00Z"),
          ],
          Values: [0, 0],
        },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-metrics",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_lambda_metrics.execute(
        { functionName: "my-function", startTime: "1h" },
        context as unknown as GetLambdaContext,
      );

      assertExists(result.dataHandles);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "metric_data");
      assertEquals(resources[0].name, "lambda-my-function");

      const data = resources[0].data as {
        metric: {
          namespace: string;
          metricName: string;
          dimensions: Array<{ name: string; value: string }>;
        };
        statistic: string;
        lambdaMetrics: Record<
          string,
          Array<{ timestamp: string; value: number }>
        >;
      };
      assertEquals(data.metric.namespace, "AWS/Lambda");
      assertEquals(data.metric.metricName, "multiple");
      assertEquals(data.metric.dimensions[0].value, "my-function");
      assertEquals(data.statistic, "multiple");

      // Verify lambda-specific metrics structure
      assertExists(data.lambdaMetrics);
      assertEquals(data.lambdaMetrics.invocations.length, 2);
      assertEquals(data.lambdaMetrics.invocations[0].value, 100);
      assertEquals(data.lambdaMetrics.errors[0].value, 2);
      assertEquals(data.lambdaMetrics.duration[0].value, 250.5);
      assertEquals(data.lambdaMetrics.throttles[0].value, 0);
    } finally {
      restore();
    }
  },
});
