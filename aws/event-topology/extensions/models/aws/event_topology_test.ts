// AWS Event Topology Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EventBridgeClient } from "npm:@aws-sdk/client-eventbridge@3.1069.0";
import { SNSClient } from "npm:@aws-sdk/client-sns@3.1069.0";
import { SQSClient } from "npm:@aws-sdk/client-sqs@3.1069.0";
import { LambdaClient } from "npm:@aws-sdk/client-lambda@3.1069.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1069.0";
import { model } from "./event_topology.ts";

// =============================================================================
// Type aliases
// =============================================================================

type DiscoverContext = Parameters<typeof model.methods.discover.execute>[1];
type AnalyzeContext = Parameters<typeof model.methods.analyze.execute>[1];

// =============================================================================
// Mock Helpers
// =============================================================================

// deno-lint-ignore no-explicit-any
type MockFn = (cmd: unknown) => any;

function mockClients(overrides: {
  sts?: MockFn;
  eventbridge?: MockFn;
  sns?: MockFn;
  sqs?: MockFn;
  lambda?: MockFn;
}): () => void {
  const originals = {
    sts: STSClient.prototype.send,
    eventbridge: EventBridgeClient.prototype.send,
    sns: SNSClient.prototype.send,
    sqs: SQSClient.prototype.send,
    lambda: LambdaClient.prototype.send,
  };
  if (overrides.sts) {
    // deno-lint-ignore no-explicit-any
    STSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sts!(_c));
    } as typeof originals.sts;
  }
  if (overrides.eventbridge) {
    // deno-lint-ignore no-explicit-any
    EventBridgeClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.eventbridge!(_c));
    } as typeof originals.eventbridge;
  }
  if (overrides.sns) {
    // deno-lint-ignore no-explicit-any
    SNSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sns!(_c));
    } as typeof originals.sns;
  }
  if (overrides.sqs) {
    // deno-lint-ignore no-explicit-any
    SQSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sqs!(_c));
    } as typeof originals.sqs;
  }
  if (overrides.lambda) {
    // deno-lint-ignore no-explicit-any
    LambdaClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.lambda!(_c));
    } as typeof originals.lambda;
  }
  return () => {
    STSClient.prototype.send = originals.sts;
    EventBridgeClient.prototype.send = originals.eventbridge;
    SNSClient.prototype.send = originals.sns;
    SQSClient.prototype.send = originals.sqs;
    LambdaClient.prototype.send = originals.lambda;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: { profile: "test-profile", region: "us-east-1" },
    definition: {
      id: "test-id",
      name: "aws-event-topology",
      version: 1,
      tags: {},
    },
  });
}

function baseMocks(): {
  sts: MockFn;
  eventbridge: MockFn;
  sns: MockFn;
  sqs: MockFn;
  lambda: MockFn;
} {
  return {
    sts: () => ({ Account: "123456789012" }),
    eventbridge: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "ListEventBusesCommand") {
        return {
          EventBuses: [{
            Name: "default",
            Arn: "arn:aws:events:us-east-1:123456789012:event-bus/default",
          }],
        };
      }
      if (name === "ListRulesCommand") {
        return {
          Rules: [{
            Name: "test-rule",
            State: "ENABLED",
            EventPattern: "{}",
          }],
        };
      }
      if (name === "ListTargetsByRuleCommand") {
        return {
          Targets: [{
            Id: "target-1",
            Arn: "arn:aws:lambda:us-east-1:123456789012:function:my-func",
          }],
        };
      }
      return {};
    },
    sns: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "ListTopicsCommand") {
        return {
          Topics: [
            { TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic" },
          ],
        };
      }
      if (name === "ListSubscriptionsByTopicCommand") {
        return {
          Subscriptions: [{
            SubscriptionArn:
              "arn:aws:sns:us-east-1:123456789012:my-topic:sub-1",
            Protocol: "sqs",
            Endpoint: "arn:aws:sqs:us-east-1:123456789012:my-queue",
          }],
        };
      }
      return {};
    },
    sqs: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "ListQueuesCommand") {
        return {
          QueueUrls: [
            "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue",
          ],
        };
      }
      if (name === "GetQueueAttributesCommand") {
        return {
          Attributes: {
            QueueArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
            ApproximateNumberOfMessages: "5",
          },
        };
      }
      return {};
    },
    lambda: () => ({ EventSourceMappings: [] }),
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/event-topology");
});

Deno.test("model version matches CalVer pattern", () => {
  const pattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(pattern.test(model.version), true);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.graph);
  assertExists(model.resources.analysis);
  assertEquals(model.resources.graph.lifetime, "12h");
  assertEquals(model.resources.analysis.lifetime, "6h");
});

Deno.test("model defines expected methods", () => {
  assertEquals("discover" in model.methods, true);
  assertEquals("analyze" in model.methods, true);
});

// =============================================================================
// discover method tests
// =============================================================================

Deno.test("discover: produces graph with correct node and edge counts", async () => {
  const restore = mockClients(baseMocks());
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);

    const data = graph.data as {
      nodes: Array<{ id: string; type: string }>;
      edges: Array<{ from: string; to: string; type: string }>;
      stats: { totalNodes: number; totalEdges: number };
    };
    // EB rule + Lambda target + SNS topic + SQS queue = 4 nodes
    // (SQS queue appears from both ListQueues and as SNS subscription target — deduped by id)
    assertEquals(data.stats.totalNodes, 4);
    // EB rule->Lambda target + SNS->SQS subscription = 2 edges
    assertEquals(data.stats.totalEdges, 2);
  } finally {
    restore();
  }
});

Deno.test("discover: skips empty target ARNs", async () => {
  const mocks = baseMocks();
  mocks.eventbridge = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListEventBusesCommand") {
      return { EventBuses: [{ Name: "default" }] };
    }
    if (name === "ListRulesCommand") {
      return { Rules: [{ Name: "rule-1", State: "ENABLED" }] };
    }
    if (name === "ListTargetsByRuleCommand") {
      return {
        Targets: [{ Id: "t1", Arn: "" }, {
          Id: "t2",
          Arn: "arn:aws:lambda:us-east-1:123456789012:function:real",
        }],
      };
    }
    return {};
  };
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as {
      nodes: Array<{ id: string }>;
      edges: Array<{ to: string }>;
    };
    // Empty ARN target should be skipped
    const emptyNode = data.nodes.find((n) => n.id === "");
    assertEquals(emptyNode, undefined);
  } finally {
    restore();
  }
});

Deno.test("discover: handles SQS redrive policy", async () => {
  const mocks = baseMocks();
  mocks.sqs = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListQueuesCommand") {
      return {
        QueueUrls: [
          "https://sqs.us-east-1.amazonaws.com/123456789012/source-queue",
        ],
      };
    }
    if (name === "GetQueueAttributesCommand") {
      return {
        Attributes: {
          QueueArn: "arn:aws:sqs:us-east-1:123456789012:source-queue",
          ApproximateNumberOfMessages: "0",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
            maxReceiveCount: 3,
          }),
        },
      };
    }
    return {};
  };
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as {
      edges: Array<
        {
          from: string;
          to: string;
          type: string;
          attributes: Record<string, unknown>;
        }
      >;
    };
    const redriveEdge = data.edges.find((e) => e.type === "redrive");
    assertExists(redriveEdge);
    assertEquals(redriveEdge.to, "arn:aws:sqs:us-east-1:123456789012:dlq");
    assertEquals(redriveEdge.attributes.maxReceiveCount, 3);
  } finally {
    restore();
  }
});

Deno.test("discover: handles SQS GetQueueAttributes failure gracefully", async () => {
  const mocks = baseMocks();
  mocks.sqs = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListQueuesCommand") {
      return {
        QueueUrls: [
          "https://sqs.us-east-1.amazonaws.com/123456789012/forbidden-queue",
        ],
      };
    }
    if (name === "GetQueueAttributesCommand") {
      throw new Error("Access Denied");
    }
    return {};
  };
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    // Should still succeed — the error is caught per-queue
    const data = graph.data as { stats: { totalNodes: number } };
    assertExists(data.stats);
  } finally {
    restore();
  }
});

Deno.test("discover: detects boundary nodes for cross-account ARNs", async () => {
  const mocks = baseMocks();
  mocks.eventbridge = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListEventBusesCommand") {
      return { EventBuses: [{ Name: "default" }] };
    }
    if (name === "ListRulesCommand") {
      return { Rules: [{ Name: "xaccount-rule", State: "ENABLED" }] };
    }
    if (name === "ListTargetsByRuleCommand") {
      return {
        Targets: [{
          Id: "t1",
          Arn:
            "arn:aws:lambda:us-east-1:999888777666:function:other-account-func",
        }],
      };
    }
    return {};
  };
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as {
      nodes: Array<{ id: string; isBoundary: boolean }>;
    };
    const crossAccount = data.nodes.find((n) => n.id.includes("999888777666"));
    assertExists(crossAccount);
    assertEquals(crossAccount.isBoundary, true);
  } finally {
    restore();
  }
});

Deno.test("discover: external SNS endpoints classified as boundary", async () => {
  const mocks = baseMocks();
  mocks.sns = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListTopicsCommand") {
      return {
        Topics: [{ TopicArn: "arn:aws:sns:us-east-1:123456789012:alerts" }],
      };
    }
    if (name === "ListSubscriptionsByTopicCommand") {
      return {
        Subscriptions: [{
          SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:alerts:abc",
          Protocol: "email",
          Endpoint: "user@example.com",
        }],
      };
    }
    return {};
  };
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as {
      nodes: Array<{ id: string; type: string; isBoundary: boolean }>;
    };
    const emailNode = data.nodes.find((n) =>
      n.id.startsWith("external:email:")
    );
    assertExists(emailNode);
    assertEquals(emailNode.type, "ExternalEndpoint");
    assertEquals(emailNode.isBoundary, true);
  } finally {
    restore();
  }
});

Deno.test("discover: Lambda ESM creates eventSource edges", async () => {
  const mocks = baseMocks();
  mocks.lambda = () => ({
    EventSourceMappings: [{
      UUID: "esm-123",
      EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:trigger-queue",
      FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:processor",
      State: "Enabled",
      BatchSize: 10,
    }],
  });
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as {
      edges: Array<{ from: string; to: string; type: string }>;
    };
    const esmEdge = data.edges.find((e) => e.type === "eventSource");
    assertExists(esmEdge);
    assertEquals(
      esmEdge.from,
      "arn:aws:sqs:us-east-1:123456789012:trigger-queue",
    );
    assertEquals(
      esmEdge.to,
      "arn:aws:lambda:us-east-1:123456789012:function:processor",
    );
  } finally {
    restore();
  }
});

Deno.test("discover: skips ESM with empty source/function ARN", async () => {
  const mocks = baseMocks();
  mocks.lambda = () => ({
    EventSourceMappings: [
      {
        UUID: "esm-empty",
        EventSourceArn: "",
        FunctionArn: "",
        State: "Enabled",
      },
      {
        UUID: "esm-ok",
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:q",
        FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:f",
        State: "Enabled",
      },
    ],
  });
  const restore = mockClients(mocks);
  try {
    const { context, getWrittenResources } = makeContext();
    await model.methods.discover.execute(
      { maxRulesPerBus: 100, maxTopics: 200, maxQueues: 500 },
      context as unknown as DiscoverContext,
    );

    const resources = getWrittenResources();
    const graph = resources.find((r) => r.specName === "graph");
    assertExists(graph);
    const data = graph.data as { edges: Array<{ type: string }> };
    const esmEdges = data.edges.filter((e) => e.type === "eventSource");
    assertEquals(esmEdges.length, 1);
  } finally {
    restore();
  }
});

// =============================================================================
// analyze method tests
// =============================================================================

function makeAnalyzeContext(graphData: Record<string, unknown>) {
  const { context, getWrittenResources } = makeContext();
  const patched = context as unknown as Record<string, unknown>;
  patched.readResource = (instance: string) => {
    if (instance === "topology") return Promise.resolve(graphData);
    return Promise.resolve(null);
  };
  return { context, getWrittenResources };
}

const sampleGraph = {
  fetchedAt: "2026-06-28T05:00:00Z",
  accountId: "123456789012",
  region: "us-east-1",
  nodes: [
    {
      id: "a",
      type: "SNSTopic",
      accountId: "123456789012",
      region: "us-east-1",
      name: "topic-a",
      isBoundary: false,
      metadata: {},
    },
    {
      id: "b",
      type: "SQSQueue",
      accountId: "123456789012",
      region: "us-east-1",
      name: "queue-b",
      isBoundary: false,
      metadata: {},
    },
    {
      id: "c",
      type: "Lambda",
      accountId: "123456789012",
      region: "us-east-1",
      name: "func-c",
      isBoundary: false,
      metadata: {},
    },
    {
      id: "d",
      type: "ExternalEndpoint",
      accountId: "123456789012",
      region: "us-east-1",
      name: "ext-d",
      isBoundary: true,
      metadata: {},
    },
    {
      id: "e",
      type: "SQSQueue",
      accountId: "123456789012",
      region: "us-east-1",
      name: "orphan-e",
      isBoundary: false,
      metadata: {},
    },
  ],
  edges: [
    {
      from: "a",
      to: "b",
      type: "subscription",
      attributes: { protocol: "sqs" },
    },
    {
      from: "a",
      to: "c",
      type: "subscription",
      attributes: { protocol: "lambda" },
    },
    {
      from: "a",
      to: "d",
      type: "subscription",
      attributes: { protocol: "email" },
    },
    { from: "b", to: "c", type: "eventSource", attributes: {} },
  ],
  stats: {
    totalNodes: 5,
    totalEdges: 4,
    nodesByType: {},
    edgesByType: {},
    maxInDegree: 2,
    maxOutDegree: 3,
    connectedComponents: 2,
    boundaryNodes: 1,
    isolatedNodes: 1,
  },
};

Deno.test("analyze: returns error when no graph data exists", async () => {
  const { context, getWrittenResources } = makeContext();
  const patched = context as unknown as Record<string, unknown>;
  patched.readResource = () => Promise.resolve(null);

  await model.methods.analyze.execute(
    { query: "hubs", threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 0);
});

Deno.test("analyze: path query requires nodeId", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "path", nodeId: undefined, threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 0);
});

Deno.test("analyze: hubs query finds nodes above threshold", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "hubs", threshold: 2 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  const analysis = resources.find((r) => r.specName === "analysis");
  assertExists(analysis);
  const data = analysis.data as {
    results: Array<{ id: string; outDegree: number }>;
    summary: { totalHubs: number };
  };
  // Node "a" has outDegree 3, node "c" has inDegree 2
  assertEquals(data.summary.totalHubs, 2);
  assertEquals(data.results[0].id, "a");
});

Deno.test("analyze: orphans query finds disconnected nodes", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "orphans", threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  const analysis = resources.find((r) => r.specName === "analysis");
  assertExists(analysis);
  const data = analysis.data as {
    results: Array<{ id: string }>;
    summary: { totalOrphans: number };
  };
  assertEquals(data.summary.totalOrphans, 1);
  assertEquals(data.results[0].id, "e");
});

Deno.test("analyze: boundaries query categorizes boundary nodes", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "boundaries", threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  const analysis = resources.find((r) => r.specName === "analysis");
  assertExists(analysis);
  const data = analysis.data as {
    summary: { totalBoundaryNodes: number; external: number };
  };
  assertEquals(data.summary.totalBoundaryNodes, 1);
  assertEquals(data.summary.external, 1);
});

Deno.test("analyze: components query groups connected nodes", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "components", threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  const analysis = resources.find((r) => r.specName === "analysis");
  assertExists(analysis);
  const data = analysis.data as {
    summary: {
      totalComponents: number;
      largestComponent: number;
      singletons: number;
    };
  };
  assertEquals(data.summary.totalComponents, 2);
  assertEquals(data.summary.largestComponent, 4);
  assertEquals(data.summary.singletons, 1);
});

Deno.test("analyze: path query returns inputs and outputs for a node", async () => {
  const { context, getWrittenResources } = makeAnalyzeContext(sampleGraph);

  await model.methods.analyze.execute(
    { query: "path", nodeId: "b", threshold: 3 },
    context as unknown as AnalyzeContext,
  );

  const resources = getWrittenResources();
  const analysis = resources.find((r) => r.specName === "analysis");
  assertExists(analysis);
  const data = analysis.data as {
    results: Array<
      { node: { id: string }; inputs: unknown[]; outputs: unknown[] }
    >;
    summary: { inputCount: number; outputCount: number };
  };
  assertEquals(data.summary.inputCount, 1);
  assertEquals(data.summary.outputCount, 1);
  assertEquals(data.results[0].node.id, "b");
});
