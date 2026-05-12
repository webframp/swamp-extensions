/**
 * Unified AI usage model for swamp.
 *
 * Provides a `status` method that checks which provider models are configured
 * and a `generate` method that reads scan data from provider models and
 * produces a unified cross-provider report as a data artifact.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments — none required, this model reads from other models' data. */
const GlobalArgsSchema = z.object({});

/** Provider status entry. */
const ProviderStatusSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  modelName: z.string(),
  hint: z.string(),
  lastScanned: z.string().nullable(),
  totalTokens: z.number().nullable(),
});

/** Status output schema. */
const StatusSchema = z.object({
  checkedAt: z.string(),
  providers: z.array(ProviderStatusSchema),
  configuredCount: z.number(),
  totalProviders: z.number(),
});

/** Unified report output schema. */
const ReportSchema = z.object({
  generatedAt: z.string(),
  days: z.number(),
  periodMinutes: z.number(),
  coverage: z.array(ProviderStatusSchema),
  providers: z.array(
    z.object({
      name: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
      inputTokensPerMinute: z.number(),
      outputTokensPerMinute: z.number(),
      topAccounts: z.array(
        z.object({
          name: z.string(),
          totalTokens: z.number(),
          percentage: z.number(),
        }),
      ),
      topModels: z.array(
        z.object({
          modelId: z.string(),
          totalTokens: z.number(),
        }),
      ),
    }),
  ),
  grandTotals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    inputTokensPerMinute: z.number(),
    outputTokensPerMinute: z.number(),
  }),
  highlights: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: "AWS Bedrock",
    modelName: "bedrock-usage",
    type: "@webframp/aws/bedrock-usage",
    hint:
      'swamp model create @webframp/aws/bedrock-usage bedrock-usage --global-arg \'profiles=["default"]\' --global-arg \'regions=["us-east-1","us-west-2"]\'',
  },
  {
    name: "GCP Vertex AI",
    modelName: "vertex-usage",
    type: "@webframp/gcp/vertex-usage",
    hint:
      "swamp model create @webframp/gcp/vertex-usage vertex-usage --global-arg 'projects=[\"my-project\"]'",
  },
  {
    name: "Azure OpenAI",
    modelName: "azure-ai-usage",
    type: "@webframp/azure/openai-usage",
    hint:
      "swamp model create @webframp/azure/openai-usage azure-ai-usage --global-arg 'subscriptions=[\"sub-id\"]'",
  },
];

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Unified AI usage model. */
export const model = {
  type: "@webframp/ai-usage",
  version: "2026.05.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    status: {
      description: "Provider configuration status",
      schema: StatusSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    report: {
      description: "Unified cross-provider AI usage report",
      schema: ReportSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    status: {
      description:
        "Check which provider models are configured and provide setup hints for unconfigured providers.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: Record<string, never>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          dataRepository: {
            findBySpec: (
              modelName: string,
              specName: string,
            ) => Promise<
              Array<{ attributes: Record<string, unknown>; updatedAt?: string }>
            >;
          };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const providers: z.infer<typeof ProviderStatusSchema>[] = [];

        for (const p of PROVIDERS) {
          let configured = false;
          let lastScanned: string | null = null;
          let totalTokens: number | null = null;

          try {
            const data = await context.dataRepository.findBySpec(
              p.modelName,
              "scan_results",
            );
            if (data.length > 0) {
              configured = true;
              const latest = data[0];
              lastScanned = (latest.attributes.scannedAt as string) ||
                latest.updatedAt ||
                null;
              const totals = latest.attributes.totals as {
                totalTokens?: number;
              } | undefined;
              totalTokens = totals?.totalTokens ?? null;
            }
          } catch {
            // Model doesn't exist — not configured
          }

          providers.push({
            provider: p.name,
            configured,
            modelName: p.modelName,
            hint: configured ? "" : p.hint,
            lastScanned,
            totalTokens,
          });
        }

        const result = {
          checkedAt: new Date().toISOString(),
          providers,
          configuredCount: providers.filter((p) => p.configured).length,
          totalProviders: PROVIDERS.length,
        };

        const handle = await context.writeResource(
          "status",
          "latest",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    generate: {
      description:
        "Generate a unified cross-provider AI usage report from collected scan data. Shows coverage status with setup hints for unconfigured providers.",
      arguments: z.object({
        days: z.number().default(30).describe("Expected lookback period"),
      }),
      execute: async (
        args: { days: number },
        context: {
          globalArgs: Record<string, never>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          dataRepository: {
            findBySpec: (
              modelName: string,
              specName: string,
            ) => Promise<Array<{ attributes: Record<string, unknown> }>>;
          };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const periodMinutes = args.days * 24 * 60;
        const coverage: z.infer<typeof ProviderStatusSchema>[] = [];
        const providerResults: z.infer<typeof ReportSchema>["providers"] = [];
        const highlights: string[] = [];

        let grandInput = 0;
        let grandOutput = 0;

        // --- AWS Bedrock ---
        try {
          const data = await context.dataRepository.findBySpec(
            "bedrock-usage",
            "scan_results",
          );
          if (data.length > 0) {
            const attrs = data[0].attributes as {
              totals: {
                inputTokens: number;
                outputTokens: number;
                totalTokens: number;
                inputTokensPerMinute: number;
                outputTokensPerMinute: number;
              };
              accounts: Array<{
                profile: string;
                totalTokens: number;
                models: Array<{ modelId: string; totalTokens: number }>;
              }>;
            };

            grandInput += attrs.totals.inputTokens;
            grandOutput += attrs.totals.outputTokens;

            const topAccounts = (attrs.accounts || [])
              .slice(0, 5)
              .map((a) => ({
                name: a.profile,
                totalTokens: a.totalTokens,
                percentage: attrs.totals.totalTokens > 0
                  ? (a.totalTokens / attrs.totals.totalTokens) * 100
                  : 0,
              }));

            const allModels = (attrs.accounts || []).flatMap(
              (a) => a.models || [],
            );
            const modelMap = new Map<string, number>();
            for (const m of allModels) {
              modelMap.set(
                m.modelId,
                (modelMap.get(m.modelId) || 0) + m.totalTokens,
              );
            }
            const topModels = [...modelMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([modelId, totalTokens]) => ({ modelId, totalTokens }));

            providerResults.push({
              name: "AWS Bedrock",
              inputTokens: attrs.totals.inputTokens,
              outputTokens: attrs.totals.outputTokens,
              totalTokens: attrs.totals.totalTokens,
              inputTokensPerMinute: attrs.totals.inputTokensPerMinute,
              outputTokensPerMinute: attrs.totals.outputTokensPerMinute,
              topAccounts,
              topModels,
            });

            coverage.push({
              provider: "AWS Bedrock",
              configured: true,
              modelName: "bedrock-usage",
              hint: "",
              lastScanned:
                (attrs as unknown as { scannedAt: string }).scannedAt || null,
              totalTokens: attrs.totals.totalTokens,
            });

            if (topAccounts.length > 0) {
              highlights.push(
                `Highest AWS account: ${topAccounts[0].name} (${
                  topAccounts[0].totalTokens.toLocaleString()
                } tokens, ${topAccounts[0].percentage.toFixed(1)}%)`,
              );
            }
            if (topModels.length > 0) {
              highlights.push(
                `Top AWS model: ${topModels[0].modelId} (${
                  topModels[0].totalTokens.toLocaleString()
                } tokens)`,
              );
            }
          } else {
            coverage.push({
              provider: "AWS Bedrock",
              configured: false,
              modelName: "bedrock-usage",
              hint: PROVIDERS[0].hint,
              lastScanned: null,
              totalTokens: null,
            });
          }
        } catch {
          coverage.push({
            provider: "AWS Bedrock",
            configured: false,
            modelName: "bedrock-usage",
            hint: PROVIDERS[0].hint,
            lastScanned: null,
            totalTokens: null,
          });
        }

        // --- GCP Vertex AI ---
        try {
          const data = await context.dataRepository.findBySpec(
            "vertex-usage",
            "scan_results",
          );
          if (data.length > 0) {
            const attrs = data[0].attributes as {
              totals: {
                inputTokens: number;
                outputTokens: number;
                totalTokens: number;
                inputTokensPerMinute: number;
                outputTokensPerMinute: number;
              };
              projects: Array<{
                project: string;
                totalTokens: number;
                models: Array<{ modelId: string; totalTokens: number }>;
              }>;
            };

            grandInput += attrs.totals.inputTokens;
            grandOutput += attrs.totals.outputTokens;

            const topAccounts = (attrs.projects || [])
              .slice(0, 5)
              .map((p) => ({
                name: p.project,
                totalTokens: p.totalTokens,
                percentage: attrs.totals.totalTokens > 0
                  ? (p.totalTokens / attrs.totals.totalTokens) * 100
                  : 0,
              }));

            const allModels = (attrs.projects || []).flatMap(
              (p) => p.models || [],
            );
            const modelMap = new Map<string, number>();
            for (const m of allModels) {
              modelMap.set(
                m.modelId,
                (modelMap.get(m.modelId) || 0) + m.totalTokens,
              );
            }
            const topModels = [...modelMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([modelId, totalTokens]) => ({ modelId, totalTokens }));

            providerResults.push({
              name: "GCP Vertex AI",
              inputTokens: attrs.totals.inputTokens,
              outputTokens: attrs.totals.outputTokens,
              totalTokens: attrs.totals.totalTokens,
              inputTokensPerMinute: attrs.totals.inputTokensPerMinute,
              outputTokensPerMinute: attrs.totals.outputTokensPerMinute,
              topAccounts,
              topModels,
            });

            coverage.push({
              provider: "GCP Vertex AI",
              configured: true,
              modelName: "vertex-usage",
              hint: "",
              lastScanned:
                (attrs as unknown as { scannedAt: string }).scannedAt || null,
              totalTokens: attrs.totals.totalTokens,
            });
          } else {
            coverage.push({
              provider: "GCP Vertex AI",
              configured: false,
              modelName: "vertex-usage",
              hint: PROVIDERS[1].hint,
              lastScanned: null,
              totalTokens: null,
            });
          }
        } catch {
          coverage.push({
            provider: "GCP Vertex AI",
            configured: false,
            modelName: "vertex-usage",
            hint: PROVIDERS[1].hint,
            lastScanned: null,
            totalTokens: null,
          });
        }

        // --- Azure OpenAI ---
        try {
          const data = await context.dataRepository.findBySpec(
            "azure-ai-usage",
            "scan_results",
          );
          if (data.length > 0) {
            const attrs = data[0].attributes as {
              totals: {
                promptTokens: number;
                generatedTokens: number;
                totalTokens: number;
                promptTokensPerMinute: number;
                generatedTokensPerMinute: number;
              };
              resources: Array<{
                resourceName: string;
                totalTokens: number;
                deployments: Array<{
                  deploymentName: string;
                  totalTokens: number;
                }>;
              }>;
            };

            grandInput += attrs.totals.promptTokens;
            grandOutput += attrs.totals.generatedTokens;

            const topAccounts = (attrs.resources || [])
              .slice(0, 5)
              .map((r) => ({
                name: r.resourceName,
                totalTokens: r.totalTokens,
                percentage: attrs.totals.totalTokens > 0
                  ? (r.totalTokens / attrs.totals.totalTokens) * 100
                  : 0,
              }));

            const allDeployments = (attrs.resources || []).flatMap(
              (r) => r.deployments || [],
            );
            const deployMap = new Map<string, number>();
            for (const d of allDeployments) {
              deployMap.set(
                d.deploymentName,
                (deployMap.get(d.deploymentName) || 0) + d.totalTokens,
              );
            }
            const topModels = [...deployMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([modelId, totalTokens]) => ({ modelId, totalTokens }));

            providerResults.push({
              name: "Azure OpenAI",
              inputTokens: attrs.totals.promptTokens,
              outputTokens: attrs.totals.generatedTokens,
              totalTokens: attrs.totals.totalTokens,
              inputTokensPerMinute: attrs.totals.promptTokensPerMinute,
              outputTokensPerMinute: attrs.totals.generatedTokensPerMinute,
              topAccounts,
              topModels,
            });

            coverage.push({
              provider: "Azure OpenAI",
              configured: true,
              modelName: "azure-ai-usage",
              hint: "",
              lastScanned:
                (attrs as unknown as { scannedAt: string }).scannedAt || null,
              totalTokens: attrs.totals.totalTokens,
            });
          } else {
            coverage.push({
              provider: "Azure OpenAI",
              configured: false,
              modelName: "azure-ai-usage",
              hint: PROVIDERS[2].hint,
              lastScanned: null,
              totalTokens: null,
            });
          }
        } catch {
          coverage.push({
            provider: "Azure OpenAI",
            configured: false,
            modelName: "azure-ai-usage",
            hint: PROVIDERS[2].hint,
            lastScanned: null,
            totalTokens: null,
          });
        }

        // Grand totals
        const grandTotal = grandInput + grandOutput;
        if (grandTotal > 0 && providerResults.length > 1) {
          const sorted = [...providerResults].sort(
            (a, b) => b.totalTokens - a.totalTokens,
          );
          highlights.push(
            `Dominant provider: ${sorted[0].name} (${
              ((sorted[0].totalTokens / grandTotal) * 100).toFixed(1)
            }% of all tokens)`,
          );
        }

        const result = {
          generatedAt: new Date().toISOString(),
          days: args.days,
          periodMinutes,
          coverage,
          providers: providerResults,
          grandTotals: {
            inputTokens: grandInput,
            outputTokens: grandOutput,
            totalTokens: grandTotal,
            inputTokensPerMinute: grandInput / periodMinutes,
            outputTokensPerMinute: grandOutput / periodMinutes,
          },
          highlights,
        };

        const handle = await context.writeResource(
          "report",
          "latest",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
