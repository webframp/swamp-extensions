/**
 * Claude Enterprise Analytics model for swamp.
 *
 * Observes enterprise analytics via the Claude Enterprise Analytics API
 * (`/v1/organizations/analytics/*`): organization-level active-user
 * summaries (DAU/WAU/MAU, seat counts, pending invites), per-user feature
 * adoption (projects, skills, connectors) aggregated org-wide, and token
 * cost/usage on usage-based Enterprise plans. Requires an Analytics API key
 * (scope read:analytics) created by the primary owner in claude.ai.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

const EXTENSION_NAME = "@webframp/anthropic/analytics";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  analyticsKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Analytics API key (scope read:analytics) from claude.ai (use vault reference)",
  ),
  discountRate: z.number().min(0).max(1).default(0).describe(
    "Enterprise volume discount off list usage/token pricing, as a fraction " +
      '(e.g. 0.15 for "15% off"). Applied to cost/user-usage totals derived ' +
      "from the Analytics API's list-price `amount` fields; list-price " +
      "reference fields (listCostUsd) are left unadjusted.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Enterprise Analytics ---

/** Raw per-day summary rows exactly as returned by /analytics/summaries. */
const AnalyticsSnapshotSchema = z.object({
  summaries: z.array(z.record(z.string(), z.unknown())).describe(
    "Raw per-day summary rows as returned by /analytics/summaries",
  ),
  count: z.number().describe("Number of summary rows returned"),
  dataRefreshedAt: z.string().nullable().describe(
    "ISO 8601 timestamp the API last refreshed its underlying data, or null",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this snapshot was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const SeatCountSchema = z.object({
  total: z.number().nullable().describe("Total assigned seat count"),
  active: z.number().nullable().describe(
    "Active seats for the latest summarized day (mirrors dau)",
  ),
  pending_invites: z.number().nullable().describe(
    "Number of pending seat invitations",
  ),
  dau: z.number().nullable().describe("Daily active user count"),
  wau: z.number().nullable().describe("Weekly active user count"),
  mau: z.number().nullable().describe("Monthly active user count"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this seat count was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/**
 * Feature adoption as adopter counts — how many users used ≥1 project / skill /
 * connector on the queried day. There is no org-level adoption endpoint; these
 * are aggregated from the per-user /analytics/users records.
 */
const AdoptionMetricsSchema = z.object({
  projects: z.number().nullable().describe(
    "Number of users who used at least one project on the queried day",
  ),
  skills: z.number().nullable().describe(
    "Number of users who used at least one skill on the queried day",
  ),
  connectors: z.number().nullable().describe(
    "Number of users who used at least one connector on the queried day",
  ),
  // false when the /users collection failed — distinguishes "error" from a
  // legitimately empty org (all-null with collected=true).
  collected: z.boolean().describe(
    "Whether the /users collection succeeded (false distinguishes an error from a legitimately empty org)",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when adoption metrics were fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const CostSchema = z.object({
  total_cents: z.number().describe(
    "Total token usage cost in USD cents, after discountRate",
  ),
  total_usd: z.number().describe(
    "Total token usage cost in USD, after discountRate",
  ),
  currency: z.string().describe("Currency code for the cost totals"),
  by_cost_type: z.record(z.string(), z.number()).describe(
    "Cost in USD cents broken down by cost_type, after discountRate",
  ),
  // Discount rate applied to total_cents/total_usd/by_cost_type (fraction).
  discountRate: z.number().describe(
    "Discount rate applied to total_cents/total_usd/by_cost_type (fraction)",
  ),
  startingAt: z.string().describe("Window start (ISO 8601 timestamp)"),
  endingAt: z.string().nullable().describe(
    "Window end (ISO 8601 timestamp), or null if open-ended",
  ),
  dataRefreshedAt: z.string().nullable().describe(
    "ISO 8601 timestamp the API last refreshed its underlying cost data, or null",
  ),
  // false when the /cost_report collection failed — distinguishes "error"
  // from a seat-based org with genuinely zero usage cost.
  collected: z.boolean().describe(
    "Whether the /cost_report collection succeeded (false distinguishes an error from a seat-based org with genuinely zero usage cost)",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when cost data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** One product's usage + cost for a single user over the window. */
const UserProductUsageSchema = z.object({
  product: z.string().describe("Product identifier (e.g. claude_code, chat)"),
  totalTokens: z.number().nullable().describe(
    "Total tokens for this product (excludes cache_creation tokens per the Analytics API)",
  ),
  outputTokens: z.number().nullable().describe(
    "Output tokens for this product",
  ),
  uncachedInputTokens: z.number().nullable().describe(
    "Uncached input tokens for this product",
  ),
  cacheReadInputTokens: z.number().nullable().describe(
    "Cache-read input tokens for this product",
  ),
  requests: z.number().nullable().describe("Request count for this product"),
  costUsd: z.number().nullable().describe(
    "Cost in USD for this product, after discountRate",
  ),
  listCostUsd: z.number().nullable().describe(
    "List-price cost in USD for this product, never discounted",
  ),
});

/** Per-user usage + cost across products (Claude Code broken out by `product`). */
const UserUsageRecordSchema = z.object({
  userId: z.string().describe("Unique user identifier"),
  email: z.string().nullable().describe("User's email address, if known"),
  name: z.string().nullable().describe("User's display name, if known"),
  totalTokens: z.number().describe(
    "Total tokens across all products for this user",
  ),
  totalCostUsd: z.number().describe(
    "Total cost in USD across all products for this user, after discountRate",
  ),
  byProduct: z.array(UserProductUsageSchema).describe(
    "Per-product usage and cost breakdown for this user",
  ),
});

/**
 * Grand totals across all returned users, in the shape @webframp/ai-usage's
 * generic provider registry expects (inputTokens/outputTokens/totalTokens
 * plus per-minute rates) so this resource can be dropped into that registry
 * without a bespoke adapter.
 */
const UserUsageTotalsSchema = z.object({
  inputTokens: z.number().describe(
    "Sum of uncached + cache-read input tokens across returned users",
  ),
  outputTokens: z.number().describe(
    "Sum of output tokens across returned users",
  ),
  totalTokens: z.number().describe("Sum of total tokens across returned users"),
  inputTokensPerMinute: z.number().describe(
    "Input tokens per minute over the window",
  ),
  outputTokensPerMinute: z.number().describe(
    "Output tokens per minute over the window",
  ),
});

const UserUsageSchema = z.object({
  startingAt: z.string().describe("Window start (ISO 8601 timestamp)"),
  endingAt: z.string().describe("Window end (ISO 8601 timestamp)"),
  filteredEmail: z.string().nullable().describe(
    "Email the results were filtered to, or null if unfiltered",
  ),
  users: z.array(UserUsageRecordSchema).describe(
    "Per-user usage and cost records, sorted by cost then tokens descending",
  ),
  totals: UserUsageTotalsSchema.describe(
    "Grand totals across returned users, in the shape @webframp/ai-usage's provider registry expects",
  ),
  // Discount rate applied to costUsd/totalCostUsd (fraction); listCostUsd is
  // always list price and is never adjusted.
  discountRate: z.number().describe(
    "Discount rate applied to costUsd/totalCostUsd (fraction); listCostUsd is never adjusted",
  ),
  count: z.number().describe("Number of users returned"),
  dataRefreshedAt: z.string().nullable().describe(
    "ISO 8601 timestamp the API last refreshed its underlying data, or null",
  ),
  // false when the report fetch failed (not an Enterprise plan, or the key
  // lacks read:analytics) — distinguishes error from a genuinely empty window.
  collected: z.boolean().describe(
    "Whether either report fetch succeeded (false distinguishes an error from a genuinely empty window)",
  ),
  error: z.string().nullable().describe(
    "Error message if either report failed, or null",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this usage data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// API Client
// =============================================================================

const BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

type QueryParams = Record<string, string | string[]>;

/** Make an authenticated request to the Analytics API. */
async function analyticsRequest(
  key: string,
  path: string,
  params?: QueryParams,
): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) if (item !== "") url.searchParams.append(k, item);
      } else if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Analytics API ${path}: ${resp.status} ${body}`);
  }
  return resp.json();
}

/**
 * Follow `next_page` cursors, accumulating the `data` array. Handles both the
 * cursor-only shape (/users: `next_page` string|null) and the has_more shape
 * (/cost_report: `has_more` + `next_page`).
 */
async function paginateAll(
  key: string,
  path: string,
  params: QueryParams,
): Promise<{ items: any[]; dataRefreshedAt: string | null }> {
  const items: any[] = [];
  let page: string | undefined;
  let dataRefreshedAt: string | null = null;
  // Bound the loop and stop if a server returns a non-advancing cursor, so a
  // buggy endpoint can neither hang nor accumulate duplicate rows forever.
  const MAX_PAGES = 200;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const p: QueryParams = { ...params };
    if (page) p.page = page;
    const data = await analyticsRequest(key, path, p);
    const batch = data.data ?? [];
    items.push(...batch);
    dataRefreshedAt = data.data_refreshed_at ?? dataRefreshedAt;
    const next: string | undefined = data.next_page ?? undefined;
    if (!next || seen.has(next)) break;
    seen.add(next);
    page = next;
  }
  return { items, dataRefreshedAt };
}

// =============================================================================
// Date helpers
// =============================================================================

/** Format a Date as a UTC YYYY-MM-DD string. */
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC YYYY-MM-DD for `n` days before now. */
function daysAgoYmd(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toYmd(d);
}

/** Matches a UTC YYYY-MM-DD date string. */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw with the offending value if `s` isn't a well-formed YYYY-MM-DD date. */
function assertYmd(s: string, argName: string): void {
  if (!YMD_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
    throw new Error(
      `${argName} (${s}) is not a valid YYYY-MM-DD date`,
    );
  }
}

/** Throw if `endingAt` isn't strictly after `startingAt` (both ISO timestamps). */
function assertRange(startingAt: string, endingAt: string): void {
  const start = new Date(startingAt).getTime();
  const end = new Date(endingAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(
      `Cannot compare date range: startingAt (${startingAt}) or endingAt (${endingAt}) is not a valid ISO 8601 timestamp`,
    );
  }
  if (end <= start) {
    throw new Error(
      `endDate (${endingAt}) must be after startDate (${startingAt})`,
    );
  }
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn?: (msg: string, props: Record<string, unknown>) => void;
  };
};

/** Coerce an API numeric field to a finite number, or null if absent/invalid. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A data-instance-safe token (no slashes/spaces) from an arbitrary string. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "user";
}

/** True if any per-product metric block on a user record shows field > 0. */
function usedAcrossProducts(user: any, field: string): boolean {
  const blocks = [
    user.chat_metrics,
    user.cowork_metrics,
    user.office_metrics,
    user.design_metrics,
  ];
  return blocks.some((b) => b && (Number(b[field]) || 0) > 0);
}

// =============================================================================
// Model Definition
// =============================================================================

/** Claude Enterprise Analytics — seat counts, adoption, DAU/WAU/MAU, and cost via the Analytics API. */
export const model = {
  type: "@webframp/anthropic/analytics",
  version: "2026.08.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.14.1",
      description:
        "Add discountRate global arg; cost and userUsage resources gain " +
        "a discountRate field, userUsage gains a totals field",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.1",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    snapshot: {
      description:
        "Raw per-day activity summaries from /analytics/summaries (DAU/WAU/MAU, seats, per-product counts)",
      schema: AnalyticsSnapshotSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    seats: {
      description:
        "Seat allocation and activity counts for the latest summarized day (total, active, pending, DAU/WAU/MAU)",
      schema: SeatCountSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    adoption: {
      description:
        "Feature adoption as adopter counts (users using ≥1 project, skill, connector), aggregated from /analytics/users",
      schema: AdoptionMetricsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    cost: {
      description:
        "Token cost/usage over the window from /analytics/cost_report (usage-based Enterprise plans; zeroed otherwise)",
      schema: CostSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    userUsage: {
      description:
        "Per-user token usage + cost across products (incl. claude_code) from /analytics/user_usage_report and /user_cost_report; optionally filtered to one email.",
      schema: UserUsageSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    collect_analytics: {
      description:
        "Collect the enterprise analytics snapshot: activity summaries, feature adoption, and cost. Fans out across /summaries, /users, and /cost_report.",
      arguments: z.object({
        startDate: z.string().optional().describe(
          "Start date (YYYY-MM-DD, UTC, inclusive; no earlier than 2026-01-01). Defaults to 7 days ago.",
        ),
        endDate: z.string().optional().describe(
          "End date (YYYY-MM-DD, UTC, exclusive). Defaults to today.",
        ),
      }),
      execute: async (
        args: { startDate?: string; endDate?: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.analyticsKey;
        const nowIso = new Date().toISOString();
        const startDate = args.startDate ?? daysAgoYmd(7);
        assertYmd(startDate, "startDate");
        const endDate = args.endDate;
        if (endDate) {
          assertYmd(endDate, "endDate");
          assertRange(`${startDate}T00:00:00Z`, `${endDate}T00:00:00Z`);
        }
        const handles: { name: string }[] = [];

        // --- 1) Activity summaries (core; failure here fails the method) ------
        const summaryData = await analyticsRequest(
          key,
          "/v1/organizations/analytics/summaries",
          {
            starting_date: startDate,
            ...(endDate ? { ending_date: endDate } : {}),
          },
        );
        const summaries: any[] = summaryData.summaries ?? [];

        // swamp reserves the instance name "latest" for internal use.
        handles.push(
          await ctx.writeResource("snapshot", "recent", {
            summaries,
            count: summaries.length,
            dataRefreshedAt: summaryData.data_refreshed_at ?? null,
            fetchedAt: nowIso,
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

        // Latest summarized day = row with the greatest starting_at. Ignore
        // rows without a usable starting_at so a malformed row cannot win the
        // reduce (String(undefined) sorts above any real ISO timestamp).
        const dated = summaries.filter((s) =>
          typeof s.starting_at === "string" && s.starting_at.length > 0
        );
        const latest = dated.length > 0
          ? dated.reduce((a, b) =>
            (a.starting_at as string) >= (b.starting_at as string) ? a : b
          )
          : null;

        handles.push(
          await ctx.writeResource("seats", "current", {
            total: num(latest?.assigned_seat_count),
            active: num(latest?.daily_active_user_count),
            pending_invites: num(latest?.pending_invite_count),
            dau: num(latest?.daily_active_user_count),
            wau: num(latest?.weekly_active_user_count),
            mau: num(latest?.monthly_active_user_count),
            fetchedAt: nowIso,
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

        // The day to attribute per-user adoption and cost to.
        const dayYmd = latest?.starting_at
          ? String(latest.starting_at).slice(0, 10)
          : startDate;

        // --- 2) Per-user adoption (best-effort) -------------------------------
        try {
          const { items: users } = await paginateAll(
            key,
            "/v1/organizations/analytics/users",
            { date: dayYmd, limit: "1000" },
          );
          const has = users.length > 0;
          let projects = 0, skills = 0, connectors = 0;
          for (const u of users) {
            if (usedAcrossProducts(u, "distinct_projects_used_count")) {
              projects++;
            }
            if (usedAcrossProducts(u, "distinct_skills_used_count")) skills++;
            if (usedAcrossProducts(u, "distinct_connectors_used_count")) {
              connectors++;
            }
          }
          handles.push(
            await ctx.writeResource("adoption", "adoption", {
              projects: has ? projects : null,
              skills: has ? skills : null,
              connectors: has ? connectors : null,
              collected: true,
              fetchedAt: nowIso,
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            }),
          );
        } catch (err) {
          (ctx.logger.warn ?? ctx.logger.info)(
            "adoption collection failed: {error}",
            { error: String(err) },
          );
          handles.push(
            await ctx.writeResource("adoption", "adoption", {
              projects: null,
              skills: null,
              connectors: null,
              collected: false,
              fetchedAt: nowIso,
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            }),
          );
        }

        // --- 3) Cost/usage (best-effort; not present on seat-based plans) -----
        const startingAt = `${startDate}T00:00:00Z`;
        const endingAt = endDate ? `${endDate}T00:00:00Z` : null;
        try {
          const { items: buckets, dataRefreshedAt } = await paginateAll(
            key,
            "/v1/organizations/analytics/cost_report",
            {
              starting_at: startingAt,
              ...(endingAt ? { ending_at: endingAt } : {}),
              bucket_width: "1d",
              // Analytics cost_report group_by dimensions differ from the
              // Console cost API; cost_type is what we break totals down by.
              "group_by[]": ["cost_type"],
            },
          );
          let totalCents = 0;
          const byCostType: Record<string, number> = {};
          for (const bucket of buckets) {
            for (const r of (bucket.results ?? [])) {
              const amt = parseFloat(r.amount ?? "0") || 0;
              totalCents += amt;
              const ct = r.cost_type ?? "unknown";
              byCostType[ct] = (byCostType[ct] ?? 0) + amt;
            }
          }
          const discountRate = ctx.globalArgs.discountRate ?? 0;
          const factor = 1 - discountRate;
          const discountedByCostType: Record<string, number> = {};
          for (const [ct, amt] of Object.entries(byCostType)) {
            discountedByCostType[ct] = amt * factor;
          }
          handles.push(
            await ctx.writeResource("cost", "window", {
              total_cents: totalCents * factor,
              total_usd: (totalCents * factor) / 100,
              currency: "USD",
              by_cost_type: discountedByCostType,
              discountRate,
              startingAt,
              endingAt,
              dataRefreshedAt: dataRefreshedAt ?? null,
              collected: true,
              fetchedAt: nowIso,
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            }),
          );
        } catch (err) {
          (ctx.logger.warn ?? ctx.logger.info)(
            "cost collection failed: {error}",
            { error: String(err) },
          );
          handles.push(
            await ctx.writeResource("cost", "window", {
              total_cents: 0,
              total_usd: 0,
              currency: "USD",
              by_cost_type: {},
              discountRate: ctx.globalArgs.discountRate ?? 0,
              startingAt,
              endingAt,
              dataRefreshedAt: null,
              collected: false,
              fetchedAt: nowIso,
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            }),
          );
        }

        ctx.logger.info(
          "Collected analytics: {days} summary days, {handles} resources",
          { days: summaries.length, handles: handles.length },
        );
        return { dataHandles: handles };
      },
    },

    collect_user_usage: {
      description:
        "Per-user token usage and cost from the Enterprise Analytics user_usage_report + user_cost_report endpoints, grouped by product (Claude Code broken out). Optionally filter to one user by email. Degrades (collected:false) rather than throwing when the reports are unavailable (e.g. seat-based plan or missing read:analytics scope).",
      arguments: z.object({
        days: z.number().min(1).max(31).optional().describe(
          "Lookback window in days, ending now (mutually redundant with " +
            "startDate — startDate wins if both are given). Capped at 31, " +
            "the API's max window. Defaults to 30 when neither is given.",
        ),
        startDate: z.string().optional().describe(
          "Start (YYYY-MM-DD, UTC, no earlier than 2026-01-01). Defaults to " +
            "`days` (or 30 days ago if `days` is also omitted). Window spans " +
            "at most 31 days.",
        ),
        endDate: z.string().optional().describe(
          "End (YYYY-MM-DD, UTC). Defaults to now.",
        ),
        email: z.string().optional().describe(
          "If set, keep only the user whose actor.email matches (case-insensitive).",
        ),
        products: z.array(z.string()).optional().describe(
          'Product filter, e.g. ["claude_code"]. Omit for all products; rows are grouped by product either way.',
        ),
      }),
      execute: async (
        args: {
          days?: number;
          startDate?: string;
          endDate?: string;
          email?: string;
          products?: string[];
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.analyticsKey;
        const nowIso = new Date().toISOString();
        const start = args.startDate ?? daysAgoYmd(args.days ?? 30);
        assertYmd(start, "startDate");
        if (args.endDate) assertYmd(args.endDate, "endDate");
        const startingAt = `${start}T00:00:00Z`;
        const endingAt = args.endDate ? `${args.endDate}T00:00:00Z` : nowIso;
        assertRange(startingAt, endingAt);
        const emailFilter = args.email?.trim().toLowerCase() || null;
        const products = args.products;
        const instance = emailFilter ? sanitize(emailFilter) : "all";

        const baseParams: QueryParams = {
          starting_at: startingAt,
          ending_at: endingAt,
          "group_by[]": ["product"],
          limit: "1000",
          ...(products && products.length ? { "products[]": products } : {}),
        };

        type Prod = {
          product: string;
          totalTokens: number | null;
          outputTokens: number | null;
          uncachedInputTokens: number | null;
          cacheReadInputTokens: number | null;
          requests: number | null;
          costUsd: number | null;
          listCostUsd: number | null;
        };
        type Rec = {
          userId: string;
          email: string | null;
          name: string | null;
          byProduct: Map<string, Prod>;
        };
        const byUser = new Map<string, Rec>();
        const rec = (a: any): Rec => {
          const id = a?.user_id ?? "unknown";
          let r = byUser.get(id);
          if (!r) {
            r = {
              userId: id,
              email: a?.email ?? null,
              name: a?.name ?? null,
              byProduct: new Map(),
            };
            byUser.set(id, r);
          }
          if (!r.email && a?.email) r.email = a.email;
          if (!r.name && a?.name) r.name = a.name;
          return r;
        };
        const prod = (r: Rec, product: string): Prod => {
          let p = r.byProduct.get(product);
          if (!p) {
            p = {
              product,
              totalTokens: null,
              outputTokens: null,
              uncachedInputTokens: null,
              cacheReadInputTokens: null,
              requests: null,
              costUsd: null,
              listCostUsd: null,
            };
            r.byProduct.set(product, p);
          }
          return p;
        };
        const addNum = (cur: number | null, v: unknown): number | null => {
          const n = num(v);
          return n === null ? cur : (cur ?? 0) + n;
        };

        // The two reports fail INDEPENDENTLY: a seat-based plan commonly serves
        // user_usage_report (tokens) while user_cost_report 403s. Collect each
        // under its own try so a cost failure never discards the token data —
        // mirrors collect_analytics's per-source best-effort.
        let dataRefreshedAt: string | null = null;
        let usageOk = false;
        let costOk = false;
        let errorMsg: string | null = null;

        try {
          // Usage report — tokens and requests, grouped by product.
          const usage = await paginateAll(
            key,
            "/v1/organizations/analytics/user_usage_report",
            { ...baseParams, order_by: "total_tokens", order: "desc" },
          );
          dataRefreshedAt = usage.dataRefreshedAt ?? dataRefreshedAt;
          for (const row of usage.items) {
            const p = prod(rec(row.actor), row.product ?? "unknown");
            p.totalTokens = addNum(p.totalTokens, row.total_tokens);
            p.outputTokens = addNum(p.outputTokens, row.output_tokens);
            p.uncachedInputTokens = addNum(
              p.uncachedInputTokens,
              row.uncached_input_tokens,
            );
            p.cacheReadInputTokens = addNum(
              p.cacheReadInputTokens,
              row.cache_read_input_tokens,
            );
            p.requests = addNum(p.requests, row.requests);
          }
          usageOk = true;
        } catch (err) {
          errorMsg = `user_usage_report: ${String(err)}`;
          (ctx.logger.warn ?? ctx.logger.info)(
            "user usage report failed: {error}",
            { error: String(err) },
          );
        }

        try {
          // Cost report — `amount`/`list_amount` are USD minor units (cents).
          const cost = await paginateAll(
            key,
            "/v1/organizations/analytics/user_cost_report",
            { ...baseParams },
          );
          dataRefreshedAt = cost.dataRefreshedAt ?? dataRefreshedAt;
          for (const row of cost.items) {
            const p = prod(rec(row.actor), row.product ?? "unknown");
            const amt = num(row.amount);
            if (amt !== null) p.costUsd = (p.costUsd ?? 0) + amt / 100;
            const list = num(row.list_amount);
            if (list !== null) {
              p.listCostUsd = (p.listCostUsd ?? 0) + list / 100;
            }
          }
          costOk = true;
        } catch (err) {
          const m = `user_cost_report: ${String(err)}`;
          errorMsg = errorMsg ? `${errorMsg}; ${m}` : m;
          (ctx.logger.warn ?? ctx.logger.info)(
            "user cost report failed: {error}",
            { error: String(err) },
          );
        }

        // Collected if EITHER report returned; error carries any partial reason.
        const collected = usageOk || costOk;
        // Round per-row cent-division noise off the aggregated dollar totals.
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const discountRate = ctx.globalArgs.discountRate ?? 0;
        const factor = 1 - discountRate;

        let users = [...byUser.values()].map((r) => {
          const byProduct = [...r.byProduct.values()].map((p) => ({
            ...p,
            // costUsd reflects the API's list-price `amount`; apply the
            // enterprise discount here. listCostUsd is already the explicit
            // list-price reference and stays unadjusted.
            costUsd: p.costUsd === null ? null : r2(p.costUsd * factor),
            listCostUsd: p.listCostUsd === null ? null : r2(p.listCostUsd),
          }));
          return {
            userId: r.userId,
            email: r.email,
            name: r.name,
            totalTokens: byProduct.reduce(
              (t, p) => t + (p.totalTokens ?? 0),
              0,
            ),
            totalCostUsd: r2(
              byProduct.reduce((t, p) => t + (p.costUsd ?? 0), 0),
            ),
            byProduct,
          };
        });
        if (emailFilter) {
          users = users.filter((u) =>
            (u.email ?? "").toLowerCase() === emailFilter
          );
        }
        users.sort((a, b) =>
          b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens
        );

        // Emails aren't injective through sanitize(); for a single filtered
        // user key the instance by the unique userId so two users can't collide.
        const outInstance = emailFilter && users.length === 1
          ? `user-${sanitize(users[0].userId)}`
          : instance;

        // Grand totals across the returned users, in the shape
        // @webframp/ai-usage's generic provider registry expects.
        const periodMinutes = Math.max(
          1,
          (new Date(endingAt).getTime() - new Date(startingAt).getTime()) /
            60000,
        );
        let totalInput = 0;
        let totalOutput = 0;
        let totalAll = 0;
        // totalAll sums the API's own total_tokens, which the Analytics API
        // docs define as excluding cache_creation tokens. totalInput below
        // (uncached + cache_read) uses the same exclusion, so the two stay
        // consistent by construction — this isn't the main Messages API,
        // where cache-write tokens can roll into a combined total.
        for (const u of users) {
          totalAll += u.totalTokens;
          for (const p of u.byProduct) {
            totalInput += (p.uncachedInputTokens ?? 0) +
              (p.cacheReadInputTokens ?? 0);
            totalOutput += p.outputTokens ?? 0;
          }
        }

        const handle = await ctx.writeResource("userUsage", outInstance, {
          startingAt,
          endingAt,
          filteredEmail: emailFilter,
          users,
          totals: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalAll,
            inputTokensPerMinute: totalInput / periodMinutes,
            outputTokensPerMinute: totalOutput / periodMinutes,
          },
          discountRate,
          count: users.length,
          dataRefreshedAt,
          collected,
          error: usageOk && costOk ? null : errorMsg,
          fetchedAt: nowIso,
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        ctx.logger.info(
          "Collected per-user usage: {count} user(s) over {start}..{end}",
          { count: users.length, start: startingAt, end: endingAt },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
