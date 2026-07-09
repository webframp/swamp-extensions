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

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "GitLab hostname (e.g. git.bethelservice.org)",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "GitLab personal access token with api scope (use vault reference)",
  ),
});

const ProjectSchema = z.object({
  name: z.string(),
  pathWithNamespace: z.string(),
  description: z.string().nullable(),
  visibility: z.string(),
  starCount: z.number(),
  forksCount: z.number(),
  lastActivityAt: z.string(),
  defaultBranch: z.string().nullable(),
  archived: z.boolean(),
  topics: z.array(z.string()),
});

const ProjectListSchema = z.object({
  projects: z.array(ProjectSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const ProjectInfoSchema = z.object({
  name: z.string(),
  pathWithNamespace: z.string(),
  description: z.string().nullable(),
  visibility: z.string(),
  defaultBranch: z.string().nullable(),
  starCount: z.number(),
  forksCount: z.number(),
  openIssuesCount: z.number(),
  archived: z.boolean(),
  topics: z.array(z.string()),
  webUrl: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  fetchedAt: z.string(),
});

const MergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  draft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
});

const MergeRequestListSchema = z.object({
  project: z.string(),
  mergeRequests: z.array(MergeRequestSchema),
  count: z.number(),
  truncated: z.boolean(),
  state: z.string(),
  fetchedAt: z.string(),
});

const IssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
});

const IssueListSchema = z.object({
  project: z.string(),
  issues: z.array(IssueSchema),
  count: z.number(),
  truncated: z.boolean(),
  state: z.string(),
  fetchedAt: z.string(),
});

const IssueDetailSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  webUrl: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const NoteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  createdAt: z.string(),
});

const NoteListSchema = z.object({
  project: z.string(),
  noteableType: z.string(),
  noteableIid: z.number(),
  notes: z.array(NoteSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const NoteDeletedSchema = z.object({
  project: z.string(),
  iid: z.number(),
  noteId: z.number(),
  deleted: z.boolean(),
  fetchedAt: z.string(),
});

const MrAssigneesSchema = z.object({
  project: z.string(),
  iid: z.number(),
  // Resulting assignee usernames after the set (empty when unassigned).
  assignees: z.array(z.string()),
  fetchedAt: z.string(),
});

const ReleaseSchema = z.object({
  tagName: z.string(),
  name: z.string(),
  createdAt: z.string(),
  releasedAt: z.string(),
  upcoming: z.boolean(),
});

const ReleaseListSchema = z.object({
  project: z.string(),
  releases: z.array(ReleaseSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const PipelineSchema = z.object({
  iid: z.number(),
  name: z.string().nullable(),
  status: z.string(),
  source: z.string(),
  ref: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PipelineListSchema = z.object({
  project: z.string(),
  pipelines: z.array(PipelineSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const LabelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

const LabelListSchema = z.object({
  project: z.string(),
  labels: z.array(LabelSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const MemberSchema = z.object({
  username: z.string(),
  name: z.string(),
  accessLevel: z.number(),
});

const MemberListSchema = z.object({
  project: z.string(),
  members: z.array(MemberSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const BranchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  default: z.boolean(),
});

const BranchListSchema = z.object({
  project: z.string(),
  branches: z.array(BranchSchema),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const DashboardMRSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  webUrl: z.string(),
  commented: z.boolean(),
  approvedByMe: z.boolean(),
  myReviewState: z
    .enum(["pending", "reviewed", "approved", "unapproved"])
    .nullable(),
});

const TodoSchema = z.object({
  id: z.string(),
  action: z.string(),
  body: z.string(),
  targetType: z.string(),
  targetUrl: z.string(),
  project: z.string().nullable(),
  author: z.string(),
  createdAt: z.string(),
});

const DashboardSchema = z.object({
  username: z.string(),
  reviewing: z.array(DashboardMRSchema),
  assigned: z.array(DashboardMRSchema),
  authored: z.array(DashboardMRSchema),
  todos: z.array(TodoSchema),
  totalCount: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const MergeStatusSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  // GitLab's detailed_merge_status enum, e.g. mergeable, need_rebase, conflict,
  // ci_must_pass, not_approved, discussions_not_resolved, draft_status.
  detailedMergeStatus: z.string().nullable(),
  conflicts: z.boolean().nullable(),
  headPipelineStatus: z.string().nullable(),
  // Head pipeline id — feed to get_pipeline_jobs to drill into CI failures.
  headPipelineId: z.number().nullable(),
  // Human-readable reasons the MR cannot merge (empty when mergeable).
  blockers: z.array(z.string()),
  summary: z.string(),
  fetchedAt: z.string(),
});

const PipelineJobSchema = z.object({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.string(),
  // GitLab failure_reason: script_failure (real/code) vs runner_system_failure,
  // stuck_or_timeout_failure, job_execution_timeout, api_failure (transient).
  failureReason: z.string().nullable(),
  allowFailure: z.boolean(),
  webUrl: z.string().nullable(),
});

const PipelineJobsSchema = z.object({
  project: z.string(),
  pipelineId: z.number(),
  scope: z.string().nullable(),
  jobs: z.array(PipelineJobSchema),
  count: z.number(),
  // true when the pipeline has more jobs than one page (100) returned.
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const JobLogSchema = z.object({
  project: z.string(),
  jobId: z.number(),
  totalLines: z.number(),
  returnedLines: z.number(),
  truncated: z.boolean(),
  // Tail of the job trace. Common credential patterns are redacted, but CI logs
  // can still leak secrets — treat as sensitive.
  log: z.string(),
  fetchedAt: z.string(),
});

const RetryResultSchema = z.object({
  project: z.string(),
  kind: z.enum(["job", "pipeline"]),
  // The id retried (job id or pipeline id).
  id: z.number(),
  // For job retries, the id of the new job GitLab created.
  newJobId: z.number().nullable(),
  status: z.string(),
  fetchedAt: z.string(),
});

const RebaseResultSchema = z.object({
  project: z.string(),
  iid: z.number(),
  // "rebased" (finished clean), "error" (see mergeError), or "in_progress"
  // (still running when polling gave up — re-check with get_merge_request).
  status: z.enum(["rebased", "error", "in_progress"]),
  mergeError: z.string().nullable(),
  fetchedAt: z.string(),
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
  const result = await resp.json();
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
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } }
      pageInfo { hasNextPage }
    }
    assignedMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } }
      pageInfo { hasNextPage }
    }
    authoredMergeRequests(state: $mrState, first: $perPage, includeArchived: $includeArchived, sort: UPDATED_DESC) {
      nodes { iid title webUrl updatedAt draft project { fullPath } author { username } labels { nodes { title } } notes(last: 5) { nodes { author { username } } } approvedBy { nodes { username } } reviewers { nodes { username mergeRequestInteraction { reviewState } } } }
      pageInfo { hasNextPage }
    }
    todos(state: pending, first: 20) {
      nodes { id action body targetType targetUrl createdAt author { username } project { nameWithNamespace } }
      pageInfo { hasNextPage }
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
  return {
    project: node.project?.fullPath ?? "",
    iid: typeof node.iid === "string" ? parseInt(node.iid, 10) : node.iid,
    title: node.title ?? "",
    author: node.author?.username ?? "",
    updatedAt: node.updatedAt ?? "",
    draft: node.draft ?? false,
    labels: node.labels?.nodes?.map((l: any) => l.title) ?? [],
    webUrl: node.webUrl ?? "",
    commented: currentUser ? noteAuthors.includes(currentUser) : false,
    approvedByMe: currentUser ? approvers.includes(currentUser) : false,
    myReviewState,
  };
}

function mapTodo(node: any): z.infer<typeof TodoSchema> {
  return {
    id: node.id ?? "",
    action: node.action ?? "",
    body: node.body ?? "",
    targetType: node.targetType ?? "",
    targetUrl: node.targetUrl ?? "",
    project: node.project?.nameWithNamespace ?? null,
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
        iid title state draft createdAt updatedAt
        sourceBranch targetBranch
        author { username }
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
  version: "2026.07.08.4",
  globalArguments: GlobalArgsSchema,
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
    mrAssignees: {
      description: "Assignees of an MR after a set/unassign",
      schema: MrAssigneesSchema,
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
  },

  methods: {
    list_projects: {
      description:
        "List projects for the authenticated user with basic metadata",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
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
          info,
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
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, MERGE_REQUESTS_QUERY, {
          fullPath: args.project,
          state: args.state === "all" ? undefined : args.state.toUpperCase(),
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
        const { host, token } = ctx.globalArgs;
        const data = await graphqlRequest(host, token, ISSUES_QUERY, {
          fullPath: args.project,
          state: args.state === "all" ? undefined : args.state.toUpperCase(),
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
          },
        );
        ctx.logger.info("Found {count} pipelines for {project}", {
          count: pipelines.length,
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
            mergeable,
            detailedMergeStatus: dms,
            conflicts: mr.conflicts ?? null,
            headPipelineStatus: mr.headPipeline?.status ?? null,
            headPipelineId,
            blockers,
            summary,
            fetchedAt: new Date().toISOString(),
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
      description: "Add a comment to a merge request",
      arguments: z.object({
        project: z.string().min(1),
        iid: z.number(),
        body: z.string().min(1),
      }),
      execute: async (
        args: { project: string; iid: number; body: string },
        ctx: ModelContext,
      ) => {
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
        const data = await graphqlRequest(host, token, CREATE_NOTE_MUTATION, {
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

    list_labels: {
      description: "List labels for a project",
      arguments: z.object({ project: z.string().min(1) }),
      execute: async (args: { project: string }, ctx: ModelContext) => {
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
