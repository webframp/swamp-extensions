/**
 * AWS Security Hub findings operations model for swamp.
 *
 * Queries and manages Security Hub findings from a delegated administrator
 * account, leveraging cross-region aggregation to cover the entire AWS
 * Organization in a single API call. Supports listing, filtering, and
 * workflow status updates (archive, resolve, reopen) for operational triage.
 *
 * Does NOT duplicate the upstream @swamp/aws/securityhub extension which
 * manages Security Hub infrastructure (hubs, rules, policies, controls).
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  type AwsSecurityFindingFilters,
  BatchUpdateFindingsCommand,
  GetFindingsCommand,
  SecurityHubClient,
} from "npm:@aws-sdk/client-securityhub@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region (aggregation home region)"),
});

const FindingSummarySchema = z.object({
  id: z.string(),
  arn: z.string(),
  type: z.string(),
  severity: z.string(),
  severityScore: z.number(),
  title: z.string(),
  description: z.string(),
  accountId: z.string(),
  region: z.string(),
  productName: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  workflowStatus: z.string(),
  recordState: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const FindingListSchema = z.object({
  findings: z.array(FindingSummarySchema),
  count: z.number(),
  truncated: z.boolean(),
  filters: z.object({
    productName: z.string().nullable(),
    severityLabel: z.string().nullable(),
    accountId: z.string().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
  }),
  fetchedAt: z.string(),
});

const FindingDetailSchema = z.object({
  id: z.string(),
  arn: z.string(),
  type: z.string(),
  severity: z.string(),
  severityScore: z.number(),
  title: z.string(),
  description: z.string(),
  accountId: z.string(),
  region: z.string(),
  productName: z.string(),
  workflowStatus: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resources: z.array(z.record(z.string(), z.unknown())),
  productFields: z.record(z.string(), z.string()),
  note: z.string().nullable(),
});

const FindingDetailsSchema = z.object({
  findings: z.array(FindingDetailSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const SeveritySummarySchema = z.object({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  informational: z.number(),
  total: z.number(),
  truncated: z.boolean(),
  accountBreakdown: z.array(
    z.object({
      accountId: z.string(),
      critical: z.number(),
      high: z.number(),
      medium: z.number(),
      low: z.number(),
    }),
  ),
  fetchedAt: z.string(),
});

const UpdateResultSchema = z.object({
  updated: z.number(),
  failed: z.number(),
  failures: z.array(
    z.object({
      findingArn: z.string(),
      errorCode: z.string(),
      errorMessage: z.string(),
    }),
  ),
  newStatus: z.string(),
  note: z.string(),
  updatedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Parse relative time strings (e.g., "24h", "7d", "30m") to ISO date. */
function parseRelativeTime(input: string): string {
  const match = input.match(/^(\d+)([mhd])$/);
  if (!match) return input; // assume ISO date
  const [, value, unit] = match;
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return new Date(Date.now() - parseInt(value) * ms).toISOString();
}

/** Create a SecurityHubClient for the configured region. */
function createClient(region: string): SecurityHubClient {
  return new SecurityHubClient({ region });
}

// =============================================================================
// Model Definition
// =============================================================================

/** Security Hub findings operations model. */
export const model = {
  type: "@webframp/aws/securityhub-findings",
  version: "2026.05.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    finding_list: {
      description: "List of Security Hub finding summaries",
      schema: FindingListSchema,
      lifetime: "30m",
      garbageCollection: 5,
    },
    finding_details: {
      description: "Full ASFF finding details",
      schema: FindingDetailsSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
    severity_summary: {
      description: "Severity aggregation across accounts",
      schema: SeveritySummarySchema,
      lifetime: "30m",
      garbageCollection: 5,
    },
    update_result: {
      description: "Result of a findings workflow status update",
      schema: UpdateResultSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    list_findings: {
      description:
        "List Security Hub findings with filters for product, severity, account, and time window",
      arguments: z.object({
        productName: z
          .string()
          .optional()
          .describe("Filter by product (e.g. GuardDuty, Inspector, Macie)"),
        severityLabel: z
          .string()
          .optional()
          .describe(
            "Filter by severity label (CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL)",
          ),
        accountId: z
          .string()
          .optional()
          .describe("Filter to a specific AWS account ID"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(100)
          .describe("Maximum findings to return"),
      }),
      execute: async (
        args: {
          productName?: string;
          severityLabel?: string;
          accountId?: string;
          startTime: string;
          endTime?: string;
          limit: number;
        },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Listing findings", {
          productName: args.productName ?? "all",
          severityLabel: args.severityLabel ?? "all",
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        const filters: Record<string, unknown[]> = {
          RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
          WorkflowStatus: [{ Value: "NEW", Comparison: "EQUALS" }],
        };

        const startIso = parseRelativeTime(args.startTime);
        const endIso = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date().toISOString();
        filters.UpdatedAt = [{ Start: startIso, End: endIso }];

        if (args.productName) {
          filters.ProductName = [
            { Value: args.productName, Comparison: "EQUALS" },
          ];
        }
        if (args.severityLabel) {
          filters.SeverityLabel = [
            { Value: args.severityLabel, Comparison: "EQUALS" },
          ];
        }
        if (args.accountId) {
          filters.AwsAccountId = [
            { Value: args.accountId, Comparison: "EQUALS" },
          ];
        }

        const resp = await client.send(
          new GetFindingsCommand({
            Filters: filters as AwsSecurityFindingFilters,
            MaxResults: args.limit,
            SortCriteria: [
              { Field: "SeverityNormalized", SortOrder: "desc" },
            ],
          }),
        );

        const findings = (resp.Findings ?? []).map((f) => ({
          id: f.Id?.split("/").pop() ?? f.Id ?? "",
          arn: f.Id ?? "",
          type: f.Types?.[0] ?? "Unknown",
          severity: f.Severity?.Label ?? "UNKNOWN",
          severityScore: f.Severity?.Product ?? 0,
          title: f.Title ?? "",
          description: f.Description ?? "",
          accountId: f.AwsAccountId ?? "",
          region: f.Region ?? "",
          productName: f.ProductFields?.["aws/securityhub/ProductName"] ?? "",
          resourceType: f.Resources?.[0]?.Type ?? null,
          resourceId: f.Resources?.[0]?.Id ?? null,
          workflowStatus: f.Workflow?.Status ?? "NEW",
          recordState: f.RecordState ?? "ACTIVE",
          createdAt: f.CreatedAt ?? "",
          updatedAt: f.UpdatedAt ?? "",
        }));

        const data = {
          findings,
          count: findings.length,
          truncated: findings.length >= args.limit,
          filters: {
            productName: args.productName ?? null,
            severityLabel: args.severityLabel ?? null,
            accountId: args.accountId ?? null,
            startTime: startIso,
            endTime: endIso,
          },
          fetchedAt: new Date().toISOString(),
        };

        const suffix = [
          args.productName,
          args.severityLabel,
          args.accountId,
        ]
          .filter(Boolean)
          .join("_") || "all";

        context.logger.info("Found {count} findings (truncated: {truncated})", {
          count: findings.length,
          truncated: data.truncated,
        });

        const handle = await context.writeResource(
          "finding_list",
          suffix,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    get_finding_details: {
      description: "Get full ASFF details for specific findings by ARN",
      arguments: z.object({
        findingArns: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Finding ARNs to retrieve (max 20)"),
      }),
      execute: async (
        args: { findingArns: string[] },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Getting details for {count} findings", {
          count: args.findingArns.length,
        });

        const client = createClient(context.globalArgs.region);

        const resp = await client.send(
          new GetFindingsCommand({
            Filters: {
              Id: args.findingArns.map((arn) => ({
                Value: arn,
                Comparison: "EQUALS" as const,
              })),
            },
            MaxResults: 20,
          }),
        );

        const findings = (resp.Findings ?? []).map((f) => ({
          id: f.Id?.split("/").pop() ?? f.Id ?? "",
          arn: f.Id ?? "",
          type: f.Types?.[0] ?? "Unknown",
          severity: f.Severity?.Label ?? "UNKNOWN",
          severityScore: f.Severity?.Product ?? 0,
          title: f.Title ?? "",
          description: f.Description ?? "",
          accountId: f.AwsAccountId ?? "",
          region: f.Region ?? "",
          productName: f.ProductFields?.["aws/securityhub/ProductName"] ?? "",
          workflowStatus: f.Workflow?.Status ?? "NEW",
          createdAt: f.CreatedAt ?? "",
          updatedAt: f.UpdatedAt ?? "",
          resources: f.Resources ?? [],
          productFields: f.ProductFields ?? {},
          note: f.Note?.Text ?? null,
        }));

        const data = {
          findings,
          count: findings.length,
          fetchedAt: new Date().toISOString(),
        };

        context.logger.info("Retrieved {count} finding details", {
          count: findings.length,
        });

        const handle = await context.writeResource(
          "finding_details",
          "details",
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    get_severity_summary: {
      description:
        "Aggregate findings by severity across all accounts in the organization",
      arguments: z.object({
        productName: z
          .string()
          .optional()
          .describe("Filter by product (e.g. GuardDuty)"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
      }),
      execute: async (
        args: { productName?: string; startTime: string },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Generating severity summary", {
          productName: args.productName ?? "all",
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        const startIso = parseRelativeTime(args.startTime);
        const filters: Record<string, unknown[]> = {
          RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
          WorkflowStatus: [{ Value: "NEW", Comparison: "EQUALS" }],
          UpdatedAt: [{ Start: startIso, End: new Date().toISOString() }],
        };
        if (args.productName) {
          filters.ProductName = [
            { Value: args.productName, Comparison: "EQUALS" },
          ];
        }

        // Paginate to collect all findings (up to 500 max for summary)
        const allFindings: Array<
          { Severity?: { Label?: string }; AwsAccountId?: string }
        > = [];
        let nextToken: string | undefined;
        const maxPages = 5;

        for (let page = 0; page < maxPages; page++) {
          const resp = await client.send(
            new GetFindingsCommand({
              Filters: filters as AwsSecurityFindingFilters,
              MaxResults: 100,
              NextToken: nextToken,
            }),
          );
          allFindings.push(...(resp.Findings ?? []));
          nextToken = resp.NextToken;
          if (!nextToken) break;
        }

        const truncated = !!nextToken;
        const counts = {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          informational: 0,
        };
        const byAccount: Record<string, typeof counts> = {};

        for (const f of allFindings) {
          const label = (f.Severity?.Label ?? "")
            .toLowerCase() as keyof typeof counts;
          if (label in counts) counts[label]++;
          const acct = f.AwsAccountId ?? "unknown";
          if (!byAccount[acct]) {
            byAccount[acct] = {
              critical: 0,
              high: 0,
              medium: 0,
              low: 0,
              informational: 0,
            };
          }
          if (label in byAccount[acct]) byAccount[acct][label]++;
        }

        const data = {
          ...counts,
          total: allFindings.length,
          truncated,
          accountBreakdown: Object.entries(byAccount).map(([accountId, c]) => ({
            accountId,
            critical: c.critical,
            high: c.high,
            medium: c.medium,
            low: c.low,
          })),
          fetchedAt: new Date().toISOString(),
        };

        context.logger.info(
          "Summary: {total} findings across {accounts} accounts (truncated: {truncated})",
          {
            total: allFindings.length,
            accounts: Object.keys(byAccount).length,
            truncated,
          },
        );

        const handle = await context.writeResource(
          "severity_summary",
          "summary",
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    archive_findings: {
      description:
        "Suppress findings (mark as false positive or expected behavior). Sets Workflow.Status to SUPPRESSED with a required note.",
      arguments: z.object({
        findingArns: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Finding ARNs to archive"),
        note: z
          .string()
          .min(1)
          .describe("Reason for archiving (required for audit trail)"),
      }),
      execute: async (
        args: { findingArns: string[]; note: string },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        return await updateWorkflowStatus(
          context.globalArgs.region,
          args.findingArns,
          "SUPPRESSED",
          args.note,
          context,
        );
      },
    },

    resolve_findings: {
      description:
        "Mark findings as resolved. Sets Workflow.Status to RESOLVED with a required note.",
      arguments: z.object({
        findingArns: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Finding ARNs to resolve"),
        note: z
          .string()
          .min(1)
          .describe("Resolution details (required for audit trail)"),
      }),
      execute: async (
        args: { findingArns: string[]; note: string },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        return await updateWorkflowStatus(
          context.globalArgs.region,
          args.findingArns,
          "RESOLVED",
          args.note,
          context,
        );
      },
    },

    reopen_findings: {
      description:
        "Reopen previously archived or resolved findings. Sets Workflow.Status to NEW with a required note.",
      arguments: z.object({
        findingArns: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Finding ARNs to reopen"),
        note: z
          .string()
          .min(1)
          .describe("Reason for reopening (required for audit trail)"),
      }),
      execute: async (
        args: { findingArns: string[]; note: string },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        return await updateWorkflowStatus(
          context.globalArgs.region,
          args.findingArns,
          "NEW",
          args.note,
          context,
        );
      },
    },
  },
};

// =============================================================================
// Shared update helper
// =============================================================================

async function updateWorkflowStatus(
  region: string,
  findingArns: string[],
  status: "SUPPRESSED" | "RESOLVED" | "NEW",
  note: string,
  context: {
    logger: {
      info: (msg: string, props?: Record<string, unknown>) => void;
    };
    writeResource: (
      spec: string,
      name: string,
      data: unknown,
    ) => Promise<unknown>;
  },
): Promise<{ dataHandles: unknown[] }> {
  const client = createClient(region);

  context.logger.info("Updating {count} findings to {status}", {
    count: findingArns.length,
    status,
  });

  const findingIdentifiers = findingArns.map((arn) => {
    const parts = arn.split(":");
    if (parts.length < 5 || !parts[3] || !parts[4]) {
      throw new Error(
        `Invalid finding ARN format: "${arn}". Expected arn:aws:securityhub:REGION:ACCOUNT:...`,
      );
    }
    return {
      Id: arn,
      ProductArn: `arn:aws:securityhub:${parts[3]}::product/${
        parts[4]
      }/default`,
    };
  });

  const resp = await client.send(
    new BatchUpdateFindingsCommand({
      FindingIdentifiers: findingIdentifiers,
      Workflow: { Status: status },
      Note: { Text: note, UpdatedBy: "swamp-securityhub-findings" },
    }),
  );

  const data = {
    updated: resp.ProcessedFindings?.length ?? 0,
    failed: resp.UnprocessedFindings?.length ?? 0,
    failures: (resp.UnprocessedFindings ?? []).map((f) => ({
      findingArn: f.FindingIdentifier?.Id ?? "",
      errorCode: f.ErrorCode ?? "",
      errorMessage: f.ErrorMessage ?? "",
    })),
    newStatus: status,
    note,
    updatedAt: new Date().toISOString(),
  };

  context.logger.info("Update complete: {updated} updated, {failed} failed", {
    updated: data.updated,
    failed: data.failed,
  });

  const handle = await context.writeResource(
    "update_result",
    status.toLowerCase(),
    data,
  );
  return { dataHandles: [handle] };
}
