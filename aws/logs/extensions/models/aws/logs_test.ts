// AWS CloudWatch Logs Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { CloudWatchLogsClient } from "npm:@aws-sdk/client-cloudwatch-logs@3.1010.0";
import { model } from "./logs.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockLogsClient(handler: (command: unknown) => unknown): () => void {
  const original = CloudWatchLogsClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  CloudWatchLogsClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    CloudWatchLogsClient.prototype.send = original;
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/logs");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model has required resources", () => {
  assertExists(model.resources.log_groups);
  assertExists(model.resources.query_results);
  assertExists(model.resources.error_analysis);
});

Deno.test("model has all four methods", () => {
  assertExists(model.methods.list_log_groups);
  assertExists(model.methods.query);
  assertExists(model.methods.find_errors);
  assertExists(model.methods.get_recent_events);
});

// =============================================================================
// list_log_groups Tests
// =============================================================================

Deno.test(
  "list_log_groups: returns mapped log groups",
  { sanitizeResources: false }, // CloudWatchLogsClient uses connection pooling
  async () => {
    const restore = mockLogsClient(() => ({
      logGroups: [
        {
          logGroupName: "/aws/lambda/func1",
          arn:
            "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/func1",
          creationTime: 1704067200000,
          retentionInDays: 30,
          storedBytes: 1073741824,
          logGroupClass: "STANDARD",
        },
        {
          logGroupName: "/aws/ecs/service1",
          arn:
            "arn:aws:logs:us-east-1:123456789012:log-group:/aws/ecs/service1",
          creationTime: 1704067200000,
          retentionInDays: undefined,
          storedBytes: 536870912,
          logGroupClass: "STANDARD",
        },
      ],
      nextToken: undefined,
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-logs", version: 1, tags: {} },
      });

      await model.methods.list_log_groups.execute(
        { limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.list_log_groups.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        logGroups: Array<{
          name: string;
          arn: string | null;
          creationTime: string | null;
          retentionDays: number | null;
          storedBytes: number | null;
          logGroupClass: string | null;
        }>;
        count: number;
      };

      assertEquals(data.count, 2);
      assertEquals(data.logGroups.length, 2);
      assertEquals(data.logGroups[0].name, "/aws/lambda/func1");
      assertEquals(data.logGroups[0].retentionDays, 30);
      assertEquals(data.logGroups[0].storedBytes, 1073741824);
      // creationTime is epoch ms converted to ISO string
      assertEquals(
        data.logGroups[0].creationTime,
        new Date(1704067200000).toISOString(),
      );
      assertEquals(data.logGroups[1].name, "/aws/ecs/service1");
      // retentionInDays undefined maps to null
      assertEquals(data.logGroups[1].retentionDays, null);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// get_recent_events Tests
// =============================================================================

Deno.test(
  "get_recent_events: returns filtered log events",
  { sanitizeResources: false }, // CloudWatchLogsClient uses connection pooling
  async () => {
    const restore = mockLogsClient(() => ({
      events: [
        {
          timestamp: 1704067200000,
          message: "Request processed",
          logStreamName: "stream-1",
        },
        {
          timestamp: 1704067260000,
          message: "Request completed",
          logStreamName: "stream-1",
        },
      ],
      nextToken: undefined,
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-logs", version: 1, tags: {} },
      });

      await model.methods.get_recent_events.execute(
        { logGroupName: "/aws/lambda/func1", startTime: "1h", limit: 100 },
        context as unknown as Parameters<
          typeof model.methods.get_recent_events.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        queryId: string;
        status: string;
        results: Array<Record<string, string>>;
        statistics: { recordsMatched: number };
      };

      assertEquals(data.status, "Complete");
      assertEquals(data.results.length, 2);
      assertEquals(data.results[0]["@message"], "Request processed");
      assertEquals(
        data.results[0]["@timestamp"],
        new Date(1704067200000).toISOString(),
      );
      assertEquals(data.results[1]["@message"], "Request completed");
      assertEquals(data.statistics.recordsMatched, 2);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// find_errors Tests
// =============================================================================

Deno.test(
  "find_errors: groups error patterns and counts totals",
  { sanitizeResources: false }, // CloudWatchLogsClient uses connection pooling
  async () => {
    // find_errors uses StartQueryCommand then GetQueryResultsCommand via
    // waitForQueryCompletion. We return Complete immediately on GetQueryResults.
    let callCount = 0;
    const restore = mockLogsClient((cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "StartQueryCommand") {
        return { queryId: "q-errors-123" };
      }
      if (name === "GetQueryResultsCommand") {
        callCount++;
        return {
          status: "Complete",
          results: [
            [
              { field: "@timestamp", value: "2026-01-01T00:00:00Z" },
              {
                field: "@message",
                value: "ERROR: Connection refused to database",
              },
            ],
            [
              { field: "@timestamp", value: "2026-01-01T00:01:00Z" },
              {
                field: "@message",
                value: "ERROR: Connection refused to cache",
              },
            ],
            [
              { field: "@timestamp", value: "2026-01-01T00:02:00Z" },
              { field: "@message", value: "FATAL: Out of memory" },
            ],
          ],
          statistics: {
            recordsMatched: 3.0,
            recordsScanned: 500.0,
            bytesScanned: 25000.0,
          },
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-logs", version: 1, tags: {} },
      });

      await model.methods.find_errors.execute(
        {
          logGroupNames: ["/aws/lambda/func1"],
          startTime: "1h",
          keywords: ["error", "fatal"],
          limit: 100,
        },
        context as unknown as Parameters<
          typeof model.methods.find_errors.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        logGroupName: string;
        totalErrors: number;
        patterns: Array<{
          pattern: string;
          count: number;
          sampleMessages: string[];
        }>;
      };

      assertEquals(data.totalErrors, 3);
      assertEquals(data.logGroupName, "/aws/lambda/func1");
      // The pattern extraction replaces numbers with [NUM], so both
      // "Connection refused to database" and "Connection refused to cache"
      // remain distinct patterns (no numbers to normalize).
      // We verify patterns exist and total count sums to 3.
      const totalFromPatterns = data.patterns.reduce(
        (sum, p) => sum + p.count,
        0,
      );
      assertEquals(totalFromPatterns, 3);
      // GetQueryResultsCommand should have been called at least once
      assertEquals(callCount >= 1, true);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// query Tests
// =============================================================================

Deno.test(
  "query: polls until complete and returns results",
  { sanitizeResources: false }, // CloudWatchLogsClient uses connection pooling
  async () => {
    let getResultsCalls = 0;
    const restore = mockLogsClient((cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "StartQueryCommand") {
        return { queryId: "q-test-123" };
      }
      if (name === "GetQueryResultsCommand") {
        getResultsCalls++;
        if (getResultsCalls === 1) {
          return { status: "Running", results: [], statistics: null };
        }
        return {
          status: "Complete",
          results: [
            [
              { field: "@message", value: "test log line" },
              { field: "@timestamp", value: "2026-01-01T00:00:00Z" },
            ],
          ],
          statistics: {
            recordsMatched: 1.0,
            recordsScanned: 100.0,
            bytesScanned: 5000.0,
          },
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: { id: "test-id", name: "aws-logs", version: 1, tags: {} },
      });

      await model.methods.query.execute(
        {
          logGroupNames: ["/aws/lambda/func1"],
          queryString:
            "fields @timestamp, @message | filter @message like /error/i | limit 50",
          startTime: "1h",
          maxWaitSeconds: 5,
        },
        context as unknown as Parameters<
          typeof model.methods.query.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        queryId: string;
        status: string;
        results: Array<Record<string, string>>;
        statistics: {
          recordsMatched: number;
          recordsScanned: number;
          bytesScanned: number;
        };
      };

      assertEquals(data.queryId, "q-test-123");
      assertEquals(data.status, "Complete");
      assertEquals(data.results.length, 1);
      assertEquals(data.results[0]["@message"], "test log line");
      assertExists(data.statistics);
      assertEquals(data.statistics.recordsMatched, 1);
      assertEquals(data.statistics.recordsScanned, 100);
      // Verify polling happened (at least 2 calls)
      assertEquals(getResultsCalls >= 2, true);
    } finally {
      restore();
    }
  },
);
