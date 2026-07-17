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
  type: z.string(),
  id: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const ActivitySchema = z.object({
  id: z.string(),
  type: z.string(),
  created_at: z.string(),
  actor: ActivityActorSchema,
  organization_id: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
});

const ActivityFeedSchema = z.object({
  activities: z.array(ActivitySchema),
  count: z.number(),
  has_more: z.boolean(),
  oldest_id: z.string().nullable(),
  newest_id: z.string().nullable(),
  fetchedAt: z.string(),
});

// --- Directory ---

const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
});

const OrgListSchema = z.object({
  organizations: z.array(OrgSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const DirectoryUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  created_at: z.string().nullable(),
});

const DirectoryUserListSchema = z.object({
  orgId: z.string(),
  users: z.array(DirectoryUserSchema),
  count: z.number(),
  has_more: z.boolean(),
  fetchedAt: z.string(),
});

const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const RoleListSchema = z.object({
  orgId: z.string(),
  roles: z.array(RoleSchema),
  count: z.number(),
  has_more: z.boolean(),
  fetchedAt: z.string(),
});

const GroupMemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  source_type: z.string(),
});

const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  member_count: z.number().nullable(),
});

const GroupListSchema = z.object({
  orgId: z.string(),
  groups: z.array(GroupSchema),
  count: z.number(),
  has_more: z.boolean(),
  fetchedAt: z.string(),
});

const GroupDetailSchema = z.object({
  orgId: z.string(),
  groupId: z.string(),
  groupName: z.string(),
  members: z.array(GroupMemberSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

// --- Effective Settings ---

const EffectiveSettingSchema = z.object({
  name: z.string(),
  value: z.unknown(),
});

const EffectiveSettingsSchema = z.object({
  orgId: z.string(),
  settings: z.array(EffectiveSettingSchema),
  count: z.number(),
  fetchedAt: z.string(),
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
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
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
        const key = ctx.globalArgs.complianceKey;
        const params: Record<string, string> = {};
        if (args.activity_types) {
          params.activity_types = args.activity_types;
        }
        // The Compliance API expects dotted range filters (created_at.gte),
        // not bracketed ones (created_at[gte]) — the latter returns HTTP 400.
        if (args.since) params["created_at.gte"] = args.since;
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
          result,
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
          result,
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
        const handle = await ctx.writeResource("users", "users", result);
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
        const handle = await ctx.writeResource("roles", "roles", result);
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
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        const data = await complianceRequest(
          key,
          `/v1/compliance/organizations/${orgId}/groups`,
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
        const handle = await ctx.writeResource("groups", "groups", result);
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
          const groupsData = await complianceRequest(
            key,
            `/v1/compliance/organizations/${orgId}/groups`,
          );
          const match = (groupsData.data ?? []).find(
            (g: any) => g.id === args.groupId,
          );
          if (match) groupName = match.name;
        } catch {
          // Non-fatal — use groupId as name
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
          result,
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
          result,
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
        const key = ctx.globalArgs.complianceKey;
        const orgId = await resolveOrgId(key, ctx.globalArgs);
        const handles: { name: string }[] = [];

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
          }),
        );

        const groupsData = await complianceRequest(
          key,
          `/v1/compliance/organizations/${orgId}/groups`,
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
