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

import { z } from "npm:zod@4.4.3";
import {
  type AwsSecurityFinding,
  type AwsSecurityFindingFilters,
  BatchUpdateFindingsCommand,
  GetFindingsCommand,
  SecurityHubClient,
} from "npm:@aws-sdk/client-securityhub@3.1069.0";
import {
  ListAccountsCommand,
  OrganizationsClient,
} from "npm:@aws-sdk/client-organizations@3.1069.0";

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
  truncated: z.boolean(),
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
      informational: z.number(),
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

const FindingsByTypeSchema = z.object({
  groups: z.array(
    z.object({
      type: z.string(),
      count: z.number(),
      severities: z.object({
        critical: z.number(),
        high: z.number(),
        medium: z.number(),
        low: z.number(),
        informational: z.number(),
      }),
      accounts: z.array(z.string()),
      findings: z.array(FindingSummarySchema),
    }),
  ),
  totalTypes: z.number(),
  totalFindings: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const DiffFindingsSchema = z.object({
  newFindings: z.array(FindingSummarySchema),
  resolvedFindings: z.array(FindingSummarySchema),
  newCount: z.number(),
  resolvedCount: z.number(),
  truncated: z.boolean(),
  currentSnapshot: z.array(FindingSummarySchema),
  fetchedAt: z.string(),
});

const AccountMapSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      status: z.string(),
    }),
  ),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const FullExportSchema = z.object({
  findings: z.array(FindingSummarySchema),
  count: z.number(),
  truncated: z.boolean(),
  totalPages: z.number(),
  filters: z.object({
    productName: z.string().nullable(),
    severityLabel: z.string().nullable(),
    workflowStatus: z.string(),
    startTime: z.string().nullable(),
  }),
  fetchedAt: z.string(),
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
  const magnitude = parseInt(value);
  if (magnitude === 0) {
    throw new Error(
      `Invalid time format: "${input}". Magnitude must be greater than 0.`,
    );
  }
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 0;
  return new Date(Date.now() - magnitude * ms).toISOString();
}

/** Create a SecurityHubClient for the configured region. */
function createClient(region: string): SecurityHubClient {
  return new SecurityHubClient({ region });
}

/** Map an AWS finding to our normalized summary schema. */
function mapFindingSummary(f: AwsSecurityFinding) {
  return {
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
  };
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
  version: "2026.06.15.1",
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
    findings_by_type: {
      description: "Findings grouped by finding type",
      schema: FindingsByTypeSchema,
      lifetime: "30m",
      garbageCollection: 5,
    },
    diff_findings: {
      description: "New and resolved findings since last run",
      schema: DiffFindingsSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
    account_map: {
      description: "AWS Organizations account ID to name mapping",
      schema: AccountMapSchema,
      lifetime: "24h",
      garbageCollection: 3,
    },
    full_export: {
      description: "Paginated full findings export",
      schema: FullExportSchema,
      lifetime: "1h",
      garbageCollection: 5,
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

          const findings = (resp.Findings ?? []).map(mapFindingSummary);

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
            st: args.startTime,
            et: args.endTime,
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
          // Paginate — API may not return all matching findings in one page
          const allRawFindings: AwsSecurityFinding[] = [];
          let detailToken: string | undefined;
          for (let page = 0; page < 3; page++) {
            const resp = await client.send(
              new GetFindingsCommand({
                Filters: {
                  Id: args.findingArns.map((arn) => ({
                    Value: arn,
                    Comparison: "EQUALS" as const,
                  })),
                },
                MaxResults: 20,
                NextToken: detailToken,
              }),
            );
            allRawFindings.push(...(resp.Findings ?? []));
            detailToken = resp.NextToken;
            if (!detailToken) break;
          }

          const findings = allRawFindings.map((
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
        workflowStatus: z
          .string()
          .default("NEW")
          .describe(
            "Workflow status to include (NEW, NOTIFIED, SUPPRESSED, RESOLVED). Defaults to NEW.",
          ),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
      }),
      execute: async (
        args: {
          productName?: string;
          workflowStatus: string;
          startTime: string;
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
        context.logger.info("Generating severity summary", {
          productName: args.productName ?? "all",
          workflowStatus: args.workflowStatus,
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        try {
          const startIso = parseRelativeTime(args.startTime);
          const filters: Record<string, unknown[]> = {
            RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            WorkflowStatus: [
              { Value: args.workflowStatus, Comparison: "EQUALS" },
            ],
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
                informational: c.informational,
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
            w: args.workflowStatus,
            t: args.startTime,
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

    list_findings_by_type: {
      description:
        "List findings grouped by finding type with severity breakdown per group",
      arguments: z.object({
        productName: z
          .string()
          .optional()
          .describe("Filter by product (e.g. GuardDuty)"),
        severityLabel: z
          .string()
          .optional()
          .describe("Minimum severity to include"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(100)
          .describe("Maximum findings to fetch before grouping"),
      }),
      execute: async (
        args: {
          productName?: string;
          severityLabel?: string;
          startTime: string;
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
        context.logger.info("Listing findings by type", {
          productName: args.productName ?? "all",
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        try {
          const filters: Record<string, unknown[]> = {
            RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            WorkflowStatus: [{ Value: "NEW", Comparison: "EQUALS" }],
            UpdatedAt: [{
              Start: parseRelativeTime(args.startTime),
              End: new Date().toISOString(),
            }],
          };
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

          const resp = await client.send(
            new GetFindingsCommand({
              Filters: filters as AwsSecurityFindingFilters,
              MaxResults: args.limit,
              SortCriteria: [
                { Field: "SeverityNormalized", SortOrder: "desc" },
              ],
            }),
          );

          const findings = (resp.Findings ?? []).map(mapFindingSummary);
          const grouped: Record<
            string,
            {
              findings: typeof findings;
              severities: Record<string, number>;
              accounts: Set<string>;
            }
          > = {};

          for (const f of findings) {
            if (!grouped[f.type]) {
              grouped[f.type] = {
                findings: [],
                severities: {
                  critical: 0,
                  high: 0,
                  medium: 0,
                  low: 0,
                  informational: 0,
                },
                accounts: new Set(),
              };
            }
            grouped[f.type].findings.push(f);
            const sev = f.severity.toLowerCase();
            if (sev in grouped[f.type].severities) {
              grouped[f.type].severities[sev]++;
            }
            grouped[f.type].accounts.add(f.accountId);
          }

          const groups = Object.entries(grouped)
            .map(([type, g]) => ({
              type,
              count: g.findings.length,
              severities: {
                critical: g.severities.critical,
                high: g.severities.high,
                medium: g.severities.medium,
                low: g.severities.low,
                informational: g.severities.informational,
              },
              accounts: [...g.accounts],
              findings: g.findings,
            }))
            .sort((a, b) => b.count - a.count);

          const data = {
            groups,
            totalTypes: groups.length,
            totalFindings: findings.length,
            truncated: !!resp.NextToken,
            fetchedAt: new Date().toISOString(),
          };

          context.logger.info("Grouped {total} findings into {types} types", {
            total: findings.length,
            types: groups.length,
          });

          const suffix = hashInstanceName({
            p: args.productName,
            s: args.severityLabel,
            t: args.startTime,
          });
          const handle = await context.writeResource(
            "findings_by_type",
            suffix,
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    diff_findings: {
      description:
        "Compare current findings with the previous run to identify new and resolved findings",
      arguments: z.object({
        productName: z
          .string()
          .optional()
          .describe("Filter by product (e.g. GuardDuty)"),
        severityLabel: z
          .string()
          .optional()
          .describe("Filter by severity label"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(100)
          .describe("Maximum findings to fetch"),
      }),
      execute: async (
        args: {
          productName?: string;
          severityLabel?: string;
          startTime: string;
          limit: number;
        },
        context: {
          globalArgs: { region: string };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource?: (
            name: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Computing findings diff", {
          productName: args.productName ?? "all",
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        try {
          const filters: Record<string, unknown[]> = {
            RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            WorkflowStatus: [{ Value: "NEW", Comparison: "EQUALS" }],
            UpdatedAt: [{
              Start: parseRelativeTime(args.startTime),
              End: new Date().toISOString(),
            }],
          };
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

          const resp = await client.send(
            new GetFindingsCommand({
              Filters: filters as AwsSecurityFindingFilters,
              MaxResults: args.limit,
              SortCriteria: [
                { Field: "SeverityNormalized", SortOrder: "desc" },
              ],
            }),
          );

          const currentFindings = (resp.Findings ?? []).map(mapFindingSummary);
          const suffix = hashInstanceName({
            p: args.productName,
            s: args.severityLabel,
            t: args.startTime,
          });

          // Read previous diff output to get the full snapshot from last run
          type PrevSnapshot = Array<{ arn: string } & Record<string, unknown>>;
          let previousFindings: PrevSnapshot = [];
          let previousWasTruncated = false;
          if (context.readResource) {
            const prev = await context.readResource(suffix);
            if (prev && Array.isArray(prev.currentSnapshot)) {
              previousFindings = prev.currentSnapshot as PrevSnapshot;
              previousWasTruncated = !!(prev.truncated);
            }
          }

          const currentTruncated = !!resp.NextToken;
          const eitherTruncated = previousWasTruncated || currentTruncated;

          const currentArns = new Set(currentFindings.map((f) => f.arn));
          const previousArns = new Set(previousFindings.map((f) => f.arn));

          // Only compute diff when NEITHER snapshot was truncated.
          // When truncated, we can't distinguish "new/resolved" from
          // "fell off the page" — both directions produce false positives.
          let newFindings: typeof currentFindings = [];
          let resolvedFindings: typeof currentFindings = [];
          if (!eitherTruncated) {
            newFindings = currentFindings.filter(
              (f) => !previousArns.has(f.arn),
            );
            resolvedFindings = previousFindings.filter(
              (f) => !currentArns.has(f.arn),
            ) as typeof currentFindings;
          }

          const diffData = {
            newFindings,
            resolvedFindings,
            newCount: newFindings.length,
            resolvedCount: resolvedFindings.length,
            truncated: currentTruncated,
            currentSnapshot: currentFindings,
            fetchedAt: new Date().toISOString(),
          };

          context.logger.info(
            "Diff: {new} new, {resolved} resolved",
            { new: newFindings.length, resolved: resolvedFindings.length },
          );

          const handle = await context.writeResource(
            "diff_findings",
            suffix,
            diffData,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    resolve_accounts: {
      description:
        "Fetch AWS Organizations account list to map account IDs to friendly names",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
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
        context.logger.info("Fetching AWS Organizations account list", {});

        // AWS Organizations is a global service — must use us-east-1 regardless of model region
        const client = new OrganizationsClient({
          region: "us-east-1",
        });
        try {
          const accounts: Array<{
            id: string;
            name: string;
            email: string;
            status: string;
          }> = [];
          let nextToken: string | undefined;
          const maxPages = 10;

          for (let page = 0; page < maxPages; page++) {
            const resp = await client.send(
              new ListAccountsCommand({ NextToken: nextToken, MaxResults: 20 }),
            );
            for (const acct of resp.Accounts ?? []) {
              accounts.push({
                id: acct.Id ?? "",
                name: acct.Name ?? "",
                email: acct.Email ?? "",
                status: acct.Status ?? "",
              });
            }
            nextToken = resp.NextToken;
            if (!nextToken) break;
          }

          const data = {
            accounts,
            count: accounts.length,
            truncated: !!nextToken,
            fetchedAt: new Date().toISOString(),
          };

          context.logger.info("Resolved {count} accounts", {
            count: accounts.length,
          });

          const handle = await context.writeResource(
            "account_map",
            "org",
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_all_findings: {
      description:
        "Paginated full export of findings (up to 500). Fetches multiple pages internally.",
      arguments: z.object({
        productName: z
          .string()
          .optional()
          .describe("Filter by product (e.g. GuardDuty)"),
        severityLabel: z
          .string()
          .optional()
          .describe("Filter by severity label"),
        workflowStatus: z
          .string()
          .default("NEW")
          .describe("Workflow status filter"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 24h, 7d)"),
        maxPages: z
          .number()
          .min(1)
          .max(5)
          .default(5)
          .describe("Maximum pages to fetch (100 findings per page, max 500)"),
      }),
      execute: async (
        args: {
          productName?: string;
          severityLabel?: string;
          workflowStatus: string;
          startTime: string;
          maxPages: number;
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
        context.logger.info("Exporting all findings (paginated)", {
          productName: args.productName ?? "all",
          maxPages: args.maxPages,
          startTime: args.startTime,
        });

        const client = createClient(context.globalArgs.region);
        try {
          const filters: Record<string, unknown[]> = {
            RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            WorkflowStatus: [
              { Value: args.workflowStatus, Comparison: "EQUALS" },
            ],
            UpdatedAt: [{
              Start: parseRelativeTime(args.startTime),
              End: new Date().toISOString(),
            }],
          };
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

          const allFindings: ReturnType<typeof mapFindingSummary>[] = [];
          let nextToken: string | undefined;
          let totalPages = 0;

          for (let page = 0; page < args.maxPages; page++) {
            const resp = await client.send(
              new GetFindingsCommand({
                Filters: filters as AwsSecurityFindingFilters,
                MaxResults: 100,
                SortCriteria: [
                  { Field: "SeverityNormalized", SortOrder: "desc" },
                ],
                NextToken: nextToken,
              }),
            );
            allFindings.push(
              ...(resp.Findings ?? []).map(mapFindingSummary),
            );
            totalPages++;
            nextToken = resp.NextToken;
            if (!nextToken) break;
          }

          const data = {
            findings: allFindings,
            count: allFindings.length,
            totalPages,
            truncated: !!nextToken,
            filters: {
              productName: args.productName ?? null,
              severityLabel: args.severityLabel ?? null,
              workflowStatus: args.workflowStatus,
              startTime: args.startTime,
            },
            fetchedAt: new Date().toISOString(),
          };

          context.logger.info(
            "Exported {count} findings across {pages} pages",
            { count: allFindings.length, pages: totalPages },
          );

          const suffix = hashInstanceName({
            p: args.productName,
            s: args.severityLabel,
            w: args.workflowStatus,
            t: args.startTime,
          });
          const handle = await context.writeResource(
            "full_export",
            suffix,
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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

    // Retrieve the actual ProductArn for each finding (paginate if needed, max 20 pages)
    // GetFindings Id filter accepts at most 20 values — chunk accordingly
    const foundFindings: AwsSecurityFinding[] = [];
    const chunkSize = 20;
    for (let i = 0; i < findingArns.length; i += chunkSize) {
      const chunk = findingArns.slice(i, i + chunkSize);
      let lookupToken: string | undefined;
      const maxLookupPages = 5;
      for (let page = 0; page < maxLookupPages; page++) {
        const lookupResp = await client.send(
          new GetFindingsCommand({
            Filters: {
              Id: chunk.map((arn) => ({
                Value: arn,
                Comparison: "EQUALS" as const,
              })),
            },
            MaxResults: 20,
            NextToken: lookupToken,
          }),
        );
        foundFindings.push(...(lookupResp.Findings ?? []));
        lookupToken = lookupResp.NextToken;
        if (!lookupToken) break;
      }
    }
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

    const suffix = hashInstanceName({
      status,
      arns: [...findingArns].sort(),
      n: note,
    });
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
