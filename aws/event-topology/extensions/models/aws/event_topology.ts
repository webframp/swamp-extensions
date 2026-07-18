/**
 * Event topology observation — discovers the directed graph of event
 * relationships (EventBridge rules, SNS subscriptions, SQS redrive chains,
 * Lambda event source mappings) and produces a unified graph resource.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  EventBridgeClient,
  ListEventBusesCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
} from "npm:@aws-sdk/client-eventbridge@3.1090.0";
import {
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from "npm:@aws-sdk/client-sns@3.1090.0";
import {
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SQSClient,
} from "npm:@aws-sdk/client-sqs@3.1090.0";
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
} from "npm:@aws-sdk/client-lambda@3.1090.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1090.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1090.0";

// Defensive pagination cap. The per-topic subscription and Lambda event-source
// mapping listings have no caller-supplied bound (unlike rules/topics/queues),
// so a pathological account could otherwise page indefinitely. 50 pages at up
// to 100 items each is a practical ceiling; hitting it is logged as a warning.
const MAX_PAGES = 50;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  profile: z.string().optional().describe("AWS profile to use"),
  region: z.string().optional().default("us-east-1").describe("AWS region"),
});

const NodeTypeEnum = z.enum([
  "EventBridgeRule",
  "EventBridgeBus",
  "SNSTopic",
  "SQSQueue",
  "Lambda",
  "StepFunctions",
  "Kinesis",
  "Firehose",
  "DynamoDB",
  "S3",
  "MSK",
  "AmazonMQ",
  "APIGateway",
  "CodePipeline",
  "CodeBuild",
  "CloudWatchLogs",
  "ECS",
  "ExternalEndpoint",
  "Unknown",
]);

const EdgeTypeEnum = z.enum([
  "targets",
  "subscription",
  "redrive",
  "eventSource",
  "dlq",
  "failureDestination",
]);

const NodeSchema = z.object({
  id: z.string(),
  type: NodeTypeEnum,
  accountId: z.string(),
  region: z.string(),
  name: z.string(),
  isBoundary: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: EdgeTypeEnum,
  attributes: z.record(z.string(), z.unknown()).default({}),
});

const GraphStatsSchema = z.object({
  totalNodes: z.number(),
  totalEdges: z.number(),
  nodesByType: z.record(z.string(), z.number()),
  edgesByType: z.record(z.string(), z.number()),
  maxInDegree: z.number(),
  maxOutDegree: z.number(),
  connectedComponents: z.number(),
  boundaryNodes: z.number(),
  isolatedNodes: z.number(),
});

const GraphSchema = z.object({
  fetchedAt: z.string(),
  accountId: z.string(),
  region: z.string(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  stats: GraphStatsSchema,
  // Additive field with a default so previously-stored graphs (written before
  // this field existed) still validate on read.
  truncated: z.boolean().default(false),
});

const AnalysisResultSchema = z.object({
  fetchedAt: z.string(),
  query: z.string(),
  results: z.array(z.record(z.string(), z.unknown())),
  summary: z.record(z.string(), z.unknown()),
});

// =============================================================================
// Helpers
// =============================================================================

type ModelContext = {
  globalArgs: { profile?: string; region?: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
    error: (msg: string, props: Record<string, unknown>) => void;
  };
};

function clientConfig(ctx: ModelContext) {
  const config: Record<string, unknown> = {};
  if (ctx.globalArgs.region) config.region = ctx.globalArgs.region;
  if (ctx.globalArgs.profile) {
    config.credentials = fromIni({ profile: ctx.globalArgs.profile });
  }
  return config;
}

async function getAccountId(ctx: ModelContext): Promise<string> {
  const sts = new STSClient(clientConfig(ctx));
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    return resp.Account ?? "unknown";
  } finally {
    sts.destroy();
  }
}

function classifyArn(arn: string): z.infer<typeof NodeTypeEnum> {
  if (arn.includes(":lambda:")) return "Lambda";
  if (arn.includes(":sqs:")) return "SQSQueue";
  if (arn.includes(":sns:")) return "SNSTopic";
  if (arn.includes(":states:")) return "StepFunctions";
  if (arn.includes(":kinesis:")) return "Kinesis";
  if (arn.includes(":firehose:")) return "Firehose";
  if (arn.includes(":execute-api:")) return "APIGateway";
  if (arn.includes(":ecs:")) return "ECS";
  if (arn.includes(":codepipeline:")) return "CodePipeline";
  if (arn.includes(":codebuild:")) return "CodeBuild";
  if (arn.includes(":logs:")) return "CloudWatchLogs";
  if (arn.includes(":events:") && arn.includes("/rule/")) {
    return "EventBridgeRule";
  }
  if (arn.includes(":events:")) return "EventBridgeBus";
  if (arn.includes(":dynamodb:")) return "DynamoDB";
  if (arn.includes(":s3:") || arn.startsWith("arn:aws:s3:")) return "S3";
  if (arn.includes(":kafka:") || arn.includes(":kafka-cluster:")) return "MSK";
  if (arn.includes(":mq:")) return "AmazonMQ";
  return "Unknown";
}

function classifyEventSource(arn: string): z.infer<typeof NodeTypeEnum> {
  if (arn.includes(":sqs:")) return "SQSQueue";
  if (arn.includes(":kinesis:")) return "Kinesis";
  if (arn.includes(":dynamodb:")) return "DynamoDB";
  if (arn.includes(":kafka:") || arn.includes(":kafka-cluster:")) return "MSK";
  if (arn.includes(":mq:")) return "AmazonMQ";
  if (arn.includes(":s3:")) return "S3";
  return "Unknown";
}

function extractName(arn: string): string {
  const parts = arn.split(":");
  const resource = parts[parts.length - 1];
  if (resource.includes("/")) return resource.split("/").pop() ?? resource;
  return resource;
}

function extractAccountId(arn: string): string {
  const parts = arn.split(":");
  return parts.length >= 5 ? parts[4] : "unknown";
}

function isBoundaryNode(arn: string, scanAccountId: string): boolean {
  const nodeAccount = extractAccountId(arn);
  if (
    nodeAccount && nodeAccount !== scanAccountId && nodeAccount !== "unknown" &&
    nodeAccount !== ""
  ) return true;
  if (arn.includes(":::")) return true;
  return false;
}

function isSnsEndpointInternal(protocol: string, endpoint: string): boolean {
  if (protocol === "lambda" || protocol === "sqs" || protocol === "firehose") {
    return true;
  }
  if (protocol === "application" && endpoint.includes(":lambda:")) return true;
  if (
    (protocol === "http" || protocol === "https") &&
    endpoint.includes(".amazonaws.com")
  ) return true;
  return false;
}

// =============================================================================
// Model
// =============================================================================

/** Event topology model — observes the directed graph of AWS event relationships. */
export const model = {
  type: "@webframp/aws/event-topology",
  version: "2026.06.28.5",
  globalArguments: GlobalArgsSchema,

  resources: {
    graph: {
      description: "Unified event topology graph — nodes and edges",
      schema: GraphSchema,
      lifetime: "12h" as const,
      garbageCollection: 3,
    },
    analysis: {
      description: "Derived analysis views from graph data",
      schema: AnalysisResultSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    // =========================================================================
    // discover — single fan-out method, queries all 4 services
    // =========================================================================
    discover: {
      description:
        "Discover event topology across EventBridge, SNS, SQS, and Lambda ESM. Produces a unified graph of nodes and edges.",
      arguments: z.object({
        maxRulesPerBus: z.number().optional().default(100)
          .describe("Max EventBridge rules to fetch per bus"),
        maxTopics: z.number().optional().default(200)
          .describe("Max SNS topics to enumerate"),
        maxQueues: z.number().optional().default(500)
          .describe("Max SQS queues to enumerate"),
      }),
      execute: async (
        args: { maxRulesPerBus: number; maxTopics: number; maxQueues: number },
        context: ModelContext,
      ) => {
        const accountId = await getAccountId(context);
        const region = context.globalArgs.region ?? "us-east-1";

        const nodes = new Map<string, z.infer<typeof NodeSchema>>();
        const edges: z.infer<typeof EdgeSchema>[] = [];
        // Set true if any pagination cap fires, so downstream consumers can tell
        // an incomplete graph from a complete one.
        let truncated = false;

        function addNode(
          id: string,
          type: z.infer<typeof NodeTypeEnum>,
          name: string,
          metadata: Record<string, unknown> = {},
        ) {
          if (!nodes.has(id)) {
            nodes.set(id, {
              id,
              type,
              accountId: extractAccountId(id) || accountId,
              region,
              name,
              isBoundary: isBoundaryNode(id, accountId),
              metadata,
            });
          }
        }

        // ----- EventBridge -----
        const ebClient = new EventBridgeClient(clientConfig(context));
        try {
          const busResp = await ebClient.send(new ListEventBusesCommand({}));
          for (const bus of busResp.EventBuses ?? []) {
            const busName = bus.Name ?? "default";
            let nextToken: string | undefined;
            let fetched = 0;

            while (fetched < args.maxRulesPerBus) {
              const rulesResp = await ebClient.send(
                new ListRulesCommand({
                  EventBusName: busName,
                  NextToken: nextToken,
                  Limit: Math.min(100, args.maxRulesPerBus - fetched),
                }),
              );

              for (const rule of rulesResp.Rules ?? []) {
                const ruleId = `eventbridge:rule:${busName}/${rule.Name}`;
                addNode(ruleId, "EventBridgeRule", rule.Name ?? "", {
                  state: rule.State,
                  scheduleExpression: rule.ScheduleExpression ?? null,
                  hasEventPattern: !!rule.EventPattern,
                });

                const targetsResp = await ebClient.send(
                  new ListTargetsByRuleCommand({
                    Rule: rule.Name,
                    EventBusName: busName,
                  }),
                );

                for (const target of targetsResp.Targets ?? []) {
                  const targetArn = target.Arn ?? "";
                  if (!targetArn) continue;
                  const targetType = classifyArn(targetArn);
                  addNode(targetArn, targetType, extractName(targetArn));
                  edges.push({
                    from: ruleId,
                    to: targetArn,
                    type: "targets",
                    attributes: {
                      targetId: target.Id ?? "",
                      retryAttempts: target.RetryPolicy?.MaximumRetryAttempts ??
                        null,
                      maxEventAge:
                        target.RetryPolicy?.MaximumEventAgeInSeconds ?? null,
                    },
                  });

                  if (target.DeadLetterConfig?.Arn) {
                    const dlqArn = target.DeadLetterConfig.Arn;
                    addNode(dlqArn, "SQSQueue", extractName(dlqArn));
                    edges.push({
                      from: targetArn,
                      to: dlqArn,
                      type: "dlq",
                      attributes: {},
                    });
                  }
                }
                fetched++;
              }

              nextToken = rulesResp.NextToken;
              if (!nextToken) break;
            }
          }
        } finally {
          ebClient.destroy();
        }

        // ----- SNS -----
        const snsClient = new SNSClient(clientConfig(context));
        try {
          const topicArns: string[] = [];
          let nextToken: string | undefined;

          while (topicArns.length < args.maxTopics) {
            const resp = await snsClient.send(
              new ListTopicsCommand({ NextToken: nextToken }),
            );
            for (const t of resp.Topics ?? []) {
              if (t.TopicArn) topicArns.push(t.TopicArn);
            }
            nextToken = resp.NextToken;
            if (!nextToken) break;
          }

          for (const topicArn of topicArns) {
            addNode(topicArn, "SNSTopic", extractName(topicArn));

            let subToken: string | undefined;
            let subPages = 0;

            while (true) {
              const resp = await snsClient.send(
                new ListSubscriptionsByTopicCommand({
                  TopicArn: topicArn,
                  NextToken: subToken,
                }),
              );

              for (const sub of resp.Subscriptions ?? []) {
                if (sub.SubscriptionArn === "PendingConfirmation") continue;
                const protocol = sub.Protocol ?? "unknown";
                const endpoint = sub.Endpoint ?? "";
                const isInternal = isSnsEndpointInternal(protocol, endpoint);

                if (isInternal && endpoint) {
                  const endpointType = classifyArn(endpoint);
                  addNode(endpoint, endpointType, extractName(endpoint));
                  edges.push({
                    from: topicArn,
                    to: endpoint,
                    type: "subscription",
                    attributes: { protocol, isInternal: true },
                  });
                } else if (endpoint) {
                  const externalId = `external:${protocol}:${
                    endpoint.slice(0, 80)
                  }`;
                  if (!nodes.has(externalId)) {
                    nodes.set(externalId, {
                      id: externalId,
                      type: "ExternalEndpoint",
                      accountId,
                      region,
                      name: endpoint.slice(0, 60),
                      isBoundary: true,
                      metadata: { protocol },
                    });
                  }
                  edges.push({
                    from: topicArn,
                    to: externalId,
                    type: "subscription",
                    attributes: { protocol, isInternal: false },
                  });
                }
              }

              subToken = resp.NextToken;
              if (!subToken) break;
              if (++subPages >= MAX_PAGES) {
                truncated = true;
                context.logger.warn(
                  "Subscription pagination cap reached; results may be incomplete",
                  { topicArn, maxPages: MAX_PAGES },
                );
                break;
              }
            }
          }
        } finally {
          snsClient.destroy();
        }

        // ----- SQS -----
        const sqsClient = new SQSClient(clientConfig(context));
        try {
          const queueUrls: string[] = [];
          let nextToken: string | undefined;

          while (queueUrls.length < args.maxQueues) {
            const resp = await sqsClient.send(
              new ListQueuesCommand({
                NextToken: nextToken,
                MaxResults: Math.min(1000, args.maxQueues - queueUrls.length),
              }),
            );
            for (const url of resp.QueueUrls ?? []) queueUrls.push(url);
            nextToken = resp.NextToken;
            if (!nextToken) break;
          }

          for (const url of queueUrls) {
            try {
              const attrs = await sqsClient.send(
                new GetQueueAttributesCommand({
                  QueueUrl: url,
                  AttributeNames: ["All"],
                }),
              );
              const a = attrs.Attributes ?? {};
              const queueArn = a.QueueArn ?? "";
              const queueName = url.split("/").pop() ?? url;

              addNode(queueArn, "SQSQueue", queueName, {
                approximateMessageCount: Number(
                  a.ApproximateNumberOfMessages ?? "0",
                ),
              });

              if (a.RedrivePolicy) {
                try {
                  const policy = JSON.parse(a.RedrivePolicy);
                  const dlqArn = policy.deadLetterTargetArn;
                  if (dlqArn) {
                    addNode(dlqArn, "SQSQueue", extractName(dlqArn));
                    edges.push({
                      from: queueArn,
                      to: dlqArn,
                      type: "redrive",
                      attributes: {
                        maxReceiveCount: Number(policy.maxReceiveCount ?? 0),
                      },
                    });
                  }
                } catch { /* malformed policy */ }
              }
            } catch (err) {
              context.logger.warn("Failed to get queue attributes", {
                url,
                error: String(err),
              });
            }
          }
        } finally {
          sqsClient.destroy();
        }

        // ----- Lambda Event Source Mappings -----
        const lambdaClient = new LambdaClient(clientConfig(context));
        try {
          let marker: string | undefined;
          let mappingPages = 0;
          while (true) {
            const resp = await lambdaClient.send(
              new ListEventSourceMappingsCommand({ Marker: marker }),
            );

            for (const m of resp.EventSourceMappings ?? []) {
              const sourceArn = m.EventSourceArn ?? "";
              const functionArn = m.FunctionArn ?? "";
              if (!sourceArn || !functionArn) continue;
              const sourceType = classifyEventSource(sourceArn);

              addNode(sourceArn, sourceType, extractName(sourceArn));
              addNode(functionArn, "Lambda", extractName(functionArn));
              edges.push({
                from: sourceArn,
                to: functionArn,
                type: "eventSource",
                attributes: {
                  uuid: m.UUID ?? "",
                  state: m.State ?? "Unknown",
                  batchSize: m.BatchSize ?? null,
                  bisectOnError: m.BisectBatchOnFunctionError ?? null,
                },
              });

              if (m.DestinationConfig?.OnFailure?.Destination) {
                const failDest = m.DestinationConfig.OnFailure.Destination;
                addNode(failDest, classifyArn(failDest), extractName(failDest));
                edges.push({
                  from: functionArn,
                  to: failDest,
                  type: "failureDestination",
                  attributes: {},
                });
              }
            }

            marker = resp.NextMarker;
            if (!marker) break;
            if (++mappingPages >= MAX_PAGES) {
              truncated = true;
              context.logger.warn(
                "Event source mapping pagination cap reached; results may be incomplete",
                { maxPages: MAX_PAGES },
              );
              break;
            }
          }
        } finally {
          lambdaClient.destroy();
        }

        // ----- Compute stats -----
        const nodesByType: Record<string, number> = {};
        for (const node of nodes.values()) {
          nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
        }

        const edgesByType: Record<string, number> = {};
        for (const edge of edges) {
          edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
        }

        const inDegree = new Map<string, number>();
        const outDegree = new Map<string, number>();
        for (const e of edges) {
          outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
          inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
        }

        // Union-find for connected components (iterative to avoid stack overflow)
        const parent = new Map<string, string>();
        const find = (x: string): string => {
          if (!parent.has(x)) parent.set(x, x);
          let root = x;
          while (parent.get(root) !== root) root = parent.get(root)!;
          let curr = x;
          while (curr !== root) {
            const next = parent.get(curr)!;
            parent.set(curr, root);
            curr = next;
          }
          return root;
        };
        const union = (a: string, b: string) => {
          parent.set(find(a), find(b));
        };

        for (const id of nodes.keys()) find(id);
        for (const e of edges) union(e.from, e.to);

        const roots = new Set([...nodes.keys()].map(find));
        const isolatedNodes =
          [...nodes.keys()].filter((n) =>
            !edges.some((e) => e.from === n || e.to === n)
          ).length;

        const result: z.infer<typeof GraphSchema> = {
          fetchedAt: new Date().toISOString(),
          accountId,
          region,
          nodes: [...nodes.values()],
          edges,
          stats: {
            totalNodes: nodes.size,
            totalEdges: edges.length,
            nodesByType,
            edgesByType,
            maxInDegree: Math.max(0, ...inDegree.values()),
            maxOutDegree: Math.max(0, ...outDegree.values()),
            connectedComponents: roots.size,
            boundaryNodes:
              [...nodes.values()].filter((n) => n.isBoundary).length,
            isolatedNodes,
          },
          truncated,
        };

        const handle = await context.writeResource("graph", "topology", result);

        context.logger.info("Event topology discovery complete", {
          nodes: nodes.size,
          edges: edges.length,
          components: roots.size,
          boundary: result.stats.boundaryNodes,
        });

        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // analyze — pure data-layer queries against stored graph
    // =========================================================================
    analyze: {
      description:
        "Analyze stored event topology graph. Produces derived views: hubs, boundaries, orphans, components, or path queries.",
      arguments: z.object({
        query: z.enum(["hubs", "boundaries", "orphans", "components", "path"])
          .describe("Analysis query type"),
        nodeId: z.string().optional()
          .describe("Node ID for path queries"),
        threshold: z.number().optional().default(3)
          .describe("Degree threshold for hub detection"),
      }),
      execute: async (
        args: { query: string; nodeId?: string; threshold: number },
        context: ModelContext,
      ) => {
        if (args.query === "path" && !args.nodeId) {
          context.logger.error("path query requires nodeId argument", {});
          return { dataHandles: [] };
        }

        const graphData = await context.readResource("topology");
        if (!graphData) {
          context.logger.error("No graph data found. Run discover first.", {});
          return { dataHandles: [] };
        }

        const graph = graphData as unknown as z.infer<typeof GraphSchema>;
        const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

        // Build adjacency
        const outEdges = new Map<string, z.infer<typeof EdgeSchema>[]>();
        const inEdges = new Map<string, z.infer<typeof EdgeSchema>[]>();
        for (const e of graph.edges) {
          if (!outEdges.has(e.from)) outEdges.set(e.from, []);
          outEdges.get(e.from)!.push(e);
          if (!inEdges.has(e.to)) inEdges.set(e.to, []);
          inEdges.get(e.to)!.push(e);
        }

        let results: Record<string, unknown>[] = [];
        let summary: Record<string, unknown> = {};

        if (args.query === "hubs") {
          for (const node of graph.nodes) {
            const inDeg = inEdges.get(node.id)?.length ?? 0;
            const outDeg = outEdges.get(node.id)?.length ?? 0;
            if (inDeg >= args.threshold || outDeg >= args.threshold) {
              results.push({
                id: node.id,
                name: node.name,
                type: node.type,
                inDegree: inDeg,
                outDegree: outDeg,
                totalDegree: inDeg + outDeg,
              });
            }
          }
          results.sort((a, b) =>
            (b.totalDegree as number) - (a.totalDegree as number)
          );
          summary = { totalHubs: results.length, threshold: args.threshold };
        }

        if (args.query === "boundaries") {
          const byReason: Record<string, unknown[]> = {
            crossAccount: [],
            external: [],
            unresolvable: [],
          };
          for (const node of graph.nodes) {
            if (!node.isBoundary) continue;
            const entry = {
              id: node.id,
              name: node.name,
              type: node.type,
              accountId: node.accountId,
            };
            if (node.type === "ExternalEndpoint") byReason.external.push(entry);
            else if (node.accountId !== graph.accountId) {
              byReason.crossAccount.push(entry);
            } else byReason.unresolvable.push(entry);
          }
          results = [byReason as unknown as Record<string, unknown>];
          summary = {
            totalBoundaryNodes: graph.stats.boundaryNodes,
            crossAccount: (byReason.crossAccount as unknown[]).length,
            external: (byReason.external as unknown[]).length,
            unresolvable: (byReason.unresolvable as unknown[]).length,
          };
        }

        if (args.query === "orphans") {
          for (const node of graph.nodes) {
            const hasEdge = graph.edges.some((e) =>
              e.from === node.id || e.to === node.id
            );
            if (!hasEdge) {
              results.push({ id: node.id, name: node.name, type: node.type });
            }
          }
          summary = { totalOrphans: results.length, byType: {} };
          for (const r of results) {
            const t = r.type as string;
            (summary.byType as Record<string, number>)[t] =
              ((summary.byType as Record<string, number>)[t] ?? 0) + 1;
          }
        }

        if (args.query === "components") {
          const parent = new Map<string, string>();
          const find = (x: string): string => {
            if (!parent.has(x)) parent.set(x, x);
            let root = x;
            while (parent.get(root) !== root) root = parent.get(root)!;
            let curr = x;
            while (curr !== root) {
              const next = parent.get(curr)!;
              parent.set(curr, root);
              curr = next;
            }
            return root;
          };
          const union = (a: string, b: string) => {
            parent.set(find(a), find(b));
          };

          for (const node of graph.nodes) find(node.id);
          for (const e of graph.edges) union(e.from, e.to);

          const components = new Map<string, string[]>();
          for (const node of graph.nodes) {
            const root = find(node.id);
            if (!components.has(root)) components.set(root, []);
            components.get(root)!.push(node.id);
          }

          const sorted = [...components.entries()]
            .map(([_root, members]) => ({
              size: members.length,
              types: [
                ...new Set(
                  members.map((id) => nodeMap.get(id)?.type ?? "Unknown"),
                ),
              ],
              members: members.slice(0, 10),
            }))
            .sort((a, b) => b.size - a.size);

          results = sorted as unknown as Record<string, unknown>[];
          summary = {
            totalComponents: sorted.length,
            largestComponent: sorted[0]?.size ?? 0,
            singletons: sorted.filter((c) => c.size === 1).length,
          };
        }

        if (args.query === "path" && args.nodeId) {
          const node = nodeMap.get(args.nodeId);
          if (node) {
            const inputs = (inEdges.get(args.nodeId) ?? []).map((e) => ({
              from: e.from,
              fromName: nodeMap.get(e.from)?.name ?? e.from,
              fromType: nodeMap.get(e.from)?.type ?? "Unknown",
              edgeType: e.type,
              attributes: e.attributes,
            }));
            const outputs = (outEdges.get(args.nodeId) ?? []).map((e) => ({
              to: e.to,
              toName: nodeMap.get(e.to)?.name ?? e.to,
              toType: nodeMap.get(e.to)?.type ?? "Unknown",
              edgeType: e.type,
              attributes: e.attributes,
            }));
            results = [{
              node: { id: node.id, name: node.name, type: node.type },
              inputs,
              outputs,
            }];
            summary = {
              inputCount: inputs.length,
              outputCount: outputs.length,
            };
          }
        }

        const analysisResult: z.infer<typeof AnalysisResultSchema> = {
          fetchedAt: new Date().toISOString(),
          query: args.query,
          results,
          summary,
        };

        const handle = await context.writeResource(
          "analysis",
          "analysis",
          analysisResult,
        );

        context.logger.info(`Analysis complete: ${args.query}`, {
          resultCount: results.length,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
