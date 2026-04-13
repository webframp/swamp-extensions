// GitHub Repository Operations Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

const RepoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  stargazerCount: z.number(),
  updatedAt: z.string(),
  primaryLanguage: z.object({ name: z.string() }).nullable(),
});

const RepoListSchema = z.object({
  repos: z.array(RepoSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const RepoInfoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  stargazerCount: z.number(),
  forkCount: z.number(),
  issues: z.object({ totalCount: z.number() }),
  pullRequests: z.object({ totalCount: z.number() }),
  watchers: z.object({ totalCount: z.number() }),
  licenseInfo: z.object({ name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  fetchedAt: z.string(),
});

const PullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

const PullRequestListSchema = z.object({
  repo: z.string(),
  pullRequests: z.array(PullRequestSchema),
  count: z.number(),
  state: z.string(),
  fetchedAt: z.string(),
});

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

const IssueListSchema = z.object({
  repo: z.string(),
  issues: z.array(IssueSchema),
  count: z.number(),
  state: z.string(),
  fetchedAt: z.string(),
});

const ReleaseSchema = z.object({
  tagName: z.string(),
  name: z.string(),
  publishedAt: z.string(),
  isPrerelease: z.boolean(),
  isDraft: z.boolean(),
});

const ReleaseListSchema = z.object({
  repo: z.string(),
  releases: z.array(ReleaseSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const WorkflowRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headBranch: z.string(),
});

const WorkflowRunListSchema = z.object({
  repo: z.string(),
  workflowRuns: z.array(WorkflowRunSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

async function runGh(
  args: string[],
): Promise<unknown> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`gh command failed: ${err}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: Record<string, never>;
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
  type: "@webframp/github",
  version: "2026.04.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    repos: {
      description: "List of repositories for the authenticated user",
      schema: RepoListSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    repo_info: {
      description: "Detailed information about a specific repository",
      schema: RepoInfoSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    pull_requests: {
      description: "List of pull requests for a repository",
      schema: PullRequestListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    issues: {
      description: "List of issues for a repository",
      schema: IssueListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    releases: {
      description: "List of releases for a repository",
      schema: ReleaseListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    workflow_runs: {
      description: "List of recent workflow runs for a repository",
      schema: WorkflowRunListSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_repos: {
      description:
        "List repositories for the authenticated user with basic metadata",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const data = await runGh([
          "repo",
          "list",
          "--json",
          "name,description,isPrivate,isFork,stargazerCount,updatedAt,primaryLanguage",
          "--limit",
          "30",
        ]);

        const repos = data as z.infer<typeof RepoSchema>[];

        const handle = await context.writeResource("repos", "all", {
          repos,
          count: repos.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} repositories", {
          count: repos.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_repo_info: {
      description:
        "Get detailed information about a specific repository including stats and metadata",
      arguments: z.object({
        repo: z
          .string()
          .describe(
            "Repository in owner/name format (e.g., octocat/Hello-World)",
          ),
      }),
      execute: async (
        args: { repo: string },
        context: ModelContext,
      ) => {
        const data = await runGh([
          "repo",
          "view",
          args.repo,
          "--json",
          "name,description,defaultBranchRef,stargazerCount,forkCount,issues,pullRequests,watchers,licenseInfo,createdAt,updatedAt",
        ]);

        const repoInfo = data as Record<string, unknown>;

        const handle = await context.writeResource(
          "repo_info",
          args.repo.replace(/\//g, "-"),
          {
            ...repoInfo,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Fetched info for {repo}", { repo: args.repo });
        return { dataHandles: [handle] };
      },
    },

    list_prs: {
      description:
        "List pull requests for a repository with optional state filter",
      arguments: z.object({
        repo: z
          .string()
          .describe(
            "Repository in owner/name format (e.g., octocat/Hello-World)",
          ),
        state: z
          .enum(["open", "closed", "merged", "all"])
          .default("open")
          .describe("Filter by PR state"),
      }),
      execute: async (
        args: { repo: string; state: string },
        context: ModelContext,
      ) => {
        const data = await runGh([
          "pr",
          "list",
          "--repo",
          args.repo,
          "--state",
          args.state,
          "--json",
          "number,title,state,author,createdAt,updatedAt,labels",
          "--limit",
          "20",
        ]);

        const prs = data as z.infer<typeof PullRequestSchema>[];
        const instanceName = `${args.repo.replace(/\//g, "-")}-${args.state}`;

        const handle = await context.writeResource(
          "pull_requests",
          instanceName,
          {
            repo: args.repo,
            pullRequests: prs,
            count: prs.length,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} PRs for {repo} ({state})", {
          count: prs.length,
          repo: args.repo,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_issues: {
      description: "List issues for a repository with optional state filter",
      arguments: z.object({
        repo: z
          .string()
          .describe(
            "Repository in owner/name format (e.g., octocat/Hello-World)",
          ),
        state: z
          .enum(["open", "closed", "all"])
          .default("open")
          .describe("Filter by issue state"),
      }),
      execute: async (
        args: { repo: string; state: string },
        context: ModelContext,
      ) => {
        const data = await runGh([
          "issue",
          "list",
          "--repo",
          args.repo,
          "--state",
          args.state,
          "--json",
          "number,title,state,author,createdAt,updatedAt,labels",
          "--limit",
          "20",
        ]);

        const issues = data as z.infer<typeof IssueSchema>[];
        const instanceName = `${args.repo.replace(/\//g, "-")}-${args.state}`;

        const handle = await context.writeResource(
          "issues",
          instanceName,
          {
            repo: args.repo,
            issues,
            count: issues.length,
            state: args.state,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} issues for {repo} ({state})", {
          count: issues.length,
          repo: args.repo,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_releases: {
      description: "List releases for a repository",
      arguments: z.object({
        repo: z
          .string()
          .describe(
            "Repository in owner/name format (e.g., octocat/Hello-World)",
          ),
      }),
      execute: async (
        args: { repo: string },
        context: ModelContext,
      ) => {
        const data = await runGh([
          "release",
          "list",
          "--repo",
          args.repo,
          "--json",
          "tagName,name,publishedAt,isPrerelease,isDraft",
          "--limit",
          "10",
        ]);

        const releases = data as z.infer<typeof ReleaseSchema>[];

        const handle = await context.writeResource(
          "releases",
          args.repo.replace(/\//g, "-"),
          {
            repo: args.repo,
            releases,
            count: releases.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} releases for {repo}", {
          count: releases.length,
          repo: args.repo,
        });
        return { dataHandles: [handle] };
      },
    },

    list_workflows: {
      description: "List recent workflow runs for a repository",
      arguments: z.object({
        repo: z
          .string()
          .describe(
            "Repository in owner/name format (e.g., octocat/Hello-World)",
          ),
      }),
      execute: async (
        args: { repo: string },
        context: ModelContext,
      ) => {
        const data = await runGh([
          "run",
          "list",
          "--repo",
          args.repo,
          "--json",
          "name,status,conclusion,createdAt,updatedAt,headBranch",
          "--limit",
          "10",
        ]);

        const runs = data as z.infer<typeof WorkflowRunSchema>[];

        const handle = await context.writeResource(
          "workflow_runs",
          args.repo.replace(/\//g, "-"),
          {
            repo: args.repo,
            workflowRuns: runs,
            count: runs.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} workflow runs for {repo}", {
          count: runs.length,
          repo: args.repo,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
