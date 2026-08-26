/**
 * Unified AI usage model for swamp.
 *
 * Provides a `status` method that checks which provider models are configured
 * and a `generate` method that reads scan data from provider models and
 * produces a unified cross-provider report as a data artifact.
 *
 * Provider definitions are data-driven: adding a new provider (Anthropic,
 * Moonshot, etc.) requires only appending to the PROVIDERS array with the
 * appropriate field mappings and setup guidance.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const EXTENSION_NAME = "@webframp/ai-usage";

// ---------------------------------------------------------------------------
// Provider Definition Interface
// ---------------------------------------------------------------------------

/**
 * Describes how to find, normalize, and present setup guidance for a single
 * AI token usage provider. Adding a provider means adding one of these objects.
 */
interface ProviderDefinition {
  /** Human-readable name shown in status and reports. */
  name: string;
  /** Swamp model instance name (what users pass to `model create`). */
  modelName: string;
  /** Extension type identifier. */
  extensionType: string;
  /** Method name invoked by the scan workflow. */
  scanMethod: string;
  /** Resource spec name where scan results are stored. */
  scanSpec: string;

  /** Setup guidance for users who haven't configured this provider. */
  setup: {
    /** Full `swamp model create` command with all required arguments. */
    command: string;
    /** Least-privilege permissions required by the provider. */
    permissions: string[];
    /** Brief explanation of the authentication mechanism. */
    authNotes: string;
  };

  /**
   * Field mappings for normalizing provider-specific scan data into the
   * unified report shape. Paths are keys within `attributes`.
   */
  fields: {
    /** Key in `totals` for input/prompt token count. */
    inputTokens: string;
    /** Key in `totals` for output/generated token count. */
    outputTokens: string;
    /** Key in `totals` for combined token count. */
    totalTokens: string;
    /** Key in `totals` for input tokens per minute. */
    inputRate: string;
    /** Key in `totals` for output tokens per minute. */
    outputRate: string;
    /** Top-level array key grouping results (accounts, projects, resources). */
    groupKey: string;
    /** Field within each group item used as the display name. */
    groupNameField: string;
    /** Field within each group item holding the token total. */
    groupTotalField: string;
    /** Array key within each group item for per-model/deployment breakdown. */
    modelKey: string;
    /** Field within each model entry for the model/deployment name. */
    modelNameField: string;
    /** Field within each model entry for the token total. */
    modelTotalField: string;
  };
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/** Registry of all supported AI usage providers with setup guidance and field mappings. */
export const PROVIDERS: ProviderDefinition[] = [
  {
    name: "AWS Bedrock",
    modelName: "bedrock-usage",
    extensionType: "@webframp/aws/bedrock-usage",
    scanMethod: "scan_accounts",
    scanSpec: "scan_results",
    setup: {
      command: `swamp model create @webframp/aws/bedrock-usage bedrock-usage \\
  --global-arg 'profiles=["default"]' \\
  --global-arg 'regions=["us-east-1","us-west-2"]'`,
      permissions: [
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
      ],
      authNotes:
        "Uses the AWS credential chain (profiles, SSO, environment variables). " +
        "Configure a profile whose assumed role grants the above CloudWatch " +
        "read-only permissions. A ReadOnlyAccess managed policy covers both.",
    },
    fields: {
      inputTokens: "inputTokens",
      outputTokens: "outputTokens",
      totalTokens: "totalTokens",
      inputRate: "inputTokensPerMinute",
      outputRate: "outputTokensPerMinute",
      groupKey: "accounts",
      groupNameField: "profile",
      groupTotalField: "totalTokens",
      modelKey: "models",
      modelNameField: "modelId",
      modelTotalField: "totalTokens",
    },
  },
  {
    name: "GCP Vertex AI",
    modelName: "vertex-usage",
    extensionType: "@webframp/gcp/vertex-usage",
    scanMethod: "scan_projects",
    scanSpec: "scan_results",
    setup: {
      command: `swamp model create @webframp/gcp/vertex-usage vertex-usage \\
  --global-arg 'projects=["my-project"]' \\
  --global-arg 'serviceAccountJson=<contents of service-account.json>'`,
      permissions: [
        "monitoring.timeSeries.list",
      ],
      authNotes:
        "Uses a GCP service account JSON key (signed JWT exchanged for an access token). " +
        "Pass the JSON key contents as the serviceAccountJson global arg, or set " +
        "GOOGLE_APPLICATION_CREDENTIALS to the key file path. The service account " +
        "needs only the Monitoring Viewer role (roles/monitoring.viewer) on each project.",
    },
    fields: {
      inputTokens: "inputTokens",
      outputTokens: "outputTokens",
      totalTokens: "totalTokens",
      inputRate: "inputTokensPerMinute",
      outputRate: "outputTokensPerMinute",
      groupKey: "projects",
      groupNameField: "project",
      groupTotalField: "totalTokens",
      modelKey: "models",
      modelNameField: "modelId",
      modelTotalField: "totalTokens",
    },
  },
  {
    name: "Azure OpenAI",
    modelName: "azure-ai-usage",
    extensionType: "@webframp/azure/openai-usage",
    scanMethod: "scan_subscriptions",
    scanSpec: "scan_results",
    setup: {
      command:
        `swamp model create @webframp/azure/openai-usage azure-ai-usage \\
  --global-arg 'subscriptions=["<subscription-uuid>"]' \\
  --global-arg 'tenantId=<tenant-uuid>' \\
  --global-arg 'clientId=<app-registration-uuid>' \\
  --global-arg 'clientSecret=<secret-value>'`,
      permissions: [
        "Microsoft.CognitiveServices/accounts/read",
        "Microsoft.Insights/metrics/read",
      ],
      authNotes:
        "Uses Azure AD client credentials flow (tenant + app registration + secret). " +
        "Assign the Reader role on each target subscription. The app registration " +
        "needs no API permissions beyond ARM Reader \u2014 metrics and resource " +
        "discovery use the same token.",
    },
    fields: {
      inputTokens: "promptTokens",
      outputTokens: "generatedTokens",
      totalTokens: "totalTokens",
      inputRate: "promptTokensPerMinute",
      outputRate: "generatedTokensPerMinute",
      groupKey: "resources",
      groupNameField: "resourceName",
      groupTotalField: "totalTokens",
      modelKey: "deployments",
      modelNameField: "deploymentName",
      modelTotalField: "totalTokens",
    },
  },
  {
    name: "Anthropic (Claude Enterprise)",
    modelName: "claude-analytics",
    extensionType: "@webframp/anthropic/analytics",
    scanMethod: "collect_user_usage",
    scanSpec: "userUsage",
    setup: {
      command:
        `swamp model create @webframp/anthropic/analytics claude-analytics \\
  --global-arg 'analyticsKey=<vault-reference>'`,
      permissions: [
        "read:analytics",
      ],
      authNotes:
        "Uses an Enterprise Analytics API key (scope read:analytics) created " +
        "by the primary owner in claude.ai — Org settings → API access. " +
        "No cloud IAM role required.",
    },
    fields: {
      inputTokens: "inputTokens",
      outputTokens: "outputTokens",
      totalTokens: "totalTokens",
      inputRate: "inputTokensPerMinute",
      outputRate: "outputTokensPerMinute",
      groupKey: "users",
      groupNameField: "email",
      groupTotalField: "totalTokens",
      modelKey: "byProduct",
      modelNameField: "product",
      modelTotalField: "totalTokens",
    },
  },
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments — none required, this model reads from other models' data. */
const GlobalArgsSchema = z.object({});

/** Provider setup guidance. */
const ProviderSetupSchema = z.object({
  command: z.string().describe(
    "Full swamp model create command with all required arguments (blank if already configured)",
  ),
  permissions: z.array(z.string()).describe(
    "Least-privilege permissions required by the provider",
  ),
  authNotes: z.string().describe(
    "Brief explanation of the authentication mechanism",
  ),
});

/** Provider status entry. */
const ProviderStatusSchema = z.object({
  provider: z.string().describe("Human-readable provider name"),
  configured: z.boolean().describe(
    "Whether scan data was found for this provider's model instance",
  ),
  modelName: z.string().describe("Swamp model instance name for the provider"),
  extensionType: z.string().describe(
    "Extension type identifier for the provider",
  ),
  setup: ProviderSetupSchema,
  lastScanned: z.string().nullable().describe(
    "ISO 8601 timestamp of the most recent scan, or null if unconfigured",
  ),
  totalTokens: z.number().nullable().describe(
    "Total token count from the latest scan, or null if unconfigured",
  ),
});

/** Status output schema. */
const StatusSchema = z.object({
  checkedAt: z.string().describe("ISO 8601 timestamp when status was checked"),
  providers: z.array(ProviderStatusSchema).describe(
    "Configuration status for every registered provider",
  ),
  configuredCount: z.number().describe(
    "Number of providers with usable scan data",
  ),
  totalProviders: z.number().describe(
    "Total number of registered providers",
  ),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Unified report output schema. */
const ReportSchema = z.object({
  generatedAt: z.string().describe(
    "ISO 8601 timestamp when the report was generated",
  ),
  days: z.number().describe("Expected lookback period, in days"),
  periodMinutes: z.number().describe("Lookback period expressed in minutes"),
  coverage: z.array(ProviderStatusSchema).describe(
    "Configuration status for every registered provider",
  ),
  providers: z.array(
    z.object({
      name: z.string().describe("Human-readable provider name"),
      inputTokens: z.number().describe("Total input/prompt tokens"),
      outputTokens: z.number().describe("Total output/generated tokens"),
      totalTokens: z.number().describe("Combined input and output tokens"),
      inputTokensPerMinute: z.number().describe(
        "Input tokens per minute over the lookback period",
      ),
      outputTokensPerMinute: z.number().describe(
        "Output tokens per minute over the lookback period",
      ),
      topAccounts: z.array(
        z.object({
          name: z.string().describe("Account, project, or resource name"),
          totalTokens: z.number().describe("Tokens attributed to this group"),
          percentage: z.number().describe(
            "Share of the provider's total tokens, as a percentage",
          ),
        }),
      ).describe(
        "Top token-consuming accounts/projects/resources for this provider",
      ),
      topModels: z.array(
        z.object({
          modelId: z.string().describe("Model or deployment identifier"),
          totalTokens: z.number().describe("Tokens attributed to this model"),
        }),
      ).describe("Top token-consuming models/deployments for this provider"),
    }),
  ).describe("Per-provider usage breakdown for configured providers"),
  grandTotals: z.object({
    inputTokens: z.number().describe(
      "Sum of input tokens across all configured providers",
    ),
    outputTokens: z.number().describe(
      "Sum of output tokens across all configured providers",
    ),
    totalTokens: z.number().describe(
      "Sum of total tokens across all configured providers",
    ),
    inputTokensPerMinute: z.number().describe(
      "Sum of input tokens per minute across all configured providers",
    ),
    outputTokensPerMinute: z.number().describe(
      "Sum of output tokens per minute across all configured providers",
    ),
  }),
  highlights: z.array(z.string()).describe(
    "Human-readable summary lines calling out notable usage patterns",
  ),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Metadata for a single data entry, as returned by `findAllForModel`. */
interface DataMeta {
  name: string;
  version: number;
  tags: Record<string, string>;
  createdAt?: Date;
}

/** Context shape expected by both methods. */
interface MethodContext {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  dataRepository: {
    findAllForModel: (
      modelType: string,
      modelId: string,
    ) => Promise<DataMeta[]>;
    getContent: (
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
  };
}

/**
 * Fetches the most recent `scanSpec` resource for a provider's model instance.
 *
 * `context.dataRepository` only exposes `findAllForModel` (metadata) and
 * `getContent` (raw bytes) — there is no `findBySpec` on the method-execution
 * context (that richer query API exists only for CEL expression resolution in
 * workflow YAML). So this fetches metadata for every data item owned by the
 * provider's model instance, filters by the `specName` tag, picks the latest
 * by `createdAt`, then fetches and parses that item's content.
 */
async function fetchLatestScanData(
  context: MethodContext,
  p: ProviderDefinition,
): Promise<{ attributes: Record<string, unknown>; updatedAt?: string } | null> {
  const all = await context.dataRepository.findAllForModel(
    p.extensionType,
    p.modelName,
  );
  const matching = all.filter((d) => d.tags?.specName === p.scanSpec);
  if (matching.length === 0) return null;

  // `DataMeta` is a locally-declared guess at findAllForModel's real return
  // shape (extensions have no SDK package to import swamp's actual Data type
  // from). Assert createdAt's runtime shape here rather than trust the TS
  // type — a silent shape mismatch is exactly how the last version of this
  // function broke (it assumed createdAt was a string and called
  // .localeCompare() on what is actually a Date).
  for (const d of matching) {
    if (d.createdAt !== undefined && !(d.createdAt instanceof Date)) {
      throw new Error(
        `Unexpected createdAt shape from findAllForModel: expected Date or undefined, got ${typeof d
          .createdAt} (value: ${
          String(d.createdAt)
        }). DataMeta interface may be out of sync with swamp's real Data type.`,
      );
    }
  }

  matching.sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );
  const latest = matching[0];

  const bytes = await context.dataRepository.getContent(
    p.extensionType,
    p.modelName,
    latest.name,
    latest.version,
  );
  if (!bytes) return null;

  const attributes = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  return { attributes, updatedAt: latest.createdAt?.toISOString() };
}

/**
 * Safely extract a nested numeric value from an object using a dot-less key.
 */
function numField(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  return typeof val === "number" ? val : 0;
}

/**
 * Build the setup object for a provider definition, blanked when configured.
 */
function buildSetup(
  provider: ProviderDefinition,
  configured: boolean,
): z.infer<typeof ProviderSetupSchema> {
  if (configured) {
    return { command: "", permissions: [], authNotes: "" };
  }
  return { ...provider.setup };
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Unified AI usage model. */
export const model = {
  type: "@webframp/ai-usage",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.20.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.05.1",
      description:
        "Breaking: hint field replaced with setup object containing command, permissions, authNotes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.20.1",
      description: "Dependency bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.1",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
        "Check which provider models are configured. Returns setup guidance " +
        "with least-privilege permissions for unconfigured providers.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const providers: z.infer<typeof ProviderStatusSchema>[] = [];

        for (const p of PROVIDERS) {
          let configured = false;
          let lastScanned: string | null = null;
          let totalTokens: number | null = null;

          try {
            const latest = await fetchLatestScanData(context, p);
            if (latest) {
              configured = true;
              lastScanned = (latest.attributes.scannedAt as string) ??
                (latest.attributes.fetchedAt as string) ??
                latest.updatedAt ??
                null;
              const totals = latest.attributes.totals as
                | Record<string, unknown>
                | undefined;
              totalTokens = totals
                ? numField(totals, p.fields.totalTokens)
                : null;
            }
          } catch (err) {
            context.logger.warn("Failed to query provider data", {
              provider: p.name,
              error: String(err),
            });
          }

          providers.push({
            provider: p.name,
            configured,
            modelName: p.modelName,
            extensionType: p.extensionType,
            setup: buildSetup(p, configured),
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
          "current",
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    generate: {
      description:
        "Generate a unified cross-provider AI usage report from collected scan data. " +
        "Shows coverage status with setup hints for unconfigured providers.",
      arguments: z.object({
        days: z.number().min(1).default(30).describe(
          "Expected lookback period",
        ),
      }),
      execute: async (
        args: { days: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const periodMinutes = args.days * 24 * 60;
        const coverage: z.infer<typeof ProviderStatusSchema>[] = [];
        const providerResults: z.infer<typeof ReportSchema>["providers"] = [];
        const highlights: string[] = [];

        for (const p of PROVIDERS) {
          try {
            const latest = await fetchLatestScanData(context, p);

            if (!latest) {
              coverage.push({
                provider: p.name,
                configured: false,
                modelName: p.modelName,
                extensionType: p.extensionType,
                setup: buildSetup(p, false),
                lastScanned: null,
                totalTokens: null,
              });
              continue;
            }

            const attrs = latest.attributes as Record<string, unknown>;
            const totals = (attrs.totals ?? {}) as Record<string, unknown>;
            const groups = (attrs[p.fields.groupKey] ?? []) as Array<
              Record<string, unknown>
            >;

            const inputTokens = numField(totals, p.fields.inputTokens);
            const outputTokens = numField(totals, p.fields.outputTokens);
            const totalTokens = numField(totals, p.fields.totalTokens);
            const inputRate = numField(totals, p.fields.inputRate);
            const outputRate = numField(totals, p.fields.outputRate);

            // Build top accounts/groups
            const groupMap = new Map<string, number>();
            for (const g of groups) {
              const name = String(g[p.fields.groupNameField] ?? "unknown");
              const tokens = numField(g, p.fields.groupTotalField);
              groupMap.set(name, (groupMap.get(name) ?? 0) + tokens);
            }
            const topAccounts = [...groupMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([name, tokens]) => ({
                name,
                totalTokens: tokens,
                percentage: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0,
              }));

            // Build top models/deployments
            const allModels = groups.flatMap(
              (g) =>
                (g[p.fields.modelKey] ?? []) as Array<
                  Record<string, unknown>
                >,
            );
            const modelMap = new Map<string, number>();
            for (const m of allModels) {
              const id = String(m[p.fields.modelNameField] ?? "unknown");
              const tokens = numField(m, p.fields.modelTotalField);
              modelMap.set(id, (modelMap.get(id) ?? 0) + tokens);
            }
            const topModels = [...modelMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([modelId, tokens]) => ({ modelId, totalTokens: tokens }));

            providerResults.push({
              name: p.name,
              inputTokens,
              outputTokens,
              totalTokens,
              inputTokensPerMinute: inputRate,
              outputTokensPerMinute: outputRate,
              topAccounts,
              topModels,
            });

            coverage.push({
              provider: p.name,
              configured: true,
              modelName: p.modelName,
              extensionType: p.extensionType,
              setup: buildSetup(p, true),
              lastScanned: (attrs.scannedAt as string) ??
                (attrs.fetchedAt as string) ??
                null,
              totalTokens,
            });

            if (topAccounts.length > 0) {
              highlights.push(
                `Highest ${p.name} account: ${topAccounts[0].name} (${
                  topAccounts[0].totalTokens.toLocaleString()
                } tokens, ${topAccounts[0].percentage.toFixed(1)}%)`,
              );
            }
            if (topModels.length > 0) {
              highlights.push(
                `Top ${p.name} model: ${topModels[0].modelId} (${
                  topModels[0].totalTokens.toLocaleString()
                } tokens)`,
              );
            }
          } catch (err) {
            context.logger.warn("Failed to query provider data", {
              provider: p.name,
              error: String(err),
            });
            coverage.push({
              provider: p.name,
              configured: false,
              modelName: p.modelName,
              extensionType: p.extensionType,
              setup: buildSetup(p, false),
              lastScanned: null,
              totalTokens: null,
            });
          }
        }

        // Grand totals
        const grandInput = providerResults.reduce(
          (s, p) => s + p.inputTokens,
          0,
        );
        const grandOutput = providerResults.reduce(
          (s, p) => s + p.outputTokens,
          0,
        );
        const grandTotal = providerResults.reduce(
          (s, p) => s + p.totalTokens,
          0,
        );
        const grandInputRate = providerResults.reduce(
          (s, p) => s + p.inputTokensPerMinute,
          0,
        );
        const grandOutputRate = providerResults.reduce(
          (s, p) => s + p.outputTokensPerMinute,
          0,
        );

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
            inputTokensPerMinute: grandInputRate,
            outputTokensPerMinute: grandOutputRate,
          },
          highlights,
        };

        const handle = await context.writeResource(
          "report",
          "current",
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Shape of a provider definition in the registry. */
export type { ProviderDefinition };
