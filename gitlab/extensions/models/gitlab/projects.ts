/**
 * GitLab project operations model for swamp.
 *
 * Queries and mutates GitLab data via the REST API (v4) for projects,
 * merge requests, issues, releases, and CI/CD pipelines. Supports
 * self-hosted instances. Auth via personal access token stored in a
 * swamp vault.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "GitLab hostname (e.g. git.bethelservice.org)",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "GitLab personal access token with api scope (use vault reference)",
  ),
});

const ProjectSchema = z.object({
  name: z.string(),
  pathWithNamespace: z.string(),
  description: z.string().nullable(),
  visibility: z.string(),
  starCount: z.number(),
  forksCount: z.number(),
  lastActivityAt: z.string(),
  defaultBranch: z.string().nullable(),
  archived: z.boolean(),
  topics: z.array(z.string()),
});

const ProjectListSchema = z.object({
  projects: z.array(ProjectSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const ProjectInfoSchema = z.object({
  name: z.string(),
  pathWithNamespace: z.string(),
  description: z.string().nullable(),
  visibility: z.string(),
  defaultBranch: z.string().nullable(),
  starCount: z.number(),
  forksCount: z.number(),
  openIssuesCount: z.number(),
  archived: z.boolean(),
  topics: z.array(z.string()),
  webUrl: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  fetchedAt: z.string(),
});

const MergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  draft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
});

const MergeRequestListSchema = z.object({
  project: z.string(),
  mergeRequests: z.array(MergeRequestSchema),
  count: z.number(),
  truncated: z.boolean(),
  state: z.string(),
  fetchedAt: z.string(),
});

const IssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
});

const IssueListSchema = z.object({
  project: z.string(),
  issues: z.array(IssueSchema),
  count: z.number(),
  truncated: z.boolean(),
  state: z.string(),
  fetchedAt: z.string(),
});

const IssueDetailSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  webUrl: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const NoteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  createdAt: z.string(),
});

const NoteListSchema = z.object({
  project: z.string(),
  noteableType: z.string(),
  noteableIid: z.number(),
  notes: z.array(NoteSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const ReleaseSchema = z.object({
  tagName: z.string(),
  name: z.string(),
  createdAt: z.string(),
  releasedAt: z.string(),
  upcoming: z.boolean(),
});

const ReleaseListSchema = z.object({
  project: z.string(),
  releases: z.array(ReleaseSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const PipelineSchema = z.object({
  iid: z.number(),
  name: z.string().nullable(),
  status: z.string(),
  source: z.string(),
  ref: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PipelineListSchema = z.object({
  project: z.string(),
  pipelines: z.array(PipelineSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const LabelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

const LabelListSchema = z.object({
  project: z.string(),
  labels: z.array(LabelSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const MemberSchema = z.object({
  username: z.string(),
  name: z.string(),
  accessLevel: z.number(),
});

const MemberListSchema = z.object({
  project: z.string(),
  members: z.array(MemberSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const BranchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  default: z.boolean(),
});

const BranchListSchema = z.object({
  project: z.string(),
  branches: z.array(BranchSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const DashboardMRSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  webUrl: z.string(),
});

const TodoSchema = z.object({
  id: z.string(),
  action: z.string(),
  body: z.string(),
  targetType: z.string(),
  targetUrl: z.string(),
  project: z.string().nullable(),
  author: z.string(),
  createdAt: z.string(),
});

const DashboardSchema = z.object({
  username: z.string(),
  reviewing: z.array(DashboardMRSchema),
  assigned: z.array(DashboardMRSchema),
  authored: z.array(DashboardMRSchema),
  todos: z.array(TodoSchema),
  totalCount: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

// =============================================================================
// GraphQL Client
// =============================================================================

async function graphqlRequest(
  host: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const resp = await fetch(`https://${host}/api/graphql`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GraphQL request failed: ${resp.status} ${body}`);
  }
  const result = await resp.json();
  if (result.errors?.length) {
    throw new Error(
      `GraphQL errors: ${result.errors.map((e: any) => e.message).join("; ")}`,
    );
  }
  return result.data;
}

const DASHBOARD_QUERY = `
query dashboard($mrState: MergeRequestState, $perPage: Int!, $includeArchived: Boolean) {
  currentUser {
    username
    reviewRequestedMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } }
      pageInfo { hasNextPage }
    }
    assignedMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } }
      pageInfo { hasNextPage }
    }
    authoredMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } }
      pageInfo { hasNextPage }
    }
    todos(state: pending, first: 20) {
      nodes { id action body targetType targetUrl createdAt author { username } project { nameWithNamespace } }
    }
  }
}`;

function mapDashboardMR(node: any): z.infer<typeof DashboardMRSchema> {
  return {
    project: node.project?.fullPath ?? "",
    iid: typeof node.iid === "string" ? parseInt(node.iid) : node.iid,
    title: node.title ?? "",
    author: node.author?.username ?? "",
    updatedAt: node.updatedAt ?? "",
    draft: node.draft ?? false,
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
    webUrl: node.webUrl ?? "",
  };
}

function mapTodo(node: any): z.infer<typeof TodoSchema> {
  return {
    id: node.id ?? "",
    action: node.action ?? "",
    body: node.body ?? "",
    targetType: node.targetType ?? "",
    targetUrl: node.targetUrl ?? "",
    project: node.project?.nameWithNamespace ?? null,
    author: node.author?.username ?? "",
    createdAt: node.createdAt ?? "",
  };
}

// =============================================================================
// REST API Client
// =============================================================================

/** Response from a list endpoint including pagination state. */
interface ListResponse {
  data: any;
  truncated: boolean;
}

class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(host: string, token: string) {
    this.baseUrl = `https://${host}/api/v4`;
    this.token = token;
  }

  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" };
  }

  private projectUrl(project: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(project)}`;
  }

  /** GET a single object (no pagination). */
  async get(path: string, params?: Record<string, string>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GitLab GET ${path}: ${resp.status} ${body}`);
    }
    return resp.json();
  }

  /** GET a list from a top-level path, returning data + truncation flag. */
  async getList(
    path: string,
    params?: Record<string, string>,
  ): Promise<ListResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GitLab GET ${path}: ${resp.status} ${body}`);
    }
    const nextPage = resp.headers.get("x-next-page");
    return {
      data: await resp.json(),
      truncated: !!nextPage && nextPage !== "",
    };
  }

  /** GET a single object scoped to a project. */
  async getProject(project: string, path: string): Promise<any> {
    const url = `${this.projectUrl(project)}${path}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `GitLab GET ${project}${path}: ${resp.status} ${body}`,
      );
    }
    return resp.json();
  }

  /** GET a list scoped to a project, returning data + truncation flag. */
  async getProjectList(
    project: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<ListResponse> {
    const url = new URL(`${this.projectUrl(project)}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `GitLab GET ${project}${path}: ${resp.status} ${body}`,
      );
    }
    const nextPage = resp.headers.get("x-next-page");
    return {
      data: await resp.json(),
      truncated: !!nextPage && nextPage !== "",
    };
  }

  async post(
    project: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const resp = await fetch(`${this.projectUrl(project)}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab POST ${project}${path}: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  async put(
    project: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const resp = await fetch(`${this.projectUrl(project)}${path}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab PUT ${project}${path}: ${resp.status} ${text}`);
    }
    return resp.json();
  }
}

// =============================================================================
// Mappers
// =============================================================================

function mapProject(raw: any): z.infer<typeof ProjectSchema> {
  return {
    name: raw.name ?? "",
    pathWithNamespace: raw.path_with_namespace ?? "",
    description: raw.description ?? null,
    visibility: raw.visibility ?? "private",
    starCount: raw.star_count ?? 0,
    forksCount: raw.forks_count ?? 0,
    lastActivityAt: raw.last_activity_at ?? raw.updated_at ?? "",
    defaultBranch: raw.default_branch ?? null,
    archived: raw.archived ?? false,
    topics: raw.topics ?? raw.tag_list ?? [],
  };
}

function mapMR(raw: any): z.infer<typeof MergeRequestSchema> {
  return {
    iid: raw.iid,
    title: raw.title ?? "",
    state: raw.state ?? "",
    author: raw.author ? { username: raw.author.username } : null,
    sourceBranch: raw.source_branch ?? "",
    targetBranch: raw.target_branch ?? "",
    draft: raw.draft ?? false,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    labels: raw.labels ?? [],
  };
}

function mapIssue(raw: any): z.infer<typeof IssueSchema> {
  return {
    iid: raw.iid,
    title: raw.title ?? "",
    state: raw.state ?? "",
    author: raw.author ? { username: raw.author.username } : null,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    labels: raw.labels ?? [],
  };
}

function mapRelease(raw: any): z.infer<typeof ReleaseSchema> {
  return {
    tagName: raw.tag_name ?? "",
    name: raw.name ?? "",
    createdAt: raw.created_at ?? "",
    releasedAt: raw.released_at ?? raw.created_at ?? "",
    upcoming: raw.upcoming_release ?? false,
  };
}

function mapPipeline(raw: any): z.infer<typeof PipelineSchema> {
  return {
    iid: raw.iid ?? raw.id,
    name: raw.name ?? null,
    status: raw.status ?? "",
    source: raw.source ?? "",
    ref: raw.ref ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

function mapIssueDetail(
  project: string,
  raw: any,
): z.infer<typeof IssueDetailSchema> {
  return {
    project,
    iid: raw.iid,
    title: raw.title ?? "",
    description: raw.description ?? "",
    state: raw.state ?? "opened",
    webUrl: raw.web_url ?? "",
    labels: raw.labels ?? [],
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

function mapNote(raw: any): z.infer<typeof NoteSchema> {
  return {
    id: raw.id,
    body: raw.body ?? "",
    author: raw.author ? { username: raw.author.username } : null,
    createdAt: raw.created_at ?? "",
  };
}

function sanitizeName(project: string): string {
  return project.replace(/\//g, "~");
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: { host: string; token: string };
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

/** GitLab model — read and write projects, issues, MRs, pipelines via REST API. */
export const model = {
  type: "@webframp/gitlab",
  version: "2026.06.12.1",
  globalArguments: GlobalArgsSchema,
  reports: ["@webframp/review-dashboard"],

  resources: {
    projects: {
      description: "List of projects for the authenticated user",
      schema: ProjectListSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    projectInfo: {
      description: "Detailed information about a specific project",
      schema: ProjectInfoSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    mergeRequests: {
      description: "List of merge requests for a project",
      schema: MergeRequestListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    issues: {
      description: "List of issues for a project",
      schema: IssueListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    issueDetail: {
      description: "Single issue detail (from create/update)",
      schema: IssueDetailSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    notes: {
      description: "Notes/comments on an issue or MR",
      schema: NoteListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    releases: {
      description: "List of releases for a project",
      schema: ReleaseListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    pipelines: {
      description: "List of recent CI/CD pipelines",
      schema: PipelineListSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
    labels: {
      description: "Labels for a project",
      schema: LabelListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    members: {
      description: "Members of a project",
      schema: MemberListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    branches: {
      description: "Branches for a project",
      schema: BranchListSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    dashboard: {
      description:
        "Cross-project MR dashboard and todos for the authenticated user",
      schema: DashboardSchema,
      lifetime: "30m" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    list_projects: {
      description:
        "List projects for the authenticated user with basic metadata",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getList("/projects", {
          membership: "true",
          per_page: "30",
          order_by: "last_activity_at",
          sort: "desc",
        });
        const projects = (data as any[]).map(mapProject);
        const handle = await ctx.writeResource("projects", "all", {
          projects,
          count: projects.length,
          truncated,
          fetchedAt: new Date().toISOString(),
        });
        ctx.logger.info("Found {count} projects", { count: projects.length });
        return { dataHandles: [handle] };
      },
    },

    get_project_info: {
      description: "Get detailed information about a specific project",
      arguments: z.object({
        project: z.string().min(1).describe(
          "Project path (e.g. mygroup/myproject)",
        ),
      }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        // Use bare project URL (no trailing path) via get() with encoded path
        const raw = await client.get(
          `/projects/${encodeURIComponent(args.project)}`,
        );
        const info = {
          name: raw.name ?? "",
          pathWithNamespace: raw.path_with_namespace ?? "",
          description: raw.description ?? null,
          visibility: raw.visibility ?? "private",
          defaultBranch: raw.default_branch ?? null,
          starCount: raw.star_count ?? 0,
          forksCount: raw.forks_count ?? 0,
          openIssuesCount: raw.open_issues_count ?? 0,
          archived: raw.archived ?? false,
          topics: raw.topics ?? raw.tag_list ?? [],
          webUrl: raw.web_url ?? "",
          createdAt: raw.created_at ?? "",
          lastActivityAt: raw.last_activity_at ?? "",
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "projectInfo",
          sanitizeName(args.project),
          info,
        );
        ctx.logger.info("Fetched info for {project}", {
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_merge_requests: {
      description:
        "List merge requests for a project with optional state filter",
      arguments: z.object({
        project: z.string().min(1),
        state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
      }),
      execute: async (
        args: { project: string; state: string },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/merge_requests",
          { state: args.state, per_page: "20" },
        );
        const mrs = (data as any[]).map(mapMR);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-${args.state}`,
          {
            project: args.project,
            mergeRequests: mrs,
            count: mrs.length,
            truncated,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} MRs for {project} ({state})", {
          count: mrs.length,
          project: args.project,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_issues: {
      description: "List issues for a project with optional state filter",
      arguments: z.object({
        project: z.string().min(1),
        state: z.enum(["opened", "closed", "all"]).default("opened"),
      }),
      execute: async (
        args: { project: string; state: string },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/issues",
          { state: args.state, per_page: "20" },
        );
        const issues = (data as any[]).map(mapIssue);
        const handle = await ctx.writeResource(
          "issues",
          `${sanitizeName(args.project)}-${args.state}`,
          {
            project: args.project,
            issues,
            count: issues.length,
            truncated,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} issues for {project} ({state})", {
          count: issues.length,
          project: args.project,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_releases: {
      description: "List releases for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/releases",
          { per_page: "10" },
        );
        const releases = (data as any[]).map(mapRelease);
        const handle = await ctx.writeResource(
          "releases",
          sanitizeName(args.project),
          {
            project: args.project,
            releases,
            count: releases.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} releases for {project}", {
          count: releases.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_pipelines: {
      description: "List recent CI/CD pipelines for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/pipelines",
          { per_page: "10" },
        );
        const pipelines = (data as any[]).map(mapPipeline);
        const handle = await ctx.writeResource(
          "pipelines",
          sanitizeName(args.project),
          {
            project: args.project,
            pipelines,
            count: pipelines.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} pipelines for {project}", {
          count: pipelines.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    create_issue: {
      description: "Create a new issue in a project",
      arguments: z.object({
        project: z.string().min(1),
        title: z.string().min(1),
        description: z.string().default(""),
        labels: z.array(z.string()).default([]),
      }),
      execute: async (
        args: {
          project: string;
          title: string;
          description: string;
          labels: string[];
        },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(args.project, "/issues", {
          title: args.title,
          description: args.description,
          labels: args.labels.join(","),
        });
        const handle = await ctx.writeResource(
          "issueDetail",
          `${sanitizeName(args.project)}-${raw.iid}`,
          mapIssueDetail(args.project, raw),
        );
        ctx.logger.info("Created issue #{iid} in {project}", {
          iid: raw.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    update_issue: {
      description:
        "Update an existing issue (title, description, labels, state)",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        stateEvent: z.enum(["close", "reopen"]).optional(),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          title?: string;
          description?: string;
          labels?: string[];
          stateEvent?: string;
        },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.description !== undefined) body.description = args.description;
        if (args.labels !== undefined) body.labels = args.labels.join(",");
        if (args.stateEvent !== undefined) body.state_event = args.stateEvent;
        const raw = await client.put(args.project, `/issues/${args.iid}`, body);
        const handle = await ctx.writeResource(
          "issueDetail",
          `${sanitizeName(args.project)}-${raw.iid}`,
          mapIssueDetail(args.project, raw),
        );
        ctx.logger.info("Updated issue #{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    add_issue_note: {
      description: "Add a comment to an issue",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        body: z.string().min(1),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(
          args.project,
          `/issues/${args.iid}/notes`,
          { body: args.body },
        );
        // Use note-specific instance name to not overwrite the full list
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-issue-${args.iid}-note-${raw.id}`,
          {
            project: args.project,
            noteableType: "issue",
            noteableIid: args.iid,
            notes: [mapNote(raw)],
            count: 1,
            truncated: false,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Added note to issue #{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_issue_notes: {
      description: "List comments on an issue",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          `/issues/${args.iid}/notes`,
          { per_page: "50", sort: "asc" },
        );
        const notes = (data as any[]).map(mapNote);
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-issue-${args.iid}`,
          {
            project: args.project,
            noteableType: "issue",
            noteableIid: args.iid,
            notes,
            count: notes.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} notes on issue #{iid}", {
          count: notes.length,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    create_merge_request: {
      description: "Create a new merge request",
      arguments: z.object({
        project: z.string().min(1),
        title: z.string().min(1),
        sourceBranch: z.string().min(1),
        targetBranch: z.string().default("main"),
        description: z.string().default(""),
      }),
      execute: async (
        args: {
          project: string;
          title: string;
          sourceBranch: string;
          targetBranch: string;
          description: string;
        },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(args.project, "/merge_requests", {
          title: args.title,
          source_branch: args.sourceBranch,
          target_branch: args.targetBranch,
          description: args.description,
        });
        const mr = mapMR(raw);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-created-${raw.iid}`,
          {
            project: args.project,
            mergeRequests: [mr],
            count: 1,
            truncated: false,
            state: "opened",
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Created MR !{iid} in {project}", {
          iid: raw.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    merge: {
      description: "Merge a merge request",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        squash: z.boolean().default(false),
      }),
      execute: async (
        args: { project: string; iid: number; squash: boolean },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.put(
          args.project,
          `/merge_requests/${args.iid}/merge`,
          { squash: args.squash },
        );
        // GitLab can return 200 with an error message on merge conflicts
        if (raw.message) {
          throw new Error(
            `GitLab merge failed for !${args.iid}: ${raw.message}`,
          );
        }
        const mr = mapMR(raw);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-merged-${args.iid}`,
          {
            project: args.project,
            mergeRequests: [mr],
            count: 1,
            truncated: false,
            state: mr.state,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Merged MR !{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    add_mr_note: {
      description: "Add a comment to a merge request",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        body: z.string().min(1),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(
          args.project,
          `/merge_requests/${args.iid}/notes`,
          { body: args.body },
        );
        // Use note-specific instance name to not overwrite the full MR notes list
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-mr-${args.iid}-note-${raw.id}`,
          {
            project: args.project,
            noteableType: "merge_request",
            noteableIid: args.iid,
            notes: [mapNote(raw)],
            count: 1,
            truncated: false,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Added note to MR !{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_labels: {
      description: "List labels for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/labels",
          { per_page: "100" },
        );
        const labels = (data as any[]).map((raw: any) => ({
          name: raw.name ?? "",
          color: raw.color ?? "",
          description: raw.description ?? null,
        }));
        const handle = await ctx.writeResource(
          "labels",
          sanitizeName(args.project),
          {
            project: args.project,
            labels,
            count: labels.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} labels for {project}", {
          count: labels.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    create_label: {
      description: "Create a label in a project",
      arguments: z.object({
        project: z.string().min(1),
        name: z.string().min(1),
        color: z.string().default("#428BCA"),
        description: z.string().default(""),
      }),
      execute: async (
        args: {
          project: string;
          name: string;
          color: string;
          description: string;
        },
        ctx: ModelContext,
      ) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        await client.post(args.project, "/labels", {
          name: args.name,
          color: args.color,
          description: args.description,
        });
        ctx.logger.info("Created label {name} in {project}", {
          name: args.name,
          project: args.project,
        });
        return { dataHandles: [] };
      },
    },

    list_members: {
      description: "List members of a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/members/all",
          { per_page: "100" },
        );
        const members = (data as any[]).map((raw: any) => ({
          username: raw.username ?? "",
          name: raw.name ?? "",
          accessLevel: raw.access_level ?? 0,
        }));
        const handle = await ctx.writeResource(
          "members",
          sanitizeName(args.project),
          {
            project: args.project,
            members,
            count: members.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} members for {project}", {
          count: members.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_branches: {
      description: "List branches for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/repository/branches",
          { per_page: "50" },
        );
        const branches = (data as any[]).map((raw: any) => ({
          name: raw.name ?? "",
          protected: raw.protected ?? false,
          default: raw.default ?? false,
        }));
        const handle = await ctx.writeResource(
          "branches",
          sanitizeName(args.project),
          {
            project: args.project,
            branches,
            count: branches.length,
            truncated,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Found {count} branches for {project}", {
          count: branches.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_my_merge_requests: {
      description:
        "List MRs and todos for the authenticated user via GraphQL (reviewer, assignee, author roles + pending todos)",
      arguments: z.object({
        role: z
          .enum(["reviewer", "assignee", "author", "all"])
          .default("all")
          .describe("Filter by role: reviewer, assignee, author, or all"),
        state: z
          .enum(["opened", "merged", "closed", "all"])
          .default("opened")
          .describe("MR state filter"),
        includeArchived: z
          .boolean()
          .default(false)
          .describe("Include MRs from archived projects"),
      }),
      execute: async (
        args: { role: string; state: string; includeArchived: boolean },
        ctx: ModelContext,
      ) => {
        const { host, token } = ctx.globalArgs;
        const variables: Record<string, unknown> = {
          mrState: args.state === "all" ? undefined : args.state,
          perPage: 20,
          includeArchived: args.includeArchived,
        };

        const data = await graphqlRequest(
          host,
          token,
          DASHBOARD_QUERY,
          variables,
        );
        const user = data.currentUser;
        if (!user) {
          throw new Error(
            "GitLab GraphQL: currentUser is null — verify the token has 'read_api' scope and is not expired",
          );
        }

        const showReviewing = args.role === "all" || args.role === "reviewer";
        const showAssigned = args.role === "all" || args.role === "assignee";
        const showAuthored = args.role === "all" || args.role === "author";

        const reviewing = showReviewing
          ? (user.reviewRequestedMergeRequests?.nodes ?? []).map(mapDashboardMR)
          : [];
        const assigned = showAssigned
          ? (user.assignedMergeRequests?.nodes ?? []).map(mapDashboardMR)
          : [];
        const authored = showAuthored
          ? (user.authoredMergeRequests?.nodes ?? []).map(mapDashboardMR)
          : [];
        const todos = (user.todos?.nodes ?? []).map(mapTodo);

        const truncated = !!(
          (showReviewing &&
            user.reviewRequestedMergeRequests?.pageInfo?.hasNextPage) ||
          (showAssigned &&
            user.assignedMergeRequests?.pageInfo?.hasNextPage) ||
          (showAuthored &&
            user.authoredMergeRequests?.pageInfo?.hasNextPage)
        );

        const totalCount = reviewing.length + assigned.length + authored.length;
        const handle = await ctx.writeResource("dashboard", user.username, {
          username: user.username,
          reviewing,
          assigned,
          authored,
          todos,
          totalCount,
          truncated,
          fetchedAt: new Date().toISOString(),
        });

        ctx.logger.info(
          "Found {total} MRs + {todos} todos for {user} (reviewing={r}, assigned={a}, authored={auth})",
          {
            total: totalCount,
            todos: todos.length,
            user: user.username,
            r: reviewing.length,
            a: assigned.length,
            auth: authored.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
