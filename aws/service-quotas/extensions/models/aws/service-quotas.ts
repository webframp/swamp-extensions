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
  GetRequestedServiceQuotaChangeCommand,
  GetServiceQuotaCommand,
  ListRequestedServiceQuotaChangeHistoryCommand,
  ListServiceQuotasCommand,
  ListServicesCommand,
  RequestServiceQuotaIncreaseCommand,
  ServiceQuotasClient,
} from "npm:@aws-sdk/client-service-quotas@3.1094.0";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "npm:@aws-sdk/client-cloudwatch@3.1094.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1094.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1094.0";
import {
  DescribeCasesCommand,
  DescribeCommunicationsCommand,
  SupportClient,
} from "npm:@aws-sdk/client-support@3.1094.0";

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

// A profile whose sweep raised an error. NOTE: on a multi-service
// check_utilization run a profile can fail partway — it may already have
// contributed entries for an earlier service before a later one threw, so a
// profile listed here is not necessarily absent from `entries`. Treat this as
// "the run for this account was incomplete", i.e. a degraded/staleness signal,
// not "this account contributed nothing".
const FailedProfileSchema = z.object({
  profile: z.string(),
  error: z.string(),
});

const UtilizationResourceSchema = z.object({
  serviceCode: z.string(),
  threshold: z.number(),
  region: z.string(),
  entries: z.array(UtilizationEntrySchema),
  truncated: z.boolean(),
  failedProfiles: z.array(FailedProfileSchema),
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
  requestedAt: z.string().nullable(),
});

const PendingRequestEntrySchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  region: z.string(),
  serviceCode: z.string(),
  quotaCode: z.string(),
  quotaName: z.string(),
  requestId: z.string(),
  desiredValue: z.number(),
  status: z.string(),
  requestedAt: z.string().nullable(),
  caseId: z.string().nullable(),
});

const PendingRequestsResourceSchema = z.object({
  region: z.string(),
  statuses: z.array(z.string()),
  entries: z.array(PendingRequestEntrySchema),
  profilesChecked: z.number(),
  truncated: z.boolean(),
  failedProfiles: z.array(FailedProfileSchema),
  fetchedAt: z.string(),
});

const CommunicationSchema = z.object({
  body: z.string(),
  submittedBy: z.string(),
  timeCreated: z.string(),
});

const CaseCommunicationsSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  region: z.string(),
  caseId: z.string(),
  displayId: z.string(),
  subject: z.string(),
  status: z.string(),
  severityCode: z.string(),
  serviceCode: z.string(),
  communications: z.array(CommunicationSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function createSupportClient(
  profile: string,
): SupportClient {
  // AWS Support API is only available in us-east-1
  const opts: Record<string, unknown> = { region: "us-east-1" };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new SupportClient(opts as { region: string });
}

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

/**
 * Redact identifiers from an error message before it is persisted. This data
 * feeds the daily briefing, which must never surface internal identifiers —
 * ARNs (account id + principal/username), bare 12-digit account ids, or
 * internal URLs. The most common failure, a `granted`/AWS SSO
 * credential-process error, embeds the org's SSO portal URL and login hints;
 * collapse it to a short, actionable, identifier-free code. Otherwise keep the
 * actionable text (missing permission, error class) while stripping who/where.
 */
function redactError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e))
    // Strip ANSI escape sequences (granted/AWS CLI errors are colorized) —
    // full CSI + charset selects, not just SGR color codes.
    // deno-lint-ignore no-control-regex
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[()][@-~])/g, "");
  // Collapse the granted / AWS SSO re-login failure — its raw text embeds the
  // org SSO portal URL — to a short, actionable code. Match ONLY phrases that
  // imply re-authentication; a bare credential-process failure (missing binary,
  // malformed output, network reset) is a different fault and must keep its
  // (redacted) text so the operator sees the real cause, not a login prompt.
  if (
    /sso login|please login|Identity Center token|sso[^\n]*expired|identity[\s-]*center[^\n]*expired/i
      .test(msg)
  ) {
    return "sso-login-required";
  }
  return msg
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/arn:aws[^\s"']*/gi, "arn:***")
    // Bare hostnames/FQDNs (no scheme): cert altnames, ENOTFOUND, VPC
    // endpoints, internal domains. Requires a leading letter and >=2 dots so
    // version strings (2026.07.10.1) and single-dot tokens (model.ts) survive.
    .replace(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, "<host>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b\d{4}-\d{4}-\d{4}\b/g, "***")
    .replace(/\b\d{12}\b/g, "***")
    .trim();
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

/** AWS Service Quotas observation and management model. */
export const model = {
  type: "@webframp/aws/service-quotas",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
    pendingRequests: {
      description:
        "Open quota-increase requests (PENDING/CASE_OPENED) across accounts",
      schema: PendingRequestsResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    caseCommunications: {
      description:
        "Communications on a support case associated with a quota increase request",
      schema: CaseCommunicationsSchema,
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
        "threshold. Accepts one serviceCode or several via serviceCodes; sweeps " +
        "all requested services in a single run and writes one 'utilization' " +
        "resource per service. Uses CloudWatch metrics where available.",
      arguments: z.object({
        serviceCode: z
          .string()
          .optional()
          .describe(
            "Single AWS service code (e.g. 'ec2'). Use this or serviceCodes.",
          ),
        serviceCodes: z
          .array(z.string())
          .optional()
          .describe(
            "Multiple AWS service codes to sweep in one fan-out (e.g. ['ec2','vpc','eks']).",
          ),
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
          serviceCode?: string;
          serviceCodes?: string[];
          threshold?: number;
          profiles?: string[];
          region?: string;
        },
        ctx: ModelContext,
      ) => {
        const rawCodes = args.serviceCodes ??
          (args.serviceCode ? [args.serviceCode] : []);
        if (rawCodes.length === 0) {
          throw new Error(
            "check_utilization requires a serviceCode or a non-empty serviceCodes array",
          );
        }
        // Dedup so a repeated service code isn't fetched or written twice.
        const codes = [...new Set(rawCodes)];
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const threshold = args.threshold ?? 0.8;

        // Accumulate over-threshold entries per service across all profiles.
        const entriesByService = new Map<
          string,
          z.infer<typeof UtilizationEntrySchema>[]
        >();
        const truncatedByService = new Map<string, boolean>();
        for (const code of codes) {
          entriesByService.set(code, []);
          truncatedByService.set(code, false);
        }
        // A single unreachable account must not sink the whole fleet sweep.
        const failedProfiles: z.infer<typeof FailedProfileSchema>[] = [];

        for (const profile of profiles) {
          const client = createQuotasClient(profile, region);
          const cw = createCloudWatchClient(profile, region);
          try {
            const accountId = await getAccountId(profile, region);

            for (const serviceCode of codes) {
              const entries = entriesByService.get(serviceCode)!;
              let nextToken: string | undefined;
              let pages = 0;
              do {
                const resp = await client.send(
                  new ListServiceQuotasCommand({
                    ServiceCode: serviceCode,
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
                      serviceCode,
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

              if (nextToken) truncatedByService.set(serviceCode, true);

              ctx.logger.info(
                "Checked {service} utilization in {account}: {count} over threshold",
                {
                  service: serviceCode,
                  account: accountId,
                  count: entries.filter((e) => e.profile === profile).length,
                },
              );
            }
          } catch (e) {
            const error = redactError(e);
            failedProfiles.push({ profile, error });
            ctx.logger.info(
              "Skipped profile {profile} in utilization sweep: {error}",
              { profile, error },
            );
          } finally {
            client.destroy();
            cw.destroy();
          }
        }

        const dataHandles = [];
        let total = 0;
        for (const serviceCode of codes) {
          const entries = entriesByService.get(serviceCode)!;
          total += entries.length;
          const handle = await ctx.writeResource(
            "utilization",
            `${serviceCode}-${threshold}`,
            {
              serviceCode,
              threshold,
              region,
              entries,
              truncated: truncatedByService.get(serviceCode)!,
              failedProfiles,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );
          dataHandles.push(handle);
        }

        ctx.logger.info(
          "Utilization check complete: {total} quotas above {threshold}% across {accounts} accounts ({failed} failed), {services} services",
          {
            total,
            threshold: threshold * 100,
            accounts: profiles.length - failedProfiles.length,
            failed: failedProfiles.length,
            services: codes.length,
          },
        );

        return { dataHandles };
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

    get_request_status: {
      description:
        "Check the status of a previously submitted quota increase request. " +
        "Returns the current status, case ID, and timestamps. Use the requestId " +
        "from a prior request_increase call.",
      arguments: z.object({
        requestId: z
          .string()
          .describe("Request ID from a prior quota increase request"),
        profile: z
          .string()
          .optional()
          .describe("Profile to query (default: first configured)"),
        region: z
          .string()
          .optional()
          .describe("Override region for this call"),
      }),
      execute: async (
        args: {
          requestId: string;
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

          const resp = await client.send(
            new GetRequestedServiceQuotaChangeCommand({
              RequestId: args.requestId,
            }),
          );

          const req = resp.RequestedQuota;
          if (!req) {
            throw new Error(
              `No quota change request found for ID: ${args.requestId}`,
            );
          }

          const handle = await ctx.writeResource(
            "increaseRequest",
            `status-${sanitizeName(args.requestId)}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              region,
              serviceCode: req.ServiceCode ?? "",
              quotaCode: req.QuotaCode ?? "",
              quotaName: req.QuotaName ?? "",
              requestId: req.Id ?? args.requestId,
              desiredValue: req.DesiredValue ?? 0,
              previousValue: 0,
              status: req.Status ?? "UNKNOWN",
              requestedAt: req.Created ? req.Created.toISOString() : null,
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Quota request {id} status: {status} (service: {service}, quota: {code}, desired: {desired})",
            {
              id: args.requestId,
              status: req.Status ?? "UNKNOWN",
              service: req.ServiceCode ?? "",
              code: req.QuotaCode ?? "",
              desired: req.DesiredValue ?? 0,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_pending_requests: {
      description:
        "Fan-out across all configured profiles to list quota-increase requests " +
        "still open (PENDING or CASE_OPENED). Read-only. Produces one " +
        "'pendingRequests' resource aggregating every open request across " +
        "accounts. Requires servicequotas:ListRequestedServiceQuotaChangeHistory.",
      arguments: z.object({
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
          profiles?: string[];
          region?: string;
        },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const region = args.region ?? ctx.globalArgs.defaultRegion;
        const statuses: ("PENDING" | "CASE_OPENED")[] = [
          "PENDING",
          "CASE_OPENED",
        ];
        const entries: z.infer<typeof PendingRequestEntrySchema>[] = [];
        let anyTruncated = false;
        // A single unreachable account must not sink the whole fleet sweep.
        const failedProfiles: z.infer<typeof FailedProfileSchema>[] = [];

        for (const profile of profiles) {
          const client = createQuotasClient(profile, region);
          try {
            const accountId = await getAccountId(profile, region);

            for (const status of statuses) {
              let nextToken: string | undefined;
              let pages = 0;
              do {
                const resp = await client.send(
                  new ListRequestedServiceQuotaChangeHistoryCommand({
                    Status: status,
                    NextToken: nextToken,
                    MaxResults: 100,
                  }),
                );

                for (const req of resp.RequestedQuotas ?? []) {
                  entries.push({
                    profile,
                    accountId,
                    region,
                    serviceCode: req.ServiceCode ?? "",
                    quotaCode: req.QuotaCode ?? "",
                    quotaName: req.QuotaName ?? "",
                    requestId: req.Id ?? "",
                    desiredValue: req.DesiredValue ?? 0,
                    status: req.Status ?? status,
                    requestedAt: req.Created ? req.Created.toISOString() : null,
                    caseId: req.CaseId || null,
                  });
                }

                nextToken = resp.NextToken;
                pages++;
              } while (nextToken && pages < MAX_PAGES);

              if (nextToken) anyTruncated = true;
            }

            ctx.logger.info(
              "Listed open quota requests in {account}: {count}",
              {
                account: accountId,
                count: entries.filter((e) => e.profile === profile).length,
              },
            );
          } catch (e) {
            const error = redactError(e);
            failedProfiles.push({ profile, error });
            ctx.logger.info(
              "Skipped profile {profile} in pending-requests sweep: {error}",
              { profile, error },
            );
          } finally {
            client.destroy();
          }
        }

        const handle = await ctx.writeResource(
          "pendingRequests",
          `pending-${region}`,
          {
            region,
            statuses,
            entries,
            profilesChecked: profiles.length,
            truncated: anyTruncated,
            failedProfiles,
            fetchedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Open quota-increase requests: {total} across {accounts} accounts ({failed} failed)",
          {
            total: entries.length,
            accounts: profiles.length - failedProfiles.length,
            failed: failedProfiles.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    get_case_communications: {
      description:
        "Retrieve communications on a support case associated with a quota " +
        "increase request. Uses the case display ID from a prior request_increase " +
        "or get_request_status call. Requires AWS Business or Enterprise support " +
        "plan and support:DescribeCases + support:DescribeCommunications permissions.",
      arguments: z.object({
        displayId: z
          .string()
          .describe(
            "Support case display ID (numeric, from the quota increase request)",
          ),
        profile: z
          .string()
          .optional()
          .describe("Profile to query (default: first configured)"),
      }),
      execute: async (
        args: {
          displayId: string;
          profile?: string;
        },
        ctx: ModelContext,
      ) => {
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const support = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile, "us-east-1");

          const casesResp = await support.send(
            new DescribeCasesCommand({
              displayId: args.displayId,
              includeCommunications: false,
            }),
          );

          const caseDetail = casesResp.cases?.[0];
          if (!caseDetail) {
            throw new Error(
              `No support case found with display ID: ${args.displayId}`,
            );
          }

          const internalCaseId = caseDetail.caseId;
          if (!internalCaseId) {
            throw new Error(
              `Support case ${args.displayId} exists but has no internal case ID — cannot retrieve communications`,
            );
          }
          const communications: Array<{
            body: string;
            submittedBy: string;
            timeCreated: string;
          }> = [];
          let nextToken: string | undefined;
          let pages = 0;
          let truncated = false;

          do {
            const commsResp = await support.send(
              new DescribeCommunicationsCommand({
                caseId: internalCaseId,
                nextToken,
              }),
            );

            for (const comm of commsResp.communications ?? []) {
              communications.push({
                body: comm.body ?? "",
                submittedBy: comm.submittedBy ?? "",
                timeCreated: comm.timeCreated ?? "",
              });
            }

            nextToken = commsResp.nextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          if (nextToken) truncated = true;

          const handle = await ctx.writeResource(
            "caseCommunications",
            `case-${args.displayId}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              region: "us-east-1",
              caseId: internalCaseId,
              displayId: args.displayId,
              subject: caseDetail.subject ?? "",
              status: caseDetail.status ?? "",
              severityCode: caseDetail.severityCode ?? "",
              serviceCode: caseDetail.serviceCode ?? "",
              communications,
              truncated,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Case {displayId} ({status}, severity: {severity}): {count} communications",
            {
              displayId: args.displayId,
              status: caseDetail.status ?? "unknown",
              severity: caseDetail.severityCode ?? "unknown",
              count: communications.length,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          support.destroy();
        }
      },
    },
  },
};
