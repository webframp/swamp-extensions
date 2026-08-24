/**
 * AWS Support case management model.
 *
 * Query, create, and manage AWS Support cases across accounts. Fan-out
 * across profiles for fleet-wide case inventory.
 *
 * AWS Support API requires Business or Enterprise support plan and is
 * only available in us-east-1 (global endpoint).
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  AddCommunicationToCaseCommand,
  CreateCaseCommand,
  DescribeCasesCommand,
  DescribeCommunicationsCommand,
  ResolveCaseCommand,
  SupportClient,
} from "npm:@aws-sdk/client-support@3.1114.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1114.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1114.0";

const EXTENSION_NAME = "@webframp/aws/support";

// =============================================================================
// Schemas
// =============================================================================

const MAX_PAGES = 20;

const GlobalArgsSchema = z.object({
  profiles: z
    .array(z.string())
    .min(1)
    .describe("AWS CLI profile names (one per account)"),
});

const CommunicationSchema = z.object({
  body: z.string(),
  submittedBy: z.string(),
  timeCreated: z.string(),
});

const CaseDetailSchema = z.object({
  caseId: z.string(),
  displayId: z.string(),
  subject: z.string(),
  status: z.string(),
  severityCode: z.string(),
  serviceCode: z.string(),
  categoryCode: z.string(),
  submittedBy: z.string(),
  timeCreated: z.string(),
  ccEmailAddresses: z.array(z.string()),
  language: z.string(),
});

const CaseResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  case: CaseDetailSchema,
  communications: z.array(CommunicationSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const CaseListResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  status: z.string(),
  cases: z.array(CaseDetailSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const CreateCaseResultSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  caseId: z.string(),
  subject: z.string(),
  serviceCode: z.string(),
  categoryCode: z.string(),
  severityCode: z.string(),
  createdAt: z.string(),
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

const CommunicationResultSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  caseId: z.string(),
  success: z.boolean(),
  addedAt: z.string(),
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

const ResolveResultSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  caseId: z.string(),
  initialStatus: z.string(),
  finalStatus: z.string(),
  resolvedAt: z.string(),
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

const FailedProfileSchema = z.object({
  profile: z.string(),
  error: z.string(),
});

const ScanAccountsResourceSchema = z.object({
  status: z.string(),
  entries: z.array(
    z.object({
      profile: z.string(),
      accountId: z.string(),
      case: CaseDetailSchema,
    }),
  ),
  profilesChecked: z.number(),
  truncated: z.boolean(),
  failedProfiles: z.array(FailedProfileSchema),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Helpers
// =============================================================================

function createSupportClient(profile: string): SupportClient {
  const opts: Record<string, unknown> = { region: "us-east-1" };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new SupportClient(opts as { region: string });
}

function createStsClient(profile: string): STSClient {
  const opts: Record<string, unknown> = { region: "us-east-1" };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new STSClient(opts as { region: string });
}

function sanitizeName(s: string): string {
  return s.replace(/[/\\]/g, "-");
}

/**
 * Redact identifiers from error messages before persistence. Strips ARNs,
 * account IDs, URLs, hostnames, and IP addresses. Collapses SSO login
 * failures to a short actionable code.
 */
function redactError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e))
    // deno-lint-ignore no-control-regex
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[()][@-~])/g, "");
  if (
    /sso login|please login|Identity Center token|sso[^\n]*expired|identity[\s-]*center[^\n]*expired/i
      .test(msg)
  ) {
    return "sso-login-required";
  }
  return msg
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/arn:aws[^\s"']*/gi, "arn:***")
    .replace(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, "<host>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b\d{4}-\d{4}-\d{4}\b/g, "***")
    .replace(/\b\d{12}\b/g, "***")
    .trim();
}

/**
 * Wrap an error from an external AWS Support/STS API call with the
 * operation and relevant identifiers, preserving the original error via
 * `cause`.
 */
function wrapApiError(
  operation: string,
  detail: Record<string, unknown>,
  err: unknown,
): never {
  const detailStr = Object.entries(detail)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${operation} failed (${detailStr}): ${message}`, {
    cause: err,
  });
}

async function getAccountId(profile: string): Promise<string> {
  const sts = createStsClient(profile);
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    return resp.Account ?? "unknown";
  } catch (err) {
    return wrapApiError("GetCallerIdentity", { profile }, err);
  } finally {
    sts.destroy();
  }
}

function toCaseDetail(
  // deno-lint-ignore no-explicit-any
  c: any,
): z.infer<typeof CaseDetailSchema> {
  return {
    caseId: c.caseId ?? "",
    displayId: c.displayId ?? "",
    subject: c.subject ?? "",
    status: c.status ?? "",
    severityCode: c.severityCode ?? "",
    serviceCode: c.serviceCode ?? "",
    categoryCode: c.categoryCode ?? "",
    submittedBy: c.submittedBy ?? "",
    timeCreated: c.timeCreated ?? "",
    ccEmailAddresses: c.ccEmailAddresses ?? [],
    language: c.language ?? "en",
  };
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

/** AWS Support case management model. */
export const model = {
  type: "@webframp/aws/support",
  version: "2026.08.24.3",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.08.05.1",
      description: "Initial release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.20.1",
      description: "Dependency bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "Wrap Support/STS API errors with operation context, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    caseDetail: {
      description:
        "Full case details with communications for a single support case",
      schema: CaseResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    caseList: {
      description: "List of support cases for a single account",
      schema: CaseListResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    createResult: {
      description: "Record of a newly created support case",
      schema: CreateCaseResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    communicationResult: {
      description: "Record of a communication added to a case",
      schema: CommunicationResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    resolveResult: {
      description: "Record of a resolved support case",
      schema: ResolveResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    scanResult: {
      description: "Fleet-wide scan of support cases across accounts",
      schema: ScanAccountsResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_cases: {
      description:
        "List support cases for an account. Filters by status (default: " +
        "open cases only). Includes resolved cases when includeResolved is set.",
      arguments: z.object({
        profile: z
          .string()
          .optional()
          .describe("Profile to query (default: first configured)"),
        includeResolved: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include resolved/closed cases (default: open only)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(100)
          .describe("Maximum cases to return (1-100, default: 100)"),
      }),
      execute: async (
        args: {
          profile?: string;
          includeResolved?: boolean;
          limit?: number;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const includeResolved = args.includeResolved ?? false;
        const limit = args.limit ?? 100;
        const client = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile);
          const cases: z.infer<typeof CaseDetailSchema>[] = [];

          let nextToken: string | undefined;
          let pages = 0;
          do {
            let resp;
            try {
              resp = await client.send(
                new DescribeCasesCommand({
                  includeResolvedCases: includeResolved,
                  includeCommunications: false,
                  maxResults: Math.min(limit - cases.length, 100),
                  nextToken,
                }),
              );
            } catch (err) {
              return wrapApiError("DescribeCases (list_cases)", {
                profile,
                includeResolved,
                page: pages,
              }, err);
            }

            for (const c of resp.cases ?? []) {
              if (cases.length >= limit) break;
              cases.push(toCaseDetail(c));
            }

            nextToken = resp.nextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES && cases.length < limit);

          const truncated = !!nextToken;
          const status = includeResolved ? "all" : "open";
          const handle = await ctx.writeResource(
            "caseList",
            `cases-${status}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              status,
              cases,
              truncated,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Listed {count} {status} cases in {account}",
            { count: cases.length, status, account: accountId },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_case: {
      description: "Get full details for a single support case including all " +
        "communications. Use the display ID (numeric) shown in the AWS console.",
      arguments: z.object({
        displayId: z
          .string()
          .min(1)
          .describe(
            "Support case display ID (numeric, e.g. '178317700500245')",
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
        const startMs = Date.now();
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const client = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile);

          // Fetch the case metadata
          let casesResp;
          try {
            casesResp = await client.send(
              new DescribeCasesCommand({
                displayId: args.displayId,
                includeCommunications: false,
                includeResolvedCases: true,
              }),
            );
          } catch (err) {
            return wrapApiError("DescribeCases (get_case)", {
              displayId: args.displayId,
              profile,
            }, err);
          }

          const caseDetail = casesResp.cases?.[0];
          if (!caseDetail) {
            throw new Error(
              `No support case found with display ID: ${args.displayId}`,
            );
          }

          const internalCaseId = caseDetail.caseId;
          if (!internalCaseId) {
            throw new Error(
              `Support case ${args.displayId} has no internal case ID`,
            );
          }

          // Fetch all communications
          const communications: z.infer<typeof CommunicationSchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;
          let truncated = false;

          do {
            let commsResp;
            try {
              commsResp = await client.send(
                new DescribeCommunicationsCommand({
                  caseId: internalCaseId,
                  nextToken,
                }),
              );
            } catch (err) {
              return wrapApiError("DescribeCommunications (get_case)", {
                caseId: internalCaseId,
                displayId: args.displayId,
                profile,
                page: pages,
              }, err);
            }

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
            "caseDetail",
            `case-${args.displayId}-${sanitizeName(profile)}`,
            {
              profile,
              accountId,
              case: toCaseDetail(caseDetail),
              communications,
              truncated,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Case {displayId} ({status}): {count} communications",
            {
              displayId: args.displayId,
              status: caseDetail.status ?? "unknown",
              count: communications.length,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    create_case: {
      description:
        "Create a new AWS Support case. MUTATING: opens a support case. " +
        "Requires support:CreateCase permission and Business/Enterprise plan. " +
        "Use list_services and list_severity_levels to discover valid codes.",
      arguments: z.object({
        subject: z
          .string()
          .min(1)
          .describe("Case subject line"),
        body: z
          .string()
          .min(1)
          .describe("Initial communication body text"),
        serviceCode: z
          .string()
          .min(1)
          .describe(
            "Service code (use DescribeServices to discover, e.g. 'amazon-elastic-compute-cloud-linux')",
          ),
        categoryCode: z
          .string()
          .min(1)
          .describe(
            "Category code within the service (e.g. 'general-guidance')",
          ),
        severityCode: z
          .string()
          .default("normal")
          .describe(
            "Severity: low, normal, high, urgent, critical (plan-dependent)",
          ),
        ccEmailAddresses: z
          .array(z.string())
          .optional()
          .describe("CC email addresses for case notifications"),
        profile: z
          .string()
          .optional()
          .describe("Profile to create case in (default: first configured)"),
      }),
      execute: async (
        args: {
          subject: string;
          body: string;
          serviceCode: string;
          categoryCode: string;
          severityCode?: string;
          ccEmailAddresses?: string[];
          profile?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const severityCode = args.severityCode ?? "normal";
        const client = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile);

          let resp;
          try {
            resp = await client.send(
              new CreateCaseCommand({
                subject: args.subject,
                communicationBody: args.body,
                serviceCode: args.serviceCode,
                categoryCode: args.categoryCode,
                severityCode,
                ccEmailAddresses: args.ccEmailAddresses,
                language: "en",
                issueType: "technical",
              }),
            );
          } catch (err) {
            return wrapApiError("CreateCase", {
              subject: args.subject,
              serviceCode: args.serviceCode,
              categoryCode: args.categoryCode,
              profile,
            }, err);
          }

          const caseId = resp.caseId;
          if (!caseId) {
            throw new Error("CreateCase returned no case ID");
          }

          const handle = await ctx.writeResource(
            "createResult",
            `created-${sanitizeName(caseId)}`,
            {
              profile,
              accountId,
              caseId,
              subject: args.subject,
              serviceCode: args.serviceCode,
              categoryCode: args.categoryCode,
              severityCode,
              createdAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Created case {caseId} in {account}: {subject}",
            { caseId, account: accountId, subject: args.subject },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    add_communication: {
      description:
        "Add a reply to an existing support case. MUTATING: adds communication. " +
        "Use the internal case ID (starts with 'case-') not the display ID.",
      arguments: z.object({
        caseId: z
          .string()
          .min(1)
          .describe("Internal case ID (e.g. 'case-123456-...')"),
        body: z
          .string()
          .min(1)
          .describe("Communication body text"),
        ccEmailAddresses: z
          .array(z.string())
          .optional()
          .describe("CC email addresses for this communication"),
        profile: z
          .string()
          .optional()
          .describe("Profile to use (default: first configured)"),
      }),
      execute: async (
        args: {
          caseId: string;
          body: string;
          ccEmailAddresses?: string[];
          profile?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const client = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile);

          let resp;
          try {
            resp = await client.send(
              new AddCommunicationToCaseCommand({
                caseId: args.caseId,
                communicationBody: args.body,
                ccEmailAddresses: args.ccEmailAddresses,
              }),
            );
          } catch (err) {
            return wrapApiError("AddCommunicationToCase", {
              caseId: args.caseId,
              profile,
            }, err);
          }

          const success = resp.result ?? false;
          const handle = await ctx.writeResource(
            "communicationResult",
            `comm-${sanitizeName(args.caseId)}-latest`,
            {
              profile,
              accountId,
              caseId: args.caseId,
              success,
              addedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Added communication to case {caseId}: {result}",
            { caseId: args.caseId, result: success ? "success" : "failed" },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    resolve_case: {
      description:
        "Resolve (close) an existing support case. MUTATING: changes case " +
        "status to resolved. Use the internal case ID.",
      arguments: z.object({
        caseId: z
          .string()
          .min(1)
          .describe("Internal case ID (e.g. 'case-123456-...')"),
        profile: z
          .string()
          .optional()
          .describe("Profile to use (default: first configured)"),
      }),
      execute: async (
        args: {
          caseId: string;
          profile?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const profile = args.profile ?? ctx.globalArgs.profiles[0];
        const client = createSupportClient(profile);
        try {
          const accountId = await getAccountId(profile);

          let resp;
          try {
            resp = await client.send(
              new ResolveCaseCommand({
                caseId: args.caseId,
              }),
            );
          } catch (err) {
            return wrapApiError(
              "ResolveCase",
              { caseId: args.caseId, profile },
              err,
            );
          }

          const handle = await ctx.writeResource(
            "resolveResult",
            `resolved-${sanitizeName(args.caseId)}`,
            {
              profile,
              accountId,
              caseId: args.caseId,
              initialStatus: resp.initialCaseStatus ?? "unknown",
              finalStatus: resp.finalCaseStatus ?? "resolved",
              resolvedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
              fetchedAt: new Date().toISOString(),
            } as unknown as Record<string, unknown>,
          );

          ctx.logger.info(
            "Resolved case {caseId}: {initial} -> {final}",
            {
              caseId: args.caseId,
              initial: resp.initialCaseStatus ?? "unknown",
              final: resp.finalCaseStatus ?? "resolved",
            },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    scan_accounts: {
      description:
        "Fan-out across all configured profiles to build a fleet-wide view " +
        "of support cases. Lists open cases by default. A single unreachable " +
        "account does not fail the entire scan.",
      arguments: z.object({
        includeResolved: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include resolved/closed cases (default: open only)"),
        profiles: z
          .array(z.string())
          .optional()
          .describe("Override: scan only these profiles"),
      }),
      execute: async (
        args: {
          includeResolved?: boolean;
          profiles?: string[];
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const includeResolved = args.includeResolved ?? false;
        const entries: Array<{
          profile: string;
          accountId: string;
          case: z.infer<typeof CaseDetailSchema>;
        }> = [];
        let anyTruncated = false;
        const failedProfiles: z.infer<typeof FailedProfileSchema>[] = [];

        for (const profile of profiles) {
          const client = createSupportClient(profile);
          try {
            const accountId = await getAccountId(profile);

            let nextToken: string | undefined;
            let pages = 0;
            do {
              const resp = await client.send(
                new DescribeCasesCommand({
                  includeResolvedCases: includeResolved,
                  includeCommunications: false,
                  maxResults: 100,
                  nextToken,
                }),
              );

              for (const c of resp.cases ?? []) {
                entries.push({
                  profile,
                  accountId,
                  case: toCaseDetail(c),
                });
              }

              nextToken = resp.nextToken;
              pages++;
            } while (nextToken && pages < MAX_PAGES);

            if (nextToken) anyTruncated = true;

            ctx.logger.info(
              "Scanned {account}: {count} cases",
              {
                account: accountId,
                count: entries.filter((e) => e.profile === profile).length,
              },
            );
          } catch (e) {
            const error = redactError(e);
            failedProfiles.push({ profile, error });
            ctx.logger.info(
              "Skipped profile {profile} in scan: {error}",
              { profile, error },
            );
          } finally {
            client.destroy();
          }
        }

        const status = includeResolved ? "all" : "open";
        const handle = await ctx.writeResource(
          "scanResult",
          `scan-${status}`,
          {
            status,
            entries,
            profilesChecked: profiles.length,
            truncated: anyTruncated,
            failedProfiles,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          } as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Fleet scan complete: {total} cases across {accounts} accounts ({failed} failed)",
          {
            total: entries.length,
            accounts: profiles.length - failedProfiles.length,
            failed: failedProfiles.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
