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

import { z } from "npm:zod@4.4.3";

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
});

const ActivitySchema = z.object({
  id: z.string().describe("Unique activity identifier"),
  type: z.string().describe(
    "Activity type (e.g. user.login, conversation.create)",
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
  params?: Record<string, string>,
): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
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

/** Paginate a compliance list endpoint, collecting all pages. */
async function paginateAll(
  key: string,
  path: string,
  params: Record<string, string>,
  dataKey: string,
  limit = 1000,
): Promise<{ items: any[]; hasMore: boolean }> {
  const items: any[] = [];
  let afterId: string | undefined;
  let hasMore = true;
  const maxPages = 20;
  let page = 0;

  while (hasMore && page < maxPages) {
    const p: Record<string, string> = {
      ...params,
      limit: String(limit),
    };
    if (afterId) p.after_id = afterId;
    const data = await complianceRequest(key, path, p);
    const results = data[dataKey] ?? data.data ?? [];
    items.push(...results);
    hasMore = data.has_more ?? false;
    const lastId = results.length > 0
      ? results[results.length - 1].id
      : undefined;
    if (lastId !== undefined && lastId !== null) {
      afterId = String(lastId);
    } else {
      hasMore = false;
    }
    page++;
  }
  return { items, hasMore };
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
  version: "2026.08.25.1",
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
        "Collect recent compliance activities. Use activity_types to filter (e.g. 'user.login', 'conversation.create').",
      arguments: z.object({
        activity_types: z.string().optional().describe(
          "Comma-separated activity type filter (e.g. 'user.login,conversation.create')",
        ),
        since: z.string().optional().describe(
          "ISO-8601 timestamp — collect activities created after this time",
        ),
        limit: z.string().optional().describe(
          "Max activities to collect per page (default 100, max 5000)",
        ),
      }),
      execute: async (
        args: { activity_types?: string; since?: string; limit?: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const key = ctx.globalArgs.complianceKey;
        const params: Record<string, string> = {};
        if (args.activity_types) {
          params.activity_types = args.activity_types;
        }
        // The Compliance API expects dotted range filters (created_at.gte),
        // not bracketed ones (created_at[gte]) — the latter returns HTTP 400.
        if (args.since) {
          if (Number.isNaN(new Date(args.since).getTime())) {
            throw new Error(
              `since (${args.since}) is not a valid ISO-8601 timestamp`,
            );
          }
          params["created_at.gte"] = args.since;
        }
        const pageLimit = args.limit ? parseInt(args.limit, 10) || 100 : 100;
        params.limit = String(Math.min(pageLimit, 5000));

        const data = await complianceRequest(
          key,
          "/v1/compliance/activities",
          params,
        );
        const activities = data.data ?? [];
        const result = {
          activities,
          count: activities.length,
          has_more: data.has_more ?? false,
          oldest_id: activities.length > 0
            ? activities[activities.length - 1].id
            : null,
          newest_id: activities.length > 0 ? activities[0].id : null,
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
        ctx.logger.info("Collected {count} activities", {
          count: result.count,
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
          name: u.name ?? null,
          role: u.role ?? "",
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
        const data = await complianceRequest(
          key,
          `/v1/compliance/organizations/${orgId}/roles`,
        );
        const roles = (data.data ?? []).map((r: any) => ({
          id: r.id ?? "",
          name: r.name ?? "",
          description: r.description ?? null,
        }));
        const result = {
          orgId,
          roles,
          count: roles.length,
          has_more: data.has_more ?? false,
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
        const data = await complianceRequest(
          key,
          `/v1/compliance/groups`,
        );
        const groups = (data.data ?? []).map((g: any) => ({
          id: g.id ?? "",
          name: g.name ?? "",
          description: g.description ?? null,
          member_count: g.member_count ?? null,
        }));
        const result = {
          orgId,
          groups,
          count: groups.length,
          has_more: data.has_more ?? false,
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
        const { items } = await paginateAll(
          key,
          `/v1/compliance/groups/${args.groupId}/members`,
          {},
          "data",
        );
        const members = items.map((m: any) => ({
          id: m.id ?? "",
          email: m.email ?? "",
          name: m.name ?? null,
          source_type: m.source_type ?? "direct",
        }));

        let groupName = args.groupId;
        try {
          // Groups listing is top-level, not org-scoped (see issue #270)
          const groupsData = await complianceRequest(
            key,
            `/v1/compliance/groups`,
          );
          const match = (groupsData.data ?? []).find(
            (g: any) => g.id === args.groupId,
          );
          if (match) groupName = match.name;
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
        const handles: { name: string }[] = [];

        // Users and roles remain org-scoped as of July 2026; only groups
        // moved to the top-level path (see issue #270).
        const { items: userItems, hasMore: usersHasMore } = await paginateAll(
          key,
          `/v1/compliance/organizations/${orgId}/users`,
          {},
          "data",
        );
        const users = userItems.map((u: any) => ({
          id: u.id ?? "",
          email: u.email ?? "",
          name: u.name ?? null,
          role: u.role ?? "",
          created_at: u.created_at ?? null,
        }));
        handles.push(
          await ctx.writeResource("users", "users", {
            orgId,
            users,
            count: users.length,
            has_more: usersHasMore,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

        const rolesData = await complianceRequest(
          key,
          `/v1/compliance/organizations/${orgId}/roles`,
        );
        const roles = (rolesData.data ?? []).map((r: any) => ({
          id: r.id ?? "",
          name: r.name ?? "",
          description: r.description ?? null,
        }));
        handles.push(
          await ctx.writeResource("roles", "roles", {
            orgId,
            roles,
            count: roles.length,
            has_more: rolesData.has_more ?? false,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

        // Groups endpoint is top-level, not org-scoped (see issue #270)
        const groupsData = await complianceRequest(
          key,
          `/v1/compliance/groups`,
        );
        const groups = (groupsData.data ?? []).map((g: any) => ({
          id: g.id ?? "",
          name: g.name ?? "",
          description: g.description ?? null,
          member_count: g.member_count ?? null,
        }));
        handles.push(
          await ctx.writeResource("groups", "groups", {
            orgId,
            groups,
            count: groups.length,
            has_more: groupsData.has_more ?? false,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

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
