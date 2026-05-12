/**
 * Azure OpenAI / AI Services token usage monitoring model for swamp.
 *
 * Queries Azure Monitor metrics for ProcessedPromptTokens and GeneratedTokens
 * across multiple subscriptions. Discovers CognitiveServices/OpenAI resources
 * and provides per-deployment breakdowns.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the azure openai-usage model. */
const GlobalArgsSchema = z.object({
  subscriptions: z
    .array(z.string())
    .describe(
      "Azure subscription IDs to scan for OpenAI/AI Services resources",
    ),
});

/** Schema for a single deployment's token usage. */
const DeploymentUsageSchema = z.object({
  deploymentName: z.string(),
  promptTokens: z.number(),
  generatedTokens: z.number(),
  totalTokens: z.number(),
});

/** Schema for per-resource usage results. */
const ResourceUsageSchema = z.object({
  subscription: z.string(),
  resourceGroup: z.string(),
  resourceName: z.string(),
  location: z.string(),
  kind: z.string(),
  promptTokens: z.number(),
  generatedTokens: z.number(),
  totalTokens: z.number(),
  deployments: z.array(DeploymentUsageSchema),
  periodMinutes: z.number(),
  promptTokensPerMinute: z.number(),
  generatedTokensPerMinute: z.number(),
});

/** Schema for the full scan results. */
const ScanResultsSchema = z.object({
  scannedAt: z.string(),
  days: z.number(),
  periodMinutes: z.number(),
  resources: z.array(ResourceUsageSchema),
  totals: z.object({
    promptTokens: z.number(),
    generatedTokens: z.number(),
    totalTokens: z.number(),
    promptTokensPerMinute: z.number(),
    generatedTokensPerMinute: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an az CLI command and return parsed JSON output. */
async function azJson(args: string[]): Promise<unknown> {
  const cmd = new Deno.Command("az", {
    args: [...args, "-o", "json"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`az command failed: ${err}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

/** Discovered AI resource. */
interface AiResource {
  name: string;
  resourceGroup: string;
  location: string;
  kind: string;
}

/**
 * List OpenAI/AIServices resources in a subscription.
 *
 * @param subscription - Azure subscription ID.
 * @returns Array of AI resource descriptors.
 */
async function listAiResources(
  subscription: string,
): Promise<AiResource[]> {
  const data = (await azJson([
    "cognitiveservices",
    "account",
    "list",
    "--subscription",
    subscription,
    "--query",
    "[?kind=='OpenAI' || kind=='AIServices'].{name:name,resourceGroup:resourceGroup,location:location,kind:kind}",
  ])) as AiResource[];
  return data || [];
}

/** Token metrics result from Azure Monitor. */
interface TokenMetrics {
  promptTokens: number;
  generatedTokens: number;
  deployments: Array<{
    name: string;
    promptTokens: number;
    generatedTokens: number;
  }>;
}

/**
 * Get token metrics for a CognitiveServices resource.
 *
 * @param subscription - Azure subscription ID.
 * @param resourceGroup - Resource group name.
 * @param resourceName - CognitiveServices account name.
 * @param startTime - ISO start time.
 * @param endTime - ISO end time.
 * @returns Token metrics with optional per-deployment breakdown.
 */
async function getTokenMetrics(
  subscription: string,
  resourceGroup: string,
  resourceName: string,
  startTime: string,
  endTime: string,
): Promise<TokenMetrics> {
  const resourceId =
    `/subscriptions/${subscription}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.CognitiveServices/accounts/${resourceName}`;

  // Get aggregate metrics
  const data = (await azJson([
    "monitor",
    "metrics",
    "list",
    "--resource",
    resourceId,
    "--metric",
    "ProcessedPromptTokens",
    "GeneratedTokens",
    "--interval",
    "P1D",
    "--aggregation",
    "Total",
    "--start-time",
    startTime,
    "--end-time",
    endTime,
  ])) as {
    value?: Array<{
      name?: { value?: string };
      timeseries?: Array<{
        data?: Array<{ total?: number | null }>;
      }>;
    }>;
  };

  let promptTokens = 0;
  let generatedTokens = 0;

  for (const metric of data.value || []) {
    const name = metric.name?.value || "";
    let total = 0;
    for (const ts of metric.timeseries || []) {
      for (const d of ts.data || []) {
        if (d.total) total += d.total;
      }
    }
    if (name === "ProcessedPromptTokens") promptTokens = total;
    if (name === "GeneratedTokens") generatedTokens = total;
  }

  // Try per-deployment breakdown
  const deployments: TokenMetrics["deployments"] = [];
  try {
    const dimData = (await azJson([
      "monitor",
      "metrics",
      "list",
      "--resource",
      resourceId,
      "--metric",
      "ProcessedPromptTokens",
      "GeneratedTokens",
      "--interval",
      "P1D",
      "--aggregation",
      "Total",
      "--start-time",
      startTime,
      "--end-time",
      endTime,
      "--dimension",
      "ModelDeploymentName",
    ])) as {
      value?: Array<{
        name?: { value?: string };
        timeseries?: Array<{
          metadatavalues?: Array<{
            name?: { value?: string };
            value?: string;
          }>;
          data?: Array<{ total?: number | null }>;
        }>;
      }>;
    };

    const deploymentMap = new Map<
      string,
      { prompt: number; generated: number }
    >();

    for (const metric of dimData.value || []) {
      const metricName = metric.name?.value || "";
      for (const ts of metric.timeseries || []) {
        let deploymentName = "unknown";
        for (const md of ts.metadatavalues || []) {
          if (
            md.name?.value?.toLowerCase().includes("modeldeploymentname")
          ) {
            deploymentName = md.value || "unknown";
          }
        }
        let total = 0;
        for (const d of ts.data || []) {
          if (d.total) total += d.total;
        }
        if (total > 0) {
          const existing = deploymentMap.get(deploymentName) || {
            prompt: 0,
            generated: 0,
          };
          if (metricName === "ProcessedPromptTokens") {
            existing.prompt += total;
          }
          if (metricName === "GeneratedTokens") existing.generated += total;
          deploymentMap.set(deploymentName, existing);
        }
      }
    }

    for (const [name, usage] of deploymentMap) {
      deployments.push({
        name,
        promptTokens: usage.prompt,
        generatedTokens: usage.generated,
      });
    }
  } catch {
    // Dimension query may fail for some resource types
  }

  return { promptTokens, generatedTokens, deployments };
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Azure OpenAI/AI Services token usage monitoring model. */
export const model = {
  type: "@webframp/azure/openai-usage",
  version: "2026.05.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    scan_results: {
      description: "Multi-subscription Azure AI token usage scan results",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    scan_subscriptions: {
      description:
        "Fan-out scan across all configured Azure subscriptions. Discovers OpenAI/AIServices resources and returns per-resource token usage with deployment breakdown.",
      arguments: z.object({
        days: z.number().default(30).describe("Lookback period in days"),
      }),
      execute: async (
        args: { days: number },
        context: {
          globalArgs: { subscriptions: string[] };
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
        const resources: z.infer<typeof ResourceUsageSchema>[] = [];

        for (const subscription of context.globalArgs.subscriptions) {
          try {
            const aiResources = await listAiResources(subscription);

            for (const res of aiResources) {
              try {
                const metrics = await getTokenMetrics(
                  subscription,
                  res.resourceGroup,
                  res.name,
                  startTime.toISOString(),
                  endTime.toISOString(),
                );

                if (
                  metrics.promptTokens === 0 &&
                  metrics.generatedTokens === 0
                ) {
                  continue;
                }

                resources.push({
                  subscription,
                  resourceGroup: res.resourceGroup,
                  resourceName: res.name,
                  location: res.location,
                  kind: res.kind,
                  promptTokens: metrics.promptTokens,
                  generatedTokens: metrics.generatedTokens,
                  totalTokens: metrics.promptTokens + metrics.generatedTokens,
                  deployments: metrics.deployments.map((d) => ({
                    deploymentName: d.name,
                    promptTokens: d.promptTokens,
                    generatedTokens: d.generatedTokens,
                    totalTokens: d.promptTokens + d.generatedTokens,
                  })),
                  periodMinutes,
                  promptTokensPerMinute: metrics.promptTokens / periodMinutes,
                  generatedTokensPerMinute: metrics.generatedTokens /
                    periodMinutes,
                });

                context.logger.info("Scanned resource", {
                  subscription,
                  resource: res.name,
                  totalTokens: metrics.promptTokens + metrics.generatedTokens,
                });
              } catch (err) {
                context.logger.warn("Failed to get metrics for resource", {
                  resource: res.name,
                  error: String(err),
                });
              }
            }
          } catch (err) {
            context.logger.warn("Failed to scan subscription", {
              subscription,
              error: String(err),
            });
          }
        }

        resources.sort((a, b) => b.totalTokens - a.totalTokens);

        const totalPrompt = resources.reduce(
          (s, r) => s + r.promptTokens,
          0,
        );
        const totalGenerated = resources.reduce(
          (s, r) => s + r.generatedTokens,
          0,
        );

        const result = {
          scannedAt: new Date().toISOString(),
          days: args.days,
          periodMinutes,
          resources,
          totals: {
            promptTokens: totalPrompt,
            generatedTokens: totalGenerated,
            totalTokens: totalPrompt + totalGenerated,
            promptTokensPerMinute: totalPrompt / periodMinutes,
            generatedTokensPerMinute: totalGenerated / periodMinutes,
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

    list_ai_resources: {
      description:
        "Discover OpenAI and AI Services resources across configured subscriptions.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { subscriptions: string[] };
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
        const allResources: Array<AiResource & { subscription: string }> = [];

        for (const subscription of context.globalArgs.subscriptions) {
          try {
            const resources = await listAiResources(subscription);
            for (const r of resources) {
              allResources.push({ ...r, subscription });
            }
          } catch (err) {
            context.logger.warn("Failed to list resources", {
              subscription,
              error: String(err),
            });
          }
        }

        // Write as a simple scan_results with empty metrics
        const result = {
          scannedAt: new Date().toISOString(),
          days: 0,
          periodMinutes: 0,
          resources: allResources.map((r) => ({
            subscription: r.subscription,
            resourceGroup: r.resourceGroup,
            resourceName: r.name,
            location: r.location,
            kind: r.kind,
            promptTokens: 0,
            generatedTokens: 0,
            totalTokens: 0,
            deployments: [],
            periodMinutes: 0,
            promptTokensPerMinute: 0,
            generatedTokensPerMinute: 0,
          })),
          totals: {
            promptTokens: 0,
            generatedTokens: 0,
            totalTokens: 0,
            promptTokensPerMinute: 0,
            generatedTokensPerMinute: 0,
          },
        };

        const handle = await context.writeResource(
          "scan_results",
          "discovery",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
