/**
 * GitHub Repository Operations Model for swamp.
 *
 * Queries GitHub data using the `gh` CLI, providing methods for listing
 * repositories, pull requests, issues, releases, and workflow runs.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

/**
 * `owner/name` repository slug. `gh` accepts other forms (bare name within a
 * configured repo, full URLs), but every method here always calls `gh` with
 * `--repo`, which requires the fully-qualified slug — anything else fails
 * deep inside the CLI with a cryptic "unknown flag" or "could not resolve"
 * error instead of naming the actual problem.
 */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const repoArg = () =>
  z
    .string()
    .regex(
      REPO_SLUG_RE,
      'Must be in "owner/name" format (e.g. octocat/Hello-World)',
    )
    .describe("Repository in owner/name format (e.g., octocat/Hello-World)");

const RepoSchema = z.object({
  name: z.string().describe("Repository name"),
  description: z.string().nullable().describe("Repository description"),
  isPrivate: z.boolean().describe("Whether the repository is private"),
  isFork: z.boolean().describe("Whether the repository is a fork"),
  stargazerCount: z.number().describe("Number of stargazers"),
  updatedAt: z.string().describe("Timestamp the repository was last updated"),
  primaryLanguage: z.object({ name: z.string() }).nullable().describe(
    "Primary programming language, or null if undetected",
  ),
});

const RepoListSchema = z.object({
  repos: z.array(RepoSchema).describe(
    "Repositories for the authenticated user",
  ),
  count: z.number().describe("Number of repositories returned"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const RepoInfoSchema = z.object({
  name: z.string().describe("Repository name"),
  description: z.string().nullable().describe("Repository description"),
  defaultBranchRef: z.object({ name: z.string() }).nullable().describe(
    "Default branch, or null if the repository has none",
  ),
  stargazerCount: z.number().describe("Number of stargazers"),
  forkCount: z.number().describe("Number of forks"),
  issues: z.object({ totalCount: z.number() }).describe(
    "Total issue count",
  ),
  pullRequests: z.object({ totalCount: z.number() }).describe(
    "Total pull request count",
  ),
  watchers: z.object({ totalCount: z.number() }).describe(
    "Total watcher count",
  ),
  licenseInfo: z.object({ name: z.string() }).nullable().describe(
    "License name, or null if unlicensed",
  ),
  createdAt: z.string().describe("Timestamp the repository was created"),
  updatedAt: z.string().describe("Timestamp the repository was last updated"),
  fetchedAt: z.string().describe("Timestamp this info was fetched"),
});

const PullRequestSchema = z.object({
  number: z.number().describe("Pull request number"),
  title: z.string().describe("Pull request title"),
  state: z.string().describe("Pull request state"),
  author: z.object({ login: z.string() }).nullable().describe(
    "Pull request author, or null if unavailable",
  ),
  createdAt: z.string().describe("Timestamp the pull request was created"),
  updatedAt: z.string().describe(
    "Timestamp the pull request was last updated",
  ),
  labels: z.array(z.object({ name: z.string() })).describe(
    "Labels applied to the pull request",
  ),
});

const PullRequestListSchema = z.object({
  repo: z.string().describe("Repository the pull requests belong to"),
  pullRequests: z.array(PullRequestSchema).describe(
    "Pull requests matching the queried state",
  ),
  count: z.number().describe("Number of pull requests returned"),
  state: z.string().describe("State filter used for the query"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const IssueSchema = z.object({
  number: z.number().describe("Issue number"),
  title: z.string().describe("Issue title"),
  state: z.string().describe("Issue state"),
  author: z.object({ login: z.string() }).nullable().describe(
    "Issue author, or null if unavailable",
  ),
  createdAt: z.string().describe("Timestamp the issue was created"),
  updatedAt: z.string().describe("Timestamp the issue was last updated"),
  labels: z.array(z.object({ name: z.string() })).describe(
    "Labels applied to the issue",
  ),
});

const IssueListSchema = z.object({
  repo: z.string().describe("Repository the issues belong to"),
  issues: z.array(IssueSchema).describe(
    "Issues matching the queried state",
  ),
  count: z.number().describe("Number of issues returned"),
  state: z.string().describe("State filter used for the query"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const ReleaseSchema = z.object({
  tagName: z.string().describe("Git tag associated with the release"),
  name: z.string().describe("Release title"),
  publishedAt: z.string().describe("Timestamp the release was published"),
  isPrerelease: z.boolean().describe("Whether the release is a prerelease"),
  isDraft: z.boolean().describe("Whether the release is a draft"),
});

const ReleaseListSchema = z.object({
  repo: z.string().describe("Repository the releases belong to"),
  releases: z.array(ReleaseSchema).describe("Releases for the repository"),
  count: z.number().describe("Number of releases returned"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const WorkflowRunSchema = z.object({
  name: z.string().describe("Workflow name"),
  status: z.string().describe("Current run status"),
  conclusion: z.string().nullable().describe(
    "Run conclusion, or null while the run is in progress",
  ),
  createdAt: z.string().describe("Timestamp the run was created"),
  updatedAt: z.string().describe("Timestamp the run was last updated"),
  headBranch: z.string().describe("Branch the run was triggered from"),
});

const WorkflowRunListSchema = z.object({
  repo: z.string().describe("Repository the workflow runs belong to"),
  workflowRuns: z.array(WorkflowRunSchema).describe(
    "Recent workflow runs for the repository",
  ),
  count: z.number().describe("Number of workflow runs returned"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

// =============================================================================
// Helper Functions
// =============================================================================

/** Execute a `gh` CLI command and return its parsed JSON output. */
async function runGh(
  args: string[],
): Promise<unknown> {
  const cmdDesc = `gh ${args.join(" ")}`;
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `${cmdDesc} failed (exit ${output.code}): ${err || "(no output)"}`,
    );
  }
  const stdout = new TextDecoder().decode(output.stdout);
  try {
    return JSON.parse(stdout);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      `${cmdDesc} returned output that could not be parsed as JSON: ${msg}`,
      { cause: parseErr },
    );
  }
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

/** GitHub model definition exposing repository query methods. */
export const model = {
  type: "@webframp/github",
  version: "2026.08.24.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description: "No schema changes (added field descriptions only)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "No schema changes (repo argument now validated as owner/name; gh errors carry command context)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.1",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
        repo: repoArg(),
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
        repo: repoArg(),
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
        const instanceName = `prs-${
          args.repo.replace(/\//g, "-")
        }-${args.state}`;

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
        repo: repoArg(),
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
        const instanceName = `issues-${
          args.repo.replace(/\//g, "-")
        }-${args.state}`;

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
        repo: repoArg(),
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
        repo: repoArg(),
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
