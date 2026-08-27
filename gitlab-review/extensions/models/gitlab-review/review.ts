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

const EXTENSION_NAME = "@webframp/gitlab-review";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "GitLab hostname (e.g. gitlab.example.com)",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "GitLab personal access token",
  ),
});

const DiffFileSchema = z.object({
  oldPath: z.string().describe("File path on the old side of the diff"),
  newPath: z.string().describe("File path on the new side of the diff"),
  diff: z.string().describe("Raw unified diff content for this file"),
  newFile: z.boolean().describe("Whether the file was newly added"),
  renamedFile: z.boolean().describe("Whether the file was renamed"),
  deletedFile: z.boolean().describe("Whether the file was deleted"),
});

const MrDiffSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request IID"),
  title: z.string().describe("Merge request title"),
  state: z.string().describe("Merge request state (opened/closed/merged)"),
  description: z.string().nullable().describe("Merge request description"),
  sourceBranch: z.string().describe("Source branch"),
  targetBranch: z.string().describe("Target branch"),
  author: z.string().describe("Merge request author's username"),
  diffs: z.array(DiffFileSchema).describe("Per-file diff content"),
  fetchedAt: z.string().describe("Timestamp the diff was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
  truncated: z.boolean().describe(
    "Whether GitLab's diff overflow limit was hit, dropping some file diffs",
  ),
});

const ReviewDraftSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request IID"),
  body: z.string().describe("Draft review comment body (markdown)"),
  createdAt: z.string().describe(
    "Timestamp the draft was created or last edited",
  ),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ReviewPostedSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request IID"),
  noteId: z.number().describe("ID of the posted GitLab note"),
  postedAt: z.string().describe("Timestamp the review comment was posted"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const LineCommentSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request IID"),
  discussionId: z.string().describe("GitLab discussion ID the comment opened"),
  noteId: z.number().describe("ID of the posted note"),
  newPath: z.string().describe("File path on the new side of the diff"),
  newLine: z.number().int().positive().nullable().describe(
    "Line number on the new side (added/changed lines), null if unset",
  ),
  oldLine: z.number().int().positive().nullable().describe(
    "Line number on the old side (deleted lines), null if unset",
  ),
  postedAt: z.string().describe("Timestamp the comment was posted"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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

/**
 * Remove approval from an MR, idempotently. GitLab's unapprove endpoint returns
 * 404 when the caller has no approval to remove; that is the desired end state
 * for "request changes", not an error, so we treat it as success. Any other
 * non-2xx status still throws. Returns whether an approval was actually removed.
 */
async function unapproveMr(
  ctx: string,
  host: string,
  token: string,
  project: string,
  iid: number,
): Promise<{ removed: boolean }> {
  const url = apiUrl(
    host,
    `/projects/${encodeProject(project)}/merge_requests/${iid}/unapprove`,
  );
  const resp = await fetch(url, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
  });
  if (resp.status === 404) {
    // Nothing to unapprove — the MR was not approved by this user. Idempotent.
    return { removed: false };
  }
  if (!resp.ok) {
    let body: string;
    try {
      body = await resp.text();
    } catch {
      body = "[unable to read response body]";
    }
    throw new Error(`${ctx}: GitLab API ${resp.status}: ${body}`);
  }
  return { removed: true };
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
  let result: any;
  try {
    result = await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GraphQL response from ${host} was not valid JSON: ${msg}`,
      { cause: err },
    );
  }
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
  version: "2026.08.26.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.07.1",
      description:
        "Additive: new lineComment resource, no changes to existing resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "No schema changes (added field descriptions and required-string min-length checks)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "No schema changes (method arguments now validate project/iid shape; malformed JSON responses raise a clear error)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description: "Fix missing upgrade description metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.3",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    lineComment: {
      description: "Record of a diff-positioned line comment",
      schema: LineCommentSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    get_mr_diff: {
      description:
        "Fetch MR metadata via GraphQL and file diffs via REST (raw diff content not available in GraphQL).",
      arguments: z.object({
        project: z.string().min(1).describe(
          "Project path (e.g. mygroup/myproject)",
        ),
        iid: z.number().int().positive().describe("Merge request IID"),
      }),
      execute: async (
        args: { project: string; iid: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
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
        let changesData: unknown;
        try {
          changesData = await changesResp.json();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `get_mr_diff ${args.project}!${args.iid} changes: response was not valid JSON: ${msg}`,
            { cause: err },
          );
        }
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
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
        body: z.string().describe("Review comment body (markdown)"),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const data = {
          project: args.project,
          iid: args.iid,
          body: args.body,
          createdAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewDraft",
          instanceName("reviewDraft", args.project, args.iid),
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
        body: z.string().describe("Updated review comment body (markdown)"),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const data = {
          project: args.project,
          iid: args.iid,
          body: args.body,
          createdAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "reviewDraft",
          instanceName("reviewDraft", args.project, args.iid),
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
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
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
      }),
      execute: async (
        args: { project: string; iid: number },
        context: ModelContext,
      ) => {
        await assertMrOpen(context, args.project, args.iid);
        const { host, token } = context.globalArgs;
        // Confirm the MR is live-accessible before treating a 404 from unapprove
        // as "no approval to remove". GitLab also returns 404 for MRs the token
        // cannot see, and the cached mrDiff state may be stale relative to the
        // current token — without this probe an inaccessible MR would be
        // reported as a successful request-changes.
        const gql = await graphqlRequest(host, token, MR_METADATA_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        if (!gql.project?.mergeRequest?.id) {
          throw new Error(
            `unapprove_mr ${args.project}!${args.iid}: MR not found or not accessible`,
          );
        }
        const { removed } = await unapproveMr(
          `unapprove_mr ${args.project}!${args.iid}`,
          host,
          token,
          args.project,
          args.iid,
        );
        context.logger.info(
          removed ? "Unapproved MR" : "MR had no approval to remove",
          { project: args.project, iid: args.iid },
        );
        return { dataHandles: [] };
      },
    },

    update_review: {
      description:
        "Edit an existing review comment on a GitLab MR via GraphQL updateNote mutation.",
      arguments: z.object({
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
        noteId: z.number().describe("Note ID to update"),
      }),
      execute: async (
        args: { project: string; iid: number; noteId: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
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
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
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
        const startMs = Date.now();
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
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
          // Idempotent: a never-approved MR has nothing to unapprove (404),
          // which is fine — the comment is already posted and the MR is left
          // unapproved either way.
          const { removed } = await unapproveMr(
            `post_review unapprove ${args.project}!${args.iid}`,
            host,
            token,
            args.project,
            args.iid,
          );
          context.logger.info(
            removed
              ? "Requested changes on MR (approval removed)"
              : "Requested changes on MR (was not approved)",
            { project: args.project, iid: args.iid },
          );
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

    post_line_comment: {
      description:
        "Post a comment positioned on a specific file/line in an MR diff " +
        "(GitLab REST discussions API — position requires the MR's current diff versions).",
      arguments: z.object({
        project: z.string().min(1).describe("Project path"),
        iid: z.number().int().positive().describe("Merge request IID"),
        body: z.string().describe("Comment body (markdown)"),
        newPath: z.string().describe("File path on the new side of the diff"),
        oldPath: z.string().optional().describe(
          "File path on the old side of the diff (defaults to newPath — " +
            "pass explicitly for renamed files, especially when commenting " +
            "on a deleted line via oldLine)",
        ),
        newLine: z.number().int().positive().optional().describe(
          "Line number on the new side (added/changed lines)",
        ),
        oldLine: z.number().int().positive().optional().describe(
          "Line number on the old side (deleted lines)",
        ),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          body: string;
          newPath: string;
          oldPath?: string;
          newLine?: number;
          oldLine?: number;
        },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        if (args.newLine === undefined && args.oldLine === undefined) {
          throw new Error(
            `post_line_comment ${args.project}!${args.iid}: at least one of newLine or oldLine must be provided`,
          );
        }
        await assertMrOpen(context, args.project, args.iid);
        const { host, token } = context.globalArgs;
        const pid = encodeProject(args.project);

        const versionsResp = await contextFetch(
          `post_line_comment ${args.project}!${args.iid} versions`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/versions`,
        );
        let versions: unknown;
        try {
          versions = await versionsResp.json();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `post_line_comment ${args.project}!${args.iid} versions: response was not valid JSON: ${msg}`,
            { cause: err },
          );
        }
        const latest = Array.isArray(versions) ? versions[0] : undefined;
        if (!latest?.base_commit_sha) {
          throw new Error(
            `post_line_comment ${args.project}!${args.iid}: no diff versions found`,
          );
        }

        const position: Record<string, unknown> = {
          position_type: "text",
          base_sha: latest.base_commit_sha,
          start_sha: latest.start_commit_sha,
          head_sha: latest.head_commit_sha,
          new_path: args.newPath,
          old_path: args.oldPath ?? args.newPath,
        };
        if (args.newLine !== undefined) position.new_line = args.newLine;
        if (args.oldLine !== undefined) position.old_line = args.oldLine;

        const discussionResp = await contextFetch(
          `post_line_comment ${args.project}!${args.iid} discussion`,
          host,
          token,
          `/projects/${pid}/merge_requests/${args.iid}/discussions`,
          {
            method: "POST",
            body: JSON.stringify({ body: args.body, position }),
          },
        );
        let discussion: any;
        try {
          discussion = await discussionResp.json();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `post_line_comment ${args.project}!${args.iid} discussion: response was not valid JSON: ${msg}`,
            { cause: err },
          );
        }
        const note = Array.isArray(discussion?.notes)
          ? discussion.notes[0]
          : undefined;
        if (!discussion?.id || !note?.id) {
          throw new Error(
            `post_line_comment ${args.project}!${args.iid}: unexpected discussion response`,
          );
        }

        const data = {
          project: args.project,
          iid: args.iid,
          discussionId: String(discussion.id),
          noteId: note.id,
          newPath: args.newPath,
          newLine: args.newLine ?? null,
          oldLine: args.oldLine ?? null,
          postedAt: new Date().toISOString(),
        };
        // Keyed by position (not just project+iid) — a single MR can carry many
        // line comments, each its own instance, unlike reviewPosted's one-per-MR
        // singular semantics.
        const positionKey = `${encodeURIComponent(args.newPath)}-${
          args.newLine ?? "x"
        }-${args.oldLine ?? "x"}`;
        const handle = await context.writeResource(
          "lineComment",
          `${
            instanceName("lineComment", args.project, args.iid)
          }-${positionKey}`,
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info("Posted line comment", {
          project: args.project,
          iid: args.iid,
          newPath: args.newPath,
          newLine: args.newLine ?? null,
          oldLine: args.oldLine ?? null,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
