// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.6.5";
const GlobalArgs = z.object({
  host: z.string().min(1).default("swamp-club.com"),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    'Swamp Club API key. Supply it as ${{ vault.get("swamp-club", "API_KEY") }}; never pass the literal key',
  ),
  maxComments: z.number().int().min(1).max(100).default(50),
}).strict();
const idempotencyKey = z.string().min(1).regex(
  /^[A-Za-z0-9._:-]+$/,
  "must contain only alphanumerics, dot, underscore, colon, or hyphen",
);
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
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<DataHandle>;
};
// The fields the workflow runtime requires on a returned handle.
type DataHandle = {
  name: string;
  dataId: string;
  version: number;
  tags: Record<string, string>;
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
  version: "2026.10.21.1",
  globalArguments: GlobalArgs,
  upgrades: [{
    toVersion: "2026.09.08.1",
    description: "Initial narrowly scoped Lab adapter",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.15.1",
    description: "No schema changes — dependency/license maintenance bump",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.18.1",
    description:
      "Normalized zod dependency version to 4.6.5; no behavioral changes",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.10.12.1",
    description:
      "No schema changes — post_ripple returns a complete data handle on a repeated key",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.10.14.1",
    description:
      "No schema changes — manifest now declares license: Apache-2.0 (SPDX)",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.10.21.1",
    description:
      "No schema changes — apiKey description and README now direct the key through vault.get",
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
        idempotencyKey,
      }).strict(),
      execute: async (
        { issueNumber, body, idempotencyKey }: {
          issueNumber: number;
          body: string;
          idempotencyKey: string;
        },
        context: Context,
      ) => {
        const resourceName = `${issueNumber}-${idempotencyKey}`;
        const existing = await context.readResource(resourceName);
        if (existing) {
          // The runtime rejects name-only handles, and writeResource is the
          // only API that returns a complete one, so re-write the record
          // unchanged. readResource resolves vault references and this
          // writes the resolved values back; acceptable because ripple holds
          // only the already-posted public comment and its identifiers.
          const handle = await context.writeResource(
            "ripple",
            resourceName,
            existing,
          );
          return { dataHandles: [handle] };
        }
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
          resourceName,
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
