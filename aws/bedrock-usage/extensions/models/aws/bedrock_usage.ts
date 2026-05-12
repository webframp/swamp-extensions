/**
 * AWS Bedrock token usage monitoring model for swamp.
 *
 * Queries CloudWatch metrics for Bedrock InputTokenCount and OutputTokenCount
 * across multiple AWS accounts (via profiles) and regions. Provides per-model
 * breakdowns, invocation stats, and multi-account fan-out scanning.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
} from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1010.0";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the bedrock-usage model. */
const GlobalArgsSchema = z.object({
  profiles: z
    .array(z.string())
    .default(["default"])
    .describe("AWS CLI profile names to scan (supports cross-account roles)"),
  regions: z
    .array(z.string())
    .default(["us-east-1", "us-west-2"])
    .describe("AWS regions to query for Bedrock metrics"),
});

/** Schema for a single model's token usage. */
const ModelUsageSchema = z.object({
  modelId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

/** Schema for per-account usage results. */
const AccountUsageSchema = z.object({
  profile: z.string(),
  accountId: z.string().nullable(),
  region: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  models: z.array(ModelUsageSchema),
  invocations: z.number().nullable(),
  periodMinutes: z.number(),
  inputTokensPerMinute: z.number(),
  outputTokensPerMinute: z.number(),
});

/** Schema for the full scan results. */
const ScanResultsSchema = z.object({
  scannedAt: z.string(),
  days: z.number(),
  periodMinutes: z.number(),
  accounts: z.array(AccountUsageSchema),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    inputTokensPerMinute: z.number(),
    outputTokensPerMinute: z.number(),
  }),
});

/** Schema for listing active models in a single account/region. */
const ActiveModelsSchema = z.object({
  profile: z.string(),
  region: z.string(),
  models: z.array(z.string()),
  fetchedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CloudWatch client for a given profile and region.
 *
 * @param profile - AWS CLI profile name.
 * @param region - AWS region.
 * @returns Configured CloudWatchClient.
 */
function createClient(profile: string, region: string): CloudWatchClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new CloudWatchClient(opts as { region: string });
}

/**
 * List Bedrock model IDs that have InputTokenCount metrics.
 *
 * @param client - CloudWatch client.
 * @returns Array of model ID strings.
 */
async function listBedrockModels(client: CloudWatchClient): Promise<string[]> {
  const models = new Set<string>();
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new ListMetricsCommand({
        Namespace: "AWS/Bedrock",
        MetricName: "InputTokenCount",
        NextToken: nextToken,
      }),
    );
    for (const m of resp.Metrics || []) {
      for (const d of m.Dimensions || []) {
        if (d.Name === "ModelId" && d.Value) models.add(d.Value);
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return [...models].sort();
}

/**
 * Get aggregate token counts for a specific model (or all models if modelId is undefined).
 *
 * @param client - CloudWatch client.
 * @param startTime - Query start.
 * @param endTime - Query end.
 * @param modelId - Optional model ID filter.
 * @returns Object with inputTokens and outputTokens.
 */
async function getTokenCounts(
  client: CloudWatchClient,
  startTime: Date,
  endTime: Date,
  modelId?: string,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const period = Math.ceil(
    (endTime.getTime() - startTime.getTime()) / 1000,
  );
  const dimensions = modelId
    ? [{ Name: "ModelId", Value: modelId }]
    : undefined;

  const queries = [
    {
      Id: "input_tokens",
      MetricStat: {
        Metric: {
          Namespace: "AWS/Bedrock",
          MetricName: "InputTokenCount",
          ...(dimensions ? { Dimensions: dimensions } : {}),
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "output_tokens",
      MetricStat: {
        Metric: {
          Namespace: "AWS/Bedrock",
          MetricName: "OutputTokenCount",
          ...(dimensions ? { Dimensions: dimensions } : {}),
        },
        Period: period,
        Stat: "Sum",
      },
    },
  ];

  const resp = await client.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: queries,
    }),
  );

  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of resp.MetricDataResults || []) {
    const val = r.Values?.[0] ?? 0;
    if (r.Id === "input_tokens") inputTokens = val;
    if (r.Id === "output_tokens") outputTokens = val;
  }
  return { inputTokens, outputTokens };
}

/**
 * Get total invocation count.
 *
 * @param client - CloudWatch client.
 * @param startTime - Query start.
 * @param endTime - Query end.
 * @returns Total invocations or null if no data.
 */
async function getInvocations(
  client: CloudWatchClient,
  startTime: Date,
  endTime: Date,
): Promise<number | null> {
  const period = Math.ceil(
    (endTime.getTime() - startTime.getTime()) / 1000,
  );
  const resp = await client.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: "invocations",
          MetricStat: {
            Metric: {
              Namespace: "AWS/Bedrock",
              MetricName: "Invocations",
            },
            Period: period,
            Stat: "Sum",
          },
        },
      ],
    }),
  );
  const val = resp.MetricDataResults?.[0]?.Values?.[0];
  return val !== undefined ? val : null;
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** AWS Bedrock token usage monitoring model. */
export const model = {
  type: "@webframp/aws/bedrock-usage",
  version: "2026.05.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    scan_results: {
      description: "Multi-account Bedrock token usage scan results",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    active_models: {
      description: "Active Bedrock models in an account/region",
      schema: ActiveModelsSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    scan_accounts: {
      description:
        "Fan-out scan across all configured profiles and regions. Returns per-account token usage with model-level breakdown.",
      arguments: z.object({
        days: z.number().default(30).describe("Lookback period in days"),
      }),
      execute: async (
        args: { days: number },
        context: {
          globalArgs: { profiles: string[]; regions: string[] };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const accounts: z.infer<typeof AccountUsageSchema>[] = [];

        for (const profile of context.globalArgs.profiles) {
          for (const region of context.globalArgs.regions) {
            try {
              const client = createClient(profile, region);

              // Get aggregate totals
              const totals = await getTokenCounts(
                client,
                startTime,
                endTime,
              );
              if (totals.inputTokens === 0 && totals.outputTokens === 0) {
                continue; // Skip accounts/regions with no usage
              }

              // Get per-model breakdown
              const modelIds = await listBedrockModels(client);
              const models: z.infer<typeof ModelUsageSchema>[] = [];

              for (const modelId of modelIds) {
                const usage = await getTokenCounts(
                  client,
                  startTime,
                  endTime,
                  modelId,
                );
                if (usage.inputTokens > 0 || usage.outputTokens > 0) {
                  models.push({
                    modelId,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.inputTokens + usage.outputTokens,
                  });
                }
              }

              // Get invocation count
              const invocations = await getInvocations(
                client,
                startTime,
                endTime,
              );

              accounts.push({
                profile,
                accountId: null, // Could resolve via STS but adds latency
                region,
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                totalTokens: totals.inputTokens + totals.outputTokens,
                models: models.sort(
                  (a, b) => b.totalTokens - a.totalTokens,
                ),
                invocations,
                periodMinutes,
                inputTokensPerMinute: totals.inputTokens / periodMinutes,
                outputTokensPerMinute: totals.outputTokens / periodMinutes,
              });

              context.logger.info("Scanned account", {
                profile,
                region,
                totalTokens: totals.inputTokens + totals.outputTokens,
              });
            } catch (err) {
              context.logger.warn("Failed to scan account", {
                profile,
                region,
                error: String(err),
              });
            }
          }
        }

        // Sort by total tokens descending
        accounts.sort((a, b) => b.totalTokens - a.totalTokens);

        const totalInput = accounts.reduce(
          (s, a) => s + a.inputTokens,
          0,
        );
        const totalOutput = accounts.reduce(
          (s, a) => s + a.outputTokens,
          0,
        );

        const result = {
          scannedAt: new Date().toISOString(),
          days: args.days,
          periodMinutes,
          accounts,
          totals: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
            inputTokensPerMinute: totalInput / periodMinutes,
            outputTokensPerMinute: totalOutput / periodMinutes,
          },
        };

        const handle = await context.writeResource(
          "scan_results",
          "latest",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    list_active_models: {
      description:
        "List Bedrock models with active metrics in a specific profile/region.",
      arguments: z.object({
        profile: z
          .string()
          .optional()
          .describe("AWS profile (defaults to first in profiles list)"),
        region: z
          .string()
          .optional()
          .describe("AWS region (defaults to first in regions list)"),
      }),
      execute: async (
        args: { profile?: string; region?: string },
        context: {
          globalArgs: { profiles: string[]; regions: string[] };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const profile = args.profile ?? context.globalArgs.profiles[0] ?? "default";
        const region = args.region ?? context.globalArgs.regions[0] ?? "us-east-1";
        const client = createClient(profile, region);
        const models = await listBedrockModels(client);

        const result = {
          profile,
          region,
          models,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "active_models",
          `${profile}-${region}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    get_token_usage: {
      description:
        "Get token usage for a single profile/region with model breakdown.",
      arguments: z.object({
        profile: z
          .string()
          .optional()
          .describe("AWS profile (defaults to first in profiles list)"),
        region: z
          .string()
          .optional()
          .describe("AWS region (defaults to first in regions list)"),
        days: z.number().default(30).describe("Lookback period in days"),
      }),
      execute: async (
        args: { profile?: string; region?: string; days: number },
        context: {
          globalArgs: { profiles: string[]; regions: string[] };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const profile = args.profile ?? context.globalArgs.profiles[0] ?? "default";
        const region = args.region ?? context.globalArgs.regions[0] ?? "us-east-1";
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const client = createClient(profile, region);

        const totals = await getTokenCounts(client, startTime, endTime);
        const modelIds = await listBedrockModels(client);
        const models: z.infer<typeof ModelUsageSchema>[] = [];

        for (const modelId of modelIds) {
          const usage = await getTokenCounts(
            client,
            startTime,
            endTime,
            modelId,
          );
          if (usage.inputTokens > 0 || usage.outputTokens > 0) {
            models.push({
              modelId,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens,
            });
          }
        }

        const invocations = await getInvocations(client, startTime, endTime);

        const result = {
          scannedAt: new Date().toISOString(),
          days: args.days,
          periodMinutes,
          accounts: [
            {
              profile,
              accountId: null,
              region,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              totalTokens: totals.inputTokens + totals.outputTokens,
              models: models.sort((a, b) => b.totalTokens - a.totalTokens),
              invocations,
              periodMinutes,
              inputTokensPerMinute: totals.inputTokens / periodMinutes,
              outputTokensPerMinute: totals.outputTokens / periodMinutes,
            },
          ],
          totals: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.inputTokens + totals.outputTokens,
            inputTokensPerMinute: totals.inputTokens / periodMinutes,
            outputTokensPerMinute: totals.outputTokens / periodMinutes,
          },
        };

        const handle = await context.writeResource(
          "scan_results",
          `${profile}-${region}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
