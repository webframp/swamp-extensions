/**
 * Claude Enterprise Compliance API model for swamp.
 *
 * Observes the compliance surface: activity feed (6-year audit trail),
 * organization directory (users, roles, groups with SCIM source), and
 * effective settings. Requires a Compliance Access Key (sk-ant-api01-...)
 * created by the primary owner in claude.ai org settings.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.6.5";

const EXTENSION_NAME = "@webframp/anthropic/compliance";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  complianceKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Compliance Access Key (sk-ant-api01-...) from claude.ai org settings (use vault reference)",
  ),
  orgId: z.string().optional().describe(
    "Organization ID to scope queries. Omit to auto-discover from /v1/compliance/organizations.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Activity Feed ---

const ActivityActorSchema = z.object({
  type: z.string().describe("Actor type (e.g. user, api_key, system)"),
  id: z.string().nullable().optional().describe("Actor's unique identifier"),
  email: z.string().nullable().optional().describe(
    "Actor's email address, if known",
  ),
  name: z.string().nullable().optional().describe(
    "Actor's display name, if known",
  ),
  user_id: z.string().nullable().optional().describe(
    "User ID for user_actor activities (matches the directory user ID)",
  ),
  email_address: z.string().nullable().optional().describe(
    "Actor's email address for user_actor activities",
  ),
});

const ActivitySchema = z.object({
  id: z.string().describe("Unique activity identifier"),
  type: z.string().describe(
    "Activity type (e.g. claude_chat_created, github_integration_updated)",
  ),
  created_at: z.string().describe("ISO 8601 timestamp the activity occurred"),
  actor: ActivityActorSchema.describe("Who or what performed the activity"),
  organization_id: z.string().nullable().describe(
    "Organization the activity belongs to",
  ),
  details: z.record(z.string(), z.unknown()).nullable().optional().describe(
    "Activity-type-specific detail payload",
  ),
});

const ActivityFeedSchema = z.object({
  activities: z.array(ActivitySchema).describe(
    "Activities returned for this page",
  ),
  count: z.number().describe("Number of activities in this page"),
  has_more: z.boolean().describe(
    "Whether more activities exist beyond this page",
  ),
  oldest_id: z.string().nullable().describe(
    "ID of the oldest activity in this page, or null if empty",
  ),
  newest_id: z.string().nullable().describe(
    "ID of the newest activity in this page, or null if empty",
  ),
  next_cursor: z.string().nullable().optional().describe(
    "Pass as after_id to continue to older activities; null when exhausted",
  ),
  pages: z.number().optional().describe("Number of API pages fetched"),
  stalled: z.boolean().optional().describe(
    "True when the API reported more data but returned no cursor that advances; has_more is then true and next_cursor null",
  ),
  filters: z.record(z.string(), z.unknown()).optional().describe(
    "Filters that produced this feed; next_cursor is only valid for the same filters",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when the feed was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// --- Directory ---

const OrgSchema = z.object({
  id: z.string().describe("Organization unique identifier"),
  name: z.string().describe("Organization display name"),
  type: z.string().nullable().describe(
    "Organization type, if provided by the API",
  ),
});

const OrgListSchema = z.object({
  organizations: z.array(OrgSchema).describe(
    "Organizations visible to the compliance key",
  ),
  count: z.number().describe("Number of organizations returned"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when organizations were fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const DirectoryUserSchema = z.object({
  id: z.string().describe("User's unique identifier"),
  email: z.string().describe("User's email address"),
  name: z.string().nullable().describe("User's display name, if known"),
  role: z.string().describe("User's organization role"),
  created_at: z.string().nullable().describe(
    "ISO 8601 timestamp the user was created, if known",
  ),
});

const DirectoryUserListSchema = z.object({
  orgId: z.string().describe("Organization these users belong to"),
  users: z.array(DirectoryUserSchema).describe(
    "Directory users for the organization",
  ),
  count: z.number().describe("Number of users returned"),
  has_more: z.boolean().describe("Whether more users exist beyond this page"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when users were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const RoleSchema = z.object({
  id: z.string().describe("Role's unique identifier"),
  name: z.string().describe("Role display name"),
  description: z.string().nullable().describe("Role description, if provided"),
});

const RoleListSchema = z.object({
  orgId: z.string().describe("Organization these roles belong to"),
  roles: z.array(RoleSchema).describe("Roles defined for the organization"),
  count: z.number().describe("Number of roles returned"),
  has_more: z.boolean().describe("Whether more roles exist beyond this page"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when roles were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const GroupMemberSchema = z.object({
  id: z.string().describe("Member's unique identifier"),
  email: z.string().describe("Member's email address"),
  name: z.string().nullable().describe("Member's display name, if known"),
  source_type: z.string().describe(
    "How the member was added (e.g. direct, scim)",
  ),
});

const GroupSchema = z.object({
  id: z.string().describe("Group's unique identifier"),
  name: z.string().describe("Group display name"),
  description: z.string().nullable().describe("Group description, if provided"),
  member_count: z.number().nullable().describe(
    "Number of members in the group, if known",
  ),
});

const GroupListSchema = z.object({
  orgId: z.string().describe("Organization these groups belong to"),
  groups: z.array(GroupSchema).describe("Groups defined for the organization"),
  count: z.number().describe("Number of groups returned"),
  has_more: z.boolean().describe("Whether more groups exist beyond this page"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when groups were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const GroupDetailSchema = z.object({
  orgId: z.string().describe("Organization the group belongs to"),
  groupId: z.string().describe("Group's unique identifier"),
  groupName: z.string().describe("Group display name"),
  members: z.array(GroupMemberSchema).describe(
    "Group members with SCIM source attribution",
  ),
  count: z.number().describe("Number of members returned"),
  has_more: z.boolean().optional().describe(
    "Whether more members exist beyond those returned (page cap reached)",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when membership was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// --- Effective Settings ---

const EffectiveSettingSchema = z.object({
  name: z.string().describe("Setting name/key"),
  value: z.unknown().describe("Setting's effective value"),
});

const EffectiveSettingsSchema = z.object({
  orgId: z.string().describe("Organization these settings belong to"),
  settings: z.array(EffectiveSettingSchema).describe(
    "Effective runtime settings (retention, redaction, IP allowlist, SSO mode, etc.)",
  ),
  count: z.number().describe("Number of settings returned"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when settings were fetched",
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

/** Make an authenticated request to the Compliance API. */
async function complianceRequest(
  key: string,
  path: string,
  params?: Record<string, string | string[]>,
): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Array values repeat the key (k=a&k=b), the form the API expects for
      // bracketed list filters such as `activity_types[]`.
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== "") url.searchParams.append(k, item);
        }
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
    throw new Error(`Compliance API ${path}: ${resp.status} ${body}`);
  }
  return resp.json();
}

/** Resolve the org ID — use provided or discover from /organizations. */
async function resolveOrgId(
  key: string,
  globalArgs: GlobalArgs,
): Promise<string> {
  if (globalArgs.orgId) return globalArgs.orgId;
  const data = await complianceRequest(key, "/v1/compliance/organizations");
  const orgs = data.data ?? data.organizations ?? data;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const id = orgs[0].uuid ?? orgs[0].id;
    if (id) return id;
  }
  throw new Error(
    "Could not discover org ID from /v1/compliance/organizations. Set orgId in globalArguments.",
  );
}

/**
 * Paginate a directory list endpoint (users, roles, groups, group members),
 * collecting all pages. These endpoints page with an opaque `next_page` token
 * passed back unchanged as `page`; they reject the activity feed's `after_id`.
 *
 * `hasMore` is true whenever data may remain unread: the page cap was hit,
 * the API said `has_more` without giving a usable `next_page`, or the token
 * stopped advancing.
 */
async function paginateAll(
  key: string,
  path: string,
  params: Record<string, string>,
  dataKey: string,
  limit = 1000,
): Promise<{ items: any[]; hasMore: boolean }> {
  const items: any[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let hasMore = false;
  const maxPages = 20;

  for (let page = 0; page < maxPages; page++) {
    const p: Record<string, string> = { ...params, limit: String(limit) };
    if (pageToken) p.page = pageToken;
    const data = await complianceRequest(key, path, p);
    items.push(...(data[dataKey] ?? data.data ?? []));
    const next = typeof data.next_page === "string" && data.next_page !== ""
      ? data.next_page
      : undefined;
    // Trust an explicit has_more; otherwise a next_page token means more.
    const more = data.has_more ?? next !== undefined;
    if (!more) {
      hasMore = false;
      break;
    }
    if (next === undefined || seen.has(next)) {
      // More data is claimed but we cannot advance: report it, don't loop.
      hasMore = true;
      break;
    }
    seen.add(next);
    pageToken = next;
    hasMore = true; // stays true if the page cap ends the loop
  }
  return { items, hasMore };
}

/** Parse an optional positive-integer argument, clamped to `max`. */
function positiveInt(
  name: string,
  value: string | undefined,
  def: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return def;
  if (!/^\d+$/.test(value.trim()) || parseInt(value, 10) < 1) {
    throw new Error(`${name} (${value}) must be a positive integer`);
  }
  return Math.min(parseInt(value, 10), max);
}

/**
 * Validate and normalize an ISO-8601 timestamp argument to UTC. A date-only
 * value means 00:00:00Z of that day. A value with a time part must carry `Z`
 * or a UTC offset: without one the result would depend on the host's timezone.
 * Impossible calendar dates (2026-02-31) are rejected rather than rolled over.
 */
function isoTimestamp(name: string, value: string): string {
  const v = value.trim();
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[Tt ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?)(Z|z|[+-]\d{2}:?\d{2})?)?$/
      .exec(v);
  if (!m) {
    throw new Error(`${name} (${value}) is not a valid ISO-8601 timestamp`);
  }
  if (m[2] !== undefined && m[3] === undefined) {
    throw new Error(
      `${name} (${value}) has a time but no timezone; add Z or an offset such as +00:00`,
    );
  }
  const [y, mo, d] = m[1].split("-").map(Number);
  // The feed is a recent audit trail, and years outside this range either
  // misparse (Date.UTC maps 0-99 to 19xx) or serialize as extended years.
  if (y < 1970 || y > 9998) {
    throw new Error(`${name} (${value}) year must be between 1970 and 9998`);
  }
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (
    day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 ||
    day.getUTCDate() !== d
  ) {
    throw new Error(`${name} (${value}) is not a real calendar date`);
  }
  const parsed = new Date(
    m[2] === undefined ? `${m[1]}T00:00:00Z` : v.replace(" ", "T"),
  );
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} (${value}) is not a valid ISO-8601 timestamp`);
  }
  return parsed.toISOString();
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
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
};

// =============================================================================
// Model Definition
// =============================================================================

/** Claude Enterprise Compliance API — activity feed, directory, and effective settings observation. */
export const model = {
  type: "@webframp/anthropic/compliance",
  version: "2026.10.07.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.30.1",
      description: "Groups endpoint moved to top-level path; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description: "Fix missing upgrade description metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.3",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.28.1",
      description:
        "No schema changes — normalized license to Apache-2.0 and corrected copyright holder to Sean Escriva",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.15.1",
      description: "No schema changes — dependency/license maintenance bump",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.1",
      description:
        "Normalized zod dependency version to 4.6.5; no behavioral changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.06.1",
      description:
        "Fixed collect_activities activity_types filter; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.07.1",
      description:
        "Fixed directory pagination (page/next_page) and user field mapping; collect_activities gains actor_ids/until/after_id/max_pages; additive schema fields only",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: ["@webframp/compliance-config-snapshot"],

  resources: {
    activities: {
      description: "Compliance activity feed (audit trail, 6-year retention)",
      schema: ActivityFeedSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    organizations: {
      description: "Organizations visible to the compliance key",
      schema: OrgListSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    users: {
      description: "Directory users for an organization",
      schema: DirectoryUserListSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    roles: {
      description: "Roles defined for an organization",
      schema: RoleListSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    groups: {
      description: "Groups defined for an organization",
      schema: GroupListSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    groupMembers: {
      description: "Members of a specific group with SCIM source attribution",
      schema: GroupDetailSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    effectiveSettings: {
      description:
        "Effective runtime settings (retention, redaction, IP allowlist, SSO mode)",
      schema: EffectiveSettingsSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    collect_activities: {
      description:
        "Collect compliance activities, newest first. Filter by activity_types, actor_ids (directory user IDs) and a created_at window (since/until). Follow older pages with max_pages or resume from a previous next_cursor via after_id.",
      arguments: z.object({
        activity_types: z.string().optional().describe(
          "Comma-separated activity type filter (e.g. 'claude_chat_created,github_integration_updated')",
        ),
        actor_ids: z.string().optional().describe(
          "Comma-separated user IDs to filter by actor (e.g. 'user_01abc,user_01def'); IDs come from sync_users",
        ),
        since: z.string().optional().describe(
          "ISO-8601 timestamp — collect activities created at or after this time",
        ),
        until: z.string().optional().describe(
          "ISO-8601 timestamp — collect activities created at or before this time",
        ),
        limit: z.string().optional().describe(
          "Max activities to collect per page (default 100, max 5000)",
        ),
        after_id: z.string().optional().describe(
          "Cursor from a previous run's next_cursor; resumes at the next older page",
        ),
        max_pages: z.string().optional().describe(
          "Max pages to fetch while has_more is true (default 1, max 50)",
        ),
      }),
      execute: async (
        args: {
          activity_types?: string;
          actor_ids?: string;
          since?: string;
          until?: string;
          limit?: string;
          after_id?: string;
          max_pages?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const params: Record<string, string | string[]> = {};
        const splitList = (v?: string) =>
          (v ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
        // The API takes repeated `activity_types[]` / `actor_ids[]` lists; a
        // bare key returns HTTP 400.
        const activityTypes = splitList(args.activity_types);
        if (activityTypes.length > 0) {
          params["activity_types[]"] = activityTypes;
        }
        const actorIds = splitList(args.actor_ids);
        if (actorIds.length > 0) {
          params["actor_ids[]"] = actorIds;
        }
        // The Compliance API expects dotted range filters (created_at.gte),
        // not bracketed ones (created_at[gte]) — the latter returns HTTP 400.
        const since = args.since
          ? isoTimestamp("since", args.since)
          : undefined;
        const until = args.until
          ? isoTimestamp("until", args.until)
          : undefined;
        if (since && until && until < since) {
          throw new Error(`until (${until}) is earlier than since (${since})`);
        }
        if (since) params["created_at.gte"] = since;
        if (until) params["created_at.lte"] = until;
        params.limit = String(positiveInt("limit", args.limit, 100, 5000));
        const maxPages = positiveInt("max_pages", args.max_pages, 1, 50);

        // Activities page newest -> oldest; `last_id` as `after_id` yields the
        // next older page.
        const activities: any[] = [];
        let cursor: string | undefined = args.after_id?.trim() || undefined;
        let hasMore = true; // loop control: more pages worth fetching
        let moreRemains = false; // honest answer: API says data is unread
        let stalled = false;
        let pages = 0;
        while (hasMore && pages < maxPages) {
          const pageParams = cursor ? { ...params, after_id: cursor } : params;
          const data = await complianceRequest(
            key,
            "/v1/compliance/activities",
            pageParams,
          );
          const batch = data.data ?? [];
          activities.push(...batch);
          pages++;
          const tail = batch.length > 0 ? batch[batch.length - 1].id : null;
          const candidates = [data.last_id, tail];
          const lastId: string | null = candidates.find((c) =>
            typeof c === "string" && c !== ""
          ) ?? null;
          moreRemains = data.has_more ?? false;
          const advanced = lastId !== null && lastId !== cursor;
          hasMore = moreRemains && advanced;
          if (moreRemains && !advanced) {
            // The API claims more data but gave no cursor that moves us on.
            // Say so in the output instead of reporting a complete feed.
            stalled = true;
            ctx.logger.info(
              "Activity cursor did not advance (last_id {lastId}); stopping",
              { lastId },
            );
          }
          cursor = lastId ?? cursor;
        }
        const result = {
          activities,
          count: activities.length,
          has_more: moreRemains,
          oldest_id: activities.length > 0
            ? activities[activities.length - 1].id
            : null,
          newest_id: activities.length > 0 ? activities[0].id : null,
          next_cursor: moreRemains && !stalled ? cursor ?? null : null,
          stalled,
          pages,
          filters: {
            activity_types: activityTypes,
            actor_ids: actorIds,
            since: since ?? null,
            until: until ?? null,
            after_id: args.after_id?.trim() || null,
          },
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "activities",
          "recent",
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Collected {count} activities in {pages} page(s)", {
          count: result.count,
          pages,
        });
        return { dataHandles: [handle] };
      },
    },

    sync_organizations: {
      description: "Discover organizations visible to the compliance key.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const data = await complianceRequest(
          key,
          "/v1/compliance/organizations",
        );
        const orgs = data.data ?? data.organizations ?? [];
        const result = {
          organizations: orgs.map((o: any) => ({
            id: o.uuid ?? o.id ?? "",
            name: o.name ?? "",
            type: o.type ?? null,
          })),
          count: orgs.length,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "organizations",
          "all",
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} organizations", {
          count: result.count,
        });
        return { dataHandles: [handle] };
      },
    },

    sync_users: {
      description:
        "Sync all directory users for the organization. Paginates automatically.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        const { items, hasMore } = await paginateAll(
          key,
          `/v1/compliance/organizations/${orgId}/users`,
          {},
          "data",
        );
        const users = items.map((u: any) => ({
          id: u.id ?? "",
          email: u.email ?? "",
          name: u.full_name ?? u.name ?? null,
          role: u.organization_role ?? u.role ?? "",
          created_at: u.created_at ?? null,
        }));
        const result = {
          orgId,
          users,
          count: users.length,
          has_more: hasMore,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("users", "users", {
          ...result,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        ctx.logger.info("Synced {count} users for org {orgId}", {
          count: result.count,
          orgId,
        });
        return { dataHandles: [handle] };
      },
    },

    sync_roles: {
      description: "Sync roles defined for the organization.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        const { items: roleItems, hasMore: rolesHasMore } = await paginateAll(
          key,
          `/v1/compliance/organizations/${orgId}/roles`,
          {},
          "data",
        );
        const roles = roleItems.map((r: any) => ({
          id: r.id ?? "",
          name: r.name ?? "",
          description: r.description ?? null,
        }));
        const result = {
          orgId,
          roles,
          count: roles.length,
          has_more: rolesHasMore,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("roles", "roles", {
          ...result,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        ctx.logger.info("Synced {count} roles for org {orgId}", {
          count: result.count,
          orgId,
        });
        return { dataHandles: [handle] };
      },
    },

    sync_groups: {
      description:
        "Sync groups for the organization. Use get_group_members for member detail with SCIM source attribution.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        // Groups endpoint is top-level, not org-scoped — the org-scoped path
        // (/v1/compliance/organizations/{orgId}/groups) returns 404 as of
        // July 2026. See: https://github.com/webframp/swamp-extensions/issues/270
        const { items: groupItems, hasMore: groupsHasMore } = await paginateAll(
          key,
          `/v1/compliance/groups`,
          {},
          "data",
        );
        const groups = groupItems.map((g: any) => ({
          id: g.id ?? "",
          name: g.name ?? "",
          description: g.description ?? null,
          member_count: g.member_count ?? null,
        }));
        const result = {
          orgId,
          groups,
          count: groups.length,
          has_more: groupsHasMore,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("groups", "groups", {
          ...result,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        ctx.logger.info("Synced {count} groups for org {orgId}", {
          count: result.count,
          orgId,
        });
        return { dataHandles: [handle] };
      },
    },

    get_group_members: {
      description:
        "Get members of a specific group, including SCIM source attribution (direct vs scim).",
      arguments: z.object({
        groupId: z.string().min(1).describe(
          "Group ID to fetch members for",
        ),
      }),
      execute: async (args: { groupId: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        // Groups are globally addressable by ID, not org-scoped like /organizations/{orgId}/users
        const { items, hasMore: membersHasMore } = await paginateAll(
          key,
          `/v1/compliance/groups/${encodeURIComponent(args.groupId)}/members`,
          {},
          "data",
        );
        const members = items.map((m: any) => ({
          id: m.user_id ?? m.id ?? "",
          email: m.email ?? "",
          name: m.full_name ?? m.name ?? null,
          source_type: m.source_type ?? "direct",
        }));

        let groupName = args.groupId;
        try {
          // Groups listing is top-level, not org-scoped (see issue #270)
          const { items: allGroups, hasMore: groupsHasMore } =
            await paginateAll(
              key,
              `/v1/compliance/groups`,
              {},
              "data",
            );
          const match = allGroups.find(
            (g: any) => g.id === args.groupId,
          );
          if (match) {
            groupName = match.name;
          } else if (groupsHasMore) {
            ctx.logger.info(
              "Group {groupId} not found in a truncated group list; using ID as name",
              { groupId: args.groupId },
            );
          }
        } catch (err) {
          // Non-fatal — use groupId as name, but surface why the lookup
          // failed so a persistent auth/permissions issue isn't silently
          // masked as "group just has no friendly name".
          ctx.logger.info(
            "Could not resolve display name for group {groupId}, falling back to ID: {error}",
            { groupId: args.groupId, error: String(err) },
          );
        }

        const result = {
          orgId,
          groupId: args.groupId,
          groupName,
          members,
          count: members.length,
          has_more: membersHasMore,
          fetchedAt: new Date().toISOString(),
        };
        // Namespaced so a groupId can never collide with another spec's
        // fixed instance name (e.g. a group literally named "users").
        const handle = await ctx.writeResource(
          "groupMembers",
          `member:${args.groupId}`,
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Fetched {count} members for group {group}", {
          count: result.count,
          group: groupName,
        });
        return { dataHandles: [handle] };
      },
    },

    sync_effective_settings: {
      description:
        "Observe effective runtime settings: data retention, content redaction, IP allowlist, SSO mode, code execution egress.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        const data = await complianceRequest(
          key,
          `/v1/compliance/organizations/${orgId}/settings`,
        );
        const raw = data.data ?? data.settings ?? data;
        const settings = Array.isArray(raw)
          ? raw.map((s: any) => ({
            name: s.name ?? s.key ?? "",
            value: s.value ?? s.setting ?? null,
          }))
          : Object.entries(raw).map(([name, value]) => ({ name, value }));

        const result = {
          orgId,
          settings,
          count: settings.length,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "effectiveSettings",
          "effectiveSettings",
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          "Synced {count} effective settings for org {orgId}",
          { count: result.count, orgId },
        );
        return { dataHandles: [handle] };
      },
    },

    sync_directory: {
      description:
        "Fan-out: sync users, roles, and groups for the organization in one method call.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        // Fetch everything before writing anything, so a failure on a later
        // endpoint (429, 5xx) cannot leave users written but roles/groups stale.
        // Users and roles remain org-scoped as of July 2026; only groups
        // moved to the top-level path (see issue #270).
        const { items: userItems, hasMore: usersHasMore } = await paginateAll(
          key,
          `/v1/compliance/organizations/${orgId}/users`,
          {},
          "data",
        );
        const { items: roleItems, hasMore: rolesHasMore } = await paginateAll(
          key,
          `/v1/compliance/organizations/${orgId}/roles`,
          {},
          "data",
        );
        // Groups endpoint is top-level, not org-scoped (see issue #270)
        const { items: groupItems, hasMore: groupsHasMore } = await paginateAll(
          key,
          `/v1/compliance/groups`,
          {},
          "data",
        );

        const users = userItems.map((u: any) => ({
          id: u.id ?? "",
          email: u.email ?? "",
          name: u.full_name ?? u.name ?? null,
          role: u.organization_role ?? u.role ?? "",
          created_at: u.created_at ?? null,
        }));
        const roles = roleItems.map((r: any) => ({
          id: r.id ?? "",
          name: r.name ?? "",
          description: r.description ?? null,
        }));
        const groups = groupItems.map((g: any) => ({
          id: g.id ?? "",
          name: g.name ?? "",
          description: g.description ?? null,
          member_count: g.member_count ?? null,
        }));
        const meta = () => ({
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        const handles = [
          await ctx.writeResource("users", "users", {
            orgId,
            users,
            count: users.length,
            has_more: usersHasMore,
            ...meta(),
          }),
          await ctx.writeResource("roles", "roles", {
            orgId,
            roles,
            count: roles.length,
            has_more: rolesHasMore,
            ...meta(),
          }),
          await ctx.writeResource("groups", "groups", {
            orgId,
            groups,
            count: groups.length,
            has_more: groupsHasMore,
            ...meta(),
          }),
        ];

        ctx.logger.info(
          "Synced directory: {users} users, {roles} roles, {groups} groups",
          {
            users: users.length,
            roles: roles.length,
            groups: groups.length,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
