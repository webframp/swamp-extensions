// GitLab Project Operations Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z
    .string()
    .describe(
      "GitLab hostname (e.g., gitlab.com or git.example.org). Uses glab's default if omitted.",
    )
    .default(""),
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
  state: z.string(),
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
  fetchedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

function buildEnv(host: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (host) {
    env["GITLAB_HOST"] = host;
  }
  return env;
}

async function runGlab(
  args: string[],
  host: string,
): Promise<unknown> {
  const env = buildEnv(host);
  const cmd = new Deno.Command("glab", {
    args,
    stdout: "piped",
    stderr: "piped",
    env: Object.keys(env).length > 0 ? env : undefined,
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`glab command failed: ${err}`);
  }
  const text = new TextDecoder().decode(output.stdout).trim();
  if (!text) return [];
  return JSON.parse(text);
}

// deno-lint-ignore no-explicit-any
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

// deno-lint-ignore no-explicit-any
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

// deno-lint-ignore no-explicit-any
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

// deno-lint-ignore no-explicit-any
function mapRelease(raw: any): z.infer<typeof ReleaseSchema> {
  return {
    tagName: raw.tag_name ?? "",
    name: raw.name ?? "",
    createdAt: raw.created_at ?? "",
    releasedAt: raw.released_at ?? raw.created_at ?? "",
    upcoming: raw.upcoming_release ?? false,
  };
}

// deno-lint-ignore no-explicit-any
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

function sanitizeName(project: string): string {
  return project.replace(/\//g, "-");
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: { host: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/gitlab",
  version: "2026.04.13.1",
  globalArguments: GlobalArgsSchema,

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
    releases: {
      description: "List of releases for a project",
      schema: ReleaseListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    pipelines: {
      description: "List of recent CI/CD pipelines for a project",
      schema: PipelineListSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_projects: {
      description:
        "List projects for the authenticated user with basic metadata",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const data = await runGlab(
          ["repo", "list", "--mine", "--output", "json", "--per-page", "30"],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const projects = (data as any[]).map(mapProject);

        const handle = await context.writeResource("projects", "all", {
          projects,
          count: projects.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} projects", {
          count: projects.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_project_info: {
      description:
        "Get detailed information about a specific project including stats and metadata",
      arguments: z.object({
        project: z
          .string()
          .describe(
            "Project in group/name format (e.g., mygroup/myproject)",
          ),
      }),
      execute: async (
        args: { project: string },
        context: ModelContext,
      ) => {
        const data = await runGlab(
          ["repo", "view", args.project, "--output", "json"],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const raw = data as any;
        const info: z.infer<typeof ProjectInfoSchema> = {
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

        const handle = await context.writeResource(
          "projectInfo",
          sanitizeName(args.project),
          info,
        );

        context.logger.info("Fetched info for {project}", {
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_merge_requests: {
      description:
        "List merge requests for a project with optional state filter",
      arguments: z.object({
        project: z
          .string()
          .describe(
            "Project in group/name format (e.g., mygroup/myproject)",
          ),
        state: z
          .enum(["opened", "closed", "merged", "all"])
          .default("opened")
          .describe("Filter by MR state"),
      }),
      execute: async (
        args: { project: string; state: string },
        context: ModelContext,
      ) => {
        const stateArgs: string[] = [];
        if (args.state === "closed") stateArgs.push("--closed");
        else if (args.state === "merged") stateArgs.push("--merged");
        else if (args.state === "all") stateArgs.push("--all");

        const data = await runGlab(
          [
            "mr",
            "list",
            "-R",
            args.project,
            ...stateArgs,
            "--output",
            "json",
            "--per-page",
            "20",
          ],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const mrs = (data as any[]).map(mapMR);
        const instanceName = `${sanitizeName(args.project)}-${args.state}`;

        const handle = await context.writeResource(
          "mergeRequests",
          instanceName,
          {
            project: args.project,
            mergeRequests: mrs,
            count: mrs.length,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} MRs for {project} ({state})",
          { count: mrs.length, project: args.project, state: args.state },
        );
        return { dataHandles: [handle] };
      },
    },

    list_issues: {
      description: "List issues for a project with optional state filter",
      arguments: z.object({
        project: z
          .string()
          .describe(
            "Project in group/name format (e.g., mygroup/myproject)",
          ),
        state: z
          .enum(["opened", "closed", "all"])
          .default("opened")
          .describe("Filter by issue state"),
      }),
      execute: async (
        args: { project: string; state: string },
        context: ModelContext,
      ) => {
        const stateArgs: string[] = [];
        if (args.state === "closed") stateArgs.push("--closed");
        else if (args.state === "all") stateArgs.push("--all");

        const data = await runGlab(
          [
            "issue",
            "list",
            "-R",
            args.project,
            ...stateArgs,
            "--output",
            "json",
            "--per-page",
            "20",
          ],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const issues = (data as any[]).map(mapIssue);
        const instanceName = `${sanitizeName(args.project)}-${args.state}`;

        const handle = await context.writeResource(
          "issues",
          instanceName,
          {
            project: args.project,
            issues,
            count: issues.length,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} issues for {project} ({state})",
          { count: issues.length, project: args.project, state: args.state },
        );
        return { dataHandles: [handle] };
      },
    },

    list_releases: {
      description: "List releases for a project",
      arguments: z.object({
        project: z
          .string()
          .describe(
            "Project in group/name format (e.g., mygroup/myproject)",
          ),
      }),
      execute: async (
        args: { project: string },
        context: ModelContext,
      ) => {
        const data = await runGlab(
          [
            "release",
            "list",
            "-R",
            args.project,
            "--output",
            "json",
            "--per-page",
            "10",
          ],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const releases = (data as any[]).map(mapRelease);

        const handle = await context.writeResource(
          "releases",
          sanitizeName(args.project),
          {
            project: args.project,
            releases,
            count: releases.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} releases for {project}", {
          count: releases.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_pipelines: {
      description: "List recent CI/CD pipelines for a project",
      arguments: z.object({
        project: z
          .string()
          .describe(
            "Project in group/name format (e.g., mygroup/myproject)",
          ),
      }),
      execute: async (
        args: { project: string },
        context: ModelContext,
      ) => {
        const data = await runGlab(
          [
            "ci",
            "list",
            "-R",
            args.project,
            "--output",
            "json",
            "--per-page",
            "10",
          ],
          context.globalArgs.host,
        );

        // deno-lint-ignore no-explicit-any
        const pipelines = (data as any[]).map(mapPipeline);

        const handle = await context.writeResource(
          "pipelines",
          sanitizeName(args.project),
          {
            project: args.project,
            pipelines,
            count: pipelines.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} pipelines for {project}", {
          count: pipelines.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
