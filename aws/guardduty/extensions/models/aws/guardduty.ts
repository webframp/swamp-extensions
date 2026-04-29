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
    }
  }
  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) return parsed;
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
    createdAt: f.CreatedAt || "",
    updatedAt: f.UpdatedAt || "",
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
    createdAt: f.CreatedAt || "",
    updatedAt: f.UpdatedAt || "",
    resource: f.Resource as Record<string, unknown> || {},
    service: f.Service as Record<string, unknown> || {},
  };
}

function mapMember(m: Member): z.infer<typeof MemberSchema> {
  return {
    accountId: m.AccountId || "",
    email: m.Email || "",
    relationshipStatus: m.RelationshipStatus || "",
    invitedAt: m.InvitedAt || null,
    updatedAt: m.UpdatedAt || null,
    detectorId: m.DetectorId || null,
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
        if (args.typePrefix) {
          criterion["type"] = { Eq: [args.typePrefix] };
        }
        if (args.severityMin !== undefined) {
          criterion["severity"] = { GreaterThanOrEqual: args.severityMin };
        }
        if (args.accountId) {
          criterion["accountId"] = { Eq: [args.accountId] };
        }

        // List finding IDs
        const allIds: string[] = [];
        let nextToken: string | undefined;
        do {
          const resp = await client.send(
            new ListFindingsCommand({
              DetectorId: detectorId,
              FindingCriteria: { Criterion: criterion },
              MaxResults: Math.min(50, args.limit - allIds.length),
              NextToken: nextToken,
            }),
          );
          if (resp.FindingIds) {
            allIds.push(...resp.FindingIds);
          }
          nextToken = resp.NextToken;
        } while (nextToken && allIds.length < args.limit);

        const ids = allIds.slice(0, args.limit);

        // Fetch summaries in batches of 50
        const findings: z.infer<typeof FindingSummarySchema>[] = [];
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
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

        const instanceParts = [
          args.typePrefix || "all",
          args.severityMin !== undefined ? `sev${args.severityMin}` : null,
          args.accountId || null,
        ].filter(Boolean);
        const instanceName = instanceParts.join("-").replace(/[\/\s:]/g, "-");

        const handle = await context.writeResource(
          "finding_list",
          instanceName,
          {
            findings,
            count: findings.length,
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
          count: findings.length,
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
        const resp = await client.send(
          new GetFindingsCommand({
            DetectorId: detectorId,
            FindingIds: ids,
          }),
        );

        const findings = (resp.Findings || []).map(mapFindingDetail);

        const handle = await context.writeResource(
          "finding_details",
          `details-${Date.now()}`,
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
      }),
      execute: async (
        args: { onlyAssociated: boolean },
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
              MaxResults: 50,
              NextToken: nextToken,
            }),
          );
          if (resp.Members) {
            members.push(...resp.Members.map(mapMember));
          }
          nextToken = resp.NextToken;
        } while (nextToken);

        const handle = await context.writeResource("member_list", "members", {
          members,
          count: members.length,
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
