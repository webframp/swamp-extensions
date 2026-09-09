// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.4.3";
const GlobalArgs = z.object({
  host: z.string().min(1).default("swamp-club.com"),
  apiKey: z.string().min(1).meta({ sensitive: true }),
  maxComments: z.number().int().min(1).max(100).default(50),
}).strict();
const Issue = z.object({
  number: z.number(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  comments: z.array(
    z.object({ author: z.string(), body: z.string(), createdAt: z.string() }),
  ),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).strict();
type Context = {
  globalArgs: z.infer<typeof GlobalArgs>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
};
function url(host: string, path: string) {
  return `https://${
    host.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }/api/v1${path}`;
}
async function request(ctx: Context, path: string, init?: RequestInit) {
  const response = await fetch(url(ctx.globalArgs.host, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.globalArgs.apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(
      `Swamp Club API ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}
/** Narrow Swamp Club Lab intake and approval-gated ripple adapter. */
export const model = {
  type: "@webframp/swamp-club",
  version: "2026.09.08.1",
  globalArguments: GlobalArgs,
  upgrades: [{
    toVersion: "2026.09.08.1",
    description: "Initial narrowly scoped Lab adapter",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  resources: {
    labIssue: {
      description: "Bounded Lab issue context",
      schema: Issue,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    ripple: {
      description: "Posted preapproved Lab ripple evidence",
      schema: z.object({
        issueNumber: z.number(),
        commentId: z.string(),
        body: z.string(),
        postedAt: z.string(),
      }).strict(),
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    get_lab_issue_context: {
      description:
        "Read one Lab issue and bounded activity without changing its lifecycle.",
      arguments: z.object({ issueNumber: z.number().int().positive() })
        .strict(),
      execute: async (
        { issueNumber }: { issueNumber: number },
        context: Context,
      ) => {
        const response = await request(context, `/lab/issues/${issueNumber}`);
        const data = await response.json() as {
          issue?: Record<string, unknown>;
        };
        const issue = data.issue;
        if (!issue) throw new Error(`Lab issue ${issueNumber} was not found`);
        const comments = Array.isArray(issue.comments)
          ? issue.comments.slice(-context.globalArgs.maxComments).map(
            (item) => {
              const c = item as Record<string, unknown>;
              return {
                author: String(c.authorUsername ?? c.author ?? "unknown"),
                body: String(c.body ?? ""),
                createdAt: String(c.createdAt ?? ""),
              };
            },
          )
          : [];
        const handle = await context.writeResource(
          "labIssue",
          String(issueNumber),
          {
            number: issueNumber,
            type: String(issue.type ?? "unknown"),
            status: String(issue.status ?? "unknown"),
            title: String(issue.title ?? ""),
            body: String(issue.body ?? ""),
            author: String(issue.authorUsername ?? "unknown"),
            comments,
            truncated: Array.isArray(issue.comments) &&
              issue.comments.length > comments.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    post_ripple: {
      description:
        "Post an explicitly approved, exact ripple and record its remote identifier.",
      arguments: z.object({
        issueNumber: z.number().int().positive(),
        body: z.string().min(1).max(20000),
        idempotencyKey: z.string().min(1),
      }).strict(),
      execute: async (
        { issueNumber, body, idempotencyKey }: {
          issueNumber: number;
          body: string;
          idempotencyKey: string;
        },
        context: Context,
      ) => {
        const marked = `${body}\n\n<!-- triage:${idempotencyKey} -->`;
        const response = await request(
          context,
          `/lab/issues/${issueNumber}/comments`,
          { method: "POST", body: JSON.stringify({ body: marked }) },
        );
        const data = await response.json() as { comment?: { id?: string } };
        if (!data.comment?.id) {
          throw new Error("Swamp Club did not return a ripple identifier");
        }
        const handle = await context.writeResource(
          "ripple",
          `${issueNumber}-${idempotencyKey}`,
          {
            issueNumber,
            commentId: data.comment.id,
            body: marked,
            postedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
