/**
 * GitLab MR review model — fetches diffs and posts review comments
 * using native fetch() against the GitLab REST API. No CLI dependencies.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().describe("GitLab hostname (e.g. gitlab.example.com)"),
  token: z.string().describe("GitLab personal access token"),
});

const DiffFileSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  diff: z.string(),
  newFile: z.boolean(),
  renamedFile: z.boolean(),
  deletedFile: z.boolean(),
});

const MrDiffSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  author: z.string(),
  diffs: z.array(DiffFileSchema),
  fetchedAt: z.string(),
  truncated: z.boolean(),
});

const ReviewDraftSchema = z.object({
  project: z.string(),
  iid: z.number(),
  body: z.string(),
  createdAt: z.string(),
});

const ReviewPostedSchema = z.object({
  project: z.string(),
  iid: z.number(),
  noteId: z.number(),
  postedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

interface ModelContext {
  globalArgs: { host: string; token: string };
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<
    {
      name: string;
      specName: string;
      kind: string;
      dataId: string;
      version: number;
      size: number;
    }
  >;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
}

function apiUrl(host: string, path: string): string {
  return `https://${host}/api/v4${path}`;
}

function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

function instanceName(prefix: string, project: string, iid: number): string {
  return `${prefix}-${encodeURIComponent(project)}-${iid}`;
}

async function gitlabFetch(
  host: string,
  token: string,
  path: string,
  opts?: RequestInit,
): Promise<Response> {
  const url = apiUrl(host, path);
  const resp = await fetch(url, {
    ...opts,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
    },
  });
  if (!resp.ok) {
    let body: string;
    try {
      body = await resp.text();
    } catch {
      body = "[unable to read response body]";
    }
    throw new Error(`GitLab API ${resp.status}: ${body}`);
  }
  return resp;
}

async function contextFetch(
  context: string,
  host: string,
  token: string,
  path: string,
  opts?: RequestInit,
): Promise<Response> {
  try {
    return await gitlabFetch(host, token, path, opts);
  } catch (err) {
    throw new Error(`${context}: ${(err as Error).message}`);
  }
}

// =============================================================================
// Model
// =============================================================================

/** GitLab MR review model — fetch diffs, draft reviews, post comments via REST API. */
export const model = {
  type: "@webframp/gitlab-review",
  version: "2026.06.04.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    mrDiff: {
      description: "MR diff content for review",
      schema: MrDiffSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    reviewDraft: {
      description: "Draft review comment (editable before posting)",
      schema: ReviewDraftSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    reviewPosted: {
      description: "Record of posted review comment",
      schema: ReviewPostedSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    get_mr_diff: {
      description:
        "Fetch MR metadata and file diffs from GitLab REST API via native fetch.",
      arguments: z.object({
        project: z.string().describe("Project path (e.g. mygroup/myproject)"),
        iid: z.number().describe("Merge request IID"),
      }),
      execute: async (
        args: { project: string; iid: number },
        context: ModelContext,
      ) => {
        const { host, token } = context.globalArgs;
        const pid = encodeProject(args.project);

        // Fetch MR metadata
        const mrResp = await contextFetch(
          `get_mr_diff ${args.project}!${args.iid}`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}`,
        );
        const mr = await mrResp.json();

        // Fetch diffs (paginated, capped at 10 pages)
        const allRawDiffs: Record<string, unknown>[] = [];
        let page = 1;
        const maxPages = 10;
        let truncated = false;
        while (page <= maxPages) {
          const diffsResp = await contextFetch(
            `get_mr_diff ${args.project}!${args.iid} diffs page ${page}`,
            host,
            token,
            `/projects/${pid}/merge_requests/${args.iid}/diffs?page=${page}&per_page=100`,
          );
          const batch = await diffsResp.json();
          if (!Array.isArray(batch)) {
            throw new Error(
              `get_mr_diff ${args.project}!${args.iid}: expected array of diffs, got: ${
                JSON.stringify(batch).slice(0, 200)
              }`,
            );
          }
          if (batch.length === 0) break;
          allRawDiffs.push(...batch);
          if (batch.length < 100) break;
          page++;
        }
        if (page > maxPages) truncated = true;

        const diffs = allRawDiffs.map((d: Record<string, unknown>) => ({
          oldPath: (d.old_path as string) ?? "",
          newPath: (d.new_path as string) ?? "",
          diff: (d.diff as string) ?? "",
          newFile: (d.new_file as boolean) ?? false,
          renamedFile: (d.renamed_file as boolean) ?? false,
          deletedFile: (d.deleted_file as boolean) ?? false,
        }));

        const data = {
          project: args.project,
          iid: args.iid,
          title: mr.title ?? "",
          description: mr.description ?? null,
          sourceBranch: mr.source_branch ?? "",
          targetBranch: mr.target_branch ?? "",
          author: mr.author?.username ?? "",
          diffs,
          fetchedAt: new Date().toISOString(),
          truncated,
        };

        const handle = await context.writeResource(
          "mrDiff",
          instanceName("mrDiff", args.project, args.iid),
          data,
        );
        context.logger.info("Fetched MR diff", {
          project: args.project,
          iid: args.iid,
          files: diffs.length,
        });
        return { dataHandles: [handle] };
      },
    },

    analyze: {
      description:
        "Store an AI-generated review draft for human review before posting. " +
        "The caller (agent/workflow) provides the analysis text.",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
        body: z.string().describe("Review comment body (markdown)"),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        context: ModelContext,
      ) => {
        const data = {
          project: args.project,
          iid: args.iid,
          body: args.body,
          createdAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewDraft",
          instanceName("reviewDraft", args.project, args.iid),
          data,
        );
        context.logger.info("Stored review draft", {
          project: args.project,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    edit_draft: {
      description:
        "Replace the current review draft body. Creates a new version " +
        "(previous versions retained per garbageCollection policy).",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
        body: z.string().describe("Updated review comment body (markdown)"),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        context: ModelContext,
      ) => {
        const data = {
          project: args.project,
          iid: args.iid,
          body: args.body,
          createdAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewDraft",
          instanceName("reviewDraft", args.project, args.iid),
          data,
        );
        context.logger.info("Updated review draft", {
          project: args.project,
          iid: args.iid,
          version: handle.version,
        });
        return { dataHandles: [handle] };
      },
    },

    approve_mr: {
      description: "Approve a merge request without posting a comment.",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
      }),
      execute: async (
        args: { project: string; iid: number },
        context: ModelContext,
      ) => {
        const { host, token } = context.globalArgs;
        const pid = encodeProject(args.project);
        await contextFetch(
          `approve_mr ${args.project}!${args.iid}`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/approve`,
          {
            method: "POST",
          },
        );
        context.logger.info("Approved MR", {
          project: args.project,
          iid: args.iid,
        });
        return { dataHandles: [] };
      },
    },

    unapprove_mr: {
      description: "Remove approval from a merge request (request changes).",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
      }),
      execute: async (
        args: { project: string; iid: number },
        context: ModelContext,
      ) => {
        const { host, token } = context.globalArgs;
        const pid = encodeProject(args.project);
        await contextFetch(
          `unapprove_mr ${args.project}!${args.iid}`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/unapprove`,
          {
            method: "POST",
          },
        );
        context.logger.info("Unapproved MR", {
          project: args.project,
          iid: args.iid,
        });
        return { dataHandles: [] };
      },
    },

    update_review: {
      description:
        "Edit an existing review comment on a GitLab MR. Updates the note " +
        "in place using the current review draft body.",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
        noteId: z.number().describe("Note ID to update"),
      }),
      execute: async (
        args: { project: string; iid: number; noteId: number },
        context: ModelContext,
      ) => {
        const { host, token } = context.globalArgs;
        const draftName = instanceName("reviewDraft", args.project, args.iid);
        const draft = await context.readResource(draftName);
        if (!draft) {
          throw new Error(
            `No review draft found for ${args.project}!${args.iid}`,
          );
        }
        const body = draft.body as string | undefined;
        if (!body) {
          throw new Error(
            `Review draft for ${args.project}!${args.iid} has no body field`,
          );
        }

        const pid = encodeProject(args.project);
        await contextFetch(
          `update_review ${args.project}!${args.iid} note ${args.noteId}`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/notes/${args.noteId}`,
          {
            method: "PUT",
            body: JSON.stringify({ body }),
          },
        );

        const data = {
          project: args.project,
          iid: args.iid,
          noteId: args.noteId,
          postedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewPosted",
          instanceName("reviewPosted", args.project, args.iid),
          data,
        );
        context.logger.info("Updated review comment", {
          project: args.project,
          iid: args.iid,
          noteId: args.noteId,
        });
        return { dataHandles: [handle] };
      },
    },

    post_review: {
      description:
        "Post the current review draft as a comment on the GitLab MR, " +
        "optionally approving or requesting changes.",
      arguments: z.object({
        project: z.string().describe("Project path"),
        iid: z.number().describe("Merge request IID"),
        action: z
          .enum(["comment", "approve", "request_changes"])
          .default("comment")
          .describe(
            "comment = note only; approve = note + approve MR; request_changes = note + unapprove MR",
          ),
      }),
      execute: async (
        args: { project: string; iid: number; action: string },
        context: ModelContext,
      ) => {
        const { host, token } = context.globalArgs;
        const draftName = instanceName("reviewDraft", args.project, args.iid);
        const draft = await context.readResource(draftName);
        if (!draft) {
          throw new Error(
            `No review draft found for ${args.project}!${args.iid}`,
          );
        }
        const body = draft.body as string | undefined;
        if (!body) {
          throw new Error(
            `Review draft for ${args.project}!${args.iid} has no body field`,
          );
        }

        const pid = encodeProject(args.project);

        // Post the comment
        const resp = await contextFetch(
          `post_review ${args.project}!${args.iid}`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/notes`,
          {
            method: "POST",
            body: JSON.stringify({ body }),
          },
        );
        const note = await resp.json();
        if (typeof note.id !== "number") {
          throw new Error(
            `post_review ${args.project}!${args.iid}: expected note id, got: ${
              JSON.stringify(note).slice(0, 200)
            }`,
          );
        }

        // Record the posted note immediately — before approval side-effects.
        // If approve/unapprove fails, the noteId is still preserved and retries
        // can detect the existing comment rather than posting a duplicate.
        const data = {
          project: args.project,
          iid: args.iid,
          noteId: note.id as number,
          postedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewPosted",
          instanceName("reviewPosted", args.project, args.iid),
          data,
        );

        // Apply approval action (best-effort after comment is recorded)
        if (args.action === "approve") {
          await contextFetch(
            `post_review approve ${args.project}!${args.iid}`,
            host,
            token,
            `/projects/${pid}/merge_requests/${args.iid}/approve`,
            { method: "POST" },
          );
          context.logger.info("Approved MR", {
            project: args.project,
            iid: args.iid,
          });
        } else if (args.action === "request_changes") {
          await contextFetch(
            `post_review unapprove ${args.project}!${args.iid}`,
            host,
            token,
            `/projects/${pid}/merge_requests/${args.iid}/unapprove`,
            { method: "POST" },
          );
          context.logger.info("Requested changes on MR", {
            project: args.project,
            iid: args.iid,
          });
        }

        context.logger.info("Posted review to GitLab", {
          project: args.project,
          iid: args.iid,
          noteId: note.id,
          action: args.action,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
