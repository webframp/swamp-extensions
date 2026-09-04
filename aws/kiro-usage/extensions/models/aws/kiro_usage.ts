/**
 * AWS Kiro per-user usage and spend monitoring model for swamp.
 *
 * Kiro is billed through AWS as a seat subscription (Power / Pro+ / Pro tiers)
 * plus metered credit consumption. Unlike token-based AI providers, Kiro has
 * no CloudWatch token metrics — its cost and per-user attribution live only in
 * the Cost and Usage Report (CUR).
 *
 * Cost Explorer collapses every Kiro line item to `NoResourceId`, so it cannot
 * attribute spend or credits to individuals. The CUR, by contrast, carries an
 * IAM Identity Store principal in `line_item_resource_id`
 * (`arn:aws:identitystore:::user/<id>`) on every per-user line. This model
 * queries the CUR via Athena, resolves each principal to a name/email through
 * the Identity Store, and produces a per-user usage + spend snapshot.
 *
 * The enterprise discount (EDP) is booked at the account level as a distinct
 * `EdpDiscount` line item with no resource id. Per-user *net* cost is therefore
 * an allocation (list cost x the tier's net/list ratio), never a billed figure;
 * the account-level gross, discount, and net are reported separately so the
 * numbers reconcile against the invoice.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "npm:@aws-sdk/client-athena@3.1126.0";
import {
  DescribeUserCommand,
  IdentitystoreClient,
} from "npm:@aws-sdk/client-identitystore@3.1126.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1126.0";

const EXTENSION_NAME = "@webframp/aws/kiro-usage";

/**
 * Athena/Glue identifier pattern. Database, table, and workgroup names are
 * interpolated into SQL as identifiers (not string literals), so they are
 * constrained to a safe character set to prevent injection. AWS Glue table and
 * database names allow letters, digits, and underscores; workgroup names also
 * allow dots and hyphens. This deliberately rejects quotes, whitespace, and
 * semicolons.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

/** CUR product code identifying Kiro line items. */
const KIRO_PRODUCT_CODE = "Kiro";

/** Usage-type prefix stripped to derive a bare tier name (Power / Pro / ProPlus). */
const TIER_PREFIX = "USE1-KiroEnterprise-";

/** Max attempts to poll an Athena query to a terminal state. */
const MAX_POLL_ATTEMPTS = 60;

/** Delay between Athena poll attempts, in milliseconds. */
const POLL_DELAY_MS = 2000;

/** Max result pages to accumulate from GetQueryResults (bounds memory/time). */
const MAX_RESULT_PAGES = 500;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the kiro-usage model. */
const GlobalArgsSchema = z.object({
  curProfile: z
    .string()
    .min(1)
    .default("default")
    .describe(
      "AWS profile with Athena + CUR S3 read access (the account hosting the CUR table)",
    ),
  identityStoreProfile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AWS profile with identitystore:DescribeUser (defaults to curProfile)",
    ),
  identityStoreId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IAM Identity Store id (e.g. d-1234567890); required when resolveIdentities is true",
    ),
  identityStoreRegion: z
    .string()
    .min(1)
    .default("us-east-1")
    .describe("Region for Identity Store API calls"),
  athenaRegion: z
    .string()
    .min(1)
    .default("us-east-1")
    .describe("Region for Athena and CUR queries"),
  athenaDatabase: z
    .string()
    .min(1)
    .regex(SAFE_IDENTIFIER, "athenaDatabase must be a valid identifier")
    .describe("Athena/Glue database containing the CUR table"),
  athenaTable: z
    .string()
    .min(1)
    .regex(SAFE_IDENTIFIER, "athenaTable must be a valid identifier")
    .describe("CUR table name within the Athena database"),
  athenaWorkgroup: z
    .string()
    .min(1)
    .regex(SAFE_IDENTIFIER, "athenaWorkgroup must be a valid identifier")
    .default("primary")
    .describe("Athena workgroup to run queries in"),
  athenaOutputLocation: z
    .string()
    .min(1)
    .describe(
      "S3 URI for Athena query results (e.g. s3://aws-athena-query-results-.../)",
    ),
  resolveIdentities: z
    .boolean()
    .default(true)
    .describe(
      "Resolve Identity Store user ids to names/emails. When false, rows carry raw user ids only (no PII).",
    ),
  mergeAccounts: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Optional map of secondary user id -> primary user id to fold duplicate/second accounts together",
    ),
});

/** A single user's Kiro usage and allocated spend for the billing period. */
const UserUsageSchema = z.object({
  userId: z.string().describe("IAM Identity Store user id from the CUR"),
  displayName: z.string().describe("Resolved display name, or empty"),
  email: z.string().describe("Resolved primary email, or empty"),
  username: z.string().describe("Resolved user name, or empty"),
  resolved: z.boolean().describe("Whether identity resolution succeeded"),
  plan: z.string().describe("Seat tier: Power, ProPlus, Pro, or (no seat)"),
  seatMonths: z.number().describe(
    "Prorated seat quantity for the period (1.0 = full month)",
  ),
  seatCostListUsd: z.number().describe("Seat subscription cost at list price"),
  seatCostNetUsd: z.number().describe(
    "Allocated net seat cost after the account-level EDP discount",
  ),
  credits: z.number().describe("Credits consumed in the period"),
  overageUsd: z.number().describe(
    "Billed credit overage in USD (0 while within allotment)",
  ),
});

/** Account-level discount reconciliation (EDP is not per-user attributable). */
const DiscountSchema = z.object({
  grossCostUsd: z.number().describe("Sum of seat subscription cost at list"),
  edpDiscountUsd: z.number().describe(
    "Account-level enterprise discount (negative of the discount magnitude)",
  ),
  netCostUsd: z.number().describe("Gross plus EDP discount (billed seat cost)"),
});

/** Per-tier rollup for the period. */
const TierRollupSchema = z.object({
  plan: z.string(),
  users: z.number(),
  seatCostListUsd: z.number(),
  seatCostNetUsd: z.number(),
  credits: z.number(),
});

/** Full scan-results resource for one billing period. */
const ScanResultsSchema = z.object({
  scannedAt: z.string().describe("ISO 8601 timestamp of the scan"),
  billingPeriod: z.string().describe(
    "Billing period start in YYYY-MM-DD form",
  ),
  currency: z.string().describe("Currency of all cost figures"),
  resolvedIdentities: z.boolean().describe(
    "Whether identity resolution was enabled for this scan",
  ),
  users: z.array(UserUsageSchema).describe(
    "Per-user usage and allocated spend, sorted by credits consumed",
  ),
  tiers: z.array(TierRollupSchema).describe("Per-tier rollup"),
  discount: DiscountSchema.describe("Account-level cost reconciliation"),
  totals: z.object({
    userCount: z.number().describe("Number of distinct users with a seat"),
    grossCostUsd: z.number().describe("Total seat cost at list price"),
    edpDiscountUsd: z.number().describe("Total account-level EDP discount"),
    netCostUsd: z.number().describe("Total billed seat cost (gross + EDP)"),
    creditsConsumed: z.number().describe("Total credits consumed"),
    overageUsd: z.number().describe("Total billed credit overage"),
  }).describe("Grand totals for the period"),
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
// Athena helpers
// ---------------------------------------------------------------------------

/** Build an Athena client for a profile/region. */
function createAthenaClient(profile: string, region: string): AthenaClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") opts.credentials = fromIni({ profile });
  return new AthenaClient(opts as { region: string });
}

/** Build an Identity Store client for a profile/region. */
function createIdentityStoreClient(
  profile: string,
  region: string,
): IdentitystoreClient {
  const opts: Record<string, unknown> = { region };
  if (profile !== "default") opts.credentials = fromIni({ profile });
  return new IdentitystoreClient(opts as { region: string });
}

/** Pause for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape a string for safe interpolation inside a single-quoted SQL literal.
 * Athena/Presto escapes a single quote by doubling it. Callers must still only
 * pass values that belong in a string literal position.
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run an Athena query to completion and return its result rows as arrays of
 * string cell values (including the header row as the first element).
 *
 * Throws with the Athena state-change reason if the query fails or is
 * cancelled, or if it does not reach a terminal state within the poll budget.
 */
async function runAthenaQuery(
  client: AthenaClient,
  sql: string,
  database: string,
  workgroup: string,
  outputLocation: string,
): Promise<string[][]> {
  let queryExecutionId: string | undefined;
  try {
    const start = await client.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        QueryExecutionContext: { Database: database },
        WorkGroup: workgroup,
        ResultConfiguration: { OutputLocation: outputLocation },
      }),
    );
    queryExecutionId = start.QueryExecutionId;
  } catch (err) {
    throw new Error(
      `Athena StartQueryExecution failed (database=${database}, workgroup=${workgroup}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!queryExecutionId) {
    throw new Error("Athena StartQueryExecution returned no QueryExecutionId");
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const exec = await client.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );
    const state = exec.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      const reason = exec.QueryExecution?.Status?.StateChangeReason ??
        "no reason given";
      throw new Error(
        `Athena query ${state} (id=${queryExecutionId}): ${reason}`,
      );
    }
    if (attempt === MAX_POLL_ATTEMPTS - 1) {
      throw new Error(
        `Athena query did not complete within ${
          (MAX_POLL_ATTEMPTS * POLL_DELAY_MS) / 1000
        }s (id=${queryExecutionId}, last state=${state})`,
      );
    }
    await sleep(POLL_DELAY_MS);
  }

  // Page through results, accumulating raw string cells. Bounded by
  // MAX_RESULT_PAGES so a large result set (or a non-clearing nextToken)
  // cannot grow memory or run without an upper bound.
  const rows: string[][] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const page = await client.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      }),
    );
    for (const r of page.ResultSet?.Rows ?? []) {
      rows.push((r.Data ?? []).map((d) => d.VarCharValue ?? ""));
    }
    nextToken = page.NextToken;
    pages++;
    if (nextToken && pages >= MAX_RESULT_PAGES) {
      throw new Error(
        `Athena query returned more than ${MAX_RESULT_PAGES} result pages ` +
          `(id=${queryExecutionId}); refusing to accumulate an unbounded ` +
          `result set. Narrow the query (e.g. a single billing period).`,
      );
    }
  } while (nextToken);

  return rows;
}

// ---------------------------------------------------------------------------
// CUR query construction and parsing
// ---------------------------------------------------------------------------

/**
 * Build the per-user CUR query. Emits one row per Identity Store user carrying
 * their tier, prorated seat quantity, list seat cost, and credits consumed for
 * the given billing period. The account-level EdpDiscount line has no resource
 * id and is intentionally excluded here (queried separately).
 */
function buildPerUserQuery(
  table: string,
  billingPeriodStart: string,
): string {
  return `
WITH kiro AS (
  SELECT
    regexp_extract(line_item_resource_id, 'user/(.*)$', 1) AS user_id,
    line_item_operation AS op,
    replace(line_item_usage_type, ${sqlLiteral(TIER_PREFIX)}, '') AS tier,
    line_item_usage_amount AS qty,
    line_item_unblended_cost AS cost
  FROM ${table}
  WHERE line_item_product_code = ${sqlLiteral(KIRO_PRODUCT_CODE)}
    AND bill_billing_period_start_date = TIMESTAMP ${
    sqlLiteral(`${billingPeriodStart} 00:00:00`)
  }
    AND line_item_resource_id LIKE '%user/%'
)
SELECT
  user_id,
  max(CASE WHEN op = 'monthly-subscription' THEN tier END) AS plan,
  coalesce(sum(CASE WHEN op = 'monthly-subscription' THEN qty END), 0) AS seat_months,
  coalesce(sum(CASE WHEN op = 'monthly-subscription' THEN cost END), 0) AS seat_list_cost,
  coalesce(sum(CASE WHEN op = 'Credits' THEN qty END), 0) AS credits
FROM kiro
GROUP BY user_id`;
}

/**
 * Build the account-level discount reconciliation query. Sums the gross
 * subscription cost and the EdpDiscount adjustment across all Kiro lines,
 * regardless of resource id.
 */
function buildDiscountQuery(
  table: string,
  billingPeriodStart: string,
): string {
  return `
SELECT
  coalesce(sum(CASE WHEN line_item_line_item_type = 'FlatRateSubscription' THEN line_item_unblended_cost END), 0) AS gross,
  coalesce(sum(CASE WHEN line_item_line_item_type = 'EdpDiscount' THEN line_item_unblended_cost END), 0) AS edp_discount,
  max(line_item_currency_code) AS currency
FROM ${table}
WHERE line_item_product_code = ${sqlLiteral(KIRO_PRODUCT_CODE)}
  AND bill_billing_period_start_date = TIMESTAMP ${
    sqlLiteral(`${billingPeriodStart} 00:00:00`)
  }`;
}

/** Convert an Athena result-set (with header row) into keyed record objects. */
function rowsToRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((key, i) => {
      rec[key] = cells[i] ?? "";
    });
    return rec;
  });
}

/** Parse a numeric string cell, returning 0 for blanks or non-numbers. */
function toNumber(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the first day of the previous month in YYYY-MM-DD form (UTC),
 * used as the default billing period (the most recent complete month).
 */
function previousMonthStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based; previous month is month-1
  const prev = new Date(Date.UTC(year, month - 1, 1));
  const y = prev.getUTCFullYear();
  const m = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/** Resolved identity fields for a single user. */
interface ResolvedIdentity {
  displayName: string;
  email: string;
  username: string;
  resolved: boolean;
}

/** Empty (unresolved) identity placeholder. */
function emptyIdentity(): ResolvedIdentity {
  return { displayName: "", email: "", username: "", resolved: false };
}

/**
 * Resolve a single Identity Store user id to name/email. Some CUR resource ids
 * carry the store prefix (e.g. `d-xxxx`-derived `xxxx-<guid>`) and must be
 * passed intact; others are bare GUIDs. Try the id as-is first, then the
 * prefix-stripped form, before giving up.
 */
async function resolveIdentity(
  client: IdentitystoreClient,
  identityStoreId: string,
  userId: string,
): Promise<ResolvedIdentity> {
  const storePrefix = identityStoreId.replace(/^d-/, "") + "-";
  const candidates = [userId];
  if (userId.startsWith(storePrefix)) {
    candidates.push(userId.slice(storePrefix.length));
  }

  for (const candidate of candidates) {
    try {
      const resp = await client.send(
        new DescribeUserCommand({
          IdentityStoreId: identityStoreId,
          UserId: candidate,
        }),
      );
      const emails = resp.Emails ?? [];
      const primary = emails.find((e) => e.Primary) ?? emails[0];
      return {
        displayName: resp.DisplayName ??
          [resp.Name?.FamilyName, resp.Name?.GivenName]
            .filter(Boolean)
            .join(", "),
        email: primary?.Value ?? "",
        username: resp.UserName ?? "",
        resolved: true,
      };
    } catch (_err) {
      // Try the next candidate id form.
      continue;
    }
  }
  return emptyIdentity();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Apply the mergeAccounts map, folding secondary user ids into their primary.
 * Seat cost, credits, seat-months, and overage accumulate; identity fields are
 * taken from the primary's own row when it has one, otherwise from the first
 * contributor seen. Plan prefers the primary's own plan, else the first
 * non-empty plan.
 *
 * The accumulator for each target is seeded as a zeroed row, and EVERY user
 * (primary and secondary alike) is added exactly once keyed by its target id.
 * The primary's own row is not special-cased — it is just another contributor.
 * This keeps the result independent of the (arbitrary) order Athena returns
 * grouped rows in.
 */
function mergeUsers(
  users: Array<z.infer<typeof UserUsageSchema>>,
  mergeMap: Record<string, string>,
): Array<z.infer<typeof UserUsageSchema>> {
  if (Object.keys(mergeMap).length === 0) return users;
  const byId = new Map<string, z.infer<typeof UserUsageSchema>>();
  for (const u of users) byId.set(u.userId, u);

  const result = new Map<string, z.infer<typeof UserUsageSchema>>();
  for (const u of users) {
    const targetId = mergeMap[u.userId] ?? u.userId;
    let acc = result.get(targetId);
    if (!acc) {
      // Seed a zeroed accumulator. Prefer the target's own identity/plan when
      // the target has a row of its own; otherwise fall back to this
      // contributor's identity as a placeholder until the primary is seen.
      const identitySource = byId.get(targetId) ?? u;
      acc = {
        userId: targetId,
        displayName: identitySource.displayName,
        email: identitySource.email,
        username: identitySource.username,
        resolved: identitySource.resolved,
        plan: "",
        seatMonths: 0,
        seatCostListUsd: 0,
        seatCostNetUsd: 0,
        credits: 0,
        overageUsd: 0,
      };
      result.set(targetId, acc);
    }
    acc.seatMonths += u.seatMonths;
    acc.seatCostListUsd += u.seatCostListUsd;
    acc.seatCostNetUsd += u.seatCostNetUsd;
    acc.credits += u.credits;
    acc.overageUsd += u.overageUsd;

    const isPrimaryOwnRow = u.userId === targetId;
    if (isPrimaryOwnRow) {
      // The primary's own row is authoritative for identity and plan.
      acc.displayName = u.displayName;
      acc.email = u.email;
      acc.username = u.username;
      acc.resolved = u.resolved;
      if (u.plan) acc.plan = u.plan;
    } else if (!acc.plan && u.plan && u.plan !== "(no seat)") {
      // A secondary can seed the plan only until the primary supplies one.
      acc.plan = u.plan;
    }
  }

  // Any accumulator that never received a plan (e.g. all contributors were
  // "(no seat)") defaults to "(no seat)" to match the non-merged path.
  for (const acc of result.values()) {
    if (!acc.plan) acc.plan = "(no seat)";
  }
  return [...result.values()];
}

/** Tier ordering weight for stable display sorting. */
function tierWeight(plan: string): number {
  switch (plan) {
    case "Power":
      return 0;
    case "ProPlus":
      return 1;
    case "Pro":
      return 2;
    default:
      return 3;
  }
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Context shape for the scan method. */
interface ScanContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
  };
}

/** AWS Kiro per-user usage and spend model. */
export const model = {
  type: "@webframp/aws/kiro-usage",
  version: "2026.09.04.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.04.1",
      description:
        "Dependency bump: AWS SDK 3.1121.0 → 3.1126.0, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    scan_results: {
      description:
        "Per-user Kiro usage and allocated spend for one billing period",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    scan: {
      description:
        "Query the CUR via Athena for per-user Kiro seat cost and credit " +
        "consumption in a billing period, resolve Identity Store principals " +
        "to names/emails, and reconcile the account-level EDP discount.",
      arguments: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "Billing period start (YYYY-MM-DD, first of month). Defaults to the most recent complete month.",
          ),
      }),
      execute: async (
        args: { month?: string },
        context: ScanContext,
      ) => {
        const startMs = Date.now();
        const g = context.globalArgs;
        const billingPeriod = args.month ?? previousMonthStart(new Date());

        const athena = createAthenaClient(g.curProfile, g.athenaRegion);

        let userRecords: Record<string, string>[];
        let discountRecord: Record<string, string>;
        try {
          const [userRows, discountRows] = await Promise.all([
            runAthenaQuery(
              athena,
              buildPerUserQuery(g.athenaTable, billingPeriod),
              g.athenaDatabase,
              g.athenaWorkgroup,
              g.athenaOutputLocation,
            ),
            runAthenaQuery(
              athena,
              buildDiscountQuery(g.athenaTable, billingPeriod),
              g.athenaDatabase,
              g.athenaWorkgroup,
              g.athenaOutputLocation,
            ),
          ]);
          userRecords = rowsToRecords(userRows);
          discountRecord = rowsToRecords(discountRows)[0] ?? {};
        } finally {
          athena.destroy();
        }

        // Account-level reconciliation. EdpDiscount rows are negative.
        const grossCostUsd = toNumber(discountRecord.gross);
        const edpDiscountUsd = toNumber(discountRecord.edp_discount);
        const netCostUsd = grossCostUsd + edpDiscountUsd;
        const currency = discountRecord.currency || "USD";

        // Per-tier net/list ratio, used to allocate the account-level discount
        // down to individual users. Computed from the gross vs. net totals so
        // the allocation reconciles to the billed figure. Falls back to 1.0
        // (no discount) when gross is zero.
        const netRatio = grossCostUsd > 0 ? netCostUsd / grossCostUsd : 1;

        // Resolve identities if enabled.
        let identityClient: IdentitystoreClient | null = null;
        const resolveEnabled = g.resolveIdentities &&
          !!g.identityStoreId;
        if (g.resolveIdentities && !g.identityStoreId) {
          context.logger.warn(
            "resolveIdentities is true but identityStoreId is unset; skipping resolution",
            {},
          );
        }
        if (resolveEnabled) {
          identityClient = createIdentityStoreClient(
            g.identityStoreProfile ?? g.curProfile,
            g.identityStoreRegion,
          );
        }

        const users: Array<z.infer<typeof UserUsageSchema>> = [];
        try {
          for (const rec of userRecords) {
            const userId = rec.user_id;
            if (!userId) continue;
            const seatListCost = toNumber(rec.seat_list_cost);
            const identity = resolveEnabled && identityClient
              ? await resolveIdentity(
                identityClient,
                g.identityStoreId as string,
                userId,
              )
              : emptyIdentity();

            users.push({
              userId,
              displayName: identity.displayName,
              email: identity.email,
              username: identity.username,
              resolved: identity.resolved,
              plan: rec.plan || "(no seat)",
              seatMonths: toNumber(rec.seat_months),
              seatCostListUsd: seatListCost,
              seatCostNetUsd: Math.round(seatListCost * netRatio * 100) / 100,
              credits: toNumber(rec.credits),
              overageUsd: 0,
            });
          }
        } finally {
          identityClient?.destroy();
        }

        const mergedUsers = mergeUsers(users, g.mergeAccounts);

        // Reconcile summed per-user net to the account-level billed net.
        // Each seatCostNetUsd was independently rounded to cents, so the sum
        // can drift from netCostUsd by a few cents. Apply the residual to the
        // largest-seat user so the per-user (and per-tier) net column sums
        // exactly to the billed figure. Only meaningful when there is a real
        // gross->net relationship; when gross is 0 the net ratio is 1.0 and
        // per-user nets equal list, so there is nothing to reconcile.
        if (mergedUsers.length > 0 && grossCostUsd > 0) {
          const summedNet = mergedUsers.reduce(
            (s, u) => s + u.seatCostNetUsd,
            0,
          );
          const residual = Math.round((netCostUsd - summedNet) * 100) / 100;
          if (residual !== 0) {
            let target = mergedUsers[0];
            for (const u of mergedUsers) {
              if (u.seatCostNetUsd > target.seatCostNetUsd) target = u;
            }
            target.seatCostNetUsd = Math.round(
              (target.seatCostNetUsd + residual) * 100,
            ) / 100;
          }
        }

        // Sort by tier weight, then by credits consumed descending.
        mergedUsers.sort((a, b) =>
          tierWeight(a.plan) - tierWeight(b.plan) ||
          b.credits - a.credits
        );

        // Per-tier rollup.
        const tierMap = new Map<string, z.infer<typeof TierRollupSchema>>();
        for (const u of mergedUsers) {
          const t = tierMap.get(u.plan) ?? {
            plan: u.plan,
            users: 0,
            seatCostListUsd: 0,
            seatCostNetUsd: 0,
            credits: 0,
          };
          t.users += 1;
          t.seatCostListUsd += u.seatCostListUsd;
          t.seatCostNetUsd += u.seatCostNetUsd;
          t.credits += u.credits;
          tierMap.set(u.plan, t);
        }
        const tiers = [...tierMap.values()].sort(
          (a, b) => tierWeight(a.plan) - tierWeight(b.plan),
        );

        const creditsConsumed = mergedUsers.reduce(
          (s, u) => s + u.credits,
          0,
        );
        const overageUsd = mergedUsers.reduce((s, u) => s + u.overageUsd, 0);

        const result = {
          scannedAt: new Date().toISOString(),
          billingPeriod,
          currency,
          resolvedIdentities: resolveEnabled,
          users: mergedUsers,
          tiers,
          discount: {
            grossCostUsd,
            edpDiscountUsd,
            netCostUsd,
          },
          totals: {
            userCount: mergedUsers.length,
            grossCostUsd,
            edpDiscountUsd,
            netCostUsd,
            creditsConsumed,
            overageUsd,
          },
        };

        context.logger.info("Kiro usage scan complete", {
          billingPeriod,
          userCount: mergedUsers.length,
          netCostUsd,
          creditsConsumed,
        });

        const handle = await context.writeResource(
          "scan_results",
          billingPeriod,
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

// Exported for the companion report extension and tests.
export {
  buildDiscountQuery,
  buildPerUserQuery,
  mergeUsers,
  previousMonthStart,
  rowsToRecords,
  ScanResultsSchema,
  tierWeight,
  toNumber,
};
