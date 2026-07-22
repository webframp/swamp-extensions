/**
 * Azure OpenAI / AI Services token usage monitoring model for swamp.
 *
 * Queries Azure Monitor metrics for ProcessedPromptTokens and GeneratedTokens
 * across multiple subscriptions. Discovers CognitiveServices/OpenAI resources
 * and provides per-deployment breakdowns.
 *
 * Authentication uses Azure AD client credentials flow (tenant_id + client_id +
 * client_secret) with no dependency on the `az` CLI.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the azure openai-usage model. */
const GlobalArgsSchema = z.object({
  subscriptions: z
    .array(z.string().uuid())
    .describe(
      "Azure subscription IDs to scan for OpenAI/AI Services resources",
    ),
  tenantId: z
    .string()
    .uuid()
    .describe("Azure AD tenant ID for authentication"),
  clientId: z
    .string()
    .uuid()
    .describe("Azure AD application (client) ID"),
  clientSecret: z
    .string()
    .meta({ sensitive: true })
    .describe("Azure AD client secret"),
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

/** Schema for discovered AI resources (no metrics). */
const ResourceListSchema = z.object({
  discoveredAt: z.string(),
  resources: z.array(z.object({
    subscription: z.string(),
    resourceGroup: z.string(),
    resourceName: z.string(),
    location: z.string(),
    kind: z.string(),
  })),
});

/** Schema for the full scan results. */
const ScanResultsSchema = z.object({
  scannedAt: z.string(),
  days: z.number(),
  periodMinutes: z.number(),
  truncated: z.boolean(),
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
// Auth Helpers
// ---------------------------------------------------------------------------

const ARM_SCOPE = "https://management.azure.com/.default";

/**
 * Acquire an access token via Azure AD client credentials flow.
 */
async function getAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: ARM_SCOPE,
  });

  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `Azure token exchange failed (${resp.status}): ${errBody}`,
    );
  }

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Azure token response missing access_token field");
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Resource Discovery
// ---------------------------------------------------------------------------

/** Discovered AI resource. */
interface AiResource {
  name: string;
  resourceGroup: string;
  location: string;
  kind: string;
}

/**
 * List OpenAI/AIServices resources in a subscription via ARM REST API.
 */
async function listAiResources(
  subscription: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<AiResource[]> {
  const filter = encodeURIComponent(
    "kind eq 'OpenAI' or kind eq 'AIServices'",
  );
  const url = `https://management.azure.com/subscriptions/${subscription}` +
    `/providers/Microsoft.CognitiveServices/accounts` +
    `?api-version=2024-10-01&$filter=${filter}`;

  const resp = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `ARM resource list failed for ${subscription} (${resp.status}): ${body}`,
    );
  }

  const data = (await resp.json()) as {
    value?: Array<{
      name?: string;
      location?: string;
      kind?: string;
      id?: string;
    }>;
  };

  return (data.value || []).map((r) => ({
    name: r.name || "unknown",
    resourceGroup: extractResourceGroup(r.id || ""),
    location: r.location || "unknown",
    kind: r.kind || "unknown",
  }));
}

/** Extract resource group name from an ARM resource ID. */
function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(
    /\/resourceGroups\/([^/]+)/i,
  );
  return match ? match[1] : "unknown";
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Token metrics result from Azure Monitor. */
interface TokenMetrics {
  promptTokens: number;
  generatedTokens: number;
  deployments: Array<{
    name: string;
    promptTokens: number;
    generatedTokens: number;
  }>;
  deploymentBreakdownFailed: boolean;
}

/**
 * Get token metrics for a CognitiveServices resource via Azure Monitor REST API.
 */
async function getTokenMetrics(
  subscription: string,
  resourceGroup: string,
  resourceName: string,
  startTime: string,
  endTime: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<TokenMetrics> {
  const resourceId =
    `/subscriptions/${subscription}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.CognitiveServices/accounts/${resourceName}`;

  const timespan = `${startTime}/${endTime}`;

  // Aggregate metrics (no dimension split)
  const metricsUrl = `https://management.azure.com${resourceId}` +
    `/providers/microsoft.insights/metrics` +
    `?api-version=2024-02-01` +
    `&metricnames=ProcessedPromptTokens,GeneratedTokens` +
    `&timespan=${encodeURIComponent(timespan)}` +
    `&interval=P1D` +
    `&aggregation=Total`;

  const resp = await fetchFn(metricsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Azure Monitor metrics failed for ${resourceName} (${resp.status}): ${body}`,
    );
  }

  const data = (await resp.json()) as {
    value?: Array<{
      name?: { value?: string };
      timeseries?: Array<{
        data?: Array<{ total?: number | null }>;
        metadatavalues?: Array<{
          name?: { value?: string };
          value?: string;
        }>;
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
        if (d.total != null) total += d.total;
      }
    }
    if (name === "ProcessedPromptTokens") promptTokens = total;
    if (name === "GeneratedTokens") generatedTokens = total;
  }

  // Per-deployment breakdown (with dimension filter)
  const deployments: TokenMetrics["deployments"] = [];
  try {
    const dimUrl = `https://management.azure.com${resourceId}` +
      `/providers/microsoft.insights/metrics` +
      `?api-version=2024-02-01` +
      `&metricnames=ProcessedPromptTokens,GeneratedTokens` +
      `&timespan=${encodeURIComponent(timespan)}` +
      `&interval=P1D` +
      `&aggregation=Total` +
      `&$filter=ModelDeploymentName eq '*'`;

    const dimResp = await fetchFn(dimUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!dimResp.ok) {
      return {
        promptTokens,
        generatedTokens,
        deployments,
        deploymentBreakdownFailed: true,
      };
    }

    const dimData = (await dimResp.json()) as typeof data;

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
          if (d.total != null) total += d.total;
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
    return {
      promptTokens,
      generatedTokens,
      deployments,
      deploymentBreakdownFailed: true,
    };
  }

  return {
    promptTokens,
    generatedTokens,
    deployments,
    deploymentBreakdownFailed: false,
  };
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Azure OpenAI/AI Services token usage monitoring model. */
export const model = {
  type: "@webframp/azure/openai-usage",
  version: "2026.07.21.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.21.1",
      description:
        "Remove az CLI dependency; auth via Azure AD client credentials flow",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    scan_results: {
      description: "Multi-subscription Azure AI token usage scan results",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    resource_list: {
      description: "Discovered AI resources (no metrics)",
      schema: ResourceListSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    scan_subscriptions: {
      description:
        "Fan-out scan across all configured Azure subscriptions. Discovers OpenAI/AIServices resources and returns per-resource token usage with deployment breakdown.",
      arguments: z.object({
        days: z.number().min(1).max(90).default(30).describe(
          "Lookback period in days",
        ),
      }),
      execute: async (
        args: { days: number },
        context: {
          globalArgs: {
            subscriptions: string[];
            tenantId: string;
            clientId: string;
            clientSecret: string;
          };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
          fetchFn?: typeof fetch;
        },
      ) => {
        const fetchFn = context.fetchFn ?? fetch;
        const { tenantId, clientId, clientSecret } = context.globalArgs;
        const token = await getAccessToken(
          tenantId,
          clientId,
          clientSecret,
          fetchFn,
        );

        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const resources: z.infer<typeof ResourceUsageSchema>[] = [];
        let anyFailed = false;

        for (const subscription of context.globalArgs.subscriptions) {
          try {
            const aiResources = await listAiResources(
              subscription,
              token,
              fetchFn,
            );

            for (const res of aiResources) {
              try {
                const metrics = await getTokenMetrics(
                  subscription,
                  res.resourceGroup,
                  res.name,
                  startTime.toISOString(),
                  endTime.toISOString(),
                  token,
                  fetchFn,
                );

                if (
                  metrics.promptTokens === 0 &&
                  metrics.generatedTokens === 0
                ) {
                  continue;
                }

                if (metrics.deploymentBreakdownFailed) {
                  context.logger.warn(
                    "Deployment breakdown unavailable for resource",
                    { resource: res.name, subscription },
                  );
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
                anyFailed = true;
                context.logger.warn("Failed to get metrics for resource", {
                  resource: res.name,
                  error: String(err),
                });
              }
            }
          } catch (err) {
            anyFailed = true;
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
          truncated: anyFailed,
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
          "current",
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
          globalArgs: {
            subscriptions: string[];
            tenantId: string;
            clientId: string;
            clientSecret: string;
          };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
          fetchFn?: typeof fetch;
        },
      ) => {
        const fetchFn = context.fetchFn ?? fetch;
        const { tenantId, clientId, clientSecret } = context.globalArgs;
        const token = await getAccessToken(
          tenantId,
          clientId,
          clientSecret,
          fetchFn,
        );

        const allResources: Array<AiResource & { subscription: string }> = [];

        for (const subscription of context.globalArgs.subscriptions) {
          try {
            const resources = await listAiResources(
              subscription,
              token,
              fetchFn,
            );
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

        const result = {
          discoveredAt: new Date().toISOString(),
          resources: allResources.map((r) => ({
            subscription: r.subscription,
            resourceGroup: r.resourceGroup,
            resourceName: r.name,
            location: r.location,
            kind: r.kind,
          })),
        };

        const handle = await context.writeResource(
          "resource_list",
          "discovery",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
