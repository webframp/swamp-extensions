/**
 * GitLab project operations model for swamp.
 *
 * Queries and mutates GitLab data via GraphQL API with REST fallback
 * where GraphQL lacks coverage (merge accept). Supports self-hosted
 * instances. Auth via personal access token stored in a swamp vault.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

const EXTENSION_NAME = "@webframp/gitlab";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "GitLab hostname (e.g. git.example.org)",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "GitLab personal access token with api scope (use vault reference)",
  ),
});

const ProjectSchema = z.object({
  name: z.string().describe("Project name"),
  pathWithNamespace: z.string().describe(
    "Full project path including group/namespace",
  ),
  description: z.string().nullable().describe("Project description"),
  visibility: z.string().describe(
    "Project visibility level (private/internal/public)",
  ),
  starCount: z.number().describe("Number of stars"),
  forksCount: z.number().describe("Number of forks"),
  lastActivityAt: z.string().describe("Timestamp of last project activity"),
  defaultBranch: z.string().nullable().describe("Default branch name"),
  archived: z.boolean().describe("Whether the project is archived"),
  topics: z.array(z.string()).describe("Topics/tags assigned to the project"),
});

const ProjectListSchema = z.object({
  projects: z.array(ProjectSchema).describe(
    "Projects for the authenticated user",
  ),
  count: z.number().describe("Number of projects returned"),
  truncated: z.boolean().describe(
    "Whether more projects exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ProjectInfoSchema = z.object({
  name: z.string().describe("Project name"),
  pathWithNamespace: z.string().describe(
    "Full project path including group/namespace",
  ),
  description: z.string().nullable().describe("Project description"),
  visibility: z.string().describe(
    "Project visibility level (private/internal/public)",
  ),
  defaultBranch: z.string().nullable().describe("Default branch name"),
  starCount: z.number().describe("Number of stars"),
  forksCount: z.number().describe("Number of forks"),
  openIssuesCount: z.number().describe("Number of open issues"),
  archived: z.boolean().describe("Whether the project is archived"),
  topics: z.array(z.string()).describe("Topics/tags assigned to the project"),
  webUrl: z.string().describe("Web URL for the project"),
  createdAt: z.string().describe("Timestamp the project was created"),
  lastActivityAt: z.string().describe("Timestamp of last project activity"),
  fetchedAt: z.string().describe("Timestamp this info was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const MergeRequestSchema = z.object({
  iid: z.number().describe("Merge request internal ID (project-scoped)"),
  title: z.string().describe("Merge request title"),
  state: z.string().describe("Merge request state (opened/closed/merged)"),
  author: z.object({ username: z.string() }).nullable().describe(
    "Merge request author, or null if unavailable",
  ),
  sourceBranch: z.string().describe("Source branch"),
  targetBranch: z.string().describe("Target branch"),
  draft: z.boolean().describe("Whether the merge request is a draft"),
  createdAt: z.string().describe("Timestamp the merge request was created"),
  updatedAt: z.string().describe(
    "Timestamp the merge request was last updated",
  ),
  mergedAt: z.string().nullable().default(null).describe(
    "Timestamp the merge request was merged, or null if not merged. " +
      "Enables downstream review-outcome / unblock-rate analysis.",
  ),
  approvers: z.array(z.string()).default([]).describe(
    "Usernames who approved (reviewed) this merge request. Enables " +
      "cross-boundary review attribution: an approver helps the MR author.",
  ),
  labels: z.array(z.string()).describe("Labels applied to the merge request"),
});

const MergeRequestListSchema = z.object({
  project: z.string().describe("Project the merge requests belong to"),
  mergeRequests: z.array(MergeRequestSchema).describe(
    "Merge requests matching the queried state",
  ),
  count: z.number().describe("Number of merge requests returned"),
  truncated: z.boolean().describe(
    "Whether more merge requests exist beyond this page",
  ),
  state: z.string().describe("State filter used for the query"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const CommitSchema = z.object({
  id: z.string().describe("Commit SHA"),
  shortId: z.string().describe("Abbreviated commit SHA"),
  title: z.string().describe("Commit title (first line of the message)"),
  authorName: z.string().describe("Commit author name"),
  authorEmail: z.string().describe("Commit author email"),
  committedDate: z.string().describe("ISO 8601 timestamp the commit was made"),
  webUrl: z.string().default("").describe("Web URL for the commit"),
});

const CommitListSchema = z.object({
  project: z.string().describe("Project the commits belong to"),
  ref: z.string().default("").describe(
    "Branch or ref the commits were listed from (empty = default branch)",
  ),
  commits: z.array(CommitSchema).describe("Commits matching the query"),
  count: z.number().describe("Number of commits returned"),
  truncated: z.boolean().describe(
    "Whether more commits exist beyond this page",
  ),
  since: z.string().default("").describe(
    "Lower time bound applied to the query (ISO 8601), empty if none",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const IssueSchema = z.object({
  iid: z.number().describe("Issue internal ID (project-scoped)"),
  title: z.string().describe("Issue title"),
  state: z.string().describe("Issue state (opened/closed)"),
  author: z.object({ username: z.string() }).nullable().describe(
    "Issue author, or null if unavailable",
  ),
  createdAt: z.string().describe("Timestamp the issue was created"),
  updatedAt: z.string().describe("Timestamp the issue was last updated"),
  labels: z.array(z.string()).describe("Labels applied to the issue"),
});

const IssueListSchema = z.object({
  project: z.string().describe("Project the issues belong to"),
  issues: z.array(IssueSchema).describe("Issues matching the queried state"),
  count: z.number().describe("Number of issues returned"),
  truncated: z.boolean().describe("Whether more issues exist beyond this page"),
  state: z.string().describe("State filter used for the query"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const IssueDetailSchema = z.object({
  project: z.string().describe("Project the issue belongs to"),
  iid: z.number().describe("Issue internal ID (project-scoped)"),
  title: z.string().describe("Issue title"),
  description: z.string().describe("Issue description body"),
  state: z.string().describe("Issue state (opened/closed)"),
  webUrl: z.string().describe("Web URL for the issue"),
  labels: z.array(z.string()).describe("Labels applied to the issue"),
  createdAt: z.string().describe("Timestamp the issue was created"),
  updatedAt: z.string().describe("Timestamp the issue was last updated"),
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

const NoteSchema = z.object({
  id: z.number().describe("Note ID"),
  body: z.string().describe("Note body text"),
  author: z.object({ username: z.string() }).nullable().describe(
    "Note author, or null if unavailable",
  ),
  createdAt: z.string().describe("Timestamp the note was created"),
});

const NoteListSchema = z.object({
  project: z.string().describe("Project the noteable belongs to"),
  noteableType: z.string().describe(
    "Type of the commented-on object (issue/merge_request)",
  ),
  noteableIid: z.number().describe("Internal ID of the commented-on object"),
  notes: z.array(NoteSchema).describe("Notes/comments returned"),
  count: z.number().describe("Number of notes returned"),
  truncated: z.boolean().describe("Whether older notes exist beyond this page"),
  fetchedAt: z.string().describe("Timestamp the notes were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// A single note inside a discussion thread. `file`/`line` are the slim diff
// position (null for a general, non-diff comment).
const DiscussionNoteSchema = z.object({
  id: z.number().describe("Note ID"),
  author: z.string().nullable().describe(
    "Note author's username, or null if unavailable",
  ),
  body: z.string().describe("Note body text"),
  createdAt: z.string().describe("Timestamp the note was created"),
  file: z.string().nullable().describe(
    "File path the note is anchored to, null for a general comment",
  ),
  line: z.number().nullable().describe(
    "Line number the note is anchored to, null for a general comment",
  ),
});

// A discussion (thread). Resolution state, location, and opener are hoisted to
// the top level so CEL can filter/count without reaching into `notes`, e.g.
// size(discussions.filter(d, d.resolvable && !d.resolved)).
const DiscussionSchema = z.object({
  // GraphQL discussion gid — the exact id add_mr_note(discussionId) and
  // resolve_mr_discussion consume.
  id: z.string().describe("GraphQL discussion gid"),
  resolvable: z.boolean().describe("Whether the discussion can be resolved"),
  resolved: z.boolean().describe(
    "Whether the discussion is currently resolved",
  ),
  resolvedBy: z.string().nullable().describe(
    "Username who resolved the discussion, null if unresolved",
  ),
  // Location + opener, hoisted from the thread's root note.
  file: z.string().nullable().describe(
    "File path the discussion is anchored to, null for a general comment",
  ),
  line: z.number().nullable().describe(
    "Line number the discussion is anchored to, null for a general comment",
  ),
  author: z.string().nullable().describe("Username who opened the discussion"),
  createdAt: z.string().describe("Timestamp the discussion was opened"),
  notes: z.array(DiscussionNoteSchema).describe(
    "Notes in this discussion thread",
  ),
});

const DiscussionListSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  discussions: z.array(DiscussionSchema).describe(
    "Discussion threads on the merge request",
  ),
  truncated: z.boolean().describe(
    "Whether more discussions exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the discussions were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const DiscussionResolutionSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  discussionId: z.string().describe(
    "GraphQL discussion gid that was resolved/unresolved",
  ),
  resolved: z.boolean().describe("Resulting resolution state"),
  resolvedBy: z.string().nullable().describe(
    "Username who resolved the discussion, null if unresolved",
  ),
  fetchedAt: z.string().describe("Timestamp the resolution was recorded"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const NoteDeletedSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  noteId: z.number().describe("Deleted note's ID"),
  deleted: z.boolean().describe("Whether the deletion was confirmed"),
  fetchedAt: z.string().describe("Timestamp the deletion was recorded"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const MrAssigneesSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  // Resulting assignee usernames after the set (empty when unassigned).
  assignees: z.array(z.string()).describe(
    "Resulting assignee usernames after the operation (empty when unassigned)",
  ),
  fetchedAt: z.string().describe("Timestamp the assignees were recorded"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const MrReviewersSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  // Resulting reviewer usernames after the set (empty when cleared).
  reviewers: z.array(z.string()).describe(
    "Resulting reviewer usernames after the operation (empty when cleared)",
  ),
  fetchedAt: z.string().describe("Timestamp the reviewers were recorded"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const UnassignResultSchema = z.object({
  project: z.string().describe("Project the merge requests belong to"),
  // The user removed from each MR (the authenticated user unless overridden).
  username: z.string().describe(
    "The user removed from each MR (the authenticated user unless overridden)",
  ),
  // Only confirmed removals land here (user absent from the resulting
  // assignees). Anything unconfirmable — null payload, no mergeRequest, or the
  // user still present after a REMOVE — goes to `failed` instead.
  results: z.array(z.object({
    iid: z.number().describe("Merge request internal ID"),
    // Assignees remaining after removal — proof co-assignees are preserved.
    remainingAssignees: z.array(z.string()).describe(
      "Assignees remaining after removal — proof co-assignees are preserved",
    ),
  })).describe("Confirmed removals, one entry per successfully updated MR"),
  // Per-MR failures (permission denied, missing MR); one bad MR does not sink
  // the batch.
  failed: z.array(z.object({
    iid: z.number().describe("Merge request internal ID"),
    error: z.string().describe("Why the removal could not be confirmed"),
  })).describe("Per-MR failures; one bad MR does not sink the batch"),
  fetchedAt: z.string().describe("Timestamp the batch was executed"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const RemoveReviewerResultSchema = z.object({
  project: z.string().describe("Project the merge requests belong to"),
  // The reviewer removed from each MR (the authenticated user unless overridden).
  username: z.string().describe(
    "The reviewer removed from each MR (the authenticated user unless overridden)",
  ),
  // Only confirmed removals land here (user absent from the resulting
  // reviewers). Unconfirmable results — null payload, no mergeRequest, or the
  // user still present after a REMOVE — go to `failed` instead.
  results: z.array(z.object({
    iid: z.number().describe("Merge request internal ID"),
    // Reviewers remaining after removal — proof co-reviewers are preserved.
    remainingReviewers: z.array(z.string()).describe(
      "Reviewers remaining after removal — proof co-reviewers are preserved",
    ),
  })).describe("Confirmed removals, one entry per successfully updated MR"),
  failed: z.array(z.object({
    iid: z.number().describe("Merge request internal ID"),
    error: z.string().describe("Why the removal could not be confirmed"),
  })).describe("Per-MR failures; one bad MR does not sink the batch"),
  fetchedAt: z.string().describe("Timestamp the batch was executed"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ReleaseSchema = z.object({
  tagName: z.string().describe("Git tag associated with the release"),
  name: z.string().describe("Release title"),
  createdAt: z.string().describe("Timestamp the release was created"),
  releasedAt: z.string().describe("Timestamp the release was/will be released"),
  upcoming: z.boolean().describe(
    "Whether the release is upcoming (not yet released)",
  ),
});

const ReleaseListSchema = z.object({
  project: z.string().describe("Project the releases belong to"),
  releases: z.array(ReleaseSchema).describe("Releases for the project"),
  count: z.number().describe("Number of releases returned"),
  truncated: z.boolean().describe(
    "Whether more releases exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const PipelineSchema = z.object({
  iid: z.number().describe("Pipeline internal ID"),
  name: z.string().nullable().describe("Pipeline name, if set"),
  status: z.string().describe("Current pipeline status"),
  source: z.string().describe(
    "What triggered the pipeline (push, schedule, etc.)",
  ),
  ref: z.string().describe("Git ref the pipeline ran against"),
  createdAt: z.string().describe("Timestamp the pipeline was created"),
  updatedAt: z.string().describe("Timestamp the pipeline was last updated"),
});

const PipelineListSchema = z.object({
  project: z.string().describe("Project the pipelines belong to"),
  pipelines: z.array(PipelineSchema).describe(
    "Recent pipelines for the project",
  ),
  count: z.number().describe("Number of pipelines returned"),
  truncated: z.boolean().describe(
    "Whether more pipelines exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const LabelSchema = z.object({
  name: z.string().describe("Label name"),
  color: z.string().describe("Label color"),
  description: z.string().nullable().describe("Label description"),
});

const LabelListSchema = z.object({
  project: z.string().describe("Project the labels belong to"),
  labels: z.array(LabelSchema).describe("Labels defined on the project"),
  count: z.number().describe("Number of labels returned"),
  truncated: z.boolean().describe("Whether more labels exist beyond this page"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const MemberSchema = z.object({
  username: z.string().describe("Member's GitLab username"),
  name: z.string().describe("Member's display name"),
  accessLevel: z.number().describe(
    "GitLab access level (10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner)",
  ),
});

const MemberListSchema = z.object({
  project: z.string().describe("Project the members belong to"),
  members: z.array(MemberSchema).describe("Members of the project"),
  count: z.number().describe("Number of members returned"),
  truncated: z.boolean().describe(
    "Whether more members exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const BranchSchema = z.object({
  name: z.string().describe("Branch name"),
  protected: z.boolean().describe("Whether the branch is protected"),
  default: z.boolean().describe("Whether this is the project's default branch"),
});

const BranchListSchema = z.object({
  project: z.string().describe("Project the branches belong to"),
  branches: z.array(BranchSchema).describe("Branches on the project"),
  count: z.number().describe("Number of branches returned"),
  truncated: z.boolean().describe(
    "Whether more branches exist beyond this page",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const DashboardMRSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  // GitLab-flavored, cross-project unique reference (e.g. group/project!123).
  // Autolinks in GitLab markdown; unambiguous in cross-project lists. Optional
  // for read-back parity with dashboards written before this field existed.
  reference: z.string().optional().describe(
    "GitLab-flavored cross-project reference (e.g. group/project!123)",
  ),
  title: z.string().describe("Merge request title"),
  author: z.string().describe("Merge request author's username"),
  updatedAt: z.string().describe(
    "Timestamp the merge request was last updated",
  ),
  draft: z.boolean().describe("Whether the merge request is a draft"),
  labels: z.array(z.string()).describe("Labels applied to the merge request"),
  webUrl: z.string().describe("Web URL for the merge request"),
  commented: z.boolean().describe(
    "Whether the authenticated user has commented",
  ),
  approvedByMe: z.boolean().describe(
    "Whether the authenticated user has approved",
  ),
  myReviewState: z
    .enum(["pending", "reviewed", "approved", "unapproved"])
    .nullable()
    .describe("The authenticated user's review state, null if not a reviewer"),
  // Head pipeline status (success, failed, running, etc.) — null when no
  // pipeline exists. Optional for read-back parity with dashboards written
  // before this field existed.
  pipelineStatus: z.string().nullable().optional().describe(
    "Head pipeline status (success, failed, running, etc.), null when no pipeline exists",
  ),
});

const TodoSchema = z.object({
  id: z.string().describe("Todo gid"),
  action: z.string().describe(
    "What triggered the todo (e.g. mentioned, assigned)",
  ),
  body: z.string().describe("Todo body text"),
  targetType: z.string().describe(
    "Type of the target object (MERGEREQUEST, ISSUE, etc.)",
  ),
  targetUrl: z.string().describe("URL of the target object"),
  project: z.string().nullable().describe(
    "Display name of the project the todo belongs to",
  ),
  // Work-item iid parsed from targetUrl (null for targets without one).
  // Optional so dashboards written before this field existed still validate.
  iid: z.number().nullable().optional().describe(
    "Work-item iid parsed from targetUrl, null for targets without one",
  ),
  // GitLab-flavored, cross-project unique reference derived from targetUrl:
  // group/project!123 for MRs, group/project#123 for issues (null otherwise).
  reference: z.string().nullable().optional().describe(
    "GitLab-flavored cross-project reference derived from targetUrl",
  ),
  // Target's lifecycle state (opened/closed/merged) for MR/issue targets, null
  // otherwise. Hoisted so "is this todo stale" is a flat CEL filter. Only
  // list_todos populates it; the capped dashboard leaves it null. Optional so
  // dashboards written before this field existed still validate.
  targetState: z.string().nullable().optional().describe(
    "Target's lifecycle state (opened/closed/merged), null when unavailable",
  ),
  author: z.string().describe("Username who triggered the todo"),
  createdAt: z.string().describe("Timestamp the todo was created"),
});

const DashboardSchema = z.object({
  username: z.string().describe("Authenticated user's GitLab username"),
  reviewing: z.array(DashboardMRSchema).describe(
    "MRs where the user is a reviewer",
  ),
  assigned: z.array(DashboardMRSchema).describe("MRs assigned to the user"),
  authored: z.array(DashboardMRSchema).describe("MRs authored by the user"),
  todos: z.array(TodoSchema).describe("Pending todos, capped at 20"),
  totalCount: z.number().describe("Total items across all dashboard sections"),
  truncated: z.boolean().describe("Whether any section hit its page cap"),
  fetchedAt: z.string().describe("Timestamp the dashboard was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const TodoListSchema = z.object({
  // All pending (or requested-state) todos for the authenticated user, fetched
  // across every page — unlike the dashboard, which caps todos at 20. Each
  // carries a hoisted `targetState`, so stale todos are a flat CEL filter:
  // `todos.filter(t, t.targetState in ["merged", "closed"])`.
  todos: z.array(TodoSchema).describe(
    "All todos for the authenticated user matching the requested state, across every page",
  ),
  count: z.number().describe("Number of todos returned"),
  // True when the safety cap (maxTodos) was hit before all pages were read.
  truncated: z.boolean().describe(
    "Whether the safety cap (maxTodos) was hit before all pages were read",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const BulkTodoResultSchema = z.object({
  // Todos confirmed done — todoMarkDone returned a non-null payload with no
  // errors. Anything unconfirmable (null payload, errors) goes to `failed`.
  results: z.array(z.object({
    id: z.string().describe("Todo id"),
    state: z.string().describe("Resulting todo state"),
  })).describe("Todos confirmed marked done"),
  // Per-todo failures; one bad id never sinks the batch.
  failed: z.array(z.object({
    id: z.string().describe("Todo id"),
    error: z.string().describe("Why the todo could not be confirmed done"),
  })).describe("Per-todo failures; one bad id never sinks the batch"),
  // Total ids submitted (results.length + failed.length).
  count: z.number().describe(
    "Total ids submitted (results.length + failed.length)",
  ),
  fetchedAt: z.string().describe("Timestamp the batch was executed"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const MergeStatusSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  title: z.string().describe("Merge request title"),
  state: z.string().describe("Merge request state"),
  draft: z.boolean().describe("Whether the merge request is a draft"),
  sourceBranch: z.string().nullable().describe("Source branch"),
  targetBranch: z.string().nullable().describe("Target branch"),
  webUrl: z.string().nullable().describe("Web URL for the merge request"),
  mergeable: z.boolean().nullable().describe(
    "Whether the merge request can currently merge",
  ),
  // GitLab's detailed_merge_status enum, e.g. mergeable, need_rebase, conflict,
  // ci_must_pass, not_approved, discussions_not_resolved, draft_status.
  detailedMergeStatus: z.string().nullable().describe(
    "GitLab's detailed_merge_status enum (e.g. mergeable, need_rebase, conflict)",
  ),
  conflicts: z.boolean().nullable().describe(
    "Whether there are merge conflicts",
  ),
  headPipelineStatus: z.string().nullable().describe(
    "Status of the head pipeline",
  ),
  // Head pipeline id — feed to get_pipeline_jobs to drill into CI failures.
  headPipelineId: z.number().nullable().describe(
    "Head pipeline id — feed to get_pipeline_jobs to drill into CI failures",
  ),
  // Human-readable reasons the MR cannot merge (empty when mergeable).
  blockers: z.array(z.string()).describe(
    "Human-readable reasons the MR cannot merge (empty when mergeable)",
  ),
  summary: z.string().describe("Plain-English summary of mergeability"),
  fetchedAt: z.string().describe("Timestamp the status was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const PipelineJobSchema = z.object({
  id: z.number().describe("Job ID"),
  name: z.string().describe("Job name"),
  stage: z.string().describe("Pipeline stage the job belongs to"),
  status: z.string().describe("Current job status"),
  // GitLab failure_reason: script_failure (real/code) vs runner_system_failure,
  // stuck_or_timeout_failure, job_execution_timeout, api_failure (transient).
  failureReason: z.string().nullable().describe(
    "GitLab failure_reason (script_failure is a real/code failure; " +
      "runner_system_failure, stuck_or_timeout_failure, job_execution_timeout, " +
      "api_failure are transient)",
  ),
  allowFailure: z.boolean().describe(
    "Whether the job is allowed to fail without blocking the pipeline",
  ),
  webUrl: z.string().nullable().describe("Web URL for the job"),
});

const PipelineJobsSchema = z.object({
  project: z.string().describe("Project the pipeline belongs to"),
  pipelineId: z.number().describe("Pipeline ID"),
  scope: z.string().nullable().describe(
    "Status scope filter applied to the query",
  ),
  jobs: z.array(PipelineJobSchema).describe("Jobs matching the scope filter"),
  count: z.number().describe("Number of jobs returned"),
  // true when the pipeline has more jobs than one page (100) returned.
  truncated: z.boolean().describe(
    "True when the pipeline has more jobs than one page (100) returned",
  ),
  fetchedAt: z.string().describe("Timestamp the jobs were fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const JobLogSchema = z.object({
  project: z.string().describe("Project the job belongs to"),
  jobId: z.number().describe("Job ID"),
  totalLines: z.number().describe("Total lines in the full job trace"),
  returnedLines: z.number().describe("Number of lines returned (the tail)"),
  truncated: z.boolean().describe(
    "Whether the returned tail is shorter than the full trace",
  ),
  // Tail of the job trace. Common credential patterns are redacted, but CI logs
  // can still leak secrets — treat as sensitive.
  log: z.string().describe(
    "Tail of the job trace. Common credential patterns are redacted, but " +
      "treat as sensitive — CI logs can still leak secrets",
  ),
  fetchedAt: z.string().describe("Timestamp the log was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const RetryResultSchema = z.object({
  project: z.string().describe("Project the job/pipeline belongs to"),
  kind: z.enum(["job", "pipeline"]).describe(
    "Whether a job or a pipeline was retried",
  ),
  // The id retried (job id or pipeline id).
  id: z.number().describe("The id retried (job id or pipeline id)"),
  // For job retries, the id of the new job GitLab created.
  newJobId: z.number().nullable().describe(
    "For job retries, the id of the new job GitLab created; null for pipeline retries",
  ),
  status: z.string().describe("Resulting status after the retry"),
  fetchedAt: z.string().describe("Timestamp the retry was triggered"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const RebaseResultSchema = z.object({
  project: z.string().describe("Project the merge request belongs to"),
  iid: z.number().describe("Merge request internal ID"),
  // "rebased" (finished clean), "error" (see mergeError), or "in_progress"
  // (still running when polling gave up — re-check with get_merge_request).
  status: z.enum(["rebased", "error", "in_progress"]).describe(
    "Rebase outcome: rebased (finished clean), error (see mergeError), or " +
      "in_progress (still running when polling gave up)",
  ),
  mergeError: z.string().nullable().describe(
    "Error message if the rebase failed",
  ),
  fetchedAt: z.string().describe("Timestamp the rebase was triggered"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

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

const DASHBOARD_QUERY = `
query dashboard($mrState: MergeRequestState, $perPage: Int!, $includeArchived: Boolean) {
  currentUser {
    username
    reviewRequestedMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } headPipeline { status } }
      pageInfo { hasNextPage }
    }
    assignedMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } headPipeline { status } }
      pageInfo { hasNextPage }
    }
    authoredMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } headPipeline { status } }
      pageInfo { hasNextPage }
    }
    todos(state: pending, first: 20) {
      nodes { id action body targetType targetUrl createdAt author { username } project { fullPath nameWithNamespace } }
      pageInfo { hasNextPage }
    }
  }
}`;

// Paginated, state-aware todos. Unlike DASHBOARD_QUERY (first: 20, no target),
// this pulls the target's lifecycle state via inline fragments so callers can
// classify stale todos without a per-item MR/issue fetch.
const LIST_TODOS_QUERY = `
query listTodos($state: [TodoStateEnum!], $first: Int!, $after: String) {
  currentUser {
    username
    todos(state: $state, first: $first, after: $after) {
      nodes {
        id action body targetType targetUrl createdAt
        author { username } project { fullPath nameWithNamespace }
        target {
          __typename
          ... on MergeRequest { state }
          ... on Issue { state }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function mapDashboardMR(
  node: any,
  currentUser?: string,
): z.infer<typeof DashboardMRSchema> {
  const noteAuthors: string[] =
    node.notes?.nodes?.map((n: any) => n.author?.username).filter(Boolean) ??
      [];
  const approvers: string[] =
    node.approvedBy?.nodes?.map((a: any) => a.username).filter(Boolean) ?? [];
  const myReviewer = currentUser
    ? (node.reviewers?.nodes ?? []).find(
      (r: any) => r.username === currentUser,
    )
    : null;
  const rawState: string | null =
    myReviewer?.mergeRequestInteraction?.reviewState ?? null;
  const STATE_MAP: Record<
    string,
    "pending" | "reviewed" | "approved" | "unapproved"
  > = {
    "unreviewed": "pending",
    "reviewed": "reviewed",
    "approved": "approved",
    "requested_changes": "unapproved",
  };
  const normalized = rawState?.toLowerCase() ?? null;
  const myReviewState = normalized ? (STATE_MAP[normalized] ?? null) : null;
  const project = node.project?.fullPath ?? "";
  const iid = typeof node.iid === "string" ? parseInt(node.iid, 10) : node.iid;
  return {
    project,
    iid,
    // Omit rather than emit a malformed reference when the project path is
    // absent or the iid isn't a valid integer (e.g. GraphQL returned null).
    reference: project && Number.isInteger(iid)
      ? `${project}!${iid}`
      : undefined,
    title: node.title ?? "",
    author: node.author?.username ?? "",
    updatedAt: node.updatedAt ?? "",
    draft: node.draft ?? false,
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
    webUrl: node.webUrl ?? "",
    commented: currentUser ? noteAuthors.includes(currentUser) : false,
    approvedByMe: currentUser ? approvers.includes(currentUser) : false,
    myReviewState,
    pipelineStatus: node.headPipeline?.status
      ? String(node.headPipeline.status).toLowerCase()
      : null,
  };
}

// Parse the work-item iid from a GitLab MR/issue targetUrl. Only the
// `/-/(merge_requests|issues)/<iid>` tail is matched, so this is robust to
// subpath installs, nested subgroups, and trailing URL segments.
function iidFromTargetUrl(url: string): number | null {
  const m = url.match(/\/-\/(?:merge_requests|issues)\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function mapTodo(node: any): z.infer<typeof TodoSchema> {
  // Build the reference from the authoritative project path (GraphQL fullPath),
  // the target type (MR → `!`, issue → `#`), and the iid parsed from the URL.
  // The todo's own `project` display field is a name, not a path, so it is kept
  // only for display and never used to form a reference.
  const fullPath: string | null = node.project?.fullPath ?? null;
  const iid = iidFromTargetUrl(node.targetUrl ?? "");
  const sep = node.targetType === "MERGEREQUEST"
    ? "!"
    : node.targetType === "ISSUE"
    ? "#"
    : null;
  const reference = fullPath && iid !== null && sep
    ? `${fullPath}${sep}${iid}`
    : null;
  return {
    id: node.id ?? "",
    action: node.action ?? "",
    body: node.body ?? "",
    targetType: node.targetType ?? "",
    targetUrl: node.targetUrl ?? "",
    project: node.project?.nameWithNamespace ?? null,
    iid,
    reference,
    // node.target is only present in the list_todos query (MR/Issue inline
    // fragments). The dashboard query omits it, so this is null there.
    targetState: node.target?.state
      ? String(node.target.state).toLowerCase()
      : null,
    author: node.author?.username ?? "",
    createdAt: node.createdAt ?? "",
  };
}

// =============================================================================
// GraphQL Queries
// =============================================================================

const PROJECTS_QUERY = `
query projects($first: Int!) {
  projects(membership: true, first: $first, sort: "latest_activity_desc") {
    nodes {
      name fullPath description visibility starCount forksCount
      lastActivityAt archived topics
      repository { rootRef }
    }
    pageInfo { hasNextPage }
  }
}`;

const PROJECT_INFO_QUERY = `
query projectInfo($fullPath: ID!) {
  project(fullPath: $fullPath) {
    name fullPath description visibility starCount forksCount
    archived topics webUrl createdAt lastActivityAt
    openIssuesCount
    repository { rootRef }
  }
}`;

const MERGE_REQUESTS_QUERY = `
query mergeRequests($fullPath: ID!, $state: MergeRequestState, $first: Int!) {
  project(fullPath: $fullPath) {
    mergeRequests(state: $state, first: $first, sort: UPDATED_DESC) {
      nodes {
        iid title state draft createdAt updatedAt mergedAt
        sourceBranch targetBranch
        author { username }
        approvedBy { nodes { username } }
        labels { nodes { title } }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

const ISSUES_QUERY = `
query issues($fullPath: ID!, $state: IssuableState, $first: Int!) {
  project(fullPath: $fullPath) {
    issues(state: $state, first: $first, sort: UPDATED_DESC) {
      nodes {
        iid title state createdAt updatedAt
        author { username }
        labels { nodes { title } }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

const RELEASES_QUERY = `
query releases($fullPath: ID!, $first: Int!) {
  project(fullPath: $fullPath) {
    releases(first: $first, sort: RELEASED_AT_DESC) {
      nodes { tagName name createdAt releasedAt upcomingRelease }
      pageInfo { hasNextPage }
    }
  }
}`;

const PIPELINES_QUERY = `
query pipelines($fullPath: ID!, $first: Int!) {
  project(fullPath: $fullPath) {
    pipelines(first: $first) {
      nodes { iid status source ref createdAt updatedAt }
      pageInfo { hasNextPage }
    }
  }
}`;

const ISSUE_NOTES_QUERY = `
query issueNotes($fullPath: ID!, $iid: String!, $first: Int!) {
  project(fullPath: $fullPath) {
    issue(iid: $iid) {
      notes(first: $first) {
        nodes { id body createdAt author { username } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const GET_ISSUE_QUERY = `
query getIssue($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    issue(iid: $iid) {
      iid title description state webUrl
      labels { nodes { title } }
      createdAt updatedAt
    }
  }
}`;

const MR_NOTES_QUERY = `
query mrNotes($fullPath: ID!, $iid: String!, $last: Int!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      notes(last: $last) {
        nodes { id body createdAt author { username } }
        pageInfo { hasPreviousPage }
      }
    }
  }
}`;

const MARK_TODO_DONE_MUTATION = `
mutation todoMarkDone($id: TodoID!) {
  todoMarkDone(input: { id: $id }) {
    todo { id state }
    errors
  }
}`;

const MR_STATUS_QUERY = `
query mrStatus($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      iid title state draft
      sourceBranch targetBranch webUrl
      detailedMergeStatus
      mergeable
      conflicts
      headPipeline { id status }
    }
  }
}`;

/**
 * Plain-English reasons keyed by GitLab's detailed_merge_status (GraphQL returns
 * the enum upper-cased). Unlisted values fall back to a humanized form.
 */
const MERGE_STATUS_EXPLANATION: Record<string, string> = {
  MERGEABLE: "ready to merge",
  NEED_REBASE: "the source branch is behind the target and must be rebased",
  CONFLICT: "there are merge conflicts with the target branch",
  CI_MUST_PASS: "a required CI/CD pipeline must succeed first",
  CI_STILL_RUNNING: "the CI/CD pipeline is still running",
  DRAFT_STATUS: "the merge request is marked as a draft",
  NOT_APPROVED: "required approvals are missing",
  DISCUSSIONS_NOT_RESOLVED: "there are unresolved discussions",
  NOT_OPEN: "the merge request is not open",
  BLOCKED_STATUS: "it is blocked by another merge request",
  EXTERNAL_STATUS_CHECKS: "external status checks must pass",
  REQUESTED_CHANGES: "changes were requested in review",
  CHECKING: "GitLab is still checking mergeability — try again shortly",
  UNCHECKED: "mergeability has not been checked yet",
  PREPARING: "GitLab is still preparing the merge request",
};

/** Max status polls for a triggered rebase before reporting it still in progress. */
const REBASE_MAX_POLLS = 15;

/**
 * Delay between rebase status polls, in ms. Env-overridable so tests can run the
 * loop fast; defaults to 2s and falls back safely if env access is denied.
 */
function rebasePollMs(): number {
  try {
    const v = Number(Deno.env.get("SWAMP_GITLAB_REBASE_POLL_MS"));
    return Number.isFinite(v) && v > 0 ? v : 2000;
  } catch {
    return 2000;
  }
}

const LABELS_QUERY = `
query labels($fullPath: ID!, $first: Int!) {
  project(fullPath: $fullPath) {
    labels(first: $first) {
      nodes { title color description }
      pageInfo { hasNextPage }
    }
  }
}`;

const MEMBERS_QUERY = `
query members($fullPath: ID!, $first: Int!) {
  project(fullPath: $fullPath) {
    projectMembers(first: $first) {
      nodes { user { username name } accessLevel { integerValue } }
      pageInfo { hasNextPage }
    }
  }
}`;

const CREATE_ISSUE_MUTATION = `
mutation createIssue($projectPath: ID!, $title: String!, $description: String, $labels: [String!]) {
  createIssue(input: { projectPath: $projectPath, title: $title, description: $description, labels: $labels }) {
    issue { iid title description state webUrl labels { nodes { title } } createdAt updatedAt }
    errors
  }
}`;

const CREATE_NOTE_MUTATION = `
mutation createNote($noteableId: NoteableID!, $body: String!) {
  createNote(input: { noteableId: $noteableId, body: $body }) {
    note { id body createdAt author { username } }
    errors
  }
}`;

// Reply into an existing thread. Separate from CREATE_NOTE_MUTATION so the
// top-level path (also used by add_issue_note) is untouched.
const REPLY_NOTE_MUTATION = `
mutation replyNote($noteableId: NoteableID!, $discussionId: DiscussionID!, $body: String!) {
  createNote(input: { noteableId: $noteableId, discussionId: $discussionId, body: $body }) {
    note { id body createdAt author { username } }
    errors
  }
}`;

const RESOLVE_DISCUSSION_MUTATION = `
mutation resolveDiscussion($id: DiscussionID!, $resolve: Boolean!) {
  discussionToggleResolve(input: { id: $id, resolve: $resolve }) {
    discussion { id resolved resolvedBy { username } }
    errors
  }
}`;

const MR_DISCUSSIONS_QUERY = `
query mrDiscussions($fullPath: ID!, $iid: String!, $first: Int!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      discussions(first: $first) {
        nodes {
          id
          resolvable
          resolved
          resolvedBy { username }
          notes(first: 100) {
            nodes {
              id system body createdAt author { username }
              position { filePath oldLine newLine }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const UPDATE_NOTE_MUTATION = `
mutation updateNote($id: NoteID!, $body: String!) {
  updateNote(input: { id: $id, body: $body }) {
    note { id body createdAt author { username } }
    errors
  }
}`;

const DESTROY_NOTE_MUTATION = `
mutation destroyNote($id: NoteID!) {
  destroyNote(input: { id: $id }) {
    note { id }
    errors
  }
}`;

// operationMode REPLACE sets the full assignee set: [] unassigns, one username
// assigns one (all GitLab CE supports), multiple assigns many (EE/Premium).
const SET_ASSIGNEES_MUTATION = `
mutation setAssignees($projectPath: ID!, $iid: String!, $usernames: [String!]!) {
  mergeRequestSetAssignees(input: { projectPath: $projectPath, iid: $iid, assigneeUsernames: $usernames, operationMode: REPLACE }) {
    mergeRequest { iid assignees { nodes { username } } }
    errors
  }
}`;

// operationMode REMOVE drops the given usernames and leaves every other
// assignee in place — atomic, no read-modify-write, so no race and no risk of
// clobbering a co-assignee. Removing a user who isn't assigned is a no-op.
const REMOVE_ASSIGNEES_MUTATION = `
mutation removeAssignees($projectPath: ID!, $iid: String!, $usernames: [String!]!) {
  mergeRequestSetAssignees(input: { projectPath: $projectPath, iid: $iid, assigneeUsernames: $usernames, operationMode: REMOVE }) {
    mergeRequest { iid assignees { nodes { username } } }
    errors
  }
}`;

const REMOVE_REVIEWERS_MUTATION = `
mutation removeReviewers($projectPath: ID!, $iid: String!, $usernames: [String!]!) {
  mergeRequestSetReviewers(input: { projectPath: $projectPath, iid: $iid, reviewerUsernames: $usernames, operationMode: REMOVE }) {
    mergeRequest { iid reviewers { nodes { username } } }
    errors
  }
}`;

const SET_REVIEWERS_MUTATION = `
mutation setReviewers($projectPath: ID!, $iid: String!, $usernames: [String!]!) {
  mergeRequestSetReviewers(input: { projectPath: $projectPath, iid: $iid, reviewerUsernames: $usernames, operationMode: REPLACE }) {
    mergeRequest { iid reviewers { nodes { username } } }
    errors
  }
}`;

const CURRENT_USER_QUERY = `
query { currentUser { username } }`;

const CREATE_MR_MUTATION = `
mutation createMR($projectPath: ID!, $title: String!, $sourceBranch: String!, $targetBranch: String!, $description: String) {
  mergeRequestCreate(input: { projectPath: $projectPath, title: $title, sourceBranch: $sourceBranch, targetBranch: $targetBranch, description: $description }) {
    mergeRequest { iid title state draft createdAt updatedAt sourceBranch targetBranch author { username } labels { nodes { title } } }
    errors
  }
}`;

const LABEL_CREATE_MUTATION = `
mutation labelCreate($projectPath: ID!, $title: String!, $color: String!, $description: String) {
  labelCreate(input: { projectPath: $projectPath, title: $title, color: $color, description: $description }) {
    label { title color description }
    errors
  }
}`;

// Helpers for extracting GraphQL global IDs
const ISSUE_ID_QUERY = `
query issueId($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) { issue(iid: $iid) { id } }
}`;

const MR_ID_QUERY = `
query mrId($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) { mergeRequest(iid: $iid) { id } }
}`;

// =============================================================================
// GraphQL Mappers
// =============================================================================

function gqlMapProject(node: any): z.infer<typeof ProjectSchema> {
  return {
    name: node.name ?? "",
    pathWithNamespace: node.fullPath ?? "",
    description: node.description ?? null,
    visibility: node.visibility ?? "private",
    starCount: node.starCount ?? 0,
    forksCount: node.forksCount ?? 0,
    lastActivityAt: node.lastActivityAt ?? "",
    defaultBranch: node.repository?.rootRef ?? null,
    archived: node.archived ?? false,
    topics: node.topics ?? [],
  };
}

function gqlMapMR(node: any): z.infer<typeof MergeRequestSchema> {
  return {
    iid: typeof node.iid === "string" ? parseInt(node.iid, 10) : node.iid,
    title: node.title ?? "",
    state: node.state ?? "",
    author: node.author ? { username: node.author.username } : null,
    sourceBranch: node.sourceBranch ?? "",
    targetBranch: node.targetBranch ?? "",
    draft: node.draft ?? false,
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    mergedAt: node.mergedAt ?? null,
    approvers: node.approvedBy?.nodes?.map((a: any) => a?.username).filter(
      Boolean,
    ) ?? [],
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
  };
}

function gqlMapIssue(node: any): z.infer<typeof IssueSchema> {
  return {
    iid: typeof node.iid === "string" ? parseInt(node.iid, 10) : node.iid,
    title: node.title ?? "",
    state: node.state ?? "",
    author: node.author ? { username: node.author.username } : null,
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
  };
}

// Maps a GraphQL issue node into the issueDetail shape. Unlike gqlMapIssue,
// this includes description and webUrl, matching the fields selected by
// GET_ISSUE_QUERY and the create/update issue mutations.
function gqlMapIssueDetail(
  node: any,
  project: string,
): Omit<
  z.infer<typeof IssueDetailSchema>,
  "fetchedAt" | "durationMs" | "collectedBy"
> {
  return {
    project,
    iid: typeof node.iid === "string" ? parseInt(node.iid, 10) : node.iid,
    title: node.title ?? "",
    description: node.description ?? "",
    state: node.state ?? "",
    webUrl: node.webUrl ?? "",
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
  };
}

function gqlMapNote(node: any): z.infer<typeof NoteSchema> {
  const rawId = node.id ?? "";
  // Extract numeric ID from gid://gitlab/Note/123
  const numId = typeof rawId === "string"
    ? parseInt(rawId.split("/").pop() ?? "0", 10)
    : rawId;
  return {
    id: numId,
    body: node.body ?? "",
    author: node.author ? { username: node.author.username } : null,
    createdAt: node.createdAt ?? "",
  };
}

// =============================================================================
// REST API Client (kept for merge accept + branches which lack GraphQL)
// =============================================================================

/** Response from a list endpoint including pagination state. */
interface ListResponse {
  data: any;
  truncated: boolean;
}

class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(host: string, token: string) {
    this.baseUrl = `https://${host}/api/v4`;
    this.token = token;
  }

  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" };
  }

  private projectUrl(project: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(project)}`;
  }

  /** GET a list scoped to a project, returning data + truncation flag. */
  async getProjectList(
    project: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<ListResponse> {
    const url = new URL(`${this.projectUrl(project)}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `GitLab GET ${project}${path}: ${resp.status} ${body}`,
      );
    }
    const nextPage = resp.headers.get("x-next-page");
    return {
      data: await resp.json(),
      truncated: !!nextPage && nextPage !== "",
    };
  }

  async put(
    project: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const resp = await fetch(`${this.projectUrl(project)}${path}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab PUT ${project}${path}: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  async post(
    project: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<any> {
    const resp = await fetch(`${this.projectUrl(project)}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab POST ${project}${path}: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  /** GET a project endpoint returning raw text (e.g. a job trace, not JSON). */
  async getProjectText(project: string, path: string): Promise<string> {
    const resp = await fetch(`${this.projectUrl(project)}${path}`, {
      headers: this.headers(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab GET ${project}${path}: ${resp.status} ${text}`);
    }
    return resp.text();
  }
}

// =============================================================================
// REST Mappers (kept for merge method which uses REST)
// =============================================================================

function mapMR(raw: any): z.infer<typeof MergeRequestSchema> {
  return {
    iid: raw.iid,
    title: raw.title ?? "",
    state: raw.state ?? "",
    author: raw.author ? { username: raw.author.username } : null,
    sourceBranch: raw.source_branch ?? "",
    targetBranch: raw.target_branch ?? "",
    draft: raw.draft ?? false,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    mergedAt: raw.merged_at ?? null,
    approvers: Array.isArray(raw.approvers) ? raw.approvers : [],
    labels: raw.labels ?? [],
  };
}

function sanitizeName(project: string): string {
  return project.replace(/\//g, "~");
}

/**
 * Best-effort redaction of common credential patterns from CI log text before
 * it is persisted. Not exhaustive — CI logs can still leak secrets — but masks
 * the obvious ones (GitLab/GitHub tokens, AWS keys, bearer tokens, URL creds,
 * and token/password assignments).
 */
function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(glpat|glptt|gldt|gloas|github_pat|ghp|gho|ghs|ghr)-[A-Za-z0-9_-]{16,}/g,
      "$1-[REDACTED]",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(/\b(sk-ant-[A-Za-z0-9-]{6})[A-Za-z0-9_-]{12,}/g, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]")
    .replace(/(\/\/[^:@/\s]+:)[^@/\s]+@/g, "$1[REDACTED]@")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|private[_-]?token)["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi,
      "$1[REDACTED]",
    );
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: { host: string; token: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
};

// =============================================================================
// Model Definition
// =============================================================================

/** GitLab model — read and write projects, issues, MRs, pipelines via GraphQL API (REST fallback for branches and merge accept). */
export const model = {
  type: "@webframp/gitlab",
  version: "2026.09.02.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.30.1",
      description:
        "Add sourceBranch, targetBranch, webUrl to mergeStatus resource",
      upgradeAttributes: (old: Record<string, unknown>) => ({
        ...old,
        sourceBranch: null,
        targetBranch: null,
        webUrl: null,
      }),
    },
    {
      toVersion: "2026.08.12.1",
      description:
        "Add pipelineStatus to dashboard MR entries (null for older data)",
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
        "No schema changes (GraphQL malformed-JSON responses now raise a clear error)",
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
    {
      toVersion: "2026.08.28.1",
      description:
        "No schema changes — normalized license to Apache-2.0 and corrected copyright holder to Sean Escriva",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.01.1",
      description:
        "Added optional nullable mergedAt and approvers[] fields to merge " +
        "requests, and a new list_commits method (commits resource). All " +
        "additive — previously-stored MR lists validate on read via the " +
        "field defaults.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: ["@webframp/review-dashboard"],

  resources: {
    projects: {
      description: "List of projects for the authenticated user",
      schema: ProjectListSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    projectInfo: {
      description: "Detailed information about a specific project",
      schema: ProjectInfoSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    mergeRequests: {
      description: "List of merge requests for a project",
      schema: MergeRequestListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    commits: {
      description: "List of commits for a project",
      schema: CommitListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    issues: {
      description: "List of issues for a project",
      schema: IssueListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    issueDetail: {
      description: "Single issue detail (from create/update)",
      schema: IssueDetailSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    notes: {
      description: "Notes/comments on an issue or MR",
      schema: NoteListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    discussions: {
      description:
        "Resolvable discussion threads on an MR, with per-thread resolution state and slim diff position",
      schema: DiscussionListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    discussionResolution: {
      description: "Outcome of resolving/unresolving an MR discussion",
      schema: DiscussionResolutionSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    mergeStatus: {
      description:
        "Mergeability of an MR — detailed_merge_status plus human-readable blockers",
      schema: MergeStatusSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    rebaseResult: {
      description: "Outcome of a triggered MR rebase",
      schema: RebaseResultSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    pipelineJobs: {
      description: "Jobs in a pipeline (with failure_reason), for CI diagnosis",
      schema: PipelineJobsSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    jobLog: {
      description: "Tail of a CI job's trace/log",
      schema: JobLogSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    retryResult: {
      description: "Outcome of a triggered job/pipeline retry",
      schema: RetryResultSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    noteDeleted: {
      description: "Record of a deleted MR note",
      schema: NoteDeletedSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    unassignResult: {
      description:
        "Result of a fan-out unassign across MRs (remaining assignees + failures)",
      schema: UnassignResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    reviewerRemovalResult: {
      description:
        "Result of a fan-out reviewer removal across MRs (remaining reviewers + failures)",
      schema: RemoveReviewerResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    mrAssignees: {
      description: "Assignees of an MR after a set/unassign",
      schema: MrAssigneesSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    mrReviewers: {
      description: "Reviewers of an MR after a set/clear",
      schema: MrReviewersSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    releases: {
      description: "List of releases for a project",
      schema: ReleaseListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    pipelines: {
      description: "List of recent CI/CD pipelines",
      schema: PipelineListSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
    labels: {
      description: "Labels for a project",
      schema: LabelListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    members: {
      description: "Members of a project",
      schema: MemberListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    branches: {
      description: "Branches for a project",
      schema: BranchListSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    dashboard: {
      description:
        "Cross-project MR dashboard and todos for the authenticated user",
      schema: DashboardSchema,
      lifetime: "30m" as const,
      garbageCollection: 3,
    },
    todoList: {
      description:
        "All todos for the authenticated user (paginated past the dashboard's " +
        "20-cap), each with a hoisted target lifecycle state",
      schema: TodoListSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    bulkTodoResult: {
      description:
        "Result of a bulk mark-todos-done (confirmed done + per-todo failures)",
      schema: BulkTodoResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_projects: {
      description:
        "List projects for the authenticated user with basic metadata",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, PROJECTS_QUERY, {
          first: 30,
        });
        const nodes = data.projects?.nodes ?? [];
        const projects = nodes.map(gqlMapProject);
        const truncated = data.projects?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource("projects", "all", {
          projects,
          count: projects.length,
          truncated,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        ctx.logger.info("Found {count} projects", { count: projects.length });
        return { dataHandles: [handle] };
      },
    },

    get_project_info: {
      description: "Get detailed information about a specific project",
      arguments: z.object({
        project: z.string().min(1).describe(
          "Project path (e.g. mygroup/myproject)",
        ),
      }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, PROJECT_INFO_QUERY, {
          fullPath: args.project,
        });
        const p = data.project;
        if (!p) throw new Error(`Project not found: ${args.project}`);
        const info = {
          name: p.name ?? "",
          pathWithNamespace: p.fullPath ?? "",
          description: p.description ?? null,
          visibility: p.visibility ?? "private",
          defaultBranch: p.repository?.rootRef ?? null,
          starCount: p.starCount ?? 0,
          forksCount: p.forksCount ?? 0,
          openIssuesCount: p.openIssuesCount ?? 0,
          archived: p.archived ?? false,
          topics: p.topics ?? [],
          webUrl: p.webUrl ?? "",
          createdAt: p.createdAt ?? "",
          lastActivityAt: p.lastActivityAt ?? "",
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "projectInfo",
          sanitizeName(args.project),
          {
            ...info,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Fetched info for {project}", {
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_merge_requests: {
      description:
        "List merge requests for a project with optional state filter",
      arguments: z.object({
        project: z.string().min(1),
        state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
      }),
      execute: async (
        args: { project: string; state: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, MERGE_REQUESTS_QUERY, {
          fullPath: args.project,
          state: args.state === "all" ? undefined : args.state,
          first: 20,
        });
        const conn = data.project?.mergeRequests;
        const mrs = (conn?.nodes ?? []).map(gqlMapMR);
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-${args.state}`,
          {
            project: args.project,
            mergeRequests: mrs,
            count: mrs.length,
            truncated,
            state: args.state,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} MRs for {project} ({state})", {
          count: mrs.length,
          project: args.project,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_commits: {
      description:
        "List commits for a project (optionally a branch), newest first. " +
        "Supports a `since` lower time bound for windowed collection. Uses " +
        "the REST repository/commits endpoint. Enables commit-based " +
        "cross-boundary attribution (who commits to another crew's repo).",
      arguments: z.object({
        project: z.string().min(1).describe(
          "Project path (group/repo) or numeric ID",
        ),
        ref: z.string().default("").describe(
          "Branch or ref to list from; empty uses the default branch",
        ),
        since: z.string().default("").describe(
          "Only commits after this ISO 8601 timestamp; empty = no lower bound",
        ),
        perPage: z.number().int().min(1).max(100).default(100).describe(
          "Page size (max 100)",
        ),
      }),
      execute: async (
        args: {
          project: string;
          ref: string;
          since: string;
          perPage: number;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const params: Record<string, string> = {
          per_page: String(args.perPage),
        };
        if (args.ref !== "") params.ref_name = args.ref;
        if (args.since !== "") params.since = args.since;
        const { data, truncated } = await client.getProjectList(
          args.project,
          `/repository/commits`,
          params,
        );
        const raw = Array.isArray(data) ? data : [];
        const commits = raw.map((c: any) => ({
          id: c.id ?? "",
          shortId: c.short_id ?? "",
          title: c.title ?? "",
          authorName: c.author_name ?? "",
          authorEmail: c.author_email ?? "",
          committedDate: c.committed_date ?? "",
          webUrl: c.web_url ?? "",
        }));
        const handle = await ctx.writeResource(
          "commits",
          // Include the ref so collecting commits from different branches of
          // the same project does not clobber a single "<project>-commits"
          // instance. `since` is intentionally not in the key — a newer window
          // for the same (project, ref) legitimately supersedes the prior one.
          `${sanitizeName(args.project)}-${args.ref || "default"}-commits`,
          {
            project: args.project,
            ref: args.ref,
            commits,
            count: commits.length,
            truncated,
            since: args.since,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} commits for {project}", {
          count: commits.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_issues: {
      description: "List issues for a project with optional state filter",
      arguments: z.object({
        project: z.string().min(1),
        state: z.enum(["opened", "closed", "all"]).default("opened"),
      }),
      execute: async (
        args: { project: string; state: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, ISSUES_QUERY, {
          fullPath: args.project,
          state: args.state === "all" ? undefined : args.state,
          first: 20,
        });
        const conn = data.project?.issues;
        const issues = (conn?.nodes ?? []).map(gqlMapIssue);
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "issues",
          `${sanitizeName(args.project)}-${args.state}`,
          {
            project: args.project,
            issues,
            count: issues.length,
            truncated,
            state: args.state,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} issues for {project} ({state})", {
          count: issues.length,
          project: args.project,
          state: args.state,
        });
        return { dataHandles: [handle] };
      },
    },

    list_releases: {
      description: "List releases for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, RELEASES_QUERY, {
          fullPath: args.project,
          first: 10,
        });
        const conn = data.project?.releases;
        const releases = (conn?.nodes ?? []).map((n: any) => ({
          tagName: n.tagName ?? "",
          name: n.name ?? "",
          createdAt: n.createdAt ?? "",
          releasedAt: n.releasedAt ?? n.createdAt ?? "",
          upcoming: n.upcomingRelease ?? false,
        }));
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "releases",
          sanitizeName(args.project),
          {
            project: args.project,
            releases,
            count: releases.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} releases for {project}", {
          count: releases.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_pipelines: {
      description: "List recent CI/CD pipelines for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, PIPELINES_QUERY, {
          fullPath: args.project,
          first: 10,
        });
        const conn = data.project?.pipelines;
        const pipelines = (conn?.nodes ?? []).map((n: any) => ({
          iid: typeof n.iid === "string" ? parseInt(n.iid, 10) : (n.iid ?? 0),
          name: null,
          status: (n.status ?? "").toLowerCase(),
          source: (n.source ?? "").toLowerCase(),
          ref: n.ref ?? "",
          createdAt: n.createdAt ?? "",
          updatedAt: n.updatedAt ?? "",
        }));
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "pipelines",
          sanitizeName(args.project),
          {
            project: args.project,
            pipelines,
            count: pipelines.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} pipelines for {project}", {
          count: pipelines.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    get_issue: {
      description:
        "Get a single issue including its description body (for reading " +
        "work-item details). Returns issue detail keyed by project and iid.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, GET_ISSUE_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const issue = data.project?.issue;
        if (!issue) {
          throw new Error(
            `Issue #${args.iid} not found in ${args.project}`,
          );
        }
        const handle = await ctx.writeResource(
          "issueDetail",
          `${sanitizeName(args.project)}-${args.iid}`,
          {
            ...gqlMapIssueDetail(issue, args.project),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Fetched issue #{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    create_issue: {
      description: "Create a new issue in a project",
      arguments: z.object({
        project: z.string().min(1),
        title: z.string().min(1),
        description: z.string().default(""),
        labels: z.array(z.string()).default([]),
      }),
      execute: async (
        args: {
          project: string;
          title: string;
          description: string;
          labels: string[];
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, CREATE_ISSUE_MUTATION, {
          projectPath: args.project,
          title: args.title,
          description: args.description || undefined,
          labels: args.labels.length ? args.labels : undefined,
        });
        const result = data.createIssue;
        if (result.errors?.length) {
          throw new Error(`createIssue failed: ${result.errors.join("; ")}`);
        }
        const issue = result.issue;
        if (!issue) {
          throw new Error(
            `createIssue returned no issue (project: ${args.project})`,
          );
        }
        const handle = await ctx.writeResource(
          "issueDetail",
          `${sanitizeName(args.project)}-${issue.iid}`,
          {
            project: args.project,
            iid: typeof issue.iid === "string"
              ? parseInt(issue.iid, 10)
              : issue.iid,
            title: issue.title ?? "",
            description: issue.description ?? "",
            state: issue.state ?? "opened",
            webUrl: issue.webUrl ?? "",
            labels: issue.labels?.nodes?.map((l: any) => l.title) ?? [],
            createdAt: issue.createdAt ?? "",
            updatedAt: issue.updatedAt ?? "",
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Created issue #{iid} in {project}", {
          iid: issue.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    update_issue: {
      description:
        "Update an existing issue (title, description, labels, state)",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        stateEvent: z.enum(["close", "reopen"]).optional(),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          title?: string;
          description?: string;
          labels?: string[];
          stateEvent?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.description !== undefined) body.description = args.description;
        if (args.labels !== undefined) body.labels = args.labels.join(",");
        if (args.stateEvent !== undefined) body.state_event = args.stateEvent;
        const raw = await client.put(
          args.project,
          `/issues/${args.iid}`,
          body,
        );
        const handle = await ctx.writeResource(
          "issueDetail",
          `${sanitizeName(args.project)}-${raw.iid}`,
          {
            project: args.project,
            iid: raw.iid,
            title: raw.title ?? "",
            description: raw.description ?? "",
            state: raw.state ?? "opened",
            webUrl: raw.web_url ?? "",
            labels: raw.labels ?? [],
            createdAt: raw.created_at ?? "",
            updatedAt: raw.updated_at ?? "",
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            fetchedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Updated issue #{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    add_issue_note: {
      description: "Add a comment to an issue",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        body: z.string().min(1),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        // Resolve issue global ID
        const idData = await graphqlRequest(host, token, ISSUE_ID_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const issueGid = idData.project?.issue?.id;
        if (!issueGid) {
          throw new Error(`Issue #${args.iid} not found in ${args.project}`);
        }
        const data = await graphqlRequest(host, token, CREATE_NOTE_MUTATION, {
          noteableId: issueGid,
          body: args.body,
        });
        const result = data.createNote;
        if (result.errors?.length) {
          throw new Error(`createNote failed: ${result.errors.join("; ")}`);
        }
        if (!result.note) {
          throw new Error(
            `createNote returned no note (project: ${args.project}, iid: ${args.iid})`,
          );
        }
        const note = gqlMapNote(result.note);
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-issue-${args.iid}-note-${note.id}`,
          {
            project: args.project,
            noteableType: "issue",
            noteableIid: args.iid,
            notes: [note],
            count: 1,
            truncated: false,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Added note to issue #{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_issue_notes: {
      description: "List comments on an issue",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, ISSUE_NOTES_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
          first: 50,
        });
        const conn = data.project?.issue?.notes;
        const notes = (conn?.nodes ?? []).map(gqlMapNote);
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-issue-${args.iid}`,
          {
            project: args.project,
            noteableType: "issue",
            noteableIid: args.iid,
            notes,
            count: notes.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} notes on issue #{iid}", {
          count: notes.length,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    list_mr_notes: {
      description:
        "List the most recent comments/discussion notes on a merge request (newest 50; truncated=true when older notes exist)",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        // last:50 returns the most recent notes — what a reviewer/replier wants
        // — rather than first:50 (the oldest). truncated flags older history.
        const data = await graphqlRequest(host, token, MR_NOTES_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
          last: 50,
        });
        const conn = data.project?.mergeRequest?.notes;
        const notes = (conn?.nodes ?? []).map(gqlMapNote);
        const truncated = conn?.pageInfo?.hasPreviousPage ?? false;
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            noteableType: "merge_request",
            noteableIid: args.iid,
            notes,
            count: notes.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} notes on MR !{iid}", {
          count: notes.length,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    mark_todo_done: {
      description:
        "Mark a to-do as done so it drops off the pending list (todoMarkDone).",
      arguments: z.object({
        todoId: z.string().min(1).describe(
          "Todo ID — the gid (gid://gitlab/Todo/NNN) or the numeric id",
        ),
      }),
      execute: async (args: { todoId: string }, ctx: ModelContext) => {
        const { host, token } = ctx.globalArgs;
        const id = /^\d+$/.test(args.todoId)
          ? `gid://gitlab/Todo/${args.todoId}`
          : args.todoId;
        const data = await graphqlRequest(
          host,
          token,
          MARK_TODO_DONE_MUTATION,
          { id },
        );
        const errors = data.todoMarkDone?.errors ?? [];
        if (errors.length) {
          throw new Error(`mark_todo_done failed: ${errors.join("; ")}`);
        }
        ctx.logger.info("Marked todo done: {id} -> {state}", {
          id,
          state: data.todoMarkDone?.todo?.state ?? "unknown",
        });
        return { dataHandles: [] };
      },
    },

    list_todos: {
      description:
        "List the authenticated user's todos across ALL pages (the dashboard " +
        "caps todos at 20), each with a hoisted targetState " +
        "(opened/closed/merged for MR/issue targets, null otherwise) so stale " +
        "todos are a flat CEL filter. Writes a todoList resource.",
      arguments: z.object({
        state: z.enum(["pending", "done", "all"]).default("pending").describe(
          "Which todos to fetch (default pending)",
        ),
        maxTodos: z.number().int().positive().default(2000).describe(
          "Safety cap on total todos fetched across pages",
        ),
      }),
      execute: async (
        args: { state: "pending" | "done" | "all"; maxTodos: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        // GraphQL `state` is a list; "all" means both pending and done.
        const stateArg = args.state === "all"
          ? ["pending", "done"]
          : [args.state];
        const PAGE = 100;
        const todos: z.infer<typeof TodoSchema>[] = [];
        let after: string | null = null;
        let username = "";
        let truncated = false;
        let hasNext = true;
        while (hasNext) {
          const data = await graphqlRequest(host, token, LIST_TODOS_QUERY, {
            state: stateArg,
            first: PAGE,
            after,
          });
          const user = data.currentUser;
          if (!user) {
            throw new Error(
              "GitLab GraphQL: currentUser is null — verify the token has 'read_api' scope and is not expired",
            );
          }
          username = user.username ?? username;
          const conn = user.todos;
          const nodes = conn?.nodes ?? [];
          for (const node of nodes) {
            if (todos.length >= args.maxTodos) {
              // Unconsumed nodes remain on this page — genuinely capped.
              truncated = true;
              break;
            }
            todos.push(mapTodo(node));
          }
          if (truncated) break;
          const morePages = !!conn?.pageInfo?.hasNextPage;
          const nextCursor = conn?.pageInfo?.endCursor ?? null;
          if (todos.length >= args.maxTodos) {
            // Consumed the page and hit the cap exactly. Only truncated if
            // GitLab says more pages remain — not when this was the last page.
            truncated = morePages;
            break;
          }
          // Advance. Stop when there are no more pages, no cursor came back, or
          // the cursor didn't move (defensive against a spinning/empty page —
          // the cap can't bound a loop whose nodes never accumulate).
          hasNext = morePages && !!nextCursor && nextCursor !== after;
          after = nextCursor;
        }
        const handle = await ctx.writeResource(
          "todoList",
          `todos-${username || "user"}`,
          {
            todos,
            count: todos.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Fetched {count} todos for {user}{trunc}", {
          count: todos.length,
          user: username,
          trunc: truncated ? ` (capped at ${args.maxTodos})` : "",
        });
        return { dataHandles: [handle] };
      },
    },

    mark_todos_done: {
      description:
        "Mark MANY todos done in one call — one sequential GraphQL request per " +
        "todo (not parallel). Bulk companion to mark_todo_done. Accepts todo " +
        "gids or numeric ids; per-todo failures are recorded and never abort " +
        "the batch. Writes a bulkTodoResult resource.",
      arguments: z.object({
        todoIds: z.array(z.string().min(1)).min(1).describe(
          "Todo ids (gid://gitlab/Todo/NNN or numeric)",
        ),
      }),
      execute: async (args: { todoIds: string[] }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const results: z.infer<typeof BulkTodoResultSchema>["results"] = [];
        const failed: z.infer<typeof BulkTodoResultSchema>["failed"] = [];
        for (const raw of args.todoIds) {
          const id = /^\d+$/.test(raw) ? `gid://gitlab/Todo/${raw}` : raw;
          try {
            const data = await graphqlRequest(
              host,
              token,
              MARK_TODO_DONE_MUTATION,
              { id },
            );
            const payload = data.todoMarkDone;
            // GitLab returns a null payload on permission-denied / not-found as
            // a routine path — guard before reading .errors.
            if (!payload) {
              throw new Error(
                "todoMarkDone returned null (permission denied or todo not found)",
              );
            }
            if (payload.errors?.length) {
              throw new Error(payload.errors.join("; "));
            }
            // A null todo with empty errors is unconfirmable — don't fabricate
            // a "done" success (mirrors the loud-failure pattern of the sibling
            // assignee/reviewer removals, which never trust "no error" alone).
            if (!payload.todo) {
              throw new Error(
                "todoMarkDone returned no todo — completion unconfirmed",
              );
            }
            results.push({ id, state: payload.todo.state ?? "done" });
          } catch (e) {
            failed.push({
              id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        const handle = await ctx.writeResource(
          "bulkTodoResult",
          "todos-marked-done",
          {
            results,
            failed,
            count: args.todoIds.length,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Marked {ok}/{total} todos done ({failed} failed)", {
          ok: results.length,
          total: args.todoIds.length,
          failed: failed.length,
        });
        return { dataHandles: [handle] };
      },
    },

    create_merge_request: {
      description: "Create a new merge request",
      arguments: z.object({
        project: z.string().min(1),
        title: z.string().min(1),
        sourceBranch: z.string().min(1),
        targetBranch: z.string().default("main"),
        description: z.string().default(""),
      }),
      execute: async (
        args: {
          project: string;
          title: string;
          sourceBranch: string;
          targetBranch: string;
          description: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, CREATE_MR_MUTATION, {
          projectPath: args.project,
          title: args.title,
          sourceBranch: args.sourceBranch,
          targetBranch: args.targetBranch,
          description: args.description || undefined,
        });
        const result = data.mergeRequestCreate;
        if (result.errors?.length) {
          throw new Error(
            `mergeRequestCreate failed: ${result.errors.join("; ")}`,
          );
        }
        if (!result.mergeRequest) {
          throw new Error(
            `mergeRequestCreate returned no MR (project: ${args.project})`,
          );
        }
        const mr = gqlMapMR(result.mergeRequest);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-created-${mr.iid}`,
          {
            project: args.project,
            mergeRequests: [mr],
            count: 1,
            truncated: false,
            state: "opened",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Created MR !{iid} in {project}", {
          iid: mr.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    get_merge_request: {
      description:
        "Report an MR's mergeability: detailed_merge_status plus a plain-English summary of why it can or cannot merge.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, MR_STATUS_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const mr = data.project?.mergeRequest;
        if (!mr) {
          throw new Error(
            `get_merge_request: MR !${args.iid} not found in ${args.project}`,
          );
        }
        const dms: string | null = mr.detailedMergeStatus ?? null;
        const mergeable = mr.mergeable ?? (dms === "MERGEABLE");
        // headPipeline.id is a gid (gid://gitlab/Ci::Pipeline/123) — extract the number.
        const headPipelineId = mr.headPipeline?.id
          ? (parseInt(String(mr.headPipeline.id).split("/").pop() ?? "", 10) ||
            null)
          : null;
        const blockers: string[] = [];
        if (!mergeable) {
          const key = dms ?? "";
          blockers.push(
            MERGE_STATUS_EXPLANATION[key] ??
              (key ? key.toLowerCase().replace(/_/g, " ") : "not mergeable"),
          );
        }
        const summary = mergeable
          ? `!${args.iid} is mergeable.`
          : `!${args.iid} cannot merge: ${blockers.join("; ")}${
            dms ? ` (${dms.toLowerCase()})` : ""
          }.`;
        const handle = await ctx.writeResource(
          "mergeStatus",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            iid: args.iid,
            title: mr.title ?? "",
            state: mr.state ?? "",
            draft: mr.draft ?? false,
            sourceBranch: mr.sourceBranch ?? null,
            targetBranch: mr.targetBranch ?? null,
            webUrl: mr.webUrl ?? null,
            mergeable,
            detailedMergeStatus: dms,
            conflicts: mr.conflicts ?? null,
            headPipelineStatus: mr.headPipeline?.status ?? null,
            headPipelineId,
            blockers,
            summary,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(summary, { project: args.project, iid: args.iid });
        return { dataHandles: [handle] };
      },
    },

    rebase_merge_request: {
      description:
        "Trigger a rebase of an MR's source branch onto its target (async), polling until it finishes or errors.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        skipCi: z.boolean().default(false),
      }),
      execute: async (
        args: { project: string; iid: number; skipCi: boolean },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const client = new GitLabClient(host, token);
        // Trigger the async rebase (202 { rebase_in_progress: true }).
        await client.put(
          args.project,
          `/merge_requests/${args.iid}/rebase${
            args.skipCi ? "?skip_ci=true" : ""
          }`,
          {},
        );
        // Poll for completion. The rebase is asynchronous, so we wait BEFORE
        // each check (including the first) to give the job time to register —
        // otherwise a first read could see a stale `rebase_in_progress: false`
        // (or a leftover `merge_error`) and report a false result. Bounded so we
        // never hang; if it never finishes we report "in_progress".
        let status: "rebased" | "error" | "in_progress" = "in_progress";
        let mergeError: string | null = null;
        const pollMs = rebasePollMs();
        for (let i = 0; i < REBASE_MAX_POLLS; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          const { data } = await client.getProjectList(
            args.project,
            `/merge_requests/${args.iid}`,
            { include_rebase_in_progress: "true" },
          );
          if (!data.rebase_in_progress) {
            mergeError = data.merge_error ?? null;
            status = mergeError ? "error" : "rebased";
            break;
          }
        }
        const handle = await ctx.writeResource(
          "rebaseResult",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            iid: args.iid,
            status,
            mergeError,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          status === "rebased"
            ? "Rebased MR !{iid}"
            : status === "error"
            ? "Rebase of MR !{iid} failed: {error}"
            : "Rebase of MR !{iid} still running",
          { iid: args.iid, error: mergeError ?? "" },
        );
        return { dataHandles: [handle] };
      },
    },

    get_pipeline_jobs: {
      description:
        "List a pipeline's jobs with failure_reason (script_failure = real; runner_system_failure / stuck_or_timeout_failure / job_execution_timeout / api_failure = transient). Defaults to failed jobs only.",
      arguments: z.object({
        project: z.string().min(1),
        pipelineId: z.number(),
        scope: z.enum(["failed", "success", "running", "all"]).default(
          "failed",
        ),
      }),
      execute: async (
        args: { project: string; pipelineId: number; scope: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const params: Record<string, string> = { per_page: "100" };
        if (args.scope !== "all") params.scope = args.scope;
        const { data, truncated } = await client.getProjectList(
          args.project,
          `/pipelines/${args.pipelineId}/jobs`,
          params,
        );
        const raw = Array.isArray(data) ? data : [];
        // Filter client-side too, so the result is correct regardless of how
        // the server interprets the scope query param.
        const filtered = args.scope === "all"
          ? raw
          : raw.filter((j: any) => j.status === args.scope);
        const jobs = filtered.map((j: any) => ({
          id: j.id,
          name: j.name ?? "",
          stage: j.stage ?? "",
          status: j.status ?? "",
          failureReason: j.failure_reason ?? null,
          allowFailure: j.allow_failure ?? false,
          webUrl: j.web_url ?? null,
        }));
        const handle = await ctx.writeResource(
          "pipelineJobs",
          `${sanitizeName(args.project)}-pipeline-${args.pipelineId}`,
          {
            project: args.project,
            pipelineId: args.pipelineId,
            scope: args.scope,
            jobs,
            count: jobs.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Pipeline {pid}: {count} {scope} job(s)", {
          pid: args.pipelineId,
          count: jobs.length,
          scope: args.scope,
        });
        return { dataHandles: [handle] };
      },
    },

    get_job_log: {
      description:
        "Fetch the tail of a CI job's trace/log (last N lines) to diagnose a failure.",
      arguments: z.object({
        project: z.string().min(1),
        jobId: z.number(),
        tailLines: z.number().default(200),
      }),
      execute: async (
        args: { project: string; jobId: number; tailLines: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const full = await client.getProjectText(
          args.project,
          `/jobs/${args.jobId}/trace`,
        );
        // Drop a single trailing newline so it doesn't count as a blank last
        // "line" (traces normally end with \n).
        const lines = full.replace(/\n$/, "").split("\n");
        const total = lines.length;
        const n = Math.max(1, args.tailLines);
        const tail = lines.slice(Math.max(0, total - n));
        const handle = await ctx.writeResource(
          "jobLog",
          `${sanitizeName(args.project)}-job-${args.jobId}`,
          {
            project: args.project,
            jobId: args.jobId,
            totalLines: total,
            returnedLines: tail.length,
            truncated: total > tail.length,
            log: redactSecrets(tail.join("\n")),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Fetched job {jobId} log tail ({n}/{total} lines)", {
          jobId: args.jobId,
          n: tail.length,
          total,
        });
        return { dataHandles: [handle] };
      },
    },

    retry_job: {
      description:
        "Retry a CI job (e.g. after a transient failure). Returns the new job's id and status.",
      arguments: z.object({
        project: z.string().min(1),
        jobId: z.number(),
      }),
      execute: async (
        args: { project: string; jobId: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(
          args.project,
          `/jobs/${args.jobId}/retry`,
        );
        const handle = await ctx.writeResource(
          "retryResult",
          `${sanitizeName(args.project)}-job-${args.jobId}`,
          {
            project: args.project,
            kind: "job",
            id: args.jobId,
            newJobId: raw.id ?? null,
            status: raw.status ?? "",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Retried job {jobId} → new job {newId} ({status})", {
          jobId: args.jobId,
          newId: raw.id ?? "?",
          status: raw.status ?? "?",
        });
        return { dataHandles: [handle] };
      },
    },

    retry_pipeline: {
      description: "Retry the failed jobs in a pipeline.",
      arguments: z.object({
        project: z.string().min(1),
        pipelineId: z.number(),
      }),
      execute: async (
        args: { project: string; pipelineId: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.post(
          args.project,
          `/pipelines/${args.pipelineId}/retry`,
        );
        const handle = await ctx.writeResource(
          "retryResult",
          `${sanitizeName(args.project)}-pipeline-${args.pipelineId}`,
          {
            project: args.project,
            kind: "pipeline",
            id: args.pipelineId,
            newJobId: null,
            status: raw.status ?? "",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Retried pipeline {pid} ({status})", {
          pid: args.pipelineId,
          status: raw.status ?? "?",
        });
        return { dataHandles: [handle] };
      },
    },

    merge: {
      description: "Merge a merge request",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        squash: z.boolean().default(false),
      }),
      execute: async (
        args: { project: string; iid: number; squash: boolean },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const raw = await client.put(
          args.project,
          `/merge_requests/${args.iid}/merge`,
          { squash: args.squash },
        );
        // GitLab can return 200 with an error message on merge conflicts
        if (raw.message) {
          throw new Error(
            `GitLab merge failed for !${args.iid}: ${raw.message}`,
          );
        }
        const mr = mapMR(raw);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-merged-${args.iid}`,
          {
            project: args.project,
            mergeRequests: [mr],
            count: 1,
            truncated: false,
            state: mr.state,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Merged MR !{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    update_merge_request: {
      description: "Update a merge request (title, description, labels, state)",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        stateEvent: z.enum(["close", "reopen"]).optional(),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          title?: string;
          description?: string;
          labels?: string[];
          stateEvent?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.description !== undefined) body.description = args.description;
        if (args.labels !== undefined) body.labels = args.labels.join(",");
        if (args.stateEvent !== undefined) body.state_event = args.stateEvent;
        const raw = await client.put(
          args.project,
          `/merge_requests/${args.iid}`,
          body,
        );
        const mr = mapMR(raw);
        const handle = await ctx.writeResource(
          "mergeRequests",
          `${sanitizeName(args.project)}-updated-${args.iid}`,
          {
            project: args.project,
            mergeRequests: [mr],
            count: 1,
            truncated: false,
            state: mr.state,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Updated MR !{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    add_mr_note: {
      description:
        "Add a comment to a merge request, or reply into an existing thread by passing discussionId (from list_mr_discussions)",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        body: z.string().min(1),
        discussionId: z
          .string()
          .optional()
          .describe("Reply into this discussion thread instead of top-level"),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          body: string;
          discussionId?: string;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        // Resolve MR global ID
        const idData = await graphqlRequest(host, token, MR_ID_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
        });
        const mrGid = idData.project?.mergeRequest?.id;
        if (!mrGid) {
          throw new Error(`MR !${args.iid} not found in ${args.project}`);
        }
        // Reply into a thread when discussionId is given; else top-level note.
        const data = args.discussionId
          ? await graphqlRequest(host, token, REPLY_NOTE_MUTATION, {
            noteableId: mrGid,
            discussionId: args.discussionId,
            body: args.body,
          })
          : await graphqlRequest(host, token, CREATE_NOTE_MUTATION, {
            noteableId: mrGid,
            body: args.body,
          });
        const result = data.createNote;
        if (result.errors?.length) {
          throw new Error(`createNote failed: ${result.errors.join("; ")}`);
        }
        if (!result.note) {
          throw new Error(
            `createNote returned no note (project: ${args.project}, iid: ${args.iid})`,
          );
        }
        const note = gqlMapNote(result.note);
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-mr-${args.iid}-note-${note.id}`,
          {
            project: args.project,
            noteableType: "merge_request",
            noteableIid: args.iid,
            notes: [note],
            count: 1,
            truncated: false,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Added note to MR !{iid} in {project}", {
          iid: args.iid,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    update_mr_note: {
      description: "Edit an existing comment on a merge request by note id.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        noteId: z.number(),
        body: z.string().min(1),
      }),
      execute: async (
        args: { project: string; iid: number; noteId: number; body: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, UPDATE_NOTE_MUTATION, {
          id: `gid://gitlab/Note/${args.noteId}`,
          body: args.body,
        });
        const result = data.updateNote;
        // GitLab returns a null payload (not a userland error) when the caller
        // can't edit the note — another user's note, a system note, a locked MR.
        if (!result) {
          throw new Error(
            `update_mr_note: note ${args.noteId} not found or permission denied`,
          );
        }
        if (result.errors?.length) {
          throw new Error(`updateNote failed: ${result.errors.join("; ")}`);
        }
        if (!result.note) {
          throw new Error(
            `updateNote returned no note (noteId: ${args.noteId}, project: ${args.project})`,
          );
        }
        const note = gqlMapNote(result.note);
        const handle = await ctx.writeResource(
          "notes",
          `${sanitizeName(args.project)}-mr-${args.iid}-note-${note.id}`,
          {
            project: args.project,
            noteableType: "merge_request",
            noteableIid: args.iid,
            notes: [note],
            count: 1,
            truncated: false,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Updated note {noteId} on MR !{iid}", {
          noteId: args.noteId,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    delete_mr_note: {
      description: "Delete a comment on a merge request by note id.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        noteId: z.number(),
      }),
      execute: async (
        args: { project: string; iid: number; noteId: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, DESTROY_NOTE_MUTATION, {
          id: `gid://gitlab/Note/${args.noteId}`,
        });
        const result = data.destroyNote;
        // Null payload = permission denied / note not found (not a userland
        // error). A successful delete returns { note: null, errors: [] }.
        if (!result) {
          throw new Error(
            `delete_mr_note: note ${args.noteId} not found or permission denied`,
          );
        }
        if (result.errors?.length) {
          throw new Error(`destroyNote failed: ${result.errors.join("; ")}`);
        }
        const handle = await ctx.writeResource(
          "noteDeleted",
          `${sanitizeName(args.project)}-mr-${args.iid}-note-${args.noteId}`,
          {
            project: args.project,
            iid: args.iid,
            noteId: args.noteId,
            deleted: true,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Deleted note {noteId} on MR !{iid}", {
          noteId: args.noteId,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    set_mr_assignees: {
      description:
        "Set (replace) an MR's assignees by username; pass an empty list to unassign. GitLab CE keeps one; EE/Premium support multiple.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        usernames: z.array(z.string()).default([]),
      }),
      execute: async (
        args: { project: string; iid: number; usernames: string[] },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, SET_ASSIGNEES_MUTATION, {
          projectPath: args.project,
          iid: String(args.iid),
          usernames: args.usernames,
        });
        const result = data.mergeRequestSetAssignees;
        if (result.errors?.length) {
          throw new Error(
            `mergeRequestSetAssignees failed: ${result.errors.join("; ")}`,
          );
        }
        const assignees: string[] =
          (result.mergeRequest?.assignees?.nodes ?? []).map((n: any) =>
            n.username
          );
        // GitLab does NOT error on an unknown/unassignable username — it just
        // omits it. Fail loudly so an assign to a typo'd user isn't reported as
        // success (and, on CE, so dropping an extra assignee surfaces).
        if (args.usernames.length > 0) {
          // GitLab lowercases usernames in responses but accepts mixed case in
          // requests — compare case-insensitively so a valid assign isn't
          // reported as failed.
          const got = new Set(assignees.map((u) => u.toLowerCase()));
          const missing = args.usernames.filter((u) =>
            !got.has(u.toLowerCase())
          );
          if (missing.length) {
            throw new Error(
              `set_mr_assignees: GitLab did not assign ${
                missing.join(", ")
              } (unknown user, or GitLab CE's single-assignee limit)`,
            );
          }
        }
        const handle = await ctx.writeResource(
          "mrAssignees",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            iid: args.iid,
            assignees,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          assignees.length
            ? "Set MR !{iid} assignees: {who}"
            : "Unassigned MR !{iid}",
          { iid: args.iid, who: assignees.join(", ") },
        );
        return { dataHandles: [handle] };
      },
    },

    unassign_from_mrs: {
      description:
        "Remove an assignee (default: the authenticated user) from multiple MRs " +
        "in a project, in one fan-out. Uses operationMode REMOVE, so other " +
        "assignees are preserved. Idempotent: removing a user who isn't assigned " +
        "is a no-op. Per-MR failures are recorded and never abort the batch.",
      arguments: z.object({
        project: z.string().min(1),
        iids: z.array(z.number()).min(1),
        username: z.string().optional(),
      }),
      execute: async (
        args: { project: string; iids: number[]; username?: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        let resolved = args.username;
        if (!resolved) {
          const who = await graphqlRequest(host, token, CURRENT_USER_QUERY, {});
          resolved = who.currentUser?.username;
        }
        if (!resolved) {
          throw new Error(
            "unassign_from_mrs: could not resolve the authenticated user; pass `username` explicitly",
          );
        }
        const username: string = resolved;

        const results: z.infer<typeof UnassignResultSchema>["results"] = [];
        const failed: z.infer<typeof UnassignResultSchema>["failed"] = [];
        for (const iid of args.iids) {
          try {
            const data = await graphqlRequest(
              host,
              token,
              REMOVE_ASSIGNEES_MUTATION,
              {
                projectPath: args.project,
                iid: String(iid),
                usernames: [username],
              },
            );
            const result = data.mergeRequestSetAssignees;
            // GitLab returns a null payload on permission-denied / missing MR
            // as a routine path — guard before reading .errors.
            if (!result) {
              throw new Error(
                "mergeRequestSetAssignees returned null (permission denied or MR not found)",
              );
            }
            if (result.errors?.length) {
              throw new Error(result.errors.join("; "));
            }
            // A null mergeRequest with empty errors is unconfirmable — do not
            // read `assignees` off it and report a fabricated empty success.
            if (!result.mergeRequest) {
              throw new Error(
                "mergeRequestSetAssignees returned no mergeRequest — removal unconfirmed",
              );
            }
            const remainingAssignees: string[] =
              (result.mergeRequest.assignees?.nodes ?? []).map((
                n: any,
              ) => n.username);
            // "No error" is not "removed". If the user is still in the
            // resulting set, treat it as a failure so a queue-clearing caller
            // isn't told it succeeded (mirrors set_mr_assignees failing loudly).
            const stillAssigned = remainingAssignees
              .map((u) => u.toLowerCase())
              .includes(username.toLowerCase());
            if (stillAssigned) {
              throw new Error(
                "REMOVE reported success but the user is still assigned",
              );
            }
            results.push({ iid, remainingAssignees });
          } catch (e) {
            failed.push({
              iid,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const handle = await ctx.writeResource(
          "unassignResult",
          `${sanitizeName(args.project)}-unassign-${username}`,
          {
            project: args.project,
            username,
            results,
            failed,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          "Unassigned {user} from {ok}/{total} MRs in {project} ({failed} failed)",
          {
            user: username,
            ok: results.length,
            total: args.iids.length,
            project: args.project,
            failed: failed.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    remove_mr_reviewers: {
      description:
        "Remove a reviewer (default: the authenticated user) from multiple MRs " +
        "in a project, in one fan-out. Uses operationMode REMOVE, so other " +
        "reviewers are preserved. Idempotent: removing a user who isn't a " +
        "reviewer is a no-op. Per-MR failures are recorded and never abort the batch. " +
        "Useful to clear yourself off MRs you've already reviewed.",
      arguments: z.object({
        project: z.string().min(1),
        iids: z.array(z.number()).min(1),
        username: z.string().optional(),
      }),
      execute: async (
        args: { project: string; iids: number[]; username?: string },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        let resolved = args.username;
        if (!resolved) {
          const who = await graphqlRequest(host, token, CURRENT_USER_QUERY, {});
          resolved = who.currentUser?.username;
        }
        if (!resolved) {
          throw new Error(
            "remove_mr_reviewers: could not resolve the authenticated user; pass `username` explicitly",
          );
        }
        const username: string = resolved;

        const results: z.infer<typeof RemoveReviewerResultSchema>["results"] =
          [];
        const failed: z.infer<typeof RemoveReviewerResultSchema>["failed"] = [];
        for (const iid of args.iids) {
          try {
            const data = await graphqlRequest(
              host,
              token,
              REMOVE_REVIEWERS_MUTATION,
              {
                projectPath: args.project,
                iid: String(iid),
                usernames: [username],
              },
            );
            const result = data.mergeRequestSetReviewers;
            // GitLab returns a null payload on permission-denied / missing MR
            // as a routine path — guard before reading .errors.
            if (!result) {
              throw new Error(
                "mergeRequestSetReviewers returned null (permission denied or MR not found)",
              );
            }
            if (result.errors?.length) {
              throw new Error(result.errors.join("; "));
            }
            if (!result.mergeRequest) {
              throw new Error(
                "mergeRequestSetReviewers returned no mergeRequest — removal unconfirmed",
              );
            }
            const remainingReviewers: string[] =
              (result.mergeRequest.reviewers?.nodes ?? []).map((
                n: any,
              ) => n.username);
            // "No error" is not "removed": if the user is still a reviewer,
            // treat it as a failure rather than report a false success.
            const stillReviewer = remainingReviewers
              .map((u) => u.toLowerCase())
              .includes(username.toLowerCase());
            if (stillReviewer) {
              throw new Error(
                "REMOVE reported success but the user is still a reviewer",
              );
            }
            results.push({ iid, remainingReviewers });
          } catch (e) {
            failed.push({
              iid,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const handle = await ctx.writeResource(
          "reviewerRemovalResult",
          `${sanitizeName(args.project)}-reviewer-remove-${username}`,
          {
            project: args.project,
            username,
            results,
            failed,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          "Removed reviewer {user} from {ok}/{total} MRs in {project} ({failed} failed)",
          {
            user: username,
            ok: results.length,
            total: args.iids.length,
            project: args.project,
            failed: failed.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    set_mr_reviewers: {
      description:
        "Set (replace) an MR's reviewers by username; pass an empty list to clear. " +
        "GitLab EE/Premium supports multiple reviewers.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        usernames: z.array(z.string()).default([]),
      }),
      execute: async (
        args: { project: string; iid: number; usernames: string[] },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, SET_REVIEWERS_MUTATION, {
          projectPath: args.project,
          iid: String(args.iid),
          usernames: args.usernames,
        });
        const result = data.mergeRequestSetReviewers;
        if (result.errors?.length) {
          throw new Error(
            `mergeRequestSetReviewers failed: ${result.errors.join("; ")}`,
          );
        }
        const reviewers: string[] =
          (result.mergeRequest?.reviewers?.nodes ?? []).map((n: any) =>
            n.username
          );
        if (args.usernames.length > 0) {
          const got = new Set(reviewers.map((u) => u.toLowerCase()));
          const missing = args.usernames.filter((u) =>
            !got.has(u.toLowerCase())
          );
          if (missing.length) {
            throw new Error(
              `set_mr_reviewers: GitLab did not set ${
                missing.join(", ")
              } as reviewer(s) (unknown user or permission issue)`,
            );
          }
        }
        const handle = await ctx.writeResource(
          "mrReviewers",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            iid: args.iid,
            reviewers,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info(
          reviewers.length
            ? "Set MR !{iid} reviewers: {who}"
            : "Cleared MR !{iid} reviewers",
          {
            iid: args.iid,
            who: reviewers.join(", "),
            project: args.project,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    list_mr_discussions: {
      description:
        "List resolvable discussion threads on an MR with per-thread resolution state and slim diff position (file/line). System-only threads are excluded. Filter for blockers with CEL: size(discussions.filter(d, d.resolvable && !d.resolved)).",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        first: z.number().int().positive().max(100).default(50),
      }),
      execute: async (
        args: { project: string; iid: number; first?: number },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        // `?? 50` is not redundant with the Zod default: the test harness (and
        // any caller that skips schema validation) does not apply defaults.
        const first = args.first ?? 50;
        const data = await graphqlRequest(host, token, MR_DISCUSSIONS_QUERY, {
          fullPath: args.project,
          iid: String(args.iid),
          first,
        });
        const conn = data.project?.mergeRequest?.discussions;
        if (!conn) {
          throw new Error(`MR !${args.iid} not found in ${args.project}`);
        }
        const parseNoteId = (gid: unknown): number =>
          parseInt(String(gid ?? "").split("/").pop() ?? "0", 10);
        const slim = (
          pos: any,
        ): { file: string | null; line: number | null } => ({
          file: pos?.filePath ?? null,
          line: pos?.newLine ?? pos?.oldLine ?? null,
        });
        const discussions: z.infer<typeof DiscussionSchema>[] = [];
        for (const d of conn.nodes ?? []) {
          // Drop system-only threads (label/assignee events, not human threads).
          const userNotes = (d.notes?.nodes ?? []).filter(
            (n: any) => !n.system,
          );
          if (userNotes.length === 0) continue;
          const root = userNotes[0];
          const rootPos = slim(root.position);
          discussions.push({
            id: d.id ?? "",
            resolvable: d.resolvable ?? false,
            resolved: d.resolved ?? false,
            resolvedBy: d.resolvedBy?.username ?? null,
            file: rootPos.file,
            line: rootPos.line,
            author: root.author?.username ?? null,
            createdAt: root.createdAt ?? "",
            notes: userNotes.map((n: any) => {
              const p = slim(n.position);
              return {
                id: parseNoteId(n.id),
                author: n.author?.username ?? null,
                body: n.body ?? "",
                createdAt: n.createdAt ?? "",
                file: p.file,
                line: p.line,
              };
            }),
          });
        }
        const handle = await ctx.writeResource(
          "discussions",
          `${sanitizeName(args.project)}-mr-${args.iid}`,
          {
            project: args.project,
            iid: args.iid,
            discussions,
            truncated: !!conn.pageInfo?.hasNextPage,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          } as unknown as Record<string, unknown>,
        );
        ctx.logger.info(
          "Fetched {count} discussions for {project}!{iid} ({unresolved} unresolved)",
          {
            count: discussions.length,
            project: args.project,
            iid: args.iid,
            unresolved:
              discussions.filter((x) => x.resolvable && !x.resolved).length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    resolve_mr_discussion: {
      description:
        "Resolve (or unresolve) a merge request discussion thread by its discussionId (from list_mr_discussions). MUTATING.",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        discussionId: z.string().min(1),
        resolved: z.boolean().default(true),
      }),
      execute: async (
        args: {
          project: string;
          iid: number;
          discussionId: string;
          resolved?: boolean;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const resolve = args.resolved ?? true;
        const data = await graphqlRequest(
          host,
          token,
          RESOLVE_DISCUSSION_MUTATION,
          { id: args.discussionId, resolve },
        );
        const result = data.discussionToggleResolve;
        // GitLab returns null on permission-denied / missing discussion.
        if (!result) {
          throw new Error(
            "discussionToggleResolve returned null (permission denied or discussion not found)",
          );
        }
        if (result.errors?.length) {
          throw new Error(
            `discussionToggleResolve failed: ${result.errors.join("; ")}`,
          );
        }
        const disc = result.discussion;
        const handle = await ctx.writeResource(
          "discussionResolution",
          `${sanitizeName(args.project)}-mr-${args.iid}-disc-${
            sanitizeName(args.discussionId)
          }`,
          {
            project: args.project,
            iid: args.iid,
            discussionId: disc?.id ?? args.discussionId,
            resolved: disc?.resolved ?? resolve,
            resolvedBy: disc?.resolvedBy?.username ?? null,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          } as unknown as Record<string, unknown>,
        );
        ctx.logger.info("{action} discussion on {project}!{iid}", {
          action: (disc?.resolved ?? resolve) ? "Resolved" : "Unresolved",
          project: args.project,
          iid: args.iid,
        });
        return { dataHandles: [handle] };
      },
    },

    list_labels: {
      description: "List labels for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, LABELS_QUERY, {
          fullPath: args.project,
          first: 100,
        });
        const conn = data.project?.labels;
        const labels = (conn?.nodes ?? []).map((n: any) => ({
          name: n.title ?? "",
          color: n.color ?? "",
          description: n.description ?? null,
        }));
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "labels",
          sanitizeName(args.project),
          {
            project: args.project,
            labels,
            count: labels.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} labels for {project}", {
          count: labels.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    create_label: {
      description: "Create a label in a project",
      arguments: z.object({
        project: z.string().min(1),
        name: z.string().min(1),
        color: z.string().default("#428BCA"),
        description: z.string().default(""),
      }),
      execute: async (
        args: {
          project: string;
          name: string;
          color: string;
          description: string;
        },
        ctx: ModelContext,
      ) => {
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, LABEL_CREATE_MUTATION, {
          projectPath: args.project,
          title: args.name,
          color: args.color,
          description: args.description || undefined,
        });
        const result = data.labelCreate;
        if (result.errors?.length) {
          throw new Error(`labelCreate failed: ${result.errors.join("; ")}`);
        }
        ctx.logger.info("Created label {name} in {project}", {
          name: args.name,
          project: args.project,
        });
        return { dataHandles: [] };
      },
    },

    list_members: {
      description: "List members of a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, MEMBERS_QUERY, {
          fullPath: args.project,
          first: 100,
        });
        const conn = data.project?.projectMembers;
        const members = (conn?.nodes ?? []).map((n: any) => ({
          username: n.user?.username ?? "",
          name: n.user?.name ?? "",
          accessLevel: n.accessLevel?.integerValue ?? 0,
        }));
        const truncated = conn?.pageInfo?.hasNextPage ?? false;
        const handle = await ctx.writeResource(
          "members",
          sanitizeName(args.project),
          {
            project: args.project,
            members,
            count: members.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} members for {project}", {
          count: members.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_branches: {
      description: "List branches for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
        const startMs = Date.now();
        // REST fallback: GitLab GraphQL does not expose repository branch listing
        const client = new GitLabClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        );
        const { data, truncated } = await client.getProjectList(
          args.project,
          "/repository/branches",
          { per_page: "50" },
        );
        const branches = (data as any[]).map((raw: any) => ({
          name: raw.name ?? "",
          protected: raw.protected ?? false,
          default: raw.default ?? false,
        }));
        const handle = await ctx.writeResource(
          "branches",
          sanitizeName(args.project),
          {
            project: args.project,
            branches,
            count: branches.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        ctx.logger.info("Found {count} branches for {project}", {
          count: branches.length,
          project: args.project,
        });
        return { dataHandles: [handle] };
      },
    },

    list_my_merge_requests: {
      description:
        "List MRs and todos for the authenticated user via GraphQL (reviewer, assignee, author roles + pending todos)",
      arguments: z.object({
        role: z
          .enum(["reviewer", "assignee", "author", "all"])
          .default("all")
          .describe("Filter by role: reviewer, assignee, author, or all"),
        state: z
          .enum(["opened", "merged", "closed", "all"])
          .default("opened")
          .describe("MR state filter"),
        includeArchived: z
          .boolean()
          .default(false)
          .describe("Include MRs from archived projects"),
      }),
      execute: async (
        args: { role: string; state: string; includeArchived: boolean },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, token } = ctx.globalArgs;
        const variables: Record<string, unknown> = {
          mrState: args.state === "all" ? undefined : args.state,
          perPage: 20,
          includeArchived: args.includeArchived,
        };

        const data = await graphqlRequest(
          host,
          token,
          DASHBOARD_QUERY,
          variables,
        );
        const user = data.currentUser;
        if (!user) {
          throw new Error(
            "GitLab GraphQL: currentUser is null — verify the token has 'read_api' scope and is not expired",
          );
        }

        const showReviewing = args.role === "all" || args.role === "reviewer";
        const showAssigned = args.role === "all" || args.role === "assignee";
        const showAuthored = args.role === "all" || args.role === "author";

        const reviewing = showReviewing
          ? (user.reviewRequestedMergeRequests?.nodes ?? []).map((n: any) =>
            mapDashboardMR(n, user.username)
          )
          : [];
        const assigned = showAssigned
          ? (user.assignedMergeRequests?.nodes ?? []).map((n: any) =>
            mapDashboardMR(n, user.username)
          )
          : [];
        const authored = showAuthored
          ? (user.authoredMergeRequests?.nodes ?? []).map((n: any) =>
            mapDashboardMR(n, user.username)
          )
          : [];
        const todos = (user.todos?.nodes ?? []).map(mapTodo);

        const truncated = !!(
          (showReviewing &&
            user.reviewRequestedMergeRequests?.pageInfo?.hasNextPage) ||
          (showAssigned &&
            user.assignedMergeRequests?.pageInfo?.hasNextPage) ||
          (showAuthored &&
            user.authoredMergeRequests?.pageInfo?.hasNextPage) ||
          user.todos?.pageInfo?.hasNextPage
        );

        const totalCount = reviewing.length + assigned.length + authored.length;
        const handle = await ctx.writeResource("dashboard", user.username, {
          username: user.username,
          reviewing,
          assigned,
          authored,
          todos,
          totalCount,
          truncated,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        ctx.logger.info(
          "Found {total} MRs + {todos} todos for {user} (reviewing={r}, assigned={a}, authored={auth})",
          {
            total: totalCount,
            todos: todos.length,
            user: user.username,
            r: reviewing.length,
            a: assigned.length,
            auth: authored.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
