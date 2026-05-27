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
  type AwsSecurityFinding,
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
  productArn: z.string(),
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
    workflowStatus: z.string(),
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
  productArn: z.string(),
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
  notFound: z.array(z.string()),
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
  if (!match) {
    // Validate it looks like an ISO date before passing through
    if (!/^\d{4}-\d{2}-\d{2}/.test(input)) {
      throw new Error(
        `Invalid time format: "${input}". Use a relative duration (e.g. 24h, 7d, 30m) or ISO 8601 date.`,
      );
    }
    return input;
  }
  const [, value, unit] = match;
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 0;
  return new Date(Date.now() - parseInt(value) * ms).toISOString();
}

/** Create a SecurityHubClient for the configured region. */
function createClient(region: string): SecurityHubClient {
  return new SecurityHubClient({ region });
}

/** Create a collision-resistant instance name from filter parameters. */
function hashInstanceName(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  // Simple FNV-1a 32-bit hash for deterministic short names
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// =============================================================================
// Model Definition
// =============================================================================

/** Security Hub findings operations model. */
export const model = {
  type: "@webframp/aws/securityhub-findings",
  version: "2026.05.26.2",
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
        workflowStatus: z
          .string()
          .default("NEW")
          .describe(
            "Filter by workflow status (NEW, NOTIFIED, SUPPRESSED, RESOLVED)",
          ),
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
          workflowStatus: string;
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
          workflowStatus: args.workflowStatus,
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        try {
          const filters: Record<string, unknown[]> = {
            RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            WorkflowStatus: [
              { Value: args.workflowStatus, Comparison: "EQUALS" },
            ],
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

          const findings = (resp.Findings ?? []).map((
            f: AwsSecurityFinding,
          ) => ({
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
            productArn: f.ProductArn ?? "",
            resourceType: f.Resources?.[0]?.Type ?? null,
            resourceId: f.Resources?.[0]?.Id ?? null,
            workflowStatus: f.Workflow?.Status ?? "NEW",
            recordState: f.RecordState ?? "ACTIVE",
            createdAt: f.CreatedAt ? String(f.CreatedAt) : "",
            updatedAt: f.UpdatedAt ? String(f.UpdatedAt) : "",
          }));

          const data = {
            findings,
            count: findings.length,
            truncated: !!resp.NextToken,
            filters: {
              productName: args.productName ?? null,
              severityLabel: args.severityLabel ?? null,
              accountId: args.accountId ?? null,
              workflowStatus: args.workflowStatus,
              startTime: startIso,
              endTime: endIso,
            },
            fetchedAt: new Date().toISOString(),
          };

          const suffix = hashInstanceName({
            p: args.productName,
            s: args.severityLabel,
            a: args.accountId,
            w: args.workflowStatus,
          });

          context.logger.info(
            "Found {count} findings (truncated: {truncated})",
            { count: findings.length, truncated: data.truncated },
          );

          const handle = await context.writeResource(
            "finding_list",
            suffix,
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        try {
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

          const findings = (resp.Findings ?? []).map((
            f: AwsSecurityFinding,
          ) => ({
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
            productArn: f.ProductArn ?? "",
            workflowStatus: f.Workflow?.Status ?? "NEW",
            createdAt: f.CreatedAt ? String(f.CreatedAt) : "",
            updatedAt: f.UpdatedAt ? String(f.UpdatedAt) : "",
            resources: f.Resources ?? [],
            productFields: f.ProductFields ?? {},
            note: f.Note?.Text ?? null,
          }));

          const data = {
            findings,
            count: findings.length,
            notFound: args.findingArns.filter(
              (arn) => !findings.some((f) => f.arn === arn),
            ),
            fetchedAt: new Date().toISOString(),
          };

          context.logger.info("Retrieved {count} finding details", {
            count: findings.length,
          });

          const suffix = hashInstanceName({
            arns: [...args.findingArns].sort(),
          });
          const handle = await context.writeResource(
            "finding_details",
            suffix,
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        try {
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
            accountBreakdown: Object.entries(byAccount).map(
              ([accountId, c]) => ({
                accountId,
                critical: c.critical,
                high: c.high,
                medium: c.medium,
                low: c.low,
              }),
            ),
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

          const suffix = hashInstanceName({
            p: args.productName,
            t: startIso,
          });
          const handle = await context.writeResource(
            "severity_summary",
            suffix,
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
          .min(1).max(512)
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
          .min(1).max(512)
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
          .min(1).max(512)
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

/**
 * Update workflow status for findings. Retrieves the actual ProductArn from
 * each finding first (via GetFindings), then passes correct identifiers to
 * BatchUpdateFindings.
 */
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
  try {
    context.logger.info("Updating {count} findings to {status}", {
      count: findingArns.length,
      status,
    });

    // First, retrieve the actual ProductArn for each finding
    const lookupResp = await client.send(
      new GetFindingsCommand({
        Filters: {
          Id: findingArns.map((arn) => ({
            Value: arn,
            Comparison: "EQUALS" as const,
          })),
        },
        MaxResults: 100,
      }),
    );

    const foundFindings = lookupResp.Findings ?? [];
    if (foundFindings.length === 0) {
      throw new Error(
        `None of the ${findingArns.length} finding ARNs could be resolved. ` +
          `Verify the ARNs are correct and the findings exist.`,
      );
    }

    const findingIdentifiers = foundFindings.map((f: AwsSecurityFinding) => ({
      Id: f.Id!,
      ProductArn: f.ProductArn!,
    }));

    const resp = await client.send(
      new BatchUpdateFindingsCommand({
        FindingIdentifiers: findingIdentifiers,
        Workflow: { Status: status },
        Note: { Text: note, UpdatedBy: "swamp-securityhub-findings" },
      }),
    );

    const notFound = findingArns.filter(
      (arn) => !foundFindings.some((f: AwsSecurityFinding) => f.Id === arn),
    );

    const data = {
      updated: resp.ProcessedFindings?.length ?? 0,
      failed: (resp.UnprocessedFindings?.length ?? 0) + notFound.length,
      failures: [
        ...(resp.UnprocessedFindings ?? []).map((
          f: {
            FindingIdentifier?: { Id?: string };
            ErrorCode?: string;
            ErrorMessage?: string;
          },
        ) => ({
          findingArn: f.FindingIdentifier?.Id ?? "",
          errorCode: f.ErrorCode ?? "",
          errorMessage: f.ErrorMessage ?? "",
        })),
        ...notFound.map((arn) => ({
          findingArn: arn,
          errorCode: "FindingNotFound",
          errorMessage: "Finding ARN not found in GetFindings lookup",
        })),
      ],
      newStatus: status,
      note,
      updatedAt: new Date().toISOString(),
    };

    context.logger.info(
      "Update complete: {updated} updated, {failed} failed",
      { updated: data.updated, failed: data.failed },
    );

    const suffix = hashInstanceName({ status, arns: [...findingArns].sort() });
    const handle = await context.writeResource(
      "update_result",
      suffix,
      data,
    );
    return { dataHandles: [handle] };
  } finally {
    client.destroy();
  }
}
