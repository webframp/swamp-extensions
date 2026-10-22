/**
 * PHP2Shell exposure-hunting model for swamp.
 *
 * Head-hunts indicators of compromise and exposure for the PHP2Shell remote
 * code execution vulnerabilities CVE-2026-109618 and CVE-2026-109619 across
 * AWS services, without any SSH or in-guest access. It observes the signals
 * AWS already collects:
 *
 *   - Amazon Inspector v2 findings for the two CVEs (vulnerable PHP inventory)
 *   - GuardDuty findings correlated against the published IOC IPs and against
 *     web-server backdoor / RCE / anomalous-behavior finding types
 *   - CloudWatch Logs Insights over VPC flow logs (IOC IP contact) and over
 *     WAF / ALB / application logs (the PHP_SESSION_UPLOAD_PROGRESS upload
 *     signal)
 *   - Security Hub (opportunistic): when a central aggregator is present, a
 *     single query covers GuardDuty + Inspector findings org-wide
 *
 * Scope spans a single account, a named set of accounts, or every active
 * account in an AWS Organization resolved from a delegated-administrator
 * account. Every method fans out across a configurable region list internally
 * (factory pattern — one behavior instance, one lock).
 *
 * The hunt is deliberately honest about what it could NOT inspect. A clean
 * result is reported as `no_signal` only for lanes that actually ran; any lane
 * that could not run (service disabled, no log groups supplied, missing
 * permissions) is recorded in `lanesSkipped` with a reason, and an account
 * with no runnable lane is `inconclusive`, never `no_signal`.
 *
 * This differs from @swamp/cve/php-rce-2026-10, which scans hosts directly over
 * SSH / Docker and can patch them. This model never touches a host; it reads
 * AWS-side telemetry only and is strictly read-only.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  Inspector2Client,
  ListFindingsCommand as ListInspectorFindingsCommand,
} from "npm:@aws-sdk/client-inspector2@3.1139.0";
import {
  type Condition,
  type Finding as GuardDutyFinding,
  GetFindingsCommand as GetGuardDutyFindingsCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand as ListGuardDutyFindingsCommand,
} from "npm:@aws-sdk/client-guardduty@3.1139.0";
import {
  type AwsSecurityFinding,
  GetFindingsCommand as GetSecurityHubFindingsCommand,
  SecurityHubClient,
} from "npm:@aws-sdk/client-securityhub@3.1139.0";
import {
  DescribeLogGroupsCommand,
  GetQueryResultsCommand,
  type QueryStatus,
  type ResultField,
  StartQueryCommand,
} from "npm:@aws-sdk/client-cloudwatch-logs@3.1139.0";
import { CloudWatchLogsClient } from "npm:@aws-sdk/client-cloudwatch-logs@3.1139.0";
import {
  ListAccountsCommand,
  OrganizationsClient,
} from "npm:@aws-sdk/client-organizations@3.1139.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1139.0";

const EXTENSION_NAME = "@webframp/aws/php2shell-hunt";

// =============================================================================
// IoC dataset — the data is the point. Stored as queryable state, overridable.
// =============================================================================

/**
 * Published indicators for the PHP2Shell RCE vulnerabilities, drawn from the
 * AWS Security Blog disclosure (MadPot telemetry, 2026-10-21) and the CERT-EU
 * 2026-018 advisory. The IP list is shared anonymization infrastructure, not
 * exclusive to this activity — observe, do not block.
 */
export const PHP2SHELL_IOCS = {
  cves: ["CVE-2026-109618", "CVE-2026-109619"] as const,
  advisory: "CERT-EU 2026-018; GHSA-w8hw-w9fx-j79w; GHSA-6wmf-4rv5-p3rp",
  /**
   * IP addresses observed targeting MadPot honeypots. 103.216.220.92 was seen
   * on 2026-10-17, four days before public disclosure; the rest on 2026-10-21.
   */
  ipIndicators: [
    "103.216.220.92",
    "31.223.184.166",
    "37.19.200.5",
    "134.209.159.64",
    "103.114.163.188",
    "95.217.98.37",
  ] as const,
  /** POST-body marker for the multi-part upload exploitation path. */
  payloadStrings: ["PHP_SESSION_UPLOAD_PROGRESS"] as const,
  /**
   * Earliest known exploitation. The blog is explicit: investigate from this
   * date, not from the 2026-10-21 public disclosure.
   */
  earliestKnownExploitation: "2026-10-17T00:00:00Z",
  /** First fixed PHP patch release per minor line. */
  fixedVersions: {
    "8.2": "8.2.35",
    "8.3": "8.3.36",
    "8.4": "8.4.27",
    "8.5": "8.5.12",
  } as const,
  /** PHP 8.1 and older receive no upstream fix. */
  unsupportedBelow: "8.2",
} as const;

/** GuardDuty finding-type fragments that plausibly indicate web RCE / backdoor. */
const GUARDDUTY_RCE_HINTS = [
  "Backdoor",
  "Trojan",
  "CryptoCurrency",
  "UnauthorizedAccess",
  "Execution",
  "Impact",
  "Discovery:",
  "Web",
] as const;

// =============================================================================
// Global args + client config
// =============================================================================

const DEFAULT_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
];

const GlobalArgsSchema = z.object({
  regions: z
    .array(z.string().min(1))
    .default(DEFAULT_REGIONS)
    .describe(
      "AWS regions to hunt across. Defaults to the four US commercial " +
        "regions. Set explicitly to cover others (e.g. eu-west-1).",
    ),
  scope: z
    .enum(["self", "accounts", "organization"])
    .default("self")
    .describe(
      "self: only the credentialed account. accounts: the account IDs in " +
        "accountIds. organization: every active account resolved from AWS " +
        "Organizations (requires a delegated-admin / management account).",
    ),
  accountIds: z
    .array(z.string().regex(/^\d{12}$/))
    .default([])
    .describe(
      "Explicit 12-digit account IDs. Required when scope=accounts; used as " +
        "an allow-list filter when scope=organization.",
    ),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AWS shared-config profile to resolve credentials from (fromIni / SSO " +
        "token cache). Omit to use the default credential chain. Point at the " +
        "delegated-admin account for organization scope.",
    ),
  jevBehavior: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional name of a pre-created @swamp/typesafe-ai (jev) behavior whose " +
        "apiKey resolves from a vault. When set, hunt asks jev to calibrate " +
        "the fuzzy GuardDuty and log signals. Create it once: " +
        "`swamp behavior create @swamp/typesafe-ai <name> --global-arg " +
        '\'apiKey=${{ vault.get("typesafe", "TYPESAFE_API_KEY") }}\'`. ' +
        "When omitted, the hunt runs unchanged with no enrichment.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Build per-region AWS client config, honoring an optional shared-config profile. */
function makeClientConfig(
  region: string,
  profile?: string,
): { region: string; credentials?: ReturnType<typeof fromIni> } {
  return {
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  };
}

// =============================================================================
// Shared helpers
// =============================================================================

/** Parse an ISO timestamp or a relative window (30m, 24h, 7d) into a Date. */
export function parseTime(timeStr: string): Date {
  const now = new Date();
  const match = timeStr.toLowerCase().match(/^(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "m":
        return new Date(now.getTime() - value * 60_000);
      case "h":
        return new Date(now.getTime() - value * 3_600_000);
      case "d":
        return new Date(now.getTime() - value * 86_400_000);
    }
  }
  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) return parsed;
  throw new Error(`Cannot parse time: ${timeStr}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a CloudWatch log group by name into the signal class it likely
 * serves for this hunt, with a relevance rank (higher = more likely useful).
 * Pure and name-based — a heuristic to rank discovery candidates for a human
 * to confirm, never an authoritative statement about a group's contents.
 */
export function classifyLogGroup(
  name: string,
): { classification: string; relevance: number } {
  const n = name.toLowerCase();
  // VPC flow logs — carry the srcAddr/dstAddr fields the IOC-IP lane needs.
  if (/flow.?log|vpc.?flow|\/vpc\/|flowlogs/.test(n)) {
    return { classification: "flow_log", relevance: 90 };
  }
  // WAF logs — most direct place to see the PHP_SESSION_UPLOAD_PROGRESS marker.
  if (/waf|wafv2|aws-waf/.test(n)) {
    return { classification: "waf_log", relevance: 85 };
  }
  // ALB/ELB access logs — request lines with the upload marker.
  if (/alb|elb|loadbalanc|load-balanc|application-?lb/.test(n)) {
    return { classification: "alb_log", relevance: 70 };
  }
  // Web/app server logs — PHP-serving SAPIs likely to log request bodies.
  if (/php|apache|httpd|nginx|fpm|caddy|frankenphp|litespeed/.test(n)) {
    return { classification: "app_log", relevance: 60 };
  }
  // Generic access/request logs — possible, lower confidence.
  if (/access|request|ingress|http/.test(n)) {
    return { classification: "possible_access_log", relevance: 30 };
  }
  return { classification: "other", relevance: 0 };
}

/** A signal lane that was requested but could not run, with a human reason. */
const SkippedLaneSchema = z.object({
  lane: z.string(),
  region: z.string().nullable(),
  accountId: z.string().nullable(),
  reason: z.string(),
});

type SkippedLane = z.infer<typeof SkippedLaneSchema>;

// =============================================================================
// Resource schemas
// =============================================================================

const IocSetSchema = z.object({
  cves: z.array(z.string()),
  advisory: z.string(),
  ipIndicators: z.array(z.string()),
  payloadStrings: z.array(z.string()),
  earliestKnownExploitation: z.string(),
  fixedVersions: z.record(z.string(), z.string()),
  unsupportedBelow: z.string(),
  fetchedAt: z.string(),
  collectedBy: z.string(),
});

const InspectorHitSchema = z.object({
  findingArn: z.string(),
  cve: z.string(),
  accountId: z.string(),
  region: z.string(),
  severity: z.string(),
  title: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  fixAvailable: z.string().nullable(),
  firstObservedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const InspectorScanSchema = z.object({
  hits: z.array(InspectorHitSchema),
  count: z.number(),
  truncated: z.boolean().describe(
    "True if the per-region page cap was hit before exhausting findings",
  ),
  regionsScanned: z.array(z.string()),
  skipped: z.array(SkippedLaneSchema),
  cves: z.array(z.string()),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const GuardDutySignalSchema = z.object({
  findingId: z.string(),
  type: z.string(),
  severity: z.number(),
  title: z.string(),
  accountId: z.string(),
  region: z.string(),
  matchedIocIps: z.array(z.string()),
  rceHint: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const GuardDutyScanSchema = z.object({
  signals: z.array(GuardDutySignalSchema),
  count: z.number(),
  iocIpMatches: z.number(),
  rceHintMatches: z.number(),
  truncated: z.boolean().describe(
    "True if the per-region page cap was hit before exhausting findings",
  ),
  regionsScanned: z.array(z.string()),
  skipped: z.array(SkippedLaneSchema),
  since: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const LogSignalSchema = z.object({
  kind: z.enum(["ioc_ip_contact", "upload_marker"]),
  region: z.string(),
  logGroup: z.string(),
  matchCount: z.number(),
  sample: z.array(z.record(z.string(), z.string())),
});

const LogScanSchema = z.object({
  signals: z.array(LogSignalSchema),
  iocIpContactCount: z.number(),
  uploadMarkerCount: z.number(),
  regionsScanned: z.array(z.string()),
  logGroupsQueried: z.array(z.string()),
  skipped: z.array(SkippedLaneSchema),
  since: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const LogGroupCandidateSchema = z.object({
  name: z.string(),
  region: z.string(),
  classification: z.string(),
  relevance: z.number(),
  storedBytes: z.number().nullable(),
  creationTime: z.string().nullable(),
});

const LogGroupCandidatesSchema = z.object({
  candidates: z.array(LogGroupCandidateSchema),
  count: z.number(),
  recommended: z.array(z.string()).describe(
    "Log group names ranked relevance >= 60 (flow/waf/alb/app) — the suggested " +
      "set to pass as logGroupNames",
  ),
  regionsScanned: z.array(z.string()),
  skipped: z.array(SkippedLaneSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const SecurityHubScanSchema = z.object({
  hits: z.array(
    z.object({
      findingArn: z.string(),
      accountId: z.string(),
      region: z.string(),
      productName: z.string(),
      type: z.string(),
      severity: z.string(),
      title: z.string(),
      matchedCve: z.string().nullable(),
    }),
  ),
  count: z.number(),
  truncated: z.boolean().describe(
    "True if the Security Hub page cap was hit before exhausting findings",
  ),
  aggregating: z.boolean().describe(
    "Whether a Security Hub aggregator answered (true) or the lane was skipped",
  ),
  regionsScanned: z.array(z.string()),
  skipped: z.array(SkippedLaneSchema),
  since: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const VERDICTS = [
  "confirmed_exposure",
  "active_targeting",
  "possible_probe",
  "no_signal",
  "inconclusive",
] as const;

const AccountVerdictSchema = z.object({
  accountId: z.string(),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  evidence: z.object({
    inspectorCves: z.array(z.string()),
    inspectorHitCount: z.number(),
    guardDutyIocIpMatches: z.array(z.string()),
    guardDutyRceHintCount: z.number(),
    logIocIpContactCount: z.number(),
    logUploadMarkerCount: z.number(),
    securityHubHitCount: z.number(),
    jevConfirmedCount: z.number().describe(
      "Signals jev scored at or above the exploitation-likelihood threshold " +
        "(only populated when jev enrichment ran)",
    ),
  }),
  lanesRun: z.array(z.string()),
  lanesSkipped: z.array(SkippedLaneSchema),
});

const ExposureReportSchema = z.object({
  orgVerdict: z.enum(VERDICTS),
  orgSummary: z.string(),
  accounts: z.array(AccountVerdictSchema),
  accountsScanned: z.number(),
  regionsScanned: z.array(z.string()),
  scope: z.string(),
  securityHubUsed: z.boolean(),
  jevEnriched: z.boolean().describe(
    "Whether jev calibrated enrichment ran for the GuardDuty/log lanes",
  ),
  jevSkipReason: z.string().nullable().describe(
    "Why jev enrichment did not run or was partial, when applicable",
  ),
  verdictCounts: z.record(z.string(), z.number()),
  since: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

// =============================================================================
// Lane implementations — each returns typed signals plus skip reasons.
// =============================================================================

type MinimalLogger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning?: (msg: string, props?: Record<string, unknown>) => void;
};

/** Resolve the set of account IDs in scope. */
async function resolveAccountIds(
  globalArgs: GlobalArgs,
  logger: MinimalLogger,
): Promise<{ accountIds: string[]; skipped: SkippedLane[] }> {
  const skipped: SkippedLane[] = [];
  if (globalArgs.scope === "self") {
    return { accountIds: [], skipped };
  }
  if (globalArgs.scope === "accounts") {
    if (globalArgs.accountIds.length === 0) {
      throw new Error(
        "scope=accounts requires a non-empty accountIds global argument.",
      );
    }
    return { accountIds: [...globalArgs.accountIds], skipped };
  }
  // organization
  const org = new OrganizationsClient(
    makeClientConfig(globalArgs.regions[0] ?? "us-east-1", globalArgs.profile),
  );
  try {
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await org.send(
        new ListAccountsCommand({ NextToken: nextToken }),
      );
      for (const a of resp.Accounts ?? []) {
        if (a.Status === "ACTIVE" && a.Id) ids.push(a.Id);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    const filtered = globalArgs.accountIds.length > 0
      ? ids.filter((id) => globalArgs.accountIds.includes(id))
      : ids;
    logger.info("Resolved {count} active org accounts", {
      count: filtered.length,
    });
    return { accountIds: filtered, skipped };
  } catch (err) {
    // Degrade honestly: we could not enumerate the org, fall back to self.
    skipped.push({
      lane: "org_account_resolution",
      region: null,
      accountId: null,
      reason:
        `Could not list AWS Organizations accounts (${errMessage(err)}). ` +
        "Falling back to the credentialed account only. Point the profile at " +
        "the delegated-admin or management account for org-wide scope.",
    });
    return { accountIds: [], skipped };
  } finally {
    org.destroy();
  }
}

/** Inspector v2: findings for the target CVEs, fanned across regions. */
async function scanInspectorLane(
  cves: string[],
  regions: string[],
  accountIds: string[],
  profile: string | undefined,
  logger: MinimalLogger,
): Promise<
  {
    hits: z.infer<typeof InspectorHitSchema>[];
    regionsQueried: string[];
    truncated: boolean;
    skipped: SkippedLane[];
  }
> {
  const hits: z.infer<typeof InspectorHitSchema>[] = [];
  const skipped: SkippedLane[] = [];
  const regionsQueried: string[] = [];
  let truncated = false;
  // Inspector's awsAccountId filter is capped at 10 values (AWS API limit), so
  // we never send it — at delegated-admin scope findings already span members.
  // Account scoping is applied client-side below.
  const accountFilter = new Set(accountIds);
  const MAX_PAGES = 50;

  for (const region of regions) {
    const client = new Inspector2Client(makeClientConfig(region, profile));
    try {
      let nextToken: string | undefined;
      let pages = 0;
      do {
        if (pages >= MAX_PAGES) {
          truncated = true;
          break;
        }
        pages++;
        const resp = await client.send(
          new ListInspectorFindingsCommand({
            filterCriteria: {
              vulnerabilityId: cves.slice(0, 10).map((v) => ({
                comparison: "EQUALS",
                value: v,
              })),
            },
            maxResults: 100,
            nextToken,
          }),
        );
        for (const f of resp.findings ?? []) {
          const acct = f.awsAccountId ?? "";
          // Client-side account filter (API filter is limited to 10 values).
          if (accountFilter.size > 0 && !accountFilter.has(acct)) continue;
          const matchedCve = (f.packageVulnerabilityDetails?.vulnerabilityId &&
              cves.includes(f.packageVulnerabilityDetails.vulnerabilityId))
            ? f.packageVulnerabilityDetails.vulnerabilityId
            : (cves.find((c) => (f.title ?? "").includes(c)) ?? cves[0]);
          const res = f.resources?.[0];
          hits.push({
            findingArn: f.findingArn ?? "",
            cve: matchedCve,
            accountId: acct,
            region,
            severity: f.severity ?? "UNKNOWN",
            title: f.title ?? "",
            resourceType: res?.type ?? null,
            resourceId: res?.id ?? null,
            fixAvailable: f.fixAvailable ?? null,
            firstObservedAt: f.firstObservedAt
              ? String(f.firstObservedAt)
              : null,
            updatedAt: f.updatedAt ? String(f.updatedAt) : null,
          });
        }
        nextToken = resp.nextToken;
      } while (nextToken);
      // The region's API answered without throwing — the lane genuinely ran
      // here, even if it returned zero findings.
      regionsQueried.push(region);
    } catch (err) {
      skipped.push({
        lane: "inspector",
        region,
        accountId: null,
        reason:
          `Inspector v2 ListFindings failed in ${region} (${
            errMessage(err)
          }). ` +
          "Inspector may be disabled in this region, or the role lacks " +
          "inspector2:ListFindings. Absence of hits here is NOT proof of safety.",
      });
    } finally {
      client.destroy();
    }
  }
  logger.info("Inspector lane: {count} CVE hits across {regions} region(s)", {
    count: hits.length,
    regions: regionsQueried.length,
  });
  return { hits, regionsQueried, truncated, skipped };
}

async function getDetectorId(
  client: GuardDutyClient,
): Promise<string | null> {
  const resp = await client.send(new ListDetectorsCommand({}));
  return resp.DetectorIds?.[0] ?? null;
}

/** GuardDuty: findings since the IoC start date, correlated to IOC IPs / RCE hints. */
async function scanGuardDutyLane(
  iocIps: string[],
  rceHints: readonly string[],
  since: Date,
  regions: string[],
  accountIds: string[],
  profile: string | undefined,
  logger: MinimalLogger,
): Promise<
  {
    signals: z.infer<typeof GuardDutySignalSchema>[];
    regionsQueried: string[];
    truncated: boolean;
    skipped: SkippedLane[];
  }
> {
  const signals: z.infer<typeof GuardDutySignalSchema>[] = [];
  const skipped: SkippedLane[] = [];
  const regionsQueried: string[] = [];
  const iocIpSet = new Set(iocIps);
  const accountFilter = new Set(accountIds);
  let truncated = false;
  // Cap ListFindings pages (50 ids/page) and the GetFindings detail fetch so an
  // org-wide delegated-admin detector cannot run the lane unbounded. 40 pages
  // = up to 2000 finding ids per region.
  const MAX_LIST_PAGES = 40;
  const MAX_DETAIL = 2000;

  for (const region of regions) {
    const client = new GuardDutyClient(makeClientConfig(region, profile));
    try {
      const detectorId = await getDetectorId(client);
      if (!detectorId) {
        skipped.push({
          lane: "guardduty",
          region,
          accountId: null,
          reason:
            `No GuardDuty detector in ${region}. GuardDuty is not enabled here, ` +
            "so no behavioral signal could be collected for this region.",
        });
        continue;
      }

      const criterion: Record<string, Condition> = {
        updatedAt: { GreaterThanOrEqual: since.getTime() },
      };
      // GuardDuty's accountId Eq filter is also value-limited and unnecessary
      // at delegated-admin scope; filter client-side instead.

      const ids: string[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      do {
        if (pages >= MAX_LIST_PAGES) {
          truncated = true;
          break;
        }
        pages++;
        const resp = await client.send(
          new ListGuardDutyFindingsCommand({
            DetectorId: detectorId,
            FindingCriteria: { Criterion: criterion },
            MaxResults: 50,
            NextToken: nextToken,
          }),
        );
        ids.push(...(resp.FindingIds ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);

      // Bound the detail fetch independently of the id count.
      const detailIds = ids.slice(0, MAX_DETAIL);
      if (ids.length > MAX_DETAIL) truncated = true;

      for (let i = 0; i < detailIds.length; i += 50) {
        const resp = await client.send(
          new GetGuardDutyFindingsCommand({
            DetectorId: detectorId,
            FindingIds: detailIds.slice(i, i + 50),
          }),
        );
        for (const f of resp.Findings ?? []) {
          const acct = f.AccountId ?? "";
          if (accountFilter.size > 0 && !accountFilter.has(acct)) continue;
          const matchedIocIps = extractFindingIps(f).filter((ip) =>
            iocIpSet.has(ip)
          );
          const type = f.Type ?? "";
          const rceHint = rceHints.some((h) => type.includes(h));
          // Keep a finding only if it relates to our hunt: an IOC IP match or
          // an RCE-shaped type. Everything else is unrelated GuardDuty noise.
          if (matchedIocIps.length === 0 && !rceHint) continue;
          signals.push({
            findingId: f.Id ?? "",
            type,
            severity: f.Severity ?? 0,
            title: f.Title ?? "",
            accountId: acct,
            region: f.Region ?? region,
            matchedIocIps,
            rceHint,
            createdAt: f.CreatedAt ? String(f.CreatedAt) : "",
            updatedAt: f.UpdatedAt ? String(f.UpdatedAt) : "",
          });
        }
      }
      // All pages fetched without throwing — lane genuinely ran in this region.
      regionsQueried.push(region);
    } catch (err) {
      skipped.push({
        lane: "guardduty",
        region,
        accountId: null,
        reason: `GuardDuty query failed in ${region} (${errMessage(err)}). ` +
          "Check guardduty:ListFindings / GetFindings permissions.",
      });
    } finally {
      client.destroy();
    }
  }
  logger.info("GuardDuty lane: {count} correlated signal(s)", {
    count: signals.length,
  });
  return { signals, regionsQueried, truncated, skipped };
}

/** Pull candidate IP strings out of a GuardDuty finding's service action blocks. */
export function extractFindingIps(f: GuardDutyFinding): string[] {
  const ips = new Set<string>();
  const action = f.Service?.Action;
  const candidates = [
    action?.NetworkConnectionAction?.RemoteIpDetails?.IpAddressV4,
    action?.AwsApiCallAction?.RemoteIpDetails?.IpAddressV4,
    action?.PortProbeAction?.PortProbeDetails?.[0]?.RemoteIpDetails
      ?.IpAddressV4,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) ips.add(c);
  }
  return [...ips];
}

/** Poll a CloudWatch Logs Insights query to completion and return rows. */
async function runInsightsQuery(
  client: CloudWatchLogsClient,
  logGroups: string[],
  queryString: string,
  startTime: Date,
  endTime: Date,
  signal: AbortSignal | undefined,
): Promise<Record<string, string>[]> {
  const start = await client.send(
    new StartQueryCommand({
      logGroupNames: logGroups,
      queryString,
      startTime: Math.floor(startTime.getTime() / 1000),
      endTime: Math.floor(endTime.getTime() / 1000),
      limit: 1000,
    }),
  );
  const queryId = start.queryId;
  if (!queryId) return [];

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 1500));
    const res = await client.send(
      new GetQueryResultsCommand({ queryId }),
    );
    const status: QueryStatus | string | undefined = res.status;
    if (status === "Complete") {
      return (res.results ?? []).map((row: ResultField[]) => {
        const obj: Record<string, string> = {};
        for (const field of row) {
          if (field.field && field.value !== undefined) {
            obj[field.field] = field.value;
          }
        }
        return obj;
      });
    }
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new Error(`Logs Insights query ${status}`);
    }
  }
  throw new Error("Logs Insights query did not complete within 60s");
}

/** Logs lane: IOC IP contact in flow logs + upload marker in WAF/ALB/app logs. */
async function scanLogsLane(
  iocIps: string[],
  payloadStrings: string[],
  since: Date,
  regions: string[],
  logGroupNames: string[],
  profile: string | undefined,
  signal: AbortSignal | undefined,
  logger: MinimalLogger,
): Promise<
  {
    signals: z.infer<typeof LogSignalSchema>[];
    regionsQueried: string[];
    skipped: SkippedLane[];
  }
> {
  const signals: z.infer<typeof LogSignalSchema>[] = [];
  const skipped: SkippedLane[] = [];
  const regionsQueried: string[] = [];
  const now = new Date();

  if (logGroupNames.length === 0) {
    skipped.push({
      lane: "logs",
      region: null,
      accountId: null,
      reason:
        "No logGroupNames supplied. Flow logs, WAF logs, and ALB access logs " +
        "live in customer-named CloudWatch log groups (or in S3, which Logs " +
        "Insights cannot read). Pass logGroupNames to run this lane. It was " +
        "not run — treat the upload-marker and flow-log IP checks as unchecked.",
    });
    return { signals, regionsQueried, skipped };
  }

  // Query each region's log groups. A log group is regional; callers pass the
  // groups relevant to the regions they listed. We try all groups per region
  // and let AWS reject groups that do not exist there (recorded as skips).
  for (const region of regions) {
    const client = new CloudWatchLogsClient(makeClientConfig(region, profile));
    let regionCompletedAQuery = false;
    try {
      // Lane A: IOC IP contact (VPC flow logs). dstAddr/srcAddr are flow-log
      // fields; we match either direction against the IOC set.
      const ipList = iocIps.map((ip) => `"${ip}"`).join(", ");
      const ipQuery = `fields @timestamp, @message, srcAddr, dstAddr ` +
        `| filter srcAddr in [${ipList}] or dstAddr in [${ipList}] ` +
        `| sort @timestamp desc | limit 1000`;
      try {
        const rows = await runInsightsQuery(
          client,
          logGroupNames,
          ipQuery,
          since,
          now,
          signal,
        );
        regionCompletedAQuery = true;
        if (rows.length > 0) {
          signals.push({
            kind: "ioc_ip_contact",
            region,
            logGroup: logGroupNames.join(","),
            matchCount: rows.length,
            sample: rows.slice(0, 10),
          });
        }
      } catch (err) {
        skipped.push({
          lane: "logs:ioc_ip_contact",
          region,
          accountId: null,
          reason:
            `Flow-log IOC IP query failed in ${region} (${errMessage(err)}). ` +
            "The supplied log groups may not be flow logs, or may not exist in " +
            "this region.",
        });
      }

      // Lane B: upload marker in request/WAF/ALB logs.
      const markerFilters = payloadStrings
        .map((s) => `@message like /${s.replace(/[/\\]/g, "\\$&")}/`)
        .join(" or ");
      const markerQuery = `fields @timestamp, @message ` +
        `| filter ${markerFilters} ` +
        `| sort @timestamp desc | limit 1000`;
      try {
        const rows = await runInsightsQuery(
          client,
          logGroupNames,
          markerQuery,
          since,
          now,
          signal,
        );
        regionCompletedAQuery = true;
        if (rows.length > 0) {
          signals.push({
            kind: "upload_marker",
            region,
            logGroup: logGroupNames.join(","),
            matchCount: rows.length,
            sample: rows.slice(0, 10),
          });
        }
      } catch (err) {
        skipped.push({
          lane: "logs:upload_marker",
          region,
          accountId: null,
          reason: `Upload-marker query failed in ${region} (${
            errMessage(err)
          }).`,
        });
      }
      if (regionCompletedAQuery) regionsQueried.push(region);
    } finally {
      client.destroy();
    }
  }
  logger.info("Logs lane: {count} signal group(s)", { count: signals.length });
  return { signals, regionsQueried, skipped };
}

/**
 * Discover candidate CloudWatch log groups across regions and classify them by
 * likely signal class. Writes ranked candidates for an agent to present; it
 * never runs a Logs Insights query and never guesses that a group definitely
 * holds the signal — name heuristics only.
 */
async function discoverLogGroupsLane(
  regions: string[],
  prefix: string | undefined,
  profile: string | undefined,
  maxPerRegion: number,
  logger: MinimalLogger,
): Promise<
  {
    candidates: z.infer<typeof LogGroupCandidateSchema>[];
    regionsQueried: string[];
    truncated: boolean;
    skipped: SkippedLane[];
  }
> {
  const candidates: z.infer<typeof LogGroupCandidateSchema>[] = [];
  const regionsQueried: string[] = [];
  const skipped: SkippedLane[] = [];
  let truncated = false;

  for (const region of regions) {
    const client = new CloudWatchLogsClient(makeClientConfig(region, profile));
    try {
      let nextToken: string | undefined;
      let perRegion = 0;
      do {
        const resp = await client.send(
          new DescribeLogGroupsCommand({
            ...(prefix ? { logGroupNamePrefix: prefix } : {}),
            limit: 50,
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        for (const g of resp.logGroups ?? []) {
          if (!g.logGroupName) continue;
          if (perRegion >= maxPerRegion) {
            truncated = true;
            break;
          }
          perRegion++;
          const { classification, relevance } = classifyLogGroup(
            g.logGroupName,
          );
          candidates.push({
            name: g.logGroupName,
            region,
            classification,
            relevance,
            storedBytes: typeof g.storedBytes === "number"
              ? g.storedBytes
              : null,
            creationTime: g.creationTime
              ? new Date(g.creationTime).toISOString()
              : null,
          });
        }
        nextToken = perRegion >= maxPerRegion ? undefined : resp.nextToken;
      } while (nextToken);
      regionsQueried.push(region);
    } catch (err) {
      skipped.push({
        lane: "discover_log_groups",
        region,
        accountId: null,
        reason: `DescribeLogGroups failed in ${region} (${errMessage(err)}). ` +
          "Check logs:DescribeLogGroups permission; candidates from this " +
          "region are not represented.",
      });
    } finally {
      client.destroy();
    }
  }

  // Rank: most relevant first, then larger (more active) groups.
  candidates.sort((a, b) =>
    b.relevance - a.relevance ||
    (b.storedBytes ?? 0) - (a.storedBytes ?? 0)
  );
  logger.info("Discovered {count} log group(s), {rec} recommended", {
    count: candidates.length,
    rec: candidates.filter((c) => c.relevance >= 60).length,
  });
  return { candidates, regionsQueried, truncated, skipped };
}

/** Security Hub lane (opportunistic): one query covering aggregated findings. */
async function scanSecurityHubLane(
  cves: string[],
  since: Date,
  homeRegion: string,
  accountIds: string[],
  profile: string | undefined,
  logger: MinimalLogger,
): Promise<
  {
    hits: z.infer<typeof SecurityHubScanSchema>["hits"];
    aggregating: boolean;
    truncated: boolean;
    skipped: SkippedLane[];
  }
> {
  const hits: z.infer<typeof SecurityHubScanSchema>["hits"] = [];
  const skipped: SkippedLane[] = [];
  const client = new SecurityHubClient(makeClientConfig(homeRegion, profile));
  try {
    let nextToken: string | undefined;
    let any = false;
    // Build the filter ONCE. Security Hub rejects pagination with
    // "Invalid NextToken: Input Query has changed" if Filters or SortCriteria
    // differ between calls — so End must not be recomputed each iteration.
    // Narrow server-side to the products that could carry PHP2Shell signal
    // (GuardDuty, Inspector); without this, an org-wide Security Hub returns
    // thousands of unrelated findings and pagination never finishes in time.
    const filters = {
      UpdatedAt: [{
        Start: since.toISOString(),
        End: new Date().toISOString(),
      }],
      ProductName: [
        { Value: "GuardDuty", Comparison: "EQUALS" as const },
        { Value: "Inspector", Comparison: "EQUALS" as const },
      ],
      ...(accountIds.length > 0
        ? {
          AwsAccountId: accountIds.map((id) => ({
            Value: id,
            Comparison: "EQUALS" as const,
          })),
        }
        : {}),
    };
    // Hard page cap so an org-wide aggregator cannot run the lane unbounded.
    const MAX_PAGES = 20;
    let pages = 0;
    let truncated = false;
    do {
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
      pages++;
      const resp = await client.send(
        new GetSecurityHubFindingsCommand({
          Filters: filters,
          MaxResults: 100,
          // Only include NextToken once we actually have one — Security Hub
          // rejects an explicitly-present NextToken: undefined with
          // "Invalid NextToken" on the first call.
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      any = true;
      for (const f of resp.Findings ?? []) {
        const matchedCve = matchFindingToCve(f, cves);
        // Keep findings that either reference one of our CVEs or come from
        // GuardDuty/Inspector (the products that would carry PHP2Shell signal).
        const product = f.ProductName ?? "";
        const relevant = matchedCve !== null ||
          /guardduty|inspector/i.test(product);
        if (!relevant) continue;
        hits.push({
          findingArn: f.Id ?? "",
          accountId: f.AwsAccountId ?? "",
          region: f.Region ?? homeRegion,
          productName: product,
          type: (f.Types ?? [])[0] ?? "",
          severity: f.Severity?.Label ?? "UNKNOWN",
          title: f.Title ?? "",
          matchedCve,
        });
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    logger.info(
      "Security Hub lane: {count} product finding(s), {cve} CVE-matched",
      {
        count: hits.length,
        cve: hits.filter((h) => h.matchedCve !== null).length,
      },
    );
    return { hits, aggregating: any, truncated, skipped };
  } catch (err) {
    skipped.push({
      lane: "securityhub",
      region: homeRegion,
      accountId: null,
      reason:
        `Security Hub GetFindings failed in ${homeRegion} (${
          errMessage(err)
        }). ` +
        "Security Hub is likely not enabled or not aggregating here. The direct " +
        "GuardDuty and Inspector lanes still cover this hunt.",
    });
    return { hits, aggregating: false, truncated: false, skipped };
  } finally {
    client.destroy();
  }
}

function matchFindingToCve(
  f: AwsSecurityFinding,
  cves: string[],
): string | null {
  for (const v of f.Vulnerabilities ?? []) {
    if (v.Id && cves.includes(v.Id)) return v.Id;
  }
  const hay = `${f.Title ?? ""} ${f.Description ?? ""}`;
  return cves.find((c) => hay.includes(c)) ?? null;
}

// =============================================================================
// jev (TypeSafe) enrichment — optional, calibrated per-signal judgement.
// =============================================================================

const JEV_YES_THRESHOLD = 0.5;

/** Compact, secret-free descriptor of a signal for jev to judge. */
type JevItem = {
  key: string;
  state: Record<string, unknown>;
  question: string;
};

type JevOutcome = {
  enriched: boolean;
  /** key -> probability of "yes" (exploitation-consistent), 0..1. */
  probabilities: Record<string, number>;
  /** keys that were actually sent to jev and got a score back. */
  scoredKeys: Set<string>;
  skipReason: string | null;
};

/**
 * Score a bounded set of compact signal descriptors with jev's `noul` via
 * runModel, calling a pre-created @swamp/typesafe-ai behavior by name so it
 * resolves its own vault-backed API key (jev's apiKey global is sensitive and
 * cannot be passed a literal value through runModel). Returns per-key
 * probabilities when enrichment ran. Any failure — runModel {ok:false}, a
 * throw, the local-only limitation, or a missing behavior — is reported as
 * not-enriched with a reason, never silently treated as "jev said no".
 */
async function enrichWithJev(
  items: JevItem[],
  jevBehavior: string,
  cap: number,
  context: MethodContext,
): Promise<JevOutcome> {
  const probabilities: Record<string, number> = {};
  const scoredKeys = new Set<string>();
  if (items.length === 0) {
    return { enriched: true, probabilities, scoredKeys, skipReason: null };
  }
  if (!context.runModel || !context.readModelData) {
    return {
      enriched: false,
      probabilities,
      scoredKeys,
      skipReason:
        "jev enrichment unavailable: runModel/readModelData not provided in " +
        "this execution context (runModel is local-only — it does not run on " +
        "remote workers). Signals fall back to the un-enriched heuristic.",
    };
  }
  const bounded = items.slice(0, cap);
  const truncatedNote = items.length > cap
    ? ` (scored ${cap} of ${items.length} signals; the remainder fall back ` +
      "to the un-enriched heuristic)"
    : "";

  for (let i = 0; i < bounded.length; i++) {
    const item = bounded[i];
    if (context.signal?.aborted) break;
    // Distinct per-call instance name so the read is unambiguous even though
    // noul keeps only the latest version of each named instance.
    const callName = `p2s-${i}`;
    let res: RunModelResult;
    try {
      res = await context.runModel({
        definition: jevBehavior,
        method: "noul",
        arguments: {
          state: item.state,
          instructions: item.question,
          yes: "Activity is consistent with PHP2Shell / web-server RCE " +
            "exploitation (e.g. multipart upload abuse or " +
            "PHP_SESSION_UPLOAD_PROGRESS manipulation).",
          no: "Activity is benign or unrelated to PHP2Shell exploitation.",
          name: callName,
        },
      });
    } catch (err) {
      // runModel can throw (e.g. a sensitive-argument rejection) rather than
      // returning {ok:false}; treat any throw as a clean, honest skip.
      return {
        enriched: false,
        probabilities,
        scoredKeys,
        skipReason: `jev enrichment errored (${errMessage(err)}). Confirm a ` +
          `@swamp/typesafe-ai behavior named "${jevBehavior}" exists with a ` +
          "vault-backed apiKey. Signals fall back to the un-enriched " +
          "heuristic." + truncatedNote,
      };
    }
    if (!res.ok) {
      return {
        enriched: false,
        probabilities,
        scoredKeys,
        skipReason:
          `jev enrichment failed via runModel (${res.error.message}). ` +
          "Signals fall back to the un-enriched heuristic." + truncatedNote,
      };
    }
    // Read back the noul probability for this call's instance. Match the
    // exact instance name only — never fall back to records[0]. readModelData
    // returns the latest version of every retained noul instance ordered
    // oldest-first, so records[0] would be an unrelated/stale score from a
    // prior call or a prior hunt. A find-miss means we simply did not get a
    // score for this signal; leave it unscored (and the caller falls back to
    // the raw heuristic for it) rather than borrow a foreign one.
    const records = await context.readModelData(jevBehavior, "noul");
    const rec = records.find((r) => r.name === `noul-${callName}`);
    const noul = rec && typeof rec.attributes.noul === "number"
      ? rec.attributes.noul
      : null;
    if (noul !== null) {
      probabilities[item.key] = noul;
      scoredKeys.add(item.key);
    }
  }
  return {
    enriched: true,
    probabilities,
    scoredKeys,
    skipReason: truncatedNote ? `jev enrichment ran${truncatedNote}` : null,
  };
}

// =============================================================================
// Correlation — turn lane signals into an honest per-account verdict.
// =============================================================================

type AccountEvidence = z.infer<typeof AccountVerdictSchema>["evidence"];

/** Build a zeroed evidence record for one account before lanes contribute. */
export function emptyEvidence(): AccountEvidence {
  return {
    inspectorCves: [],
    inspectorHitCount: 0,
    guardDutyIocIpMatches: [],
    guardDutyRceHintCount: 0,
    logIocIpContactCount: 0,
    logUploadMarkerCount: 0,
    securityHubHitCount: 0,
    jevConfirmedCount: 0,
  };
}

/**
 * Correlate one account's accumulated lane evidence into a single exposure
 * verdict and a human-readable summary. The ranking is deliberate:
 * confirmed_exposure > active_targeting > possible_probe, and a lane that never
 * ran yields `inconclusive` rather than the falsely-reassuring `no_signal`.
 */
export function verdictFor(
  ev: AccountEvidence,
  lanesRun: string[],
  jevEnriched = false,
): { verdict: typeof VERDICTS[number]; summary: string } {
  if (ev.inspectorHitCount > 0 || ev.securityHubHitCount > 0) {
    const cves = ev.inspectorCves.length > 0
      ? ev.inspectorCves.join(", ")
      : PHP2SHELL_IOCS.cves.join(", ");
    return {
      verdict: "confirmed_exposure",
      summary:
        `Vulnerable PHP identified by Amazon Inspector / Security Hub for ${cves}. ` +
        "Patch immediately and investigate for compromise from 2026-10-17.",
    };
  }
  if (ev.guardDutyIocIpMatches.length > 0 || ev.logIocIpContactCount > 0) {
    return {
      verdict: "active_targeting",
      summary: "Contact with published IOC infrastructure observed " +
        `(GuardDuty IOC IPs: ${ev.guardDutyIocIpMatches.length}, ` +
        `flow-log contacts: ${ev.logIocIpContactCount}). Investigate the ` +
        "targeted resources; the IPs are shared infrastructure, so confirm " +
        "intent rather than block blindly.",
    };
  }
  // possible_probe tier. When jev enrichment ran, trust its calibrated
  // judgement for the signals it scored (jevConfirmedCount), AND still honor
  // the raw heuristic for any signals jev did not score (capped, missed) —
  // those were folded into the raw counts so they are never silently dropped.
  if (jevEnriched) {
    if (
      ev.jevConfirmedCount > 0 || ev.logUploadMarkerCount > 0 ||
      ev.guardDutyRceHintCount > 0
    ) {
      const unscored = ev.logUploadMarkerCount + ev.guardDutyRceHintCount;
      return {
        verdict: "possible_probe",
        summary: `jev judged ${ev.jevConfirmedCount} signal(s) as consistent ` +
          "with PHP2Shell exploitation (calibrated above threshold)" +
          (unscored > 0
            ? `, plus ${unscored} un-scored signal(s) retained by the raw ` +
              "heuristic"
            : "") +
          ". Review the web servers behind them.",
      };
    }
    // jev ran and cleared every signal it scored, and none fell back — the
    // RCE-hint noise is not probe-worthy.
  } else if (ev.logUploadMarkerCount > 0 || ev.guardDutyRceHintCount > 0) {
    return {
      verdict: "possible_probe",
      summary:
        "Exploitation-shaped activity seen without a confirmed vulnerable " +
        `install (upload markers: ${ev.logUploadMarkerCount}, GuardDuty ` +
        `RCE-shaped findings: ${ev.guardDutyRceHintCount}). Review the web ` +
        "servers behind these signals. Enable jev enrichment to calibrate " +
        "these fuzzy signals and cut noise.",
    };
  }
  if (lanesRun.length === 0) {
    return {
      verdict: "inconclusive",
      summary:
        "No signal lane could run for this account. This is NOT a clean " +
        "result — nothing was actually inspected. See lanesSkipped.",
    };
  }
  return {
    verdict: "no_signal",
    summary:
      `No PHP2Shell signal across the lanes that ran (${
        lanesRun.join(", ")
      }). ` +
      (jevEnriched
        ? "jev cleared the behavioral signals as not exploitation-consistent. "
        : "") +
      "Note Inspector only covers SSM/ECR-scanned resources; unmanaged hosts " +
      "and S3-based logs are not represented here.",
  };
}

const VERDICT_RANK: Record<typeof VERDICTS[number], number> = {
  confirmed_exposure: 4,
  active_targeting: 3,
  possible_probe: 2,
  inconclusive: 1,
  no_signal: 0,
};

// =============================================================================
// Model definition
// =============================================================================

type WriteResource = (
  spec: string,
  instance: string,
  data: unknown,
) => Promise<{ name: string }>;

type RunModelResult =
  | { ok: true; resources: Array<{ name: string }> }
  | { ok: false; error: { message: string } };

type RunModelOptions = {
  modelType?: string;
  definition?: string;
  name?: string;
  method: string;
  arguments?: Record<string, unknown>;
};

type DataRecord = {
  name: string;
  attributes: Record<string, unknown>;
};

type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: WriteResource;
  logger: MinimalLogger;
  signal?: AbortSignal;
  runModel?: (options: RunModelOptions) => Promise<RunModelResult>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;
};

/**
 * The PHP2Shell AWS hunt behavior. Exposes `show_iocs` plus four signal-lane
 * scans and the `hunt` orchestrator that correlates them into a per-account
 * exposure verdict. Read-only; never touches a host.
 */
export const model = {
  type: "@webframp/aws/php2shell-hunt",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],

  resources: {
    ioc_set: {
      description: "PHP2Shell indicators of compromise as queryable data",
      schema: IocSetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    inspector_scan: {
      description: "Amazon Inspector v2 findings matching the PHP2Shell CVEs",
      schema: InspectorScanSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
    guardduty_scan: {
      description: "GuardDuty findings correlated to PHP2Shell IOC IPs / RCE",
      schema: GuardDutyScanSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
    log_scan: {
      description:
        "CloudWatch Logs Insights signals (IOC IP contact, upload marker)",
      schema: LogScanSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
    log_group_candidates: {
      description:
        "Ranked CloudWatch log group discovery candidates for the logs lane",
      schema: LogGroupCandidatesSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    securityhub_scan: {
      description: "Security Hub aggregated findings relevant to PHP2Shell",
      schema: SecurityHubScanSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
    exposure_report: {
      description: "Correlated per-account PHP2Shell exposure verdict",
      schema: ExposureReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
  },

  methods: {
    show_iocs: {
      description:
        "Emit the PHP2Shell indicator set as queryable swamp data. No AWS calls.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const handle = await context.writeResource("ioc_set", "php2shell", {
          cves: [...PHP2SHELL_IOCS.cves],
          advisory: PHP2SHELL_IOCS.advisory,
          ipIndicators: [...PHP2SHELL_IOCS.ipIndicators],
          payloadStrings: [...PHP2SHELL_IOCS.payloadStrings],
          earliestKnownExploitation: PHP2SHELL_IOCS.earliestKnownExploitation,
          fixedVersions: { ...PHP2SHELL_IOCS.fixedVersions },
          unsupportedBelow: PHP2SHELL_IOCS.unsupportedBelow,
          fetchedAt: new Date().toISOString(),
          collectedBy: EXTENSION_NAME,
        });
        return { dataHandles: [handle] };
      },
    },

    scan_inspector: {
      description:
        "Query Amazon Inspector v2 for findings matching the PHP2Shell CVEs across the configured regions.",
      arguments: z.object({
        cves: z
          .array(z.string())
          .default([...PHP2SHELL_IOCS.cves])
          .describe("CVE IDs to match (defaults to the two PHP2Shell CVEs)"),
      }),
      execute: async (args: { cves: string[] }, context: MethodContext) => {
        const startMs = Date.now();
        const { regions, profile } = context.globalArgs;
        const { accountIds } = await resolveAccountIds(
          context.globalArgs,
          context.logger,
        );
        const { hits, regionsQueried, truncated, skipped } =
          await scanInspectorLane(
            args.cves,
            regions,
            accountIds,
            profile,
            context.logger,
          );
        const handle = await context.writeResource(
          "inspector_scan",
          "inspector",
          {
            hits,
            count: hits.length,
            truncated,
            regionsScanned: regionsQueried,
            skipped,
            cves: args.cves,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    scan_guardduty: {
      description:
        "Query GuardDuty for findings since the IoC start date, correlated to the PHP2Shell IOC IPs and RCE-shaped finding types.",
      arguments: z.object({
        since: z
          .string()
          .default(PHP2SHELL_IOCS.earliestKnownExploitation)
          .describe(
            "Start of the investigation window (ISO or relative like 7d). " +
              "Defaults to 2026-10-17, the earliest known exploitation.",
          ),
        iocIps: z
          .array(z.string())
          .default([...PHP2SHELL_IOCS.ipIndicators])
          .describe("IOC IP list to correlate against (overridable)"),
      }),
      execute: async (
        args: { since: string; iocIps: string[] },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const { regions, profile } = context.globalArgs;
        const since = parseTime(args.since);
        const { accountIds } = await resolveAccountIds(
          context.globalArgs,
          context.logger,
        );
        const { signals, regionsQueried, truncated, skipped } =
          await scanGuardDutyLane(
            args.iocIps,
            GUARDDUTY_RCE_HINTS,
            since,
            regions,
            accountIds,
            profile,
            context.logger,
          );
        const handle = await context.writeResource(
          "guardduty_scan",
          "guardduty",
          {
            signals,
            count: signals.length,
            iocIpMatches: signals.filter((s) => s.matchedIocIps.length > 0)
              .length,
            rceHintMatches: signals.filter((s) => s.rceHint).length,
            truncated,
            regionsScanned: regionsQueried,
            skipped,
            since: since.toISOString(),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    scan_logs: {
      description:
        "Run CloudWatch Logs Insights over supplied log groups for IOC IP contact (flow logs) and the PHP_SESSION_UPLOAD_PROGRESS upload marker (WAF/ALB/app logs).",
      arguments: z.object({
        logGroupNames: z
          .array(z.string().min(1))
          .default([])
          .describe(
            "CloudWatch log groups to query (flow logs, WAF logs, ALB access " +
              "logs, app logs). Required for this lane to run — groups cannot " +
              "be auto-discovered and S3-delivered logs are out of reach.",
          ),
        since: z
          .string()
          .default(PHP2SHELL_IOCS.earliestKnownExploitation)
          .describe("Start of the search window (ISO or relative)"),
      }),
      execute: async (
        args: { logGroupNames: string[]; since: string },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const { regions, profile } = context.globalArgs;
        const since = parseTime(args.since);
        const { signals, regionsQueried, skipped } = await scanLogsLane(
          [...PHP2SHELL_IOCS.ipIndicators],
          [...PHP2SHELL_IOCS.payloadStrings],
          since,
          regions,
          args.logGroupNames,
          profile,
          context.signal,
          context.logger,
        );
        const handle = await context.writeResource("log_scan", "logs", {
          signals,
          iocIpContactCount: signals
            .filter((s) => s.kind === "ioc_ip_contact")
            .reduce((n, s) => n + s.matchCount, 0),
          uploadMarkerCount: signals
            .filter((s) => s.kind === "upload_marker")
            .reduce((n, s) => n + s.matchCount, 0),
          regionsScanned: regionsQueried,
          logGroupsQueried: args.logGroupNames,
          skipped,
          since: since.toISOString(),
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_log_groups: {
      description:
        "Discover and rank CloudWatch log groups across the configured regions by likely relevance to the logs lane (flow / WAF / ALB / app). Writes candidates for review; runs no queries.",
      arguments: z.object({
        prefix: z
          .string()
          .optional()
          .describe(
            "Optional log-group name prefix filter (e.g. /vpc/ or /aws/waf).",
          ),
        maxPerRegion: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Cap on log groups enumerated per region."),
      }),
      execute: async (
        args: { prefix?: string; maxPerRegion: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const { regions, profile } = context.globalArgs;
        const { candidates, regionsQueried, truncated, skipped } =
          await discoverLogGroupsLane(
            regions,
            args.prefix,
            profile,
            args.maxPerRegion,
            context.logger,
          );
        const recommended = candidates
          .filter((c) => c.relevance >= 60)
          .map((c) => c.name);
        const handle = await context.writeResource(
          "log_group_candidates",
          "candidates",
          {
            candidates,
            count: candidates.length,
            recommended,
            regionsScanned: regionsQueried,
            skipped,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    scan_securityhub: {
      description:
        "Opportunistically query Security Hub for aggregated GuardDuty/Inspector findings relevant to PHP2Shell. Skips cleanly when Security Hub is not aggregating.",
      arguments: z.object({
        since: z
          .string()
          .default(PHP2SHELL_IOCS.earliestKnownExploitation)
          .describe("Start of the search window (ISO or relative)"),
      }),
      execute: async (args: { since: string }, context: MethodContext) => {
        const startMs = Date.now();
        const { regions, profile } = context.globalArgs;
        const since = parseTime(args.since);
        const { accountIds } = await resolveAccountIds(
          context.globalArgs,
          context.logger,
        );
        const homeRegion = regions[0] ?? "us-east-1";
        const { hits, aggregating, truncated, skipped } =
          await scanSecurityHubLane(
            [...PHP2SHELL_IOCS.cves],
            since,
            homeRegion,
            accountIds,
            profile,
            context.logger,
          );
        const handle = await context.writeResource(
          "securityhub_scan",
          "securityhub",
          {
            hits,
            count: hits.length,
            truncated,
            aggregating,
            regionsScanned: aggregating ? [homeRegion] : [],
            skipped,
            since: since.toISOString(),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    hunt: {
      description:
        "Run all signal lanes across the configured scope and regions, correlate them, and write a per-account PHP2Shell exposure verdict. Honest about lanes that could not run.",
      arguments: z.object({
        since: z
          .string()
          .default(PHP2SHELL_IOCS.earliestKnownExploitation)
          .describe(
            "Start of the investigation window. Defaults to 2026-10-17.",
          ),
        logGroupNames: z
          .array(z.string().min(1))
          .default([])
          .describe(
            "Optional CloudWatch log groups for the flow-log / upload-marker " +
              "lane. Omit to skip that lane (recorded in lanesSkipped).",
          ),
        useSecurityHub: z
          .boolean()
          .default(true)
          .describe(
            "Try the Security Hub aggregated lane first. Falls back to direct " +
              "GuardDuty/Inspector regardless of this flag.",
          ),
        jevMaxCalls: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(15)
          .describe(
            "Cap on jev enrichment calls per hunt (one per fuzzy signal). " +
              "Only used when jevBehavior is set.",
          ),
      }),
      execute: async (
        args: {
          since: string;
          logGroupNames: string[];
          useSecurityHub: boolean;
          jevMaxCalls: number;
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const { regions, profile, scope } = context.globalArgs;
        const since = parseTime(args.since);
        const { accountIds, skipped: scopeSkips } = await resolveAccountIds(
          context.globalArgs,
          context.logger,
        );

        // Run the direct lanes (always), and Security Hub opportunistically.
        const [inspector, guardduty, logs] = await Promise.all([
          scanInspectorLane(
            [...PHP2SHELL_IOCS.cves],
            regions,
            accountIds,
            profile,
            context.logger,
          ),
          scanGuardDutyLane(
            [...PHP2SHELL_IOCS.ipIndicators],
            GUARDDUTY_RCE_HINTS,
            since,
            regions,
            accountIds,
            profile,
            context.logger,
          ),
          scanLogsLane(
            [...PHP2SHELL_IOCS.ipIndicators],
            [...PHP2SHELL_IOCS.payloadStrings],
            since,
            regions,
            args.logGroupNames,
            profile,
            context.signal,
            context.logger,
          ),
        ]);

        let sh:
          | Awaited<ReturnType<typeof scanSecurityHubLane>>
          | null = null;
        if (args.useSecurityHub) {
          sh = await scanSecurityHubLane(
            [...PHP2SHELL_IOCS.cves],
            since,
            regions[0] ?? "us-east-1",
            accountIds,
            profile,
            context.logger,
          );
        }

        // Optional jev enrichment of the fuzzy lanes (GuardDuty RCE-hint
        // findings + log upload markers). Keys encode the signal's origin so
        // correlation can credit the right account. Compact, secret-free state.
        const jevItems: JevItem[] = [];
        guardduty.signals.forEach((s, i) => {
          if (!s.rceHint) return;
          jevItems.push({
            key: `gd:${s.accountId || "unknown"}:${i}`,
            state: {
              source: "guardduty",
              findingType: s.type,
              title: s.title,
              severity: s.severity,
              region: s.region,
            },
            question: "Is this GuardDuty finding consistent with PHP2Shell / " +
              "web-server remote code execution exploitation (for example " +
              "multipart file-upload abuse or PHP_SESSION_UPLOAD_PROGRESS " +
              "manipulation), as opposed to unrelated malware or recon?",
          });
        });
        logs.signals.forEach((s, i) => {
          if (s.kind !== "upload_marker") return;
          jevItems.push({
            key: `log:${i}`,
            state: {
              source: "logs",
              signal: "php_session_upload_progress_marker",
              region: s.region,
              matchCount: s.matchCount,
            },
            question:
              "Does the presence of the PHP_SESSION_UPLOAD_PROGRESS marker in " +
              "these request logs indicate attempted exploitation rather than " +
              "benign use of PHP's upload-progress feature?",
          });
        });

        let jevEnriched = false;
        let jevSkipReason: string | null = null;
        let jevProbs: Record<string, number> = {};
        let jevScored = new Set<string>();
        const jevSkips: SkippedLane[] = [];
        if (context.globalArgs.jevBehavior) {
          const outcome = await enrichWithJev(
            jevItems,
            context.globalArgs.jevBehavior,
            args.jevMaxCalls,
            context,
          );
          jevEnriched = outcome.enriched;
          jevSkipReason = outcome.skipReason;
          jevProbs = outcome.probabilities;
          jevScored = outcome.scoredKeys;
          if (!outcome.enriched && outcome.skipReason) {
            jevSkips.push({
              lane: "jev",
              region: null,
              accountId: null,
              reason: outcome.skipReason,
            });
          }
        }

        // Correlate per account. Build the account universe from whatever we
        // know: the resolved scope, plus any account that appeared in a signal.
        const perAccount = new Map<string, AccountEvidence>();
        const ensure = (id: string) => {
          const key = id || "unknown";
          if (!perAccount.has(key)) perAccount.set(key, emptyEvidence());
          return perAccount.get(key)!;
        };
        for (const id of accountIds) ensure(id);

        for (const h of inspector.hits) {
          const ev = ensure(h.accountId);
          ev.inspectorHitCount++;
          if (!ev.inspectorCves.includes(h.cve)) ev.inspectorCves.push(h.cve);
        }
        for (let i = 0; i < guardduty.signals.length; i++) {
          const s = guardduty.signals[i];
          const ev = ensure(s.accountId);
          for (const ip of s.matchedIocIps) {
            if (!ev.guardDutyIocIpMatches.includes(ip)) {
              ev.guardDutyIocIpMatches.push(ip);
            }
          }
          // A jev-scored rce-hint signal is governed by jev's verdict
          // (jevConfirmedCount), so it must NOT also count toward the raw
          // heuristic. An rce-hint signal jev did NOT score (capped, missed,
          // or jev not enriched) still counts raw so it is never silently
          // dropped.
          const jevKey = `gd:${s.accountId || "unknown"}:${i}`;
          if (s.rceHint && !jevScored.has(jevKey)) {
            ev.guardDutyRceHintCount++;
          }
        }
        for (let i = 0; i < logs.signals.length; i++) {
          const s = logs.signals[i];
          // Flow/app log signals are not account-attributed by Logs Insights.
          // When exactly one account is in scope, fold them into it. Otherwise
          // bucket them under a clearly-synthetic label (not a real account ID)
          // so the verdict row cannot be mistaken for a specific account.
          const key = accountIds.length === 1
            ? accountIds[0]
            : "log-signals (unattributed)";
          const ev = ensure(key);
          if (s.kind === "ioc_ip_contact") {
            ev.logIocIpContactCount += s.matchCount;
          } else if (!jevScored.has(`log:${i}`)) {
            // Upload markers jev scored are governed by jevConfirmedCount; only
            // count un-scored ones toward the raw heuristic.
            ev.logUploadMarkerCount += s.matchCount;
          }
        }
        if (sh) {
          for (const h of sh.hits) {
            const ev = ensure(h.accountId);
            if (h.matchedCve) {
              // Only a CVE-matched Security Hub finding confirms exposure.
              ev.securityHubHitCount++;
              if (!ev.inspectorCves.includes(h.matchedCve)) {
                ev.inspectorCves.push(h.matchedCve);
              }
            } else {
              // A GuardDuty/Inspector finding that merely exists in Security
              // Hub is behavioral corroboration, not confirmation of vulnerable
              // PHP. Count it at the possible_probe tier, never confirmed.
              ev.guardDutyRceHintCount++;
            }
          }
        }

        // Credit jev-confirmed signals to the account that produced them. Keys
        // encode origin: gd:<account>:<i> for GuardDuty, log:<i> for log markers
        // (log signals are unattributed, so they credit the single-account or
        // synthetic bucket, mirroring the raw log fold above).
        if (jevEnriched) {
          const logBucketKey = accountIds.length === 1
            ? accountIds[0]
            : "log-signals (unattributed)";
          for (const [key, prob] of Object.entries(jevProbs)) {
            if (prob < JEV_YES_THRESHOLD) continue;
            if (key.startsWith("gd:")) {
              const acct = key.split(":")[1] ?? "unknown";
              ensure(acct).jevConfirmedCount++;
            } else if (key.startsWith("log:")) {
              ensure(logBucketKey).jevConfirmedCount++;
            }
          }
        }

        // Which lanes actually ran, judged by whether at least one region's
        // API call completed — not inferred from skip counts. A lane that threw
        // in every region has regionsQueried.length === 0 and does NOT count as
        // run, so an empty result there yields inconclusive, never no_signal.
        const laneRan = {
          inspector: inspector.regionsQueried.length > 0,
          guardduty: guardduty.regionsQueried.length > 0,
          logs: logs.regionsQueried.length > 0,
          securityhub: sh?.aggregating ?? false,
        };
        const globalLanesRun = Object.entries(laneRan)
          .filter(([, ran]) => ran)
          .map(([name]) => name);
        const allSkips: SkippedLane[] = [
          ...scopeSkips,
          ...inspector.skipped,
          ...guardduty.skipped,
          ...logs.skipped,
          ...(sh?.skipped ?? []),
          ...jevSkips,
        ];

        const accounts = [...perAccount.entries()].map(([accountId, ev]) => {
          const { verdict, summary } = verdictFor(
            ev,
            globalLanesRun,
            jevEnriched,
          );
          return {
            accountId,
            verdict,
            summary,
            evidence: ev,
            lanesRun: globalLanesRun,
            lanesSkipped: allSkips,
          };
        });

        // If scope resolved to self and nothing was attributed, still emit one
        // honest account row so a clean/inconclusive result is explicit.
        if (accounts.length === 0) {
          const { verdict, summary } = verdictFor(
            emptyEvidence(),
            globalLanesRun,
            jevEnriched,
          );
          accounts.push({
            accountId: "self",
            verdict,
            summary,
            evidence: emptyEvidence(),
            lanesRun: globalLanesRun,
            lanesSkipped: allSkips,
          });
        }

        const verdictCounts: Record<string, number> = {};
        let worst: typeof VERDICTS[number] = "no_signal";
        for (const a of accounts) {
          verdictCounts[a.verdict] = (verdictCounts[a.verdict] ?? 0) + 1;
          if (VERDICT_RANK[a.verdict] > VERDICT_RANK[worst]) worst = a.verdict;
        }

        const handle = await context.writeResource(
          "exposure_report",
          "report",
          {
            orgVerdict: worst,
            orgSummary: orgSummaryFor(worst, verdictCounts, accounts.length),
            accounts,
            accountsScanned: accounts.length,
            regionsScanned: regions,
            scope,
            securityHubUsed: sh?.aggregating ?? false,
            jevEnriched,
            jevSkipReason,
            verdictCounts,
            since: since.toISOString(),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info(
          "Hunt complete: org verdict {verdict} across {n} account(s)",
          { verdict: worst, n: accounts.length },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

function orgSummaryFor(
  worst: typeof VERDICTS[number],
  counts: Record<string, number>,
  total: number,
): string {
  const parts = Object.entries(counts)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
  if (worst === "confirmed_exposure") {
    return `Confirmed PHP2Shell exposure present. ${total} account(s): ${parts}. ` +
      "Patch vulnerable PHP now and investigate from 2026-10-17.";
  }
  if (worst === "active_targeting") {
    return `IOC infrastructure contact observed. ${total} account(s): ${parts}.`;
  }
  if (worst === "possible_probe") {
    return `Exploitation-shaped activity seen. ${total} account(s): ${parts}.`;
  }
  if (worst === "inconclusive") {
    return `No lane could run for any account — nothing was inspected. ${parts}.`;
  }
  return `No PHP2Shell signal across the lanes that ran. ${total} account(s): ${parts}. ` +
    "Absence of signal is not proof of safety — see lanesSkipped and the " +
    "Inspector coverage caveat.";
}
