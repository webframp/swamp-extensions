// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.4.3";

const Comment = z.object({
  path: z.string().min(1),
  newLine: z.number().int().positive(),
  body: z.string().min(1).max(20000),
}).strict();
type Ctx = {
  globalArgs: { host: string; token: string };
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
};
const name = (project: string, iid: number) =>
  `mrDiff-${encodeURIComponent(project)}-${iid}`;
const api = (host: string, path: string) => `https://${host}/api/v4${path}`;
async function request(ctx: Ctx, path: string, init?: RequestInit) {
  const response = await fetch(api(ctx.globalArgs.host, path), {
    ...init,
    headers: {
      "PRIVATE-TOKEN": ctx.globalArgs.token,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitLab API ${response.status}: ${await response.text()}`);
  }
  return response;
}
function changedLines(diff: string): Set<number> {
  const lines = new Set<number>();
  let current = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.add(current);
      current++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) current++;
  }
  return lines;
}
/** GitLab review augmentation for SHA-bound, changed-line inline reviews. */
export const extension = {
  type: "@webframp/gitlab-review",
  methods: [{
    post_inline_review: {
      description:
        "Post a SHA-bound batch of validated changed-line comments, optionally removing approval.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number().int().positive(),
        expectedHeadSha: z.string().min(1),
        comments: z.array(Comment).min(1).max(50),
        action: z.enum(["comment", "request_changes"]),
      }).strict(),
      execute: async (
        args: {
          project: string;
          iid: number;
          expectedHeadSha: string;
          comments: z.infer<typeof Comment>[];
          action: "comment" | "request_changes";
        },
        context: Ctx,
      ) => {
        const snapshot = await context.readResource(
          name(args.project, args.iid),
        );
        if (!snapshot || snapshot.state !== "opened") {
          throw new Error(
            "A current opened immutable mrDiff snapshot is required",
          );
        }
        const files = Array.isArray(snapshot.diffs)
          ? snapshot.diffs as Record<string, unknown>[]
          : [];
        const seenPositions = new Set<string>();
        for (const comment of args.comments) {
          const position = `${comment.path}:${comment.newLine}`;
          if (seenPositions.has(position)) {
            throw new Error(
              `Comment ${position} is duplicated in this request`,
            );
          }
          seenPositions.add(position);
        }
        for (const comment of args.comments) {
          const file = files.find((f) => f.newPath === comment.path);
          if (
            !file || !changedLines(String(file.diff ?? "")).has(comment.newLine)
          ) {
            throw new Error(
              `Comment ${comment.path}:${comment.newLine} is not a changed line in the immutable diff`,
            );
          }
        }
        const project = encodeURIComponent(args.project);
        const versions = await (await request(
          context,
          `/projects/${project}/merge_requests/${args.iid}/versions`,
        )).json() as Array<
          {
            base_commit_sha?: string;
            start_commit_sha?: string;
            head_commit_sha?: string;
          }
        >;
        const version = versions[0];
        if (
          !version?.base_commit_sha ||
          !version.start_commit_sha ||
          version.head_commit_sha !== args.expectedHeadSha
        ) {
          throw new Error(
            "MR head SHA changed; recollect and review before posting",
          );
        }
        const resourceName = `${project}-${args.iid}-${args.expectedHeadSha}`;
        const existing = await context.readResource(resourceName);
        const discussions: Array<
          {
            discussionId: string;
            noteId: number;
            path: string;
            newLine: number;
          }
        > = Array.isArray(existing?.discussions)
          ? [...(existing?.discussions as typeof discussions)]
          : [];
        const posted = new Set(
          discussions.map((d) => `${d.path}:${d.newLine}`),
        );
        for (const comment of args.comments) {
          const key = `${comment.path}:${comment.newLine}`;
          if (posted.has(key)) continue;
          const response = await request(
            context,
            `/projects/${project}/merge_requests/${args.iid}/discussions`,
            {
              method: "POST",
              body: JSON.stringify({
                body: comment.body,
                position: {
                  position_type: "text",
                  base_sha: version.base_commit_sha,
                  start_sha: version.start_commit_sha,
                  head_sha: version.head_commit_sha,
                  old_path: comment.path,
                  new_path: comment.path,
                  new_line: comment.newLine,
                },
              }),
            },
          );
          const data = await response.json() as {
            id?: string;
            notes?: Array<{ id?: number }>;
          };
          if (!data.id || !data.notes?.[0]?.id) {
            throw new Error(
              "GitLab returned an invalid inline discussion response",
            );
          }
          discussions.push({
            discussionId: data.id,
            noteId: data.notes[0].id,
            path: comment.path,
            newLine: comment.newLine,
          });
          posted.add(key);
          await context.writeResource("inlineReview", resourceName, {
            project: args.project,
            iid: args.iid,
            expectedHeadSha: args.expectedHeadSha,
            action: args.action,
            discussions,
            postedAt: new Date().toISOString(),
          });
        }
        if (args.action === "request_changes") {
          const response = await fetch(
            api(
              context.globalArgs.host,
              `/projects/${project}/merge_requests/${args.iid}/unapprove`,
            ),
            {
              method: "POST",
              headers: { "PRIVATE-TOKEN": context.globalArgs.token },
            },
          );
          if (!response.ok && response.status !== 404) {
            throw new Error(
              `GitLab request changes failed: ${response.status}`,
            );
          }
        }
        const handle = await context.writeResource(
          "inlineReview",
          resourceName,
          {
            project: args.project,
            iid: args.iid,
            expectedHeadSha: args.expectedHeadSha,
            action: args.action,
            discussions,
            postedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
