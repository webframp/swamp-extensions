/**
 * AWS GuardDuty operations model for swamp.
 *
 * Provides methods to list and inspect GuardDuty findings from a
 * delegated administrator account, covering all member accounts
 * in an AWS Organization. Also lists member account enrollment status.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  type Condition,
  type Finding,
  GetFindingsCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand,
  ListMembersCommand,
  type Member,
} from "npm:@aws-sdk/client-guardduty@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for GuardDuty"),
});

const FindingSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.number(),
  title: z.string(),
  description: z.string(),
  accountId: z.string(),
  region: z.string(),
  resourceType: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const FindingListSchema = z.object({
  findings: z.array(FindingSummarySchema),
  count: z.number(),
  truncated: z.boolean(),
  filters: z.object({
    typePrefix: z.string().nullable(),
    severityMin: z.number().nullable(),
    accountId: z.string().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
  }),
  fetchedAt: z.string(),
});

const FindingDetailSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.number(),
  title: z.string(),
  description: z.string(),
  accountId: z.string(),
  region: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resource: z.record(z.string(), z.unknown()),
  service: z.record(z.string(), z.unknown()),
});

const FindingDetailsSchema = z.object({
  findings: z.array(FindingDetailSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const MemberSchema = z.object({
  accountId: z.string(),
  email: z.string(),
  relationshipStatus: z.string(),
  invitedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  detectorId: z.string().nullable(),
});

const MemberListSchema = z.object({
  members: z.array(MemberSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function parseRelativeTime(timeStr: string): Date {
  const now = new Date();
  const match = timeStr.match(/^(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case "m":
        return new Date(now.getTime() - value * 60 * 1000);
      case "h":
        return new Date(now.getTime() - value * 60 * 60 * 1000);
      case "d":
        return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
      default:
        throw new Error(`Unknown time unit: ${unit}`);
    }
  }
  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) return parsed;
  throw new Error(`Cannot parse time: ${timeStr}`);
}

async function getDetectorId(client: GuardDutyClient): Promise<string> {
  const resp = await client.send(new ListDetectorsCommand({}));
  const ids = resp.DetectorIds || [];
  if (ids.length === 0) {
    throw new Error("No GuardDuty detector found in this region/account");
  }
  return ids[0];
}

function mapFindingSummary(
  f: Finding,
): z.infer<typeof FindingSummarySchema> {
  return {
    id: f.Id || "",
    type: f.Type || "",
    severity: f.Severity ?? 0,
    title: f.Title || "",
    description: f.Description || "",
    accountId: f.AccountId || "",
    region: f.Region || "",
    resourceType: f.Resource?.ResourceType || null,
    createdAt: f.CreatedAt ? String(f.CreatedAt) : "",
    updatedAt: f.UpdatedAt ? String(f.UpdatedAt) : "",
  };
}

function mapFindingDetail(
  f: Finding,
): z.infer<typeof FindingDetailSchema> {
  return {
    id: f.Id || "",
    type: f.Type || "",
    severity: f.Severity ?? 0,
    title: f.Title || "",
    description: f.Description || "",
    accountId: f.AccountId || "",
    region: f.Region || "",
    createdAt: f.CreatedAt ? String(f.CreatedAt) : "",
    updatedAt: f.UpdatedAt ? String(f.UpdatedAt) : "",
    resource: (f.Resource as Record<string, unknown> | undefined) ?? {},
    service: (f.Service as Record<string, unknown> | undefined) ?? {},
  };
}

function mapMember(m: Member): z.infer<typeof MemberSchema> {
  return {
    accountId: m.AccountId || "",
    email: m.Email || "",
    relationshipStatus: m.RelationshipStatus || "",
    invitedAt: m.InvitedAt ? String(m.InvitedAt) : null,
    updatedAt: m.UpdatedAt ? String(m.UpdatedAt) : null,
    detectorId: m.DetectorId ?? null,
  };
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * GuardDuty extension model — list findings, get finding details,
 * and list member accounts from a delegated administrator.
 */
export const model = {
  type: "@webframp/aws/guardduty",
  version: "2026.04.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    finding_list: {
      description: "List of GuardDuty finding summaries",
      schema: FindingListSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    finding_details: {
      description: "Full GuardDuty finding details",
      schema: FindingDetailsSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    member_list: {
      description: "GuardDuty member account enrollment",
      schema: MemberListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_findings: {
      description:
        "List GuardDuty findings with optional filters for type, severity, time window, and account",
      arguments: z.object({
        typePrefix: z
          .string()
          .optional()
          .describe(
            "Filter by finding type prefix (e.g. UnauthorizedAccess, CredentialAccess, Recon)",
          ),
        severityMin: z
          .number()
          .optional()
          .describe("Minimum severity threshold (0-10)"),
        accountId: z
          .string()
          .optional()
          .describe("Filter to a specific member account ID"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 30m, 7d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        limit: z
          .number()
          .min(1)
          .max(500)
          .default(50)
          .describe("Maximum number of findings to return"),
      }),
      execute: async (
        args: {
          typePrefix?: string;
          severityMin?: number;
          accountId?: string;
          startTime: string;
          endTime?: string;
          limit: number;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new GuardDutyClient({
          region: context.globalArgs.region,
        });
        const detectorId = await getDetectorId(client);

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        // Build filter criteria
        const criterion: Record<string, Condition> = {
          updatedAt: {
            GreaterThanOrEqual: startTime.getTime(),
            LessThanOrEqual: endTime.getTime(),
          },
        };
        if (args.severityMin !== undefined) {
          criterion["severity"] = { GreaterThanOrEqual: args.severityMin };
        }
        if (args.accountId) {
          criterion["accountId"] = { Eq: [args.accountId] };
        }

        // List finding IDs — when using typePrefix, fetch more to compensate
        // for client-side filtering, but cap to avoid unbounded API calls
        const maxIds = args.typePrefix ? args.limit * 20 : args.limit;
        const allIds: string[] = [];
        let nextToken: string | undefined;
        do {
          const batchSize = Math.min(50, maxIds - allIds.length);
          if (batchSize <= 0) break;
          const resp = await client.send(
            new ListFindingsCommand({
              DetectorId: detectorId,
              FindingCriteria: { Criterion: criterion },
              MaxResults: batchSize,
              NextToken: nextToken,
            }),
          );
          if (resp.FindingIds) {
            allIds.push(...resp.FindingIds);
          }
          nextToken = resp.NextToken;
        } while (nextToken && allIds.length < maxIds);

        // Fetch details in batches of 50
        const findings: z.infer<typeof FindingSummarySchema>[] = [];
        for (let i = 0; i < allIds.length; i += 50) {
          const batch = allIds.slice(i, i + 50);
          const resp = await client.send(
            new GetFindingsCommand({
              DetectorId: detectorId,
              FindingIds: batch,
            }),
          );
          if (resp.Findings) {
            findings.push(...resp.Findings.map(mapFindingSummary));
          }
        }

        // Apply client-side prefix filter and enforce limit
        const matched = args.typePrefix
          ? findings.filter((f) => f.type.startsWith(args.typePrefix!))
          : findings;
        const filtered = matched.slice(0, args.limit);

        const instanceParts = [
          args.typePrefix ?? "_all",
          args.severityMin !== undefined ? `sev${args.severityMin}` : null,
          args.accountId || null,
        ].filter(Boolean);
        const instanceName = instanceParts.join("-").replace(
          /[^a-zA-Z0-9_-]/g,
          "-",
        );

        const handle = await context.writeResource(
          "finding_list",
          instanceName,
          {
            findings: filtered,
            count: filtered.length,
            truncated: nextToken !== undefined || matched.length > args.limit,
            filters: {
              typePrefix: args.typePrefix || null,
              severityMin: args.severityMin ?? null,
              accountId: args.accountId || null,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} findings", {
          count: filtered.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_finding_details: {
      description:
        "Get full details for specific findings by ID, including resource and service action data",
      arguments: z.object({
        findingIds: z
          .array(z.string())
          .min(1, "at least one finding ID required")
          .max(50)
          .describe("Finding IDs to retrieve (max 50)"),
      }),
      execute: async (
        args: { findingIds: string[] },
        context: {
          globalArgs: { region: string };
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
        const client = new GuardDutyClient({
          region: context.globalArgs.region,
        });
        const detectorId = await getDetectorId(client);

        const ids = args.findingIds.slice(0, 50);

        // Build a stable, collision-resistant instance name
        const instanceSuffix = ids.length === 1 ? ids[0] : Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-1",
              new TextEncoder().encode(ids.slice().sort().join(",")),
            ),
          ),
        ).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

        const resp = await client.send(
          new GetFindingsCommand({
            DetectorId: detectorId,
            FindingIds: ids,
          }),
        );

        const findings = (resp.Findings || []).map(mapFindingDetail);

        const handle = await context.writeResource(
          "finding_details",
          `details-${instanceSuffix}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
          {
            findings,
            count: findings.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Retrieved {count} finding details", {
          count: findings.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_members: {
      description: "List GuardDuty member accounts and their enrollment status",
      arguments: z.object({
        onlyAssociated: z
          .boolean()
          .default(true)
          .describe("Only return associated (active) members"),
        limit: z
          .number()
          .min(1)
          .max(1000)
          .default(500)
          .describe("Maximum number of members to return"),
      }),
      execute: async (
        args: { onlyAssociated: boolean; limit: number },
        context: {
          globalArgs: { region: string };
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
        const client = new GuardDutyClient({
          region: context.globalArgs.region,
        });
        const detectorId = await getDetectorId(client);

        const members: z.infer<typeof MemberSchema>[] = [];
        let nextToken: string | undefined;
        do {
          const resp = await client.send(
            new ListMembersCommand({
              DetectorId: detectorId,
              OnlyAssociated: args.onlyAssociated ? "true" : "false",
              MaxResults: Math.min(50, args.limit - members.length),
              NextToken: nextToken,
            }),
          );
          if (resp.Members) {
            members.push(...resp.Members.map(mapMember));
          }
          nextToken = resp.NextToken;
        } while (nextToken && members.length < args.limit);

        const truncated = nextToken !== undefined ||
          members.length > args.limit;
        const result = members.slice(0, args.limit);

        const handle = await context.writeResource("member_list", "members", {
          members: result,
          count: result.length,
          truncated,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} member accounts", {
          count: members.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
