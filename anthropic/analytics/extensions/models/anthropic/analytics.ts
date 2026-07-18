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

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  analyticsKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Analytics API key (scope read:analytics) from claude.ai (use vault reference)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Enterprise Analytics ---

/** Raw per-day summary rows exactly as returned by /analytics/summaries. */
const AnalyticsSnapshotSchema = z.object({
  summaries: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  dataRefreshedAt: z.string().nullable(),
  fetchedAt: z.string(),
});

const SeatCountSchema = z.object({
  total: z.number().nullable(),
  active: z.number().nullable(),
  pending_invites: z.number().nullable(),
  dau: z.number().nullable(),
  wau: z.number().nullable(),
  mau: z.number().nullable(),
  fetchedAt: z.string(),
});

/**
 * Feature adoption as adopter counts — how many users used ≥1 project / skill /
 * connector on the queried day. There is no org-level adoption endpoint; these
 * are aggregated from the per-user /analytics/users records.
 */
const AdoptionMetricsSchema = z.object({
  projects: z.number().nullable(),
  skills: z.number().nullable(),
  connectors: z.number().nullable(),
  // false when the /users collection failed — distinguishes "error" from a
  // legitimately empty org (all-null with collected=true).
  collected: z.boolean(),
  fetchedAt: z.string(),
});

const CostSchema = z.object({
  total_cents: z.number(),
  total_usd: z.number(),
  currency: z.string(),
  by_cost_type: z.record(z.string(), z.number()),
  startingAt: z.string(),
  endingAt: z.string().nullable(),
  dataRefreshedAt: z.string().nullable(),
  // false when the /cost_report collection failed — distinguishes "error"
  // from a seat-based org with genuinely zero usage cost.
  collected: z.boolean(),
  fetchedAt: z.string(),
});

/** One product's usage + cost for a single user over the window. */
const UserProductUsageSchema = z.object({
  product: z.string(),
  totalTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  uncachedInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
  requests: z.number().nullable(),
  costUsd: z.number().nullable(),
  listCostUsd: z.number().nullable(),
});

/** Per-user usage + cost across products (Claude Code broken out by `product`). */
const UserUsageRecordSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  totalTokens: z.number(),
  totalCostUsd: z.number(),
  byProduct: z.array(UserProductUsageSchema),
});

const UserUsageSchema = z.object({
  startingAt: z.string(),
  endingAt: z.string(),
  filteredEmail: z.string().nullable(),
  users: z.array(UserUsageRecordSchema),
  count: z.number(),
  dataRefreshedAt: z.string().nullable(),
  // false when the report fetch failed (not an Enterprise plan, or the key
  // lacks read:analytics) — distinguishes error from a genuinely empty window.
  collected: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
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
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
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
        const key = ctx.globalArgs.analyticsKey;
        const nowIso = new Date().toISOString();
        const startDate = args.startDate ?? daysAgoYmd(7);
        const endDate = args.endDate;
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
          handles.push(
            await ctx.writeResource("cost", "window", {
              total_cents: totalCents,
              total_usd: totalCents / 100,
              currency: "USD",
              by_cost_type: byCostType,
              startingAt,
              endingAt,
              dataRefreshedAt: dataRefreshedAt ?? null,
              collected: true,
              fetchedAt: nowIso,
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
              startingAt,
              endingAt,
              dataRefreshedAt: null,
              collected: false,
              fetchedAt: nowIso,
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
        startDate: z.string().optional().describe(
          "Start (YYYY-MM-DD, UTC, no earlier than 2026-01-01). Defaults to 30 days ago. Window spans at most 31 days.",
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
          startDate?: string;
          endDate?: string;
          email?: string;
          products?: string[];
        },
        ctx: ModelContext,
      ) => {
        const key = ctx.globalArgs.analyticsKey;
        const nowIso = new Date().toISOString();
        const start = args.startDate ?? daysAgoYmd(30);
        const startingAt = `${start}T00:00:00Z`;
        const endingAt = args.endDate ? `${args.endDate}T00:00:00Z` : nowIso;
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

        let users = [...byUser.values()].map((r) => {
          const byProduct = [...r.byProduct.values()].map((p) => ({
            ...p,
            costUsd: p.costUsd === null ? null : r2(p.costUsd),
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

        const handle = await ctx.writeResource("userUsage", outInstance, {
          startingAt,
          endingAt,
          filteredEmail: emailFilter,
          users,
          count: users.length,
          dataRefreshedAt,
          collected,
          error: usageOk && costOk ? null : errorMsg,
          fetchedAt: nowIso,
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
