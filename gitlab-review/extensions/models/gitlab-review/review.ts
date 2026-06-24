/**
 * GitLab MR review model — fetches diffs and posts review comments.
 * Uses GraphQL for note operations and MR metadata, REST fallback for
 * diff content (not available via GraphQL) and approve/unapprove.
 * No CLI dependencies.
 *
 * @module
 */
// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().describe("GitLab hostname (e.g. gitlab.example.com)"),
  token: z.string().meta({ sensitive: true }).describe(
    "GitLab personal access token",
  ),
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
  state: z.string(),
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

async function assertMrOpen(
  context: ModelContext,
  project: string,
  iid: number,
): Promise<void> {
  const diffData = await context.readResource(
    instanceName("mrDiff", project, iid),
  );
  if (!diffData) {
    throw new Error(
      `No MR data for ${project}!${iid}. Run get_mr_diff first to fetch MR state.`,
    );
  }
  const state = (diffData.state as string) ?? "unknown";
  if (state !== "opened") {
    throw new Error(
      `MR ${project}!${iid} is ${state}. Cannot post or approve a ${state} MR.`,
    );
  }
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

const MR_METADATA_QUERY = `
query mrMetadata($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      id iid title state description sourceBranch targetBranch
      author { username }
    }
  }
}`;

const CREATE_NOTE_MUTATION = `
mutation createNote($noteableId: NoteableID!, $body: String!) {
  createNote(input: { noteableId: $noteableId, body: $body }) {
    note { id body }
    errors
  }
}`;

const UPDATE_NOTE_MUTATION = `
mutation updateNote($id: NoteID!, $body: String!) {
  updateNote(input: { id: $id, body: $body }) {
    note { id body }
    errors
  }
}`;

// =============================================================================
// Model
// =============================================================================

/** GitLab MR review model — fetch diffs, draft reviews, post comments via GraphQL (REST fallback for diffs & approvals). */
export const model = {
  type: "@webframp/gitlab-review",
  version: "2026.06.24.1",
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
        "Fetch MR metadata via GraphQL and file diffs via REST (raw diff content not available in GraphQL).",
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

        // Fetch MR metadata via GraphQL
        const gqlData = await graphqlRequest(host, token, MR_METADATA_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const mr = gqlData.project?.mergeRequest;
        if (!mr) {
          throw new Error(
            `get_mr_diff: MR !${args.iid} not found in ${args.project}`,
          );
        }

        // Fetch diffs via REST (only place raw diff content is available)
        const changesResp = await contextFetch(
          `get_mr_diff ${args.project}!${args.iid} changes`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/changes?access_raw_diffs=true`,
        );
        const changesData = await changesResp.json();
        const raw = (changesData as Record<string, unknown>).changes;
        const allRawDiffs: Record<string, unknown>[] = Array.isArray(raw)
          ? raw
          : [];
        const truncated = !!(
          (changesData as Record<string, unknown>).overflow
        );

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
          state: (mr.state ?? "unknown").toLowerCase(),
          description: mr.description ?? null,
          sourceBranch: mr.sourceBranch ?? "",
          targetBranch: mr.targetBranch ?? "",
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
        await assertMrOpen(context, args.project, args.iid);
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
        await assertMrOpen(context, args.project, args.iid);
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
        "Edit an existing review comment on a GitLab MR via GraphQL updateNote mutation.",
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

        const noteGid = `gid://gitlab/Note/${args.noteId}`;
        const result = await graphqlRequest(
          host,
          token,
          UPDATE_NOTE_MUTATION,
          { id: noteGid, body },
        );
        if (result.updateNote?.errors?.length) {
          throw new Error(
            `updateNote failed: ${result.updateNote.errors.join("; ")}`,
          );
        }
        if (!result.updateNote?.note) {
          throw new Error(
            `updateNote returned no note (noteId: ${args.noteId}, project: ${args.project})`,
          );
        }

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
        "Post the current review draft as a comment via GraphQL createNote, " +
        "optionally approving or requesting changes (REST).",
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
        await assertMrOpen(context, args.project, args.iid);
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

        // Get MR global ID for createNote
        const gqlData = await graphqlRequest(host, token, MR_METADATA_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const mrGid = gqlData.project?.mergeRequest?.id;
        if (!mrGid) {
          throw new Error(
            `post_review: MR !${args.iid} not found in ${args.project}`,
          );
        }

        // Post note via GraphQL
        const noteResult = await graphqlRequest(
          host,
          token,
          CREATE_NOTE_MUTATION,
          { noteableId: mrGid, body },
        );
        if (noteResult.createNote?.errors?.length) {
          throw new Error(
            `createNote failed: ${noteResult.createNote.errors.join("; ")}`,
          );
        }
        const noteGid = noteResult.createNote?.note?.id ?? "";
        // Extract numeric ID from gid://gitlab/Note/123
        const noteId = parseInt(noteGid.split("/").pop() ?? "0", 10);
        if (!noteId) {
          throw new Error(
            `post_review ${args.project}!${args.iid}: expected note id from GraphQL, got: ${noteGid}`,
          );
        }

        // Record the posted note immediately
        const data = {
          project: args.project,
          iid: args.iid,
          noteId,
          postedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewPosted",
          instanceName("reviewPosted", args.project, args.iid),
          data,
        );

        // Apply approval action via REST (no GraphQL mutations for approve/unapprove)
        const pid = encodeProject(args.project);
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
          noteId,
          action: args.action,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
