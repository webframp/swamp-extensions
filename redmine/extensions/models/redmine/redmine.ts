/**
 * Redmine issue tracker model for swamp.
 *
 * Provides CRUD operations on Redmine issues, project queries,
 * status/tracker/user lookups, and custom field access via the
 * Redmine REST API.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4.3.6";
import { redmineApi, redmineApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Types for raw Redmine API responses (snake_case)
// =============================================================================

interface RawStatus {
  id: number;
  name: string;
  is_closed: boolean;
}

interface RawTracker {
  id: number;
  name: string;
  default_status: { id: number; name: string };
  description: string;
}

interface RawProject {
  id: number;
  name: string;
  identifier: string;
  description: string;
  status: number;
  is_public: boolean;
  created_on: string;
  updated_on: string;
}

interface RawMembership {
  id: number;
  project: { id: number; name: string };
  user?: { id: number; name: string };
  group?: { id: number; name: string };
  roles: Array<{ id: number; name: string }>;
}

interface RawCustomField {
  id: number;
  name: string;
  customized_type: string;
  field_format: string;
  is_required: boolean;
  is_filter: boolean;
  multiple: boolean;
  default_value: string;
  possible_values: Array<{ value: string }>;
  trackers: Array<{ id: number; name: string }>;
}

/** Raw Redmine issue shape (snake_case) as returned by the API. */
export interface RawIssue {
  /** Issue ID. */
  id: number;
  /** Project reference. */
  project: { id: number; name: string };
  /** Tracker reference. */
  tracker: { id: number; name: string };
  /** Status reference. */
  status: { id: number; name: string; is_closed?: boolean };
  /** Priority reference. */
  priority: { id: number; name: string };
  /** Author reference. */
  author: { id: number; name: string };
  /** Assignee reference (absent when unassigned). */
  assigned_to?: { id: number; name: string };
  /** Issue subject line. */
  subject: string;
  /** Issue description body. */
  description: string;
  /** Planned start date (ISO 8601 or null). */
  start_date: string | null;
  /** Planned due date (ISO 8601 or null). */
  due_date: string | null;
  /** Percent done (0–100). */
  done_ratio: number;
  /** Whether the issue is private. */
  is_private: boolean;
  /** Estimated hours (null if unset). */
  estimated_hours: number | null;
  /** Hours spent (present when include=spent_hours). */
  spent_hours?: number;
  /** Creation timestamp (ISO 8601). */
  created_on: string;
  /** Last-updated timestamp (ISO 8601). */
  updated_on: string;
  /** Closed timestamp (ISO 8601 or null). */
  closed_on: string | null;
  /** Parent issue reference. */
  parent?: { id: number };
  /** Custom field values. */
  custom_fields?: Array<{
    id: number;
    name: string;
    value: string | string[];
  }>;
  /** Journal entries (present in detail responses). */
  journals?: Array<{
    id: number;
    user: { id: number; name: string };
    notes: string;
    created_on: string;
    details: Array<{
      property: string;
      name: string;
      old_value: string | null;
      new_value: string | null;
    }>;
  }>;
  /** Child issue references. */
  children?: Array<
    { id: number; tracker: { id: number; name: string }; subject: string }
  >;
  /** Issue relations (present when include=relations). */
  relations?: Array<{
    id: number;
    issue_id: number;
    issue_to_id: number;
    relation_type: string;
    delay: number | null;
  }>;
  /** Watchers (present when include=watchers). */
  watchers?: Array<{ id: number; name: string }>;
}

// =============================================================================
// Mapping helpers: snake_case → camelCase
// =============================================================================

/** Map a raw Redmine issue to camelCase fields. */
export function mapIssue(raw: RawIssue): Record<string, unknown> {
  return {
    id: raw.id,
    project: raw.project,
    tracker: raw.tracker,
    status: raw.status,
    priority: raw.priority,
    author: raw.author,
    assignedTo: raw.assigned_to ?? null,
    subject: raw.subject,
    description: raw.description,
    startDate: raw.start_date,
    dueDate: raw.due_date,
    doneRatio: raw.done_ratio,
    isPrivate: raw.is_private,
    estimatedHours: raw.estimated_hours,
    spentHours: raw.spent_hours ?? null,
    createdOn: raw.created_on,
    updatedOn: raw.updated_on,
    closedOn: raw.closed_on,
    parent: raw.parent ?? null,
    customFields: (raw.custom_fields ?? []).map((cf) => ({
      id: cf.id,
      name: cf.name,
      value: cf.value,
    })),
  };
}

/** Map a raw Redmine issue detail (with journals and children) to camelCase fields. */
export function mapIssueDetail(raw: RawIssue): Record<string, unknown> {
  return {
    ...mapIssue(raw),
    journals: (raw.journals ?? []).map((j) => ({
      id: j.id,
      user: j.user,
      notes: j.notes,
      createdOn: j.created_on,
      details: j.details.map((d) => ({
        property: d.property,
        name: d.name,
        oldValue: d.old_value,
        newValue: d.new_value,
      })),
    })),
    children: (raw.children ?? []).map((c) => ({
      id: c.id,
      tracker: c.tracker,
      subject: c.subject,
    })),
    relations: (raw.relations ?? []).map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      issueToId: r.issue_to_id,
      relationType: r.relation_type,
      delay: r.delay,
    })),
    watchers: raw.watchers ?? [],
  };
}

// =============================================================================
// Context type used by all methods
// =============================================================================

type MethodContext = {
  globalArgs: {
    host: string;
    apiKey: string;
    project: string;
    username?: string;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string; dataId: string; version: number }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

/** Redmine issue tracker model definition for swamp. */
export const model = {
  type: "@webframp/redmine",
  version: "2026.04.30.1",

  upgrades: [
    {
      toVersion: "2026.04.30.1",
      description:
        "Add Zod schemas to all resource specs — no globalArguments changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  globalArguments: z.object({
    host: z.string().describe(
      "Redmine instance URL (e.g. https://redmine.example.com)",
    ),
    apiKey: z.string().meta({ sensitive: true }).describe(
      "Redmine API key (40-character hex string)",
    ),
    project: z.string().describe("Default project identifier"),
    username: z.string().optional().describe(
      "Redmine username for X-Redmine-Username header (required by some ingress configurations)",
    ),
  }),

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  resources: {
    issues: {
      description: "List of issues matching query filters",
      schema: z.object({
        issues: z.array(z.object({
          id: z.number(),
          project: z.object({ id: z.number(), name: z.string() }),
          tracker: z.object({ id: z.number(), name: z.string() }),
          status: z.object({
            id: z.number(),
            name: z.string(),
            is_closed: z.boolean().optional(),
          }),
          priority: z.object({ id: z.number(), name: z.string() }),
          author: z.object({ id: z.number(), name: z.string() }),
          assignedTo: z.object({ id: z.number(), name: z.string() }).nullable(),
          subject: z.string(),
          description: z.string(),
          startDate: z.string().nullable(),
          dueDate: z.string().nullable(),
          doneRatio: z.number(),
          isPrivate: z.boolean(),
          estimatedHours: z.number().nullable(),
          spentHours: z.number().nullable(),
          createdOn: z.string(),
          updatedOn: z.string(),
          closedOn: z.string().nullable(),
          parent: z.object({ id: z.number() }).nullable(),
          customFields: z.array(z.object({
            id: z.number(),
            name: z.string(),
            value: z.union([z.string(), z.array(z.string())]),
          })),
        })),
        totalCount: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    issue_detail: {
      description: "Single issue with journals and children",
      schema: z.object({
        id: z.number(),
        project: z.object({ id: z.number(), name: z.string() }),
        tracker: z.object({ id: z.number(), name: z.string() }),
        status: z.object({
          id: z.number(),
          name: z.string(),
          is_closed: z.boolean().optional(),
        }),
        priority: z.object({ id: z.number(), name: z.string() }),
        author: z.object({ id: z.number(), name: z.string() }),
        assignedTo: z.object({ id: z.number(), name: z.string() }).nullable(),
        subject: z.string(),
        description: z.string(),
        startDate: z.string().nullable(),
        dueDate: z.string().nullable(),
        doneRatio: z.number(),
        isPrivate: z.boolean(),
        estimatedHours: z.number().nullable(),
        spentHours: z.number().nullable(),
        createdOn: z.string(),
        updatedOn: z.string(),
        closedOn: z.string().nullable(),
        parent: z.object({ id: z.number() }).nullable(),
        customFields: z.array(z.object({
          id: z.number(),
          name: z.string(),
          value: z.union([z.string(), z.array(z.string())]),
        })),
        journals: z.array(z.object({
          id: z.number(),
          user: z.object({ id: z.number(), name: z.string() }),
          notes: z.string(),
          createdOn: z.string(),
          details: z.array(z.object({
            property: z.string(),
            name: z.string(),
            oldValue: z.string().nullable(),
            newValue: z.string().nullable(),
          })),
        })),
        children: z.array(z.object({
          id: z.number(),
          tracker: z.object({ id: z.number(), name: z.string() }),
          subject: z.string(),
        })),
        relations: z.array(z.object({
          id: z.number(),
          issueId: z.number(),
          issueToId: z.number(),
          relationType: z.string(),
          delay: z.number().nullable(),
        })),
        watchers: z.array(z.object({
          id: z.number(),
          name: z.string(),
        })),
      }),
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    projects: {
      description: "List of accessible projects",
      schema: z.object({
        projects: z.array(z.object({
          id: z.number(),
          name: z.string(),
          identifier: z.string(),
          description: z.string(),
          status: z.number(),
          isPublic: z.boolean(),
          createdOn: z.string(),
          updatedOn: z.string(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    statuses: {
      description: "Issue statuses (id, name, isClosed)",
      schema: z.object({
        statuses: z.array(z.object({
          id: z.number(),
          name: z.string(),
          isClosed: z.boolean(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    trackers: {
      description: "Trackers (id, name, defaultStatus, description)",
      schema: z.object({
        trackers: z.array(z.object({
          id: z.number(),
          name: z.string(),
          defaultStatus: z.object({ id: z.number(), name: z.string() }),
          description: z.string(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    users: {
      description: "Project memberships (users and groups with roles)",
      schema: z.object({
        members: z.array(z.object({
          id: z.number(),
          name: z.string(),
          type: z.enum(["user", "group"]),
          roles: z.array(z.object({ id: z.number(), name: z.string() })),
        })),
        project: z.string(),
        fetchedAt: z.string(),
      }),
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    custom_fields: {
      description:
        "Custom field definitions (id, name, fieldFormat, possibleValues, ...)",
      schema: z.object({
        customFields: z.array(z.object({
          id: z.number(),
          name: z.string(),
          customizedType: z.string(),
          fieldFormat: z.string(),
          isRequired: z.boolean(),
          isFilter: z.boolean(),
          multiple: z.boolean(),
          defaultValue: z.string(),
          possibleValues: z.array(z.object({ value: z.string() })),
          trackers: z.array(z.object({ id: z.number(), name: z.string() })),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    relations: {
      description: "Issue relations (blocks, precedes, relates, etc.)",
      schema: z.object({
        relations: z.array(z.object({
          id: z.number(),
          issueId: z.number(),
          issueToId: z.number(),
          relationType: z.string(),
          delay: z.number().nullable(),
        })),
        issueId: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    versions: {
      description: "Project versions (milestones/sprints)",
      schema: z.object({
        versions: z.array(z.object({
          id: z.number(),
          project: z.object({ id: z.number(), name: z.string() }),
          name: z.string(),
          description: z.string(),
          status: z.string(),
          dueDate: z.string().nullable(),
          sharing: z.string(),
          wikiPageTitle: z.string().nullable(),
          createdOn: z.string(),
          updatedOn: z.string(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    time_entries: {
      description: "Time entries for issues or projects",
      schema: z.object({
        timeEntries: z.array(z.object({
          id: z.number(),
          project: z.object({ id: z.number(), name: z.string() }),
          issue: z.object({ id: z.number() }).optional(),
          user: z.object({ id: z.number(), name: z.string() }),
          activity: z.object({ id: z.number(), name: z.string() }),
          hours: z.number(),
          comments: z.string(),
          spentOn: z.string(),
          createdOn: z.string(),
          updatedOn: z.string(),
        })),
        totalCount: z.number(),
        fetchedAt: z.string(),
      }),
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    search_results: {
      description: "Search results across issues, projects, and wiki",
      schema: z.object({
        results: z.array(z.object({
          id: z.number(),
          title: z.string(),
          type: z.string(),
          url: z.string(),
          description: z.string(),
          datetime: z.string(),
        })),
        totalCount: z.number(),
        query: z.string(),
        fetchedAt: z.string(),
      }),
      lifetime: "15m" as const,
      garbageCollection: 3,
    },
    issue_categories: {
      description: "Issue categories for a project",
      schema: z.object({
        categories: z.array(z.object({
          id: z.number(),
          project: z.object({ id: z.number(), name: z.string() }),
          name: z.string(),
        })),
        project: z.string(),
        fetchedAt: z.string(),
      }),
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
  },

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  methods: {
    // ── Lookup methods (implemented) ──────────────────────────────────────

    list_statuses: {
      description: "List all issue statuses",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { host, apiKey, username } = context.globalArgs;
        const data = await redmineApi<{ issue_statuses: RawStatus[] }>(
          host,
          apiKey,
          "GET",
          "/issue_statuses.json",
          undefined,
          username,
        );

        const statuses = data.issue_statuses.map((s) => ({
          id: s.id,
          name: s.name,
          isClosed: s.is_closed,
        }));

        const handle = await context.writeResource("statuses", "all", {
          statuses,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} statuses", {
          count: statuses.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_trackers: {
      description: "List all trackers",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { host, apiKey, username } = context.globalArgs;
        const data = await redmineApi<{ trackers: RawTracker[] }>(
          host,
          apiKey,
          "GET",
          "/trackers.json",
          undefined,
          username,
        );

        const trackers = data.trackers.map((t) => ({
          id: t.id,
          name: t.name,
          defaultStatus: t.default_status,
          description: t.description,
        }));

        const handle = await context.writeResource("trackers", "all", {
          trackers,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} trackers", {
          count: trackers.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_projects: {
      description: "List all accessible projects",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { host, apiKey, username } = context.globalArgs;
        const rawProjects = await redmineApiPaginated<RawProject>(
          host,
          apiKey,
          "/projects.json",
          "projects",
          undefined,
          undefined,
          username,
        );

        const projects = rawProjects.map((p) => ({
          id: p.id,
          name: p.name,
          identifier: p.identifier,
          description: p.description,
          status: p.status,
          isPublic: p.is_public,
          createdOn: p.created_on,
          updatedOn: p.updated_on,
        }));

        const handle = await context.writeResource("projects", "all", {
          projects,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} projects", {
          count: projects.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_users: {
      description:
        "List project memberships (users and groups with their roles)",
      arguments: z.object({
        project: z.string().optional().describe(
          "Project identifier (defaults to global project arg)",
        ),
      }),
      execute: async (
        args: { project?: string },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const project = args.project ?? context.globalArgs.project;

        const rawMemberships = await redmineApiPaginated<RawMembership>(
          host,
          apiKey,
          `/projects/${encodeURIComponent(project)}/memberships.json`,
          "memberships",
          undefined,
          undefined,
          username,
        );

        const members = rawMemberships.map((m) => {
          if (m.user) {
            return {
              id: m.user.id,
              name: m.user.name,
              type: "user" as const,
              roles: m.roles,
            };
          }
          return {
            id: m.group!.id,
            name: m.group!.name,
            type: "group" as const,
            roles: m.roles,
          };
        });

        const handle = await context.writeResource("users", project, {
          members,
          project,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} members in project {project}", {
          count: members.length,
          project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_custom_fields: {
      description: "List all custom field definitions",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { host, apiKey, username } = context.globalArgs;
        const data = await redmineApi<{ custom_fields: RawCustomField[] }>(
          host,
          apiKey,
          "GET",
          "/custom_fields.json",
          undefined,
          username,
        );

        const customFields = data.custom_fields.map((cf) => ({
          id: cf.id,
          name: cf.name,
          customizedType: cf.customized_type,
          fieldFormat: cf.field_format,
          isRequired: cf.is_required,
          isFilter: cf.is_filter,
          multiple: cf.multiple,
          defaultValue: cf.default_value,
          possibleValues: cf.possible_values,
          trackers: cf.trackers,
        }));

        const handle = await context.writeResource("custom_fields", "all", {
          customFields,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} custom fields", {
          count: customFields.length,
        });
        return { dataHandles: [handle] };
      },
    },

    // ── Stub methods (not yet implemented) ────────────────────────────────

    list_issues: {
      description: "List issues matching filters",
      arguments: z.object({
        project: z.string().optional().describe("Project identifier"),
        trackerId: z.number().optional().describe("Filter by tracker ID"),
        statusId: z.union([
          z.number(),
          z.literal("open"),
          z.literal("closed"),
          z.literal("*"),
        ])
          .optional()
          .describe("Filter by status ID or open/closed/*"),
        assignedToId: z.union([z.number(), z.literal("me")])
          .optional()
          .describe("Filter by assignee ID or 'me'"),
        parentId: z.number().optional().describe("Filter by parent issue ID"),
        limit: z.number().optional().describe(
          "Max results (default 25, max 100)",
        ),
        sort: z.string().optional().describe(
          "Sort field (e.g., 'updated_on:desc')",
        ),
      }),
      execute: async (
        args: {
          project?: string;
          trackerId?: number;
          statusId?: number | "open" | "closed" | "*";
          assignedToId?: number | "me";
          parentId?: number;
          limit?: number;
          sort?: string;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const params: Record<string, string> = {};

        const projectId = args.project ?? context.globalArgs.project;
        params.project_id = projectId;

        if (args.trackerId !== undefined) {
          params.tracker_id = String(args.trackerId);
        }
        if (args.statusId !== undefined) {
          params.status_id = String(args.statusId);
        }
        if (args.assignedToId !== undefined) {
          params.assigned_to_id = String(args.assignedToId);
        }
        if (args.parentId !== undefined) {
          params.parent_id = String(args.parentId);
        }
        if (args.sort !== undefined) {
          params.sort = args.sort;
        }

        const rawIssues = await redmineApiPaginated<RawIssue>(
          host,
          apiKey,
          "/issues.json",
          "issues",
          params,
          args.limit ?? 100,
          username,
        );

        const issues = rawIssues.map(mapIssue);

        // Build instance name from active filters
        const filterParts: string[] = [];
        if (args.statusId !== undefined) {
          filterParts.push(String(args.statusId));
        }
        if (args.trackerId !== undefined) {
          filterParts.push(String(args.trackerId));
        }
        const instanceName = filterParts.length > 0
          ? filterParts.join("-")
          : "all";

        const handle = await context.writeResource("issues", instanceName, {
          issues,
          totalCount: issues.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} issues", { count: issues.length });
        return { dataHandles: [handle] };
      },
    },

    get_issue: {
      description: "Get a single issue with journals and children",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
      }),
      execute: async (
        args: { issueId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const data = await redmineApi<{ issue: RawIssue }>(
          host,
          apiKey,
          "GET",
          `/issues/${args.issueId}.json?include=journals,children,relations,watchers`,
          undefined,
          username,
        );

        const issue = mapIssueDetail(data.issue);

        const handle = await context.writeResource(
          "issue_detail",
          String(args.issueId),
          issue,
        );

        context.logger.info("Fetched issue {id}", { id: args.issueId });
        return { dataHandles: [handle] };
      },
    },

    create_issue: {
      description: "Create a new issue",
      arguments: z.object({
        subject: z.string().describe("Issue subject"),
        project: z.string().optional().describe("Project identifier"),
        trackerId: z.number().optional().describe("Tracker ID"),
        statusId: z.number().optional().describe("Status ID"),
        priorityId: z.number().optional().describe("Priority ID"),
        assignedToId: z.number().optional().describe("Assignee user ID"),
        description: z.string().optional().describe("Issue description"),
        parentIssueId: z.number().optional().describe("Parent issue ID"),
        estimatedHours: z.number().optional().describe("Estimated hours"),
        customFields: z.array(z.object({
          id: z.number(),
          value: z.union([z.string(), z.array(z.string())]),
        })).optional().describe("Custom field values"),
      }),
      execute: async (
        args: {
          subject: string;
          project?: string;
          trackerId?: number;
          statusId?: number;
          priorityId?: number;
          assignedToId?: number;
          description?: string;
          parentIssueId?: number;
          estimatedHours?: number;
          customFields?: Array<{
            id: number;
            value: string | string[];
          }>;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;

        // Build payload with only defined fields
        const issuePayload: Record<string, unknown> = {
          project_id: args.project ?? context.globalArgs.project,
          subject: args.subject,
        };
        if (args.trackerId !== undefined) {
          issuePayload.tracker_id = args.trackerId;
        }
        if (args.description !== undefined) {
          issuePayload.description = args.description;
        }
        if (args.assignedToId !== undefined) {
          issuePayload.assigned_to_id = args.assignedToId;
        }
        if (args.statusId !== undefined) {
          issuePayload.status_id = args.statusId;
        }
        if (args.priorityId !== undefined) {
          issuePayload.priority_id = args.priorityId;
        }
        if (args.parentIssueId !== undefined) {
          issuePayload.parent_issue_id = args.parentIssueId;
        }
        if (args.estimatedHours !== undefined) {
          issuePayload.estimated_hours = args.estimatedHours;
        }
        if (args.customFields !== undefined) {
          issuePayload.custom_fields = args.customFields;
        }

        const data = await redmineApi<{ issue: RawIssue }>(
          host,
          apiKey,
          "POST",
          "/issues.json",
          { issue: issuePayload },
          username,
        );

        const issue = mapIssueDetail(data.issue);

        const handle = await context.writeResource(
          "issue_detail",
          String(data.issue.id),
          issue,
        );

        context.logger.info("Created issue {id}", { id: data.issue.id });
        return { dataHandles: [handle] };
      },
    },

    update_issue: {
      description: "Update an existing issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID to update"),
        subject: z.string().optional().describe("New subject"),
        trackerId: z.number().optional().describe("New tracker ID"),
        statusId: z.number().optional().describe("New status ID"),
        priorityId: z.number().optional().describe("New priority ID"),
        assignedToId: z.number().optional().describe("New assignee user ID"),
        description: z.string().optional().describe("New description"),
        parentIssueId: z.number().optional().describe("New parent issue ID"),
        estimatedHours: z.number().optional().describe("New estimated hours"),
        doneRatio: z.number().optional().describe("Percent done (0-100)"),
        dueDate: z.string().optional().describe(
          "Updated due date (YYYY-MM-DD)",
        ),
        notes: z.string().optional().describe("Journal note to add"),
        customFields: z.array(z.object({
          id: z.number(),
          value: z.union([z.string(), z.array(z.string())]),
        })).optional().describe("Custom field values to update"),
      }),
      execute: async (
        args: {
          issueId: number;
          subject?: string;
          statusId?: number;
          trackerId?: number;
          priorityId?: number;
          assignedToId?: number;
          description?: string;
          parentIssueId?: number;
          estimatedHours?: number;
          doneRatio?: number;
          dueDate?: string;
          notes?: string;
          customFields?: Array<{
            id: number;
            value: string | string[];
          }>;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;

        // Build update payload with only defined fields
        const issuePayload: Record<string, unknown> = {};
        if (args.statusId !== undefined) {
          issuePayload.status_id = args.statusId;
        }
        if (args.subject !== undefined) {
          issuePayload.subject = args.subject;
        }
        if (args.description !== undefined) {
          issuePayload.description = args.description;
        }
        if (args.assignedToId !== undefined) {
          issuePayload.assigned_to_id = args.assignedToId;
        }
        if (args.notes !== undefined) {
          issuePayload.notes = args.notes;
        }
        if (args.doneRatio !== undefined) {
          issuePayload.done_ratio = args.doneRatio;
        }
        if (args.dueDate !== undefined) {
          issuePayload.due_date = args.dueDate;
        }
        if (args.trackerId !== undefined) {
          issuePayload.tracker_id = args.trackerId;
        }
        if (args.priorityId !== undefined) {
          issuePayload.priority_id = args.priorityId;
        }
        if (args.parentIssueId !== undefined) {
          issuePayload.parent_issue_id = args.parentIssueId;
        }
        if (args.estimatedHours !== undefined) {
          issuePayload.estimated_hours = args.estimatedHours;
        }
        if (args.customFields !== undefined) {
          issuePayload.custom_fields = args.customFields;
        }

        // PUT returns 204 No Content
        await redmineApi(
          host,
          apiKey,
          "PUT",
          `/issues/${args.issueId}.json`,
          { issue: issuePayload },
          username,
        );

        // Re-fetch the updated issue
        const data = await redmineApi<{ issue: RawIssue }>(
          host,
          apiKey,
          "GET",
          `/issues/${args.issueId}.json?include=journals,children,relations,watchers`,
          undefined,
          username,
        );

        const issue = mapIssueDetail(data.issue);

        const handle = await context.writeResource(
          "issue_detail",
          String(args.issueId),
          issue,
        );

        context.logger.info("Updated issue {id}", { id: args.issueId });
        return { dataHandles: [handle] };
      },
    },

    delete_issue: {
      description: "Delete an issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID to delete"),
      }),
      execute: async (
        args: { issueId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        await redmineApi(
          host,
          apiKey,
          "DELETE",
          `/issues/${args.issueId}.json`,
          undefined,
          username,
        );
        context.logger.info("Deleted issue {id}", { id: args.issueId });
        return { dataHandles: [] };
      },
    },

    list_relations: {
      description: "List relations for an issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
      }),
      execute: async (
        args: { issueId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const data = await redmineApi<{
          relations: Array<{
            id: number;
            issue_id: number;
            issue_to_id: number;
            relation_type: string;
            delay: number | null;
          }>;
        }>(
          host,
          apiKey,
          "GET",
          `/issues/${args.issueId}/relations.json`,
          undefined,
          username,
        );

        const relations = data.relations.map((r) => ({
          id: r.id,
          issueId: r.issue_id,
          issueToId: r.issue_to_id,
          relationType: r.relation_type,
          delay: r.delay,
        }));

        const handle = await context.writeResource(
          "relations",
          String(args.issueId),
          {
            relations,
            issueId: args.issueId,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} relations for issue {id}", {
          count: relations.length,
          id: args.issueId,
        });
        return { dataHandles: [handle] };
      },
    },

    create_relation: {
      description: "Create a relation between two issues",
      arguments: z.object({
        issueId: z.number().describe("Source issue ID"),
        issueToId: z.number().describe("Target issue ID"),
        relationType: z.enum([
          "relates",
          "duplicates",
          "duplicated",
          "blocks",
          "blocked",
          "precedes",
          "follows",
          "copied_to",
          "copied_from",
        ]).describe("Relation type"),
        delay: z.number().optional().describe(
          "Delay in days (for precedes/follows)",
        ),
      }),
      execute: async (
        args: {
          issueId: number;
          issueToId: number;
          relationType: string;
          delay?: number;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const payload: Record<string, unknown> = {
          issue_to_id: args.issueToId,
          relation_type: args.relationType,
        };
        if (args.delay !== undefined) payload.delay = args.delay;

        await redmineApi<{
          relation: {
            id: number;
            issue_id: number;
            issue_to_id: number;
            relation_type: string;
            delay: number | null;
          };
        }>(
          host,
          apiKey,
          "POST",
          `/issues/${args.issueId}/relations.json`,
          { relation: payload },
          username,
        );

        context.logger.info("Created {type} relation from {from} to {to}", {
          type: args.relationType,
          from: args.issueId,
          to: args.issueToId,
        });
        return { dataHandles: [] };
      },
    },

    delete_relation: {
      description: "Delete a relation",
      arguments: z.object({
        relationId: z.number().describe("Relation ID to delete"),
      }),
      execute: async (
        args: { relationId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        await redmineApi(
          host,
          apiKey,
          "DELETE",
          `/relations/${args.relationId}.json`,
          undefined,
          username,
        );
        context.logger.info("Deleted relation {id}", { id: args.relationId });
        return { dataHandles: [] };
      },
    },

    list_versions: {
      description: "List project versions (milestones/sprints)",
      arguments: z.object({
        project: z.string().optional().describe(
          "Project identifier (defaults to global project arg)",
        ),
      }),
      execute: async (
        args: { project?: string },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const project = args.project ?? context.globalArgs.project;

        interface RawVersion {
          id: number;
          project: { id: number; name: string };
          name: string;
          description: string;
          status: string;
          due_date: string | null;
          sharing: string;
          wiki_page_title: string | null;
          created_on: string;
          updated_on: string;
        }

        const data = await redmineApi<{ versions: RawVersion[] }>(
          host,
          apiKey,
          "GET",
          `/projects/${encodeURIComponent(project)}/versions.json`,
          undefined,
          username,
        );

        const versions = data.versions.map((v) => ({
          id: v.id,
          project: v.project,
          name: v.name,
          description: v.description,
          status: v.status,
          dueDate: v.due_date,
          sharing: v.sharing,
          wikiPageTitle: v.wiki_page_title,
          createdOn: v.created_on,
          updatedOn: v.updated_on,
        }));

        const handle = await context.writeResource("versions", project, {
          versions,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} versions in project {project}", {
          count: versions.length,
          project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_time_entries: {
      description: "List time entries, optionally filtered by issue or project",
      arguments: z.object({
        issueId: z.number().optional().describe("Filter by issue ID"),
        project: z.string().optional().describe(
          "Filter by project identifier",
        ),
        userId: z.number().optional().describe("Filter by user ID"),
        from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to: z.string().optional().describe("End date (YYYY-MM-DD)"),
        limit: z.number().optional().describe("Max results (default 25)"),
      }),
      execute: async (
        args: {
          issueId?: number;
          project?: string;
          userId?: number;
          from?: string;
          to?: string;
          limit?: number;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.issueId !== undefined) {
          params.issue_id = String(args.issueId);
        }
        if (args.project !== undefined) {
          params.project_id = args.project;
        }
        if (args.userId !== undefined) params.user_id = String(args.userId);
        if (args.from !== undefined) params.from = args.from;
        if (args.to !== undefined) params.to = args.to;

        const rawEntries = await redmineApiPaginated<{
          id: number;
          project: { id: number; name: string };
          issue?: { id: number };
          user: { id: number; name: string };
          activity: { id: number; name: string };
          hours: number;
          comments: string;
          spent_on: string;
          created_on: string;
          updated_on: string;
        }>(
          host,
          apiKey,
          "/time_entries.json",
          "time_entries",
          params,
          args.limit ?? 100,
          username,
        );

        const timeEntries = rawEntries.map((e) => ({
          id: e.id,
          project: e.project,
          issue: e.issue,
          user: e.user,
          activity: e.activity,
          hours: e.hours,
          comments: e.comments,
          spentOn: e.spent_on,
          createdOn: e.created_on,
          updatedOn: e.updated_on,
        }));

        const instanceName = args.issueId
          ? String(args.issueId)
          : args.project ?? "all";

        const handle = await context.writeResource(
          "time_entries",
          instanceName,
          {
            timeEntries,
            totalCount: timeEntries.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} time entries", {
          count: timeEntries.length,
        });
        return { dataHandles: [handle] };
      },
    },

    log_time: {
      description: "Log time spent on an issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
        hours: z.number().describe("Hours spent"),
        activityId: z.number().optional().describe("Activity ID"),
        comments: z.string().optional().describe("Comment"),
        spentOn: z.string().optional().describe(
          "Date spent (YYYY-MM-DD, defaults to today)",
        ),
      }),
      execute: async (
        args: {
          issueId: number;
          hours: number;
          activityId?: number;
          comments?: string;
          spentOn?: string;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const payload: Record<string, unknown> = {
          issue_id: args.issueId,
          hours: args.hours,
        };
        if (args.activityId !== undefined) {
          payload.activity_id = args.activityId;
        }
        if (args.comments !== undefined) payload.comments = args.comments;
        if (args.spentOn !== undefined) payload.spent_on = args.spentOn;

        const data = await redmineApi<{
          time_entry: {
            id: number;
            project: { id: number; name: string };
            issue: { id: number };
            user: { id: number; name: string };
            activity: { id: number; name: string };
            hours: number;
            comments: string;
            spent_on: string;
            created_on: string;
            updated_on: string;
          };
        }>(
          host,
          apiKey,
          "POST",
          "/time_entries.json",
          { time_entry: payload },
          username,
        );

        const e = data.time_entry;
        const entry = {
          id: e.id,
          project: e.project,
          issue: e.issue,
          user: e.user,
          activity: e.activity,
          hours: e.hours,
          comments: e.comments,
          spentOn: e.spent_on,
          createdOn: e.created_on,
          updatedOn: e.updated_on,
        };

        const handle = await context.writeResource(
          "time_entries",
          String(args.issueId),
          {
            timeEntries: [entry],
            totalCount: 1,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Logged {hours}h on issue {id}", {
          hours: args.hours,
          id: args.issueId,
        });
        return { dataHandles: [handle] };
      },
    },

    add_watcher: {
      description: "Add a watcher to an issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
        userId: z.number().describe("User ID to add as watcher"),
      }),
      execute: async (
        args: { issueId: number; userId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        await redmineApi(
          host,
          apiKey,
          "POST",
          `/issues/${args.issueId}/watchers.json`,
          { user_id: args.userId },
          username,
        );
        context.logger.info("Added watcher {userId} to issue {issueId}", {
          userId: args.userId,
          issueId: args.issueId,
        });
        return { dataHandles: [] };
      },
    },

    remove_watcher: {
      description: "Remove a watcher from an issue",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
        userId: z.number().describe("User ID to remove as watcher"),
      }),
      execute: async (
        args: { issueId: number; userId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        await redmineApi(
          host,
          apiKey,
          "DELETE",
          `/issues/${args.issueId}/watchers/${args.userId}.json`,
          undefined,
          username,
        );
        context.logger.info("Removed watcher {userId} from issue {issueId}", {
          userId: args.userId,
          issueId: args.issueId,
        });
        return { dataHandles: [] };
      },
    },

    search: {
      description: "Search across issues, projects, and wiki pages",
      arguments: z.object({
        query: z.string().describe("Search query"),
        project: z.string().optional().describe(
          "Scope search to project identifier",
        ),
        limit: z.number().optional().describe("Max results (default 25)"),
      }),
      execute: async (
        args: { query: string; project?: string; limit?: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const params = new URLSearchParams({ q: args.query });
        if (args.limit !== undefined) {
          params.set("limit", String(args.limit));
        }

        const basePath = args.project
          ? `/projects/${encodeURIComponent(args.project)}/search.json`
          : "/search.json";

        const data = await redmineApi<{
          results: Array<{
            id: number;
            title: string;
            type: string;
            url: string;
            description: string;
            datetime: string;
          }>;
          total_count: number;
        }>(
          host,
          apiKey,
          "GET",
          `${basePath}?${params}`,
          undefined,
          username,
        );

        const handle = await context.writeResource(
          "search_results",
          args.query.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50),
          {
            results: data.results,
            totalCount: data.total_count,
            query: args.query,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Search for '{query}' returned {count} results", {
          query: args.query,
          count: data.total_count,
        });
        return { dataHandles: [handle] };
      },
    },

    get_version: {
      description: "Get a single version by ID",
      arguments: z.object({
        versionId: z.number().describe("Version ID"),
      }),
      execute: async (
        args: { versionId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;

        interface RawVersion {
          id: number;
          project: { id: number; name: string };
          name: string;
          description: string;
          status: string;
          due_date: string | null;
          sharing: string;
          wiki_page_title: string | null;
          created_on: string;
          updated_on: string;
        }

        const data = await redmineApi<{ version: RawVersion }>(
          host,
          apiKey,
          "GET",
          `/versions/${args.versionId}.json`,
          undefined,
          username,
        );

        const v = data.version;
        const version = {
          id: v.id,
          project: v.project,
          name: v.name,
          description: v.description,
          status: v.status,
          dueDate: v.due_date,
          sharing: v.sharing,
          wikiPageTitle: v.wiki_page_title,
          createdOn: v.created_on,
          updatedOn: v.updated_on,
        };

        const handle = await context.writeResource(
          "versions",
          String(args.versionId),
          { versions: [version], fetchedAt: new Date().toISOString() },
        );

        context.logger.info("Fetched version {id}", { id: args.versionId });
        return { dataHandles: [handle] };
      },
    },

    create_version: {
      description: "Create a project version (milestone/sprint)",
      arguments: z.object({
        project: z.string().optional().describe(
          "Project identifier (defaults to global project arg)",
        ),
        name: z.string().describe("Version name"),
        description: z.string().optional().describe("Description"),
        status: z.enum(["open", "locked", "closed"]).optional().describe(
          "Version status",
        ),
        dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        sharing: z.enum([
          "none",
          "descendants",
          "hierarchy",
          "tree",
          "system",
        ]).optional().describe("Sharing scope"),
        wikiPageTitle: z.string().optional().describe("Wiki page title"),
      }),
      execute: async (
        args: {
          project?: string;
          name: string;
          description?: string;
          status?: string;
          dueDate?: string;
          sharing?: string;
          wikiPageTitle?: string;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const project = args.project ?? context.globalArgs.project;

        const payload: Record<string, unknown> = { name: args.name };
        if (args.description !== undefined) {
          payload.description = args.description;
        }
        if (args.status !== undefined) payload.status = args.status;
        if (args.dueDate !== undefined) payload.due_date = args.dueDate;
        if (args.sharing !== undefined) payload.sharing = args.sharing;
        if (args.wikiPageTitle !== undefined) {
          payload.wiki_page_title = args.wikiPageTitle;
        }

        const data = await redmineApi<{
          version: {
            id: number;
            project: { id: number; name: string };
            name: string;
            description: string;
            status: string;
            due_date: string | null;
            sharing: string;
            wiki_page_title: string | null;
            created_on: string;
            updated_on: string;
          };
        }>(
          host,
          apiKey,
          "POST",
          `/projects/${encodeURIComponent(project)}/versions.json`,
          { version: payload },
          username,
        );

        const v = data.version;
        const version = {
          id: v.id,
          project: v.project,
          name: v.name,
          description: v.description,
          status: v.status,
          dueDate: v.due_date,
          sharing: v.sharing,
          wikiPageTitle: v.wiki_page_title,
          createdOn: v.created_on,
          updatedOn: v.updated_on,
        };

        const handle = await context.writeResource(
          "versions",
          String(v.id),
          { versions: [version], fetchedAt: new Date().toISOString() },
        );

        context.logger.info("Created version {name} ({id})", {
          name: v.name,
          id: v.id,
        });
        return { dataHandles: [handle] };
      },
    },

    update_version: {
      description: "Update a version",
      arguments: z.object({
        versionId: z.number().describe("Version ID"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        status: z.enum(["open", "locked", "closed"]).optional().describe(
          "New status",
        ),
        dueDate: z.string().optional().describe("New due date (YYYY-MM-DD)"),
        sharing: z.enum([
          "none",
          "descendants",
          "hierarchy",
          "tree",
          "system",
        ]).optional().describe("New sharing scope"),
        wikiPageTitle: z.string().optional().describe("New wiki page title"),
      }),
      execute: async (
        args: {
          versionId: number;
          name?: string;
          description?: string;
          status?: string;
          dueDate?: string;
          sharing?: string;
          wikiPageTitle?: string;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const payload: Record<string, unknown> = {};
        if (args.name !== undefined) payload.name = args.name;
        if (args.description !== undefined) {
          payload.description = args.description;
        }
        if (args.status !== undefined) payload.status = args.status;
        if (args.dueDate !== undefined) payload.due_date = args.dueDate;
        if (args.sharing !== undefined) payload.sharing = args.sharing;
        if (args.wikiPageTitle !== undefined) {
          payload.wiki_page_title = args.wikiPageTitle;
        }

        await redmineApi(
          host,
          apiKey,
          "PUT",
          `/versions/${args.versionId}.json`,
          { version: payload },
          username,
        );

        context.logger.info("Updated version {id}", { id: args.versionId });
        return { dataHandles: [] };
      },
    },

    delete_version: {
      description: "Delete a version",
      arguments: z.object({
        versionId: z.number().describe("Version ID to delete"),
      }),
      execute: async (
        args: { versionId: number },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        await redmineApi(
          host,
          apiKey,
          "DELETE",
          `/versions/${args.versionId}.json`,
          undefined,
          username,
        );
        context.logger.info("Deleted version {id}", { id: args.versionId });
        return { dataHandles: [] };
      },
    },

    update_journal: {
      description: "Update a journal entry's notes",
      arguments: z.object({
        journalId: z.number().describe("Journal ID"),
        notes: z.string().describe("Updated notes content"),
        privateNotes: z.boolean().optional().describe(
          "Mark notes as private",
        ),
      }),
      execute: async (
        args: { journalId: number; notes: string; privateNotes?: boolean },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const payload: Record<string, unknown> = { notes: args.notes };
        if (args.privateNotes !== undefined) {
          payload.private_notes = args.privateNotes;
        }

        await redmineApi(
          host,
          apiKey,
          "PUT",
          `/journals/${args.journalId}.json`,
          { journal: payload },
          username,
        );

        context.logger.info("Updated journal {id}", { id: args.journalId });
        return { dataHandles: [] };
      },
    },

    list_issue_categories: {
      description: "List issue categories for a project",
      arguments: z.object({
        project: z.string().optional().describe(
          "Project identifier (defaults to global project arg)",
        ),
      }),
      execute: async (
        args: { project?: string },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const project = args.project ?? context.globalArgs.project;

        const data = await redmineApi<{
          issue_categories: Array<{
            id: number;
            project: { id: number; name: string };
            name: string;
          }>;
        }>(
          host,
          apiKey,
          "GET",
          `/projects/${encodeURIComponent(project)}/issue_categories.json`,
          undefined,
          username,
        );

        const categories = data.issue_categories;

        const handle = await context.writeResource(
          "issue_categories",
          project,
          { categories, project, fetchedAt: new Date().toISOString() },
        );

        context.logger.info("Found {count} categories in project {project}", {
          count: categories.length,
          project,
        });
        return { dataHandles: [handle] };
      },
    },

    upload_file: {
      description:
        "Upload a file and attach it to an issue (two-step: upload binary, then attach token)",
      arguments: z.object({
        issueId: z.number().describe("Issue ID to attach the file to"),
        filePath: z.string().refine(
          (p) => !p.startsWith("/") && !p.includes(".."),
          "Only relative paths without '..' are allowed",
        ).describe("Local file path to upload (relative)"),
        filename: z.string().optional().describe(
          "Filename for the attachment (defaults to basename of filePath)",
        ),
        description: z.string().optional().describe(
          "Attachment description",
        ),
        contentType: z.string().optional().describe(
          "MIME type (auto-detected from filename if omitted)",
        ),
      }),
      execute: async (
        args: {
          issueId: number;
          filePath: string;
          filename?: string;
          description?: string;
          contentType?: string;
        },
        context: MethodContext,
      ) => {
        const { host, apiKey, username } = context.globalArgs;
        const fileName = args.filename ??
          args.filePath.split("/").pop() ??
          "attachment";

        // Step 1: Upload binary
        const fileData = await Deno.readFile(args.filePath);
        const params = new URLSearchParams();
        params.set("filename", fileName);
        if (args.contentType) params.set("content_type", args.contentType);

        const headers: Record<string, string> = {
          "X-Redmine-API-Key": apiKey,
          "Content-Type": "application/octet-stream",
        };
        if (username) headers["X-Redmine-Username"] = username;

        const uploadResp = await fetch(
          `${host}/uploads.json?${params}`,
          { method: "POST", headers, body: fileData },
        );

        if (!uploadResp.ok) {
          throw new Error(`Upload failed: ${uploadResp.status}`);
        }

        const uploadData = (await uploadResp.json()) as {
          upload: { id: number; token: string };
        };
        const token = uploadData.upload.token;

        // Step 2: Attach to issue
        const attachment: Record<string, string> = {
          token,
          filename: fileName,
        };
        if (args.description) attachment.description = args.description;
        if (args.contentType) attachment.content_type = args.contentType;

        await redmineApi(
          host,
          apiKey,
          "PUT",
          `/issues/${args.issueId}.json`,
          { issue: { uploads: [attachment] } },
          username,
        );

        context.logger.info("Attached {filename} to issue {id}", {
          filename: fileName,
          id: args.issueId,
        });
        return { dataHandles: [] };
      },
    },
  },
};
