// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.4.3";
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
type Ctx = {
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
};
const key = (repo: string) => encodeURIComponent(repo);
async function gh(args: string[]): Promise<unknown> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const value = new TextDecoder().decode(out.stdout).trim();
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
const issueFields =
  "number,title,body,state,author,createdAt,updatedAt,labels,comments,url";
/** GitHub triage augmentation for exact context and approval-gated actions. */
export const extension = {
  type: "@webframp/github",
  methods: [{
    get_issue_context: {
      description: "Retrieve one issue with bounded recent comments.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        maxComments: z.number().int().min(1).max(100).default(50),
      }).strict(),
      execute: async (
        args: { repo: string; number: number; maxComments: number },
        context: Ctx,
      ) => {
        const data = await gh([
          "issue",
          "view",
          String(args.number),
          "--repo",
          args.repo,
          "--json",
          issueFields,
        ]) as Record<string, unknown>;
        if (Array.isArray(data.comments)) {
          data.comments = data.comments.slice(-args.maxComments);
        }
        const handle = await context.writeResource(
          "triageIssue",
          `${key(args.repo)}-${args.number}`,
          {
            repo: args.repo,
            number: args.number,
            context: data,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    get_pull_request_context: {
      description: "Retrieve one PR with immutable head/base SHA and checks.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        maxComments: z.number().int().min(1).max(100).default(50),
      }).strict(),
      execute: async (
        args: { repo: string; number: number; maxComments: number },
        context: Ctx,
      ) => {
        const data = await gh([
          "pr",
          "view",
          String(args.number),
          "--repo",
          args.repo,
          "--json",
          "number,title,body,state,author,createdAt,updatedAt,labels,comments,url,headRefOid,baseRefOid,isDraft,mergeStateStatus,statusCheckRollup,reviews",
        ]) as Record<string, unknown>;
        if (Array.isArray(data.comments)) {
          data.comments = data.comments.slice(-args.maxComments);
        }
        const handle = await context.writeResource(
          "triagePullRequest",
          `${key(args.repo)}-${args.number}`,
          {
            repo: args.repo,
            number: args.number,
            context: data,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    create_issue: {
      description:
        "Create an approved issue with a durable idempotency marker.",
      arguments: z.object({
        repo,
        title: z.string().min(1),
        body: z.string(),
        idempotencyKey: z.string().min(1),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          title: string;
          body: string;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => {
        const resourceName = `${key(args.repo)}-create-${args.idempotencyKey}`;
        if (await context.readResource(resourceName)) {
          return { dataHandles: [{ name: resourceName }] };
        }
        const marker = `<!-- triage:${args.idempotencyKey} -->`;
        const result = await gh([
          "issue",
          "create",
          "--repo",
          args.repo,
          "--title",
          args.title,
          "--body",
          `${args.body}\n\n${marker}`,
        ]);
        const createdNumber = typeof result === "string"
          ? Number(/\/issues\/(\d+)\s*$/.exec(result)?.[1])
          : NaN;
        if (!Number.isInteger(createdNumber)) {
          throw new Error(
            `Could not parse issue number from gh issue create output: ${result}`,
          );
        }
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "create_issue",
            target: createdNumber,
            idempotencyKey: args.idempotencyKey,
            result,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    add_issue_comment: {
      description: "Post an approved issue comment with an idempotency marker.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        body: z.string().min(1),
        idempotencyKey: z.string().min(1),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          number: number;
          body: string;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => {
        const resourceName = `${key(args.repo)}-comment-${args.idempotencyKey}`;
        if (await context.readResource(resourceName)) {
          return { dataHandles: [{ name: resourceName }] };
        }
        const result = await gh([
          "issue",
          "comment",
          String(args.number),
          "--repo",
          args.repo,
          "--body",
          `${args.body}\n\n<!-- triage:${args.idempotencyKey} -->`,
        ]);
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "add_issue_comment",
            target: args.number,
            idempotencyKey: args.idempotencyKey,
            result,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    close_issue: {
      description: "Close one explicitly approved issue.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        idempotencyKey: z.string().min(1),
      }).strict(),
      execute: async (
        args: { repo: string; number: number; idempotencyKey: string },
        context: Ctx,
      ) => {
        const resourceName = `${key(args.repo)}-close-${args.idempotencyKey}`;
        if (await context.readResource(resourceName)) {
          return { dataHandles: [{ name: resourceName }] };
        }
        const result = await gh([
          "issue",
          "close",
          String(args.number),
          "--repo",
          args.repo,
        ]);
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "close_issue",
            target: args.number,
            idempotencyKey: args.idempotencyKey,
            result,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    get_workflow_run: {
      description: "Read one exact GitHub Actions run and its head SHA.",
      arguments: z.object({ repo, runId: z.number().int().positive() })
        .strict(),
      execute: async (args: { repo: string; runId: number }, context: Ctx) => {
        const result = await gh([
          "run",
          "view",
          String(args.runId),
          "--repo",
          args.repo,
          "--json",
          "databaseId,workflowName,status,conclusion,headSha,url,createdAt,updatedAt",
        ]);
        const handle = await context.writeResource(
          "triageAction",
          `${key(args.repo)}-run-${args.runId}`,
          {
            repo: args.repo,
            action: "get_workflow_run",
            target: args.runId,
            idempotencyKey: `read-${args.runId}`,
            result,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    retry_workflow_run: {
      description: "Retry one approved failed workflow run exactly once.",
      arguments: z.object({
        repo,
        runId: z.number().int().positive(),
        failedOnly: z.boolean().default(false),
        idempotencyKey: z.string().min(1),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          runId: number;
          failedOnly: boolean;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => {
        const resourceName = `${key(args.repo)}-retry-${args.idempotencyKey}`;
        if (await context.readResource(resourceName)) {
          return { dataHandles: [{ name: resourceName }] };
        }
        const result = await gh([
          "run",
          "rerun",
          String(args.runId),
          "--repo",
          args.repo,
          ...(args.failedOnly ? ["--failed"] : []),
        ]);
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "retry_workflow_run",
            target: args.runId,
            idempotencyKey: args.idempotencyKey,
            result,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
