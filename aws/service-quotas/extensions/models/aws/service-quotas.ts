/**
 * AWS Service Quotas observation model.
 *
 * Query and monitor service quotas across accounts. Fan-out utilization
 * checks identify quotas approaching limits before they cause failures.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  GetServiceQuotaCommand,
  ListServiceQuotasCommand,
  ListServicesCommand,
  RequestServiceQuotaIncreaseCommand,
  ServiceQuotasClient,
} from "npm:@aws-sdk/client-service-quotas@3.1069.0";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "npm:@aws-sdk/client-cloudwatch@3.1069.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1069.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1069.0";

// =============================================================================
// Schemas
// =============================================================================

const MAX_PAGES = 20;

const GlobalArgsSchema = z.object({
  profiles: z
    .array(z.string())
    .min(1)
    .describe("AWS CLI profile names (one per account)"),
  defaultRegion: z
    .string()
    .default("us-east-1")
    .describe("AWS region for Service Quotas API calls"),
});

const QuotaDetailSchema = z.object({
  serviceCode: z.string(),
  serviceName: z.string(),
  quotaCode: z.string(),
  quotaName: z.string(),
  value: z.number(),
  unit: z.string(),
  adjustable: z.boolean(),
  globalQuota: z.boolean(),
  usageValue: z.number().nullable(),
  utilizationPct: z.number().nullable(),
});

const QuotaResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  region: z.string(),
  quota: QuotaDetailSchema,
  fetchedAt: z.string(),
});

const QuotasResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  region: z.string(),
  serviceCode: z.string(),
  quotas: z.array(QuotaDetailSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const ServiceEntrySchema = z.object({
  serviceCode: z.string(),
  serviceName: z.string(),
});

const ServicesResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  services: z.array(ServiceEntrySchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const UtilizationEntrySchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  serviceCode: z.string(),
  quotaCode: z.string(),
  quotaName: z.string(),
  value: z.number(),
  usageValue: z.number(),
  utilizationPct: z.number(),
  adjustable: z.boolean(),
});

const UtilizationResourceSchema = z.object({
  serviceCode: z.string(),
  threshold: z.number(),
  region: z.string(),
  entries: z.array(UtilizationEntrySchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const IncreaseRequestSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  region: z.string(),
  serviceCode: z.string(),
  quotaCode: z.string(),
  quotaName: z.string(),
  requestId: z.string(),
  desiredValue: z.number(),
  previousValue: z.number(),
  status: z.string(),
  requestedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function createQuotasClient(
  profile: string,
  region: string,
): ServiceQuotasClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new ServiceQuotasClient(opts as { region: string });
}

function createCloudWatchClient(
  profile: string,
  region: string,
): CloudWatchClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new CloudWatchClient(opts as { region: string });
}

function createStsClient(profile: string, region: string): STSClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new STSClient(opts as { region: string });
}

function sanitizeName(s: string): string {
  return s.replace(/[/\\]/g, "-");
}

async function getAccountId(profile: string, region: string): Promise<string> {
  const sts = createStsClient(profile, region);
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    return resp.Account ?? "unknown";
  } finally {
    sts.destroy();
  }
}

async function getUsageMetric(
  cw: CloudWatchClient,
  namespace: string | undefined,
  metricName: string | undefined,
  dimensions: Array<{ Name: string; Value: string }> | undefined,
): Promise<number | null> {
  if (!namespace || !metricName) return null;

  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60 * 1000);

  try {
    const resp = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: "usage",
            MetricStat: {
              Metric: {
                Namespace: namespace,
                MetricName: metricName,
                Dimensions: dimensions?.map((d) => ({
                  Name: d.Name,
                  Value: d.Value,
                })),
              },
              Period: 300,
              Stat: "Maximum",
            },
          },
        ],
        StartTime: start,
        EndTime: end,
      }),
    );
    const values = resp.MetricDataResults?.[0]?.Values;
    return values && values.length > 0 ? values[0] : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Context interface
// =============================================================================

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
}

// =============================================================================
// Model
// =============================================================================

/** AWS Service Quotas observation model with fan-out utilization checking. */
export const model = {
  type: "@webframp/aws/service-quotas",
  version: "2026.06.25.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    quota: {
      description: "Single quota detail with current value and usage",
      schema: QuotaResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    quotas: {
      description: "All quotas for a service in a given account",
      schema: QuotasResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    services: {
      description: "Available service codes for quota lookup",
      schema: ServicesResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    utilization: {
      description: "Quotas at or above a usage threshold across accounts",
      schema: UtilizationResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    increaseRequest: {
      description: "Record of a submitted quota increase request",
      schema: IncreaseRequestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    get_quota: {
      description:
        "Get a specific quota by service code and quota code. Returns the " +
        "applied value (account-level override or default), usage if available " +
        "from CloudWatch, and whether it's adjustable.",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g. 'iam')"),
        quotaCode: z.string().describe("Quota code (e.g. 'L-FE177D64')"),
        profile: z
          .string()
          .optional()
          .describe("Single profile to query (default: first configured)"),
        region: z
          .string()
          .optional()
          .describe("Override region for this call"),
      }),
      execute: async (
        args: {
          serviceCode: string;
          quotaCode: string;
          profile?: string;
          region?: string;
        },
        ctx: ModelContext,
      ) => {
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const client = createQuotasClient(profile, region);
        const cw = createCloudWatchClient(profile, region);
        try {
          const accountId = await getAccountId(profile, region);

          const resp = await client.send(
            new GetServiceQuotaCommand({
              ServiceCode: args.serviceCode,
              QuotaCode: args.quotaCode,
            }),
          );

          const q = resp.Quota;
          if (!q) {
            throw new Error(
              `No quota found for ${args.serviceCode}/${args.quotaCode}`,
            );
          }
          const usageMetric = q.UsageMetric;
          const usageValue = await getUsageMetric(
            cw,
            usageMetric?.MetricNamespace,
            usageMetric?.MetricName,
            usageMetric?.MetricDimensions
              ? Object.entries(usageMetric.MetricDimensions).map(([k, v]) => ({
                Name: k,
                Value: v as string,
              }))
              : undefined,
          );

          const value = q.Value ?? 0;
          const utilizationPct = usageValue !== null && value > 0
            ? Math.round((usageValue / value) * 10000) / 100
            : null;

          const quota: z.infer<typeof QuotaDetailSchema> = {
            serviceCode: args.serviceCode,
            serviceName: q.ServiceName ?? args.serviceCode,
            quotaCode: args.quotaCode,
            quotaName: q.QuotaName ?? "",
            value,
            unit: q.Unit ?? "None",
            adjustable: q.Adjustable ?? false,
            globalQuota: q.GlobalQuota ?? false,
            usageValue,
            utilizationPct,
          };

          const handle = await ctx.writeResource(
            "quota",
            `${args.serviceCode}-${args.quotaCode}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              region,
              quota,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Quota {service}/{code} in {account}: {value} ({usage}% used)",
            {
              service: args.serviceCode,
              code: args.quotaCode,
              account: accountId,
              value,
              usage: utilizationPct ?? "unknown",
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
          cw.destroy();
        }
      },
    },

    list_quotas: {
      description:
        "List all quotas for a service in a given account. Optionally filter " +
        "to only quotas with applied (non-default) values.",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g. 'iam')"),
        profile: z
          .string()
          .optional()
          .describe("Single profile to query (default: first configured)"),
        region: z
          .string()
          .optional()
          .describe("Override region for this call"),
      }),
      execute: async (
        args: { serviceCode: string; profile?: string; region?: string },
        ctx: ModelContext,
      ) => {
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const client = createQuotasClient(profile, region);
        try {
          const accountId = await getAccountId(profile, region);
          const quotas: z.infer<typeof QuotaDetailSchema>[] = [];

          let nextToken: string | undefined;
          let pages = 0;
          do {
            const resp = await client.send(
              new ListServiceQuotasCommand({
                ServiceCode: args.serviceCode,
                NextToken: nextToken,
                MaxResults: 100,
              }),
            );

            for (const q of resp.Quotas ?? []) {
              quotas.push({
                serviceCode: args.serviceCode,
                serviceName: q.ServiceName ?? args.serviceCode,
                quotaCode: q.QuotaCode ?? "",
                quotaName: q.QuotaName ?? "",
                value: q.Value ?? 0,
                unit: q.Unit ?? "None",
                adjustable: q.Adjustable ?? false,
                globalQuota: q.GlobalQuota ?? false,
                usageValue: null,
                utilizationPct: null,
              });
            }

            nextToken = resp.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const truncated = !!nextToken;
          const handle = await ctx.writeResource(
            "quotas",
            `${args.serviceCode}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              region,
              serviceCode: args.serviceCode,
              quotas,
              truncated,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Listed {count} quotas for {service} in {account}",
            {
              count: quotas.length,
              service: args.serviceCode,
              account: accountId,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_services: {
      description: "Discover available AWS service codes for quota lookup.",
      arguments: z.object({
        profile: z
          .string()
          .optional()
          .describe("Single profile to query (default: first configured)"),
      }),
      execute: async (
        args: { profile?: string },
        ctx: ModelContext,
      ) => {
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const region = ctx.globalArgs.defaultRegion;
        const client = createQuotasClient(profile, region);
        try {
          const accountId = await getAccountId(profile, region);
          const services: z.infer<typeof ServiceEntrySchema>[] = [];

          let nextToken: string | undefined;
          let pages = 0;
          do {
            const resp = await client.send(
              new ListServicesCommand({
                NextToken: nextToken,
                MaxResults: 100,
              }),
            );

            for (const s of resp.Services ?? []) {
              services.push({
                serviceCode: s.ServiceCode ?? "",
                serviceName: s.ServiceName ?? "",
              });
            }

            nextToken = resp.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const truncated = !!nextToken;
          const handle = await ctx.writeResource(
            "services",
            `services-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              services,
              truncated,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info("Discovered {count} service codes", {
            count: services.length,
          });

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    check_utilization: {
      description:
        "Fan-out across all configured profiles to find quotas above a usage " +
        "threshold. Uses CloudWatch metrics where available. Produces a single " +
        "'utilization' resource with all over-threshold entries.",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g. 'iam')"),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.8)
          .describe("Utilization threshold as fraction (0.8 = 80%)"),
        profiles: z
          .array(z.string())
          .optional()
          .describe("Override: check only these profiles"),
        region: z
          .string()
          .optional()
          .describe("Override region for this check"),
      }),
      execute: async (
        args: {
          serviceCode: string;
          threshold?: number;
          profiles?: string[];
          region?: string;
        },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const threshold = args.threshold ?? 0.8;
        const entries: z.infer<typeof UtilizationEntrySchema>[] = [];
        let anyTruncated = false;

        for (const profile of profiles) {
          const client = createQuotasClient(profile, region);
          const cw = createCloudWatchClient(profile, region);
          try {
            const accountId = await getAccountId(profile, region);

            let nextToken: string | undefined;
            let pages = 0;
            do {
              const resp = await client.send(
                new ListServiceQuotasCommand({
                  ServiceCode: args.serviceCode,
                  NextToken: nextToken,
                  MaxResults: 100,
                }),
              );

              for (const q of resp.Quotas ?? []) {
                const usageMetric = q.UsageMetric;
                if (!usageMetric?.MetricNamespace) continue;

                const usageValue = await getUsageMetric(
                  cw,
                  usageMetric.MetricNamespace,
                  usageMetric.MetricName,
                  usageMetric.MetricDimensions
                    ? Object.entries(usageMetric.MetricDimensions).map((
                      [k, v],
                    ) => ({ Name: k, Value: v as string }))
                    : undefined,
                );

                if (usageValue === null) continue;
                const value = q.Value ?? 0;
                if (value === 0) continue;

                const pct = usageValue / value;
                if (pct >= threshold) {
                  entries.push({
                    profile,
                    accountId,
                    serviceCode: args.serviceCode,
                    quotaCode: q.QuotaCode ?? "",
                    quotaName: q.QuotaName ?? "",
                    value,
                    usageValue,
                    utilizationPct: Math.round(pct * 10000) / 100,
                    adjustable: q.Adjustable ?? false,
                  });
                }
              }

              nextToken = resp.NextToken;
              pages++;
            } while (nextToken && pages < MAX_PAGES);

            if (nextToken) anyTruncated = true;

            ctx.logger.info(
              "Checked {service} utilization in {account}: {count} over threshold",
              {
                service: args.serviceCode,
                account: accountId,
                count: entries.filter((e) => e.profile === profile).length,
              },
            );
          } finally {
            client.destroy();
            cw.destroy();
          }
        }

        const handle = await ctx.writeResource(
          "utilization",
          `${args.serviceCode}-${threshold}`,
          {
            serviceCode: args.serviceCode,
            threshold,
            region,
            entries,
            truncated: anyTruncated,
            fetchedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Utilization check complete: {total} quotas above {threshold}% across {accounts} accounts",
          {
            total: entries.length,
            threshold: threshold * 100,
            accounts: profiles.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    request_increase: {
      description:
        "Request a quota increase for a specific service quota. MUTATING: " +
        "submits a request to AWS Service Quotas. Requires " +
        "servicequotas:RequestServiceQuotaIncrease permission.",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g. 'iam')"),
        quotaCode: z.string().describe("Quota code (e.g. 'L-FE177D64')"),
        desiredValue: z.number().describe("Requested new quota value"),
        profile: z
          .string()
          .optional()
          .describe("Profile with write access (default: first configured)"),
        region: z
          .string()
          .optional()
          .describe("Override region for this call"),
      }),
      execute: async (
        args: {
          serviceCode: string;
          quotaCode: string;
          desiredValue: number;
          profile?: string;
          region?: string;
        },
        ctx: ModelContext,
      ) => {
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const client = createQuotasClient(profile, region);
        try {
          const accountId = await getAccountId(profile, region);

          const current = await client.send(
            new GetServiceQuotaCommand({
              ServiceCode: args.serviceCode,
              QuotaCode: args.quotaCode,
            }),
          );
          const previousValue = current.Quota?.Value ?? 0;
          const quotaName = current.Quota?.QuotaName ?? "";

          const resp = await client.send(
            new RequestServiceQuotaIncreaseCommand({
              ServiceCode: args.serviceCode,
              QuotaCode: args.quotaCode,
              DesiredValue: args.desiredValue,
            }),
          );

          const req = resp.RequestedQuota;
          if (!req) {
            throw new Error(
              `No response for quota increase request ${args.serviceCode}/${args.quotaCode}`,
            );
          }
          const handle = await ctx.writeResource(
            "increaseRequest",
            `${args.serviceCode}-${args.quotaCode}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              region,
              serviceCode: args.serviceCode,
              quotaCode: args.quotaCode,
              quotaName,
              requestId: req.Id ?? "",
              desiredValue: args.desiredValue,
              previousValue,
              status: req.Status ?? "PENDING",
              requestedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Quota increase requested: {service}/{code} in {account} from {prev} to {desired} (status: {status})",
            {
              service: args.serviceCode,
              code: args.quotaCode,
              account: accountId,
              prev: previousValue,
              desired: args.desiredValue,
              status: req.Status ?? "PENDING",
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },
  },
};
