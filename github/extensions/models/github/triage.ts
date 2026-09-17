// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.6.5";
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const idempotencyKey = z.string().min(1).regex(
  /^[A-Za-z0-9._:-]+$/,
  "must contain only alphanumerics, dot, underscore, colon, or hyphen",
);
type Ctx = {
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};
const key = (repo: string) => encodeURIComponent(repo);
const REDACTED_FLAGS = new Set(["--body", "--title"]);
function redactArgs(args: string[]): string[] {
  return args.map((arg, index) =>
    index > 0 && REDACTED_FLAGS.has(args[index - 1]) ? "[redacted]" : arg
  );
}
async function gh(args: string[]): Promise<unknown> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `gh ${redactArgs(args).join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
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
        if (Array.isArray(data.reviews)) {
          data.reviews = data.reviews.slice(-args.maxComments);
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
        idempotencyKey,
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
        idempotencyKey,
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
        idempotencyKey,
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
        idempotencyKey,
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
    watch_pr_checks: {
      description:
        "Poll a PR's status checks to completion; bounded by timeoutSeconds.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        timeoutSeconds: z.number().int().positive().max(3600).default(1800),
        pollIntervalSeconds: z.number().int().min(1).max(60).default(15),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          number: number;
          timeoutSeconds: number;
          pollIntervalSeconds: number;
        },
        context: Ctx,
      ) => {
        const maxIterations = Math.ceil(
          args.timeoutSeconds / args.pollIntervalSeconds,
        );
        type Check = { name: string; bucket: string; link: string };
        let checks: Check[] = [];
        let started = false;
        let timedOut = true;
        for (let iterations = 0; iterations < maxIterations; iterations++) {
          try {
            checks = await gh([
              "pr",
              "checks",
              String(args.number),
              "--repo",
              args.repo,
              "--json",
              "name,state,bucket,link,workflow",
            ]) as Check[];
          } catch (err) {
            context.logger.info(
              "watch_pr_checks: transient gh failure on iteration {iteration}: {error}",
              { iteration: iterations, error: String(err) },
            );
            checks = [];
          }
          // An empty list means checks haven't registered yet (e.g. right
          // after opening the PR) — that's "not started", not "done".
          if (checks.length > 0) {
            started = true;
            if (!checks.some((c) => c.bucket === "pending")) {
              timedOut = false;
              break;
            }
          }
          if (iterations < maxIterations - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, args.pollIntervalSeconds * 1000)
            );
          }
        }
        const status = !timedOut && started &&
            checks.every((c) => c.bucket === "pass" || c.bucket === "skipping")
          ? "succeeded"
          : "failed";
        const handle = await context.writeResource(
          "triageAction",
          `${key(args.repo)}-checks-${args.number}`,
          {
            repo: args.repo,
            action: "watch_pr_checks",
            target: args.number,
            idempotencyKey: `watch-${args.number}`,
            result: { status, runId: String(args.number), checks, timedOut },
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    merge_pull_request: {
      description:
        "Post an approved merge-request comment and poll until the PR merges.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        approvalComment: z.string().min(1).default("/shipit"),
        timeoutSeconds: z.number().int().positive().max(3600).default(600),
        pollIntervalSeconds: z.number().int().min(1).max(60).default(15),
        idempotencyKey,
      }).strict(),
      execute: async (
        args: {
          repo: string;
          number: number;
          approvalComment: string;
          timeoutSeconds: number;
          pollIntervalSeconds: number;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => {
        const resourceName = `${key(args.repo)}-merge-${args.idempotencyKey}`;
        const existing = await context.readResource(resourceName) as {
          result?: { status?: string };
        } | null;
        const existingStatus = existing?.result?.status;
        if (existingStatus === "succeeded" || existingStatus === "failed") {
          return { dataHandles: [{ name: resourceName }] };
        }
        if (existingStatus !== "posted") {
          // Record that the comment was posted *before* polling, so a retry
          // after a crash or transient failure mid-poll doesn't re-post it.
          await gh([
            "pr",
            "comment",
            String(args.number),
            "--repo",
            args.repo,
            "--body",
            args.approvalComment,
          ]);
          await context.writeResource("triageAction", resourceName, {
            repo: args.repo,
            action: "merge_pull_request",
            target: args.number,
            idempotencyKey: args.idempotencyKey,
            result: { status: "posted" },
            recordedAt: new Date().toISOString(),
          });
        }
        const maxIterations = Math.ceil(
          args.timeoutSeconds / args.pollIntervalSeconds,
        );
        type PrView = { state: string; mergedAt: string | null };
        let view: PrView = { state: "UNKNOWN", mergedAt: null };
        for (let iterations = 0; iterations < maxIterations; iterations++) {
          try {
            view = await gh([
              "pr",
              "view",
              String(args.number),
              "--repo",
              args.repo,
              "--json",
              "state,mergedAt",
            ]) as PrView;
          } catch (err) {
            context.logger.info(
              "merge_pull_request: transient gh failure on iteration {iteration}: {error}",
              { iteration: iterations, error: String(err) },
            );
          }
          if (view.state === "MERGED" || view.state === "CLOSED") {
            break;
          }
          if (iterations < maxIterations - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, args.pollIntervalSeconds * 1000)
            );
          }
        }
        const status = view.state === "MERGED" ? "succeeded" : "failed";
        const timedOut = view.state !== "MERGED" && view.state !== "CLOSED";
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "merge_pull_request",
            target: args.number,
            idempotencyKey: args.idempotencyKey,
            result: { status, runId: String(args.number), view, timedOut },
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
