/**
 * Claude Enterprise Admin API (user management) model for swamp.
 *
 * Observes members, custom roles, and RBAC groups, and changes them: adds
 * members to a group and switches members between the `user` and `managed`
 * ("Custom") organization roles. Requires an Admin API key (sk-ant-api01-...)
 * created by the primary owner in claude.ai → Organization settings → API with
 * the read:members, write:members, read:rbac_groups and write:rbac_groups
 * scopes, for all linked organizations.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.6.5";

const EXTENSION_NAME = "@webframp/anthropic/admin";

/** Roles the API cannot modify; members holding them are never targeted. */
export const PRIVILEGED_ROLES = [
  "owner",
  "primary_owner",
  "membership_admin",
] as const;

/** Roles the API can assign. */
const ASSIGNABLE_ROLES = ["user", "managed"] as const;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  adminKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Admin API key (sk-ant-api01-...) from claude.ai → Organization settings → API (use vault reference)",
  ),
  requestsPerMinute: z.number().int().min(1).max(100).optional().describe(
    "Client-side pacing for Admin API calls. The API allows 100/min per organization, shared by every caller; default 80 leaves headroom.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const MemberSchema = z.object({
  id: z.string().describe("Member's user ID (user_...)"),
  email: z.string().describe("Member's email address"),
  name: z.string().nullable().describe("Member's display name, if known"),
  role: z.string().describe(
    "Organization role: user, managed, owner, membership_admin, or primary_owner",
  ),
  added_at: z.string().nullable().describe(
    "ISO 8601 timestamp the member joined, if known",
  ),
});

const MemberListSchema = z.object({
  members: z.array(MemberSchema).describe("Organization members"),
  count: z.number().describe("Number of members returned"),
  roleCounts: z.record(z.string(), z.number()).describe(
    "Number of members per organization role",
  ),
  fetchedAt: z.string().describe("ISO 8601 timestamp of the fetch"),
  durationMs: z.number().optional().describe("Method duration in milliseconds"),
  collectedBy: z.string().optional().describe("Extension that collected this"),
});

const RbacRoleSchema = z.object({
  id: z.string().describe("Custom role ID (rbac_role_...)"),
  name: z.string().describe("Custom role display name"),
});

const RbacRoleListSchema = z.object({
  roles: z.array(RbacRoleSchema).describe("Custom roles in the organization"),
  count: z.number().describe("Number of roles returned"),
  fetchedAt: z.string().describe("ISO 8601 timestamp of the fetch"),
  durationMs: z.number().optional().describe("Method duration in milliseconds"),
  collectedBy: z.string().optional().describe("Extension that collected this"),
});

const RbacGroupMemberSchema = z.object({
  user_id: z.string().describe("Member's user ID"),
  email: z.string().describe("Member's email address"),
});

const RbacGroupSchema = z.object({
  id: z.string().describe("Group ID (rbac_group_...)"),
  name: z.string().describe("Group display name"),
  source_type: z.string().describe(
    "direct (created in claude.ai or the API) or scim (owned by the IdP; read-only)",
  ),
  role_ids: z.array(z.string()).nullable().describe(
    "Custom roles attached to the group; null when role data was temporarily unavailable",
  ),
  role_names: z.array(z.string()).describe(
    "Names of the attached custom roles, resolved from the role catalog",
  ),
  members: z.array(RbacGroupMemberSchema).describe("Current group members"),
  member_count: z.number().describe("Number of members"),
  member_role_counts: z.record(z.string(), z.number()).describe(
    "Group members per organization role, joined against the roster (members not in the roster count as unknown)",
  ),
});

const RbacGroupListSchema = z.object({
  groups: z.array(RbacGroupSchema).describe(
    "Enterprise RBAC groups with attached roles and members",
  ),
  role_coverage: z.record(z.string(), z.record(z.string(), z.number()))
    .describe(
      "Per custom role ID: distinct members of the groups carrying it, counted by organization role",
    ),
  role_data_complete: z.boolean().describe(
    "False when any group's role_ids was unavailable, so role_coverage may undercount",
  ),
  count: z.number().describe("Number of groups returned"),
  fetchedAt: z.string().describe("ISO 8601 timestamp of the fetch"),
  durationMs: z.number().optional().describe("Method duration in milliseconds"),
  collectedBy: z.string().optional().describe("Extension that collected this"),
});

const FailureSchema = z.object({
  userId: z.string().describe("User the request was for"),
  email: z.string().describe("User's email address"),
  previousRole: z.string().describe(
    "Member's organization role before the attempt (for rollback)",
  ),
  outcome: z.enum(["failed", "unknown"]).describe(
    "failed: the API rejected the request. unknown: no response (network, timeout, cancel) — the change may have been applied",
  ),
  status: z.number().nullable().describe(
    "HTTP status, or null for no response",
  ),
  error: z.string().describe("Error detail (truncated)"),
});

const GroupMemberChangeSchema = z.object({
  groupId: z.string().describe("Target group ID"),
  groupName: z.string().describe("Target group name"),
  groupRoleIds: z.array(z.string()).describe("Roles attached to the group"),
  dryRun: z.boolean().describe("True when no changes were sent"),
  selection: z.record(z.string(), z.unknown()).describe(
    "How targets were selected (roles or explicit userIds)",
  ),
  targeted: z.number().describe("Members matching the selection"),
  added: z.array(RbacGroupMemberSchema).describe(
    "Members added (or that would be added, on a dry run)",
  ),
  alreadyMember: z.number().describe("Targets already in the group"),
  skippedIneligible: z.array(RbacGroupMemberSchema).describe(
    "Explicit userIds skipped because their role is not user or managed (e.g. privileged)",
  ),
  notFound: z.array(z.string()).describe(
    "Explicit userIds that are not organization members",
  ),
  failed: z.array(FailureSchema).describe(
    "Requests that failed or whose outcome is unknown",
  ),
  aborted: z.string().nullable().describe(
    "Why the run stopped early, or null if it ran to completion",
  ),
  fetchedAt: z.string().describe("ISO 8601 timestamp the run finished"),
  durationMs: z.number().optional().describe("Method duration in milliseconds"),
  collectedBy: z.string().optional().describe("Extension that collected this"),
});

const RoleChangeEntrySchema = z.object({
  userId: z.string().describe("Member's user ID"),
  email: z.string().describe("Member's email address"),
  previousRole: z.string().describe("Role before the change (for rollback)"),
  newRole: z.string().describe("Role after the change"),
});

const RoleChangeSchema = z.object({
  targetRole: z.string().describe("Role assigned: user or managed"),
  requireGroupId: z.string().nullable().describe(
    "Members had to be in this group to be changed",
  ),
  expectRoleId: z.string().nullable().describe(
    "Custom role the required group was verified to carry",
  ),
  requireRoleId: z.string().nullable().describe(
    "Members had to be in some group carrying this custom role",
  ),
  coveringGroupIds: z.array(z.string()).describe(
    "Groups whose members counted as covered (requireGroupId, or every group carrying requireRoleId)",
  ),
  dryRun: z.boolean().describe("True when no changes were sent"),
  selection: z.record(z.string(), z.unknown()).describe(
    "How targets were selected (fromRoles or explicit userIds)",
  ),
  targeted: z.number().describe("Members matching the selection"),
  changed: z.array(RoleChangeEntrySchema).describe(
    "Members whose role changed (or would change, on a dry run)",
  ),
  alreadyInRole: z.number().describe("Targets already holding targetRole"),
  skippedNotInGroup: z.array(RbacGroupMemberSchema).describe(
    "Targets left unchanged because they are not (or no longer) in requireGroupId, or in no group carrying requireRoleId",
  ),
  skippedIneligible: z.array(RbacGroupMemberSchema).describe(
    "Explicit userIds skipped because their role is not user or managed (e.g. privileged)",
  ),
  notFound: z.array(z.string()).describe(
    "Explicit userIds that are not organization members",
  ),
  failed: z.array(FailureSchema).describe(
    "Requests that failed or whose outcome is unknown",
  ),
  aborted: z.string().nullable().describe(
    "Why the run stopped early, or null if it ran to completion",
  ),
  fetchedAt: z.string().describe("ISO 8601 timestamp the run finished"),
  durationMs: z.number().optional().describe("Method duration in milliseconds"),
  collectedBy: z.string().optional().describe("Extension that collected this"),
});

type Member = z.infer<typeof MemberSchema>;
type GroupMember = z.infer<typeof RbacGroupMemberSchema>;
type Failure = z.infer<typeof FailureSchema>;

// =============================================================================
// API Client
// =============================================================================

const BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 60_000;
/** A retry-after longer than this fails the request instead of waiting. */
const MAX_RETRY_AFTER_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 500;
/** Page cap for every list (1,000 rows per page). Past it the call throws. */
const MAX_PAGES = 50;

/** An Admin API response with a non-2xx status after retries. */
export class AdminApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
    /** An earlier attempt got no reply or a 5xx, so it may have been applied. */
    readonly ambiguous = false,
  ) {
    super(
      `Admin API ${method} ${path}: ${status} ${
        body.slice(0, MAX_ERROR_CHARS)
      }`,
    );
    this.name = "AdminApiError";
  }
}

/** No response from the Admin API after retries (network error or timeout). */
export class AdminNetworkError extends Error {
  constructor(readonly method: string, readonly path: string, cause: unknown) {
    super(`Admin API ${method} ${path}: no response (${String(cause)})`);
    this.name = "AdminNetworkError";
  }
}

/** The run was cancelled; `sent` says whether any attempt reached the network. */
export class AdminCancelledError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly sent: boolean,
  ) {
    super(
      `Admin API ${method} ${path}: cancelled ${
        sent ? "after the request was sent" : "before the request was sent"
      }`,
    );
    this.name = "AdminCancelledError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Admin API client for one method execution. Spaces requests to stay under
 * `requestsPerMinute`, times out each request, and retries 429, 5xx, and
 * no-response failures, honoring `retry-after` and otherwise backing off
 * exponentially. Every write the API offers is safe to repeat.
 */
export class AdminClient {
  private nextAt = 0;
  private readonly intervalMs: number;

  constructor(
    private readonly key: string,
    requestsPerMinute: number,
    private readonly signal?: AbortSignal,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    private readonly backoffBaseMs = 1000,
  ) {
    this.intervalMs = Math.ceil(60_000 / requestsPerMinute);
  }

  /** Wait for this request's slot. */
  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = this.nextAt - now;
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
    if (wait > 0) await sleep(wait, this.signal);
  }

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<any> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== "") url.searchParams.set(k, v);
    }
    let sent = false;
    let ambiguous = false;
    // Every wait honors cancellation; report whether anything went out.
    const wait = async (ms: number) => {
      try {
        if (ms < 0) await this.pace();
        else await sleep(ms, this.signal);
      } catch (err) {
        if (this.signal?.aborted) {
          throw new AdminCancelledError(method, path, sent);
        }
        throw err;
      }
    };
    for (let attempt = 0;; attempt++) {
      await wait(-1);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let resp: Response;
      let text: string;
      try {
        sent = true;
        resp = await fetch(url.toString(), {
          method,
          headers: {
            "x-api-key": this.key,
            "anthropic-version": API_VERSION,
            "content-type": "application/json",
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: this.signal
            ? AbortSignal.any([this.signal, timeout])
            : timeout,
        });
        // Read the body under the same timeout and retry path as the request.
        text = await resp.text();
      } catch (err) {
        if (this.signal?.aborted) {
          throw new AdminCancelledError(method, path, sent);
        }
        ambiguous = true;
        if (attempt >= MAX_RETRIES) {
          throw new AdminNetworkError(method, path, err);
        }
        await wait(Math.min(2 ** attempt * this.backoffBaseMs, MAX_BACKOFF_MS));
        continue;
      }
      if (resp.ok) {
        try {
          return text.trim() === "" ? {} : JSON.parse(text);
        } catch {
          throw new AdminApiError(
            method,
            path,
            resp.status,
            `unparseable response body: ${text}`,
            true,
          );
        }
      }
      const transient = resp.status === 429 || resp.status >= 500;
      if (!transient || attempt >= MAX_RETRIES) {
        throw new AdminApiError(method, path, resp.status, text, ambiguous);
      }
      if (resp.status >= 500) ambiguous = true;
      const header = resp.headers.get("retry-after");
      const retryAfter = header === null || header.trim() === ""
        ? NaN
        : Number(header);
      let backoff: number;
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        backoff = retryAfter * 1000;
        if (backoff > MAX_RETRY_AFTER_MS) {
          throw new AdminApiError(method, path, resp.status, text, ambiguous);
        }
      } else {
        backoff = Math.min(2 ** attempt * this.backoffBaseMs, MAX_BACKOFF_MS);
      }
      await wait(backoff);
    }
  }

  /** Member list: ID-based pagination (limit + after_id, until has_more is false). */
  async listMembers(): Promise<Member[]> {
    const path = "/v1/organizations/users";
    const out: Member[] = [];
    let afterId: string | undefined;
    for (let pageNo = 0;; pageNo++) {
      if (pageNo >= MAX_PAGES) {
        throw new Error(
          `${path} has more than ${
            MAX_PAGES * 1000
          } members; refusing to act on a partial roster`,
        );
      }
      const params: Record<string, string> = { limit: "1000" };
      if (afterId) params.after_id = afterId;
      const data = await this.request("GET", path, { params });
      if (!Array.isArray(data?.data) || typeof data?.has_more !== "boolean") {
        throw new Error(
          `${path} returned an unexpected page shape (data array and boolean has_more required); refusing to act on a partial roster`,
        );
      }
      out.push(...data.data.map((u: any) => ({
        id: String(u.id ?? ""),
        email: String(u.email ?? ""),
        name: u.name ?? null,
        role: String(u.role ?? ""),
        added_at: u.added_at ?? null,
      })));
      if (!data.has_more) return out;
      const last = typeof data.last_id === "string" ? data.last_id : undefined;
      if (!last || last === afterId) {
        throw new Error(
          `${path} reported has_more without an advancing last_id; refusing to act on a partial roster`,
        );
      }
      afterId = last;
    }
  }

  /** Group, role, and group-member lists: opaque cursor (next_page → page). */
  async listCursor(path: string): Promise<any[]> {
    const out: any[] = [];
    const seen = new Set<string>();
    let page: string | undefined;
    for (let pageNo = 0;; pageNo++) {
      if (pageNo >= MAX_PAGES) {
        throw new Error(
          `${path} has more than ${MAX_PAGES} pages; refusing to act on a partial list`,
        );
      }
      const params: Record<string, string> = { limit: "1000" };
      if (page) params.page = page;
      const data = await this.request("GET", path, { params });
      if (!Array.isArray(data?.data)) {
        throw new Error(
          `${path} returned no data array; refusing to act on a partial list`,
        );
      }
      out.push(...data.data);
      // An explicit has_more:false ends the list even when a next_page token
      // is present (the API reference shows both together).
      if (data.has_more === false) return out;
      const next = typeof data.next_page === "string" && data.next_page !== ""
        ? data.next_page
        : undefined;
      if (!next) {
        if (data.has_more === true) {
          throw new Error(
            `${path} reported has_more without a next_page cursor; refusing to act on a partial list`,
          );
        }
        return out;
      }
      if (seen.has(next)) {
        throw new Error(
          `${path} returned a repeating next_page cursor; refusing to act on a partial list`,
        );
      }
      seen.add(next);
      page = next;
    }
  }

  async listGroupMembers(groupId: string): Promise<GroupMember[]> {
    const items = await this.listCursor(
      `/v1/organizations/rbac_groups/${encodeURIComponent(groupId)}/members`,
    );
    // Deduplicate: coverage checks compare counts, and a repeated row would
    // hide a missing member.
    const byId = new Map<string, GroupMember>();
    for (const m of items) {
      const id = String(m.user_id ?? "");
      if (!byId.has(id)) {
        byId.set(id, { user_id: id, email: String(m.email ?? "") });
      }
    }
    return [...byId.values()];
  }

  /**
   * Every group carrying `roleId`. Throws when any group's role data is
   * unavailable (a group might carry the role without showing it) or when no
   * group carries it.
   */
  async listGroupsCarrying(roleId: string): Promise<string[]> {
    const groups = await this.listCursor("/v1/organizations/rbac_groups");
    const unknown = groups.filter((g) => !Array.isArray(g?.role_ids));
    if (unknown.length > 0) {
      throw new Error(
        `Role data unavailable for ${unknown.length} group(s) (${
          unknown.map((g) => g?.id).join(", ")
        }); retry`,
      );
    }
    const ids = groups.filter((g) => g.role_ids.includes(roleId)).map((g) =>
      String(g.id)
    );
    if (ids.length === 0) {
      throw new Error(`No group carries role ${roleId}`);
    }
    return ids;
  }

  /**
   * Read a group and verify it carries `expectRoleId` (when given). Throws when
   * role data is temporarily unavailable (`role_ids: null`) rather than
   * treating it as "no roles".
   */
  async getGroupWithRoles(
    groupId: string,
    expectRoleId?: string,
  ): Promise<{ name: string; sourceType: string; roleIds: string[] }> {
    const g = await this.request(
      "GET",
      `/v1/organizations/rbac_groups/${encodeURIComponent(groupId)}`,
    );
    const name = String(g?.name ?? groupId);
    if (!Array.isArray(g?.role_ids)) {
      throw new Error(
        `Role data for group ${name} (${groupId}) is unavailable (role_ids is ${
          JSON.stringify(g?.role_ids)
        }); retry`,
      );
    }
    const roleIds: string[] = g.role_ids;
    if (expectRoleId && !roleIds.includes(expectRoleId)) {
      throw new Error(
        `Group ${name} does not carry role ${expectRoleId} (attached: ${
          roleIds.join(", ") || "none"
        }); attach it in claude.ai first`,
      );
    }
    return { name, sourceType: String(g?.source_type ?? ""), roleIds };
  }
}

function clientFor(ctx: ModelContext): AdminClient {
  return new AdminClient(
    ctx.globalArgs.adminKey,
    ctx.globalArgs.requestsPerMinute ?? 80,
    ctx.signal,
  );
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

const roleCounts = (members: Member[]) => countBy(members.map((m) => m.role));

const isAssignable = (role: string) =>
  (ASSIGNABLE_ROLES as readonly string[]).includes(role);

/**
 * Resolve targets from the live roster: either every member whose role is in
 * `roles`, or the explicit `userIds`. Only `user` and `managed` members are
 * ever returned.
 */
function selectTargets(
  members: Member[],
  sel: { roles?: string[]; userIds?: string[] },
): { targets: Member[]; skippedIneligible: Member[]; notFound: string[] } {
  const byRole = (sel.roles?.length ?? 0) > 0;
  const byId = (sel.userIds?.length ?? 0) > 0;
  if (byRole === byId) {
    throw new Error("Pass exactly one of roles/fromRoles or userIds");
  }
  if (byRole) {
    const bad = sel.roles!.filter((r) => !isAssignable(r));
    if (bad.length > 0) {
      throw new Error(
        `Refusing to target roles ${bad.join(", ")}: only ${
          ASSIGNABLE_ROLES.join(" and ")
        } members can be changed (${
          PRIVILEGED_ROLES.join(", ")
        } are managed in claude.ai)`,
      );
    }
    return {
      targets: members.filter((m) => sel.roles!.includes(m.role)),
      skippedIneligible: [],
      notFound: [],
    };
  }
  const index = new Map(members.map((m) => [m.id, m]));
  const targets: Member[] = [];
  const skippedIneligible: Member[] = [];
  const notFound: string[] = [];
  for (const id of new Set(sel.userIds)) {
    const m = index.get(id);
    if (!m) notFound.push(id);
    else if (!isAssignable(m.role)) skippedIneligible.push(m);
    else targets.push(m);
  }
  return { targets, skippedIneligible, notFound };
}

const asGroupMember = (m: Member): GroupMember => ({
  user_id: m.id,
  email: m.email,
});

/** Consecutive identical failures that stop a run. */
const ABORT_AFTER_REPEATS = 3;

/**
 * Decides when a write loop should stop: at once on 401/403 (the key cannot
 * do this), or after a run of identical failures (IdP-managed roles, rate
 * limit exhausted, network down), however many writes succeeded before.
 */
class AbortPolicy {
  private streak = 0;
  private lastStatus: number | null | undefined;

  success(): void {
    this.streak = 0;
    this.lastStatus = undefined;
  }

  failure(f: Failure): string | null {
    if (f.status === 401 || f.status === 403) {
      return `Authorization failed (${f.status}): ${f.error}`;
    }
    this.streak = f.status === this.lastStatus ? this.streak + 1 : 1;
    this.lastStatus = f.status;
    if (this.streak >= ABORT_AFTER_REPEATS) {
      return `${this.streak} consecutive requests failed with ${
        f.status ?? "no response"
      }: ${f.error}`;
    }
    return null;
  }
}

/**
 * `failed` only when the API definitively rejected the request (4xx, 429)
 * and no earlier attempt could have been applied.
 * No response, a 5xx (often a gateway), or an unreadable 2xx may mean the
 * change was applied, so those are `unknown`.
 */
function failureOf(m: Member, err: unknown): Failure {
  const status = err instanceof AdminApiError ? err.status : null;
  const detail = err instanceof AdminApiError ? err.body : String(err);
  const rejected = status !== null && status >= 400 && status < 500 &&
    !(err as AdminApiError).ambiguous;
  return {
    userId: m.id,
    email: m.email,
    previousRole: m.role,
    outcome: rejected ? "failed" : "unknown",
    status,
    error: detail.slice(0, MAX_ERROR_CHARS),
  };
}

const cancelledInFlight = (m: Member): Failure => ({
  userId: m.id,
  email: m.email,
  previousRole: m.role,
  outcome: "unknown",
  status: null,
  error: "Cancelled while the request was in flight",
});

/**
 * Deterministic per mode: dry runs and applies never share an instance, so a
 * later dry run cannot become the latest apply record. Every run is a new
 * version of its instance, kept by the spec's garbageCollection count.
 */
const runMode = (dryRun: boolean) => (dryRun ? "dryrun" : "apply");

/** Run-record versions kept per instance (each version is one run). */
const AUDIT_VERSIONS = 1000;

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  };
};

const meta = (startMs: number) => ({
  fetchedAt: new Date().toISOString(),
  durationMs: Date.now() - startMs,
  collectedBy: EXTENSION_NAME,
});

// =============================================================================
// Model Definition
// =============================================================================

const RoleListArg = z.array(z.string().min(1));
const UserIdListArg = z.array(
  z.string().regex(/^user_/, "user IDs start with user_"),
);

/** Re-read the required group's membership this often during a role run. */
const GROUP_RECHECK_EVERY = 100;

/** Claude Enterprise Admin API — members, custom roles, and RBAC groups. */
export const model = {
  type: "@webframp/anthropic/admin",
  version: "2026.10.20.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],

  resources: {
    members: {
      description: "Organization members and their organization roles",
      schema: MemberListSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
    rbacRoles: {
      description: "Custom roles defined in the organization",
      schema: RbacRoleListSchema,
      lifetime: "24h" as const,
      garbageCollection: 10,
    },
    rbacGroups: {
      description: "RBAC groups with attached custom roles and members",
      schema: RbacGroupListSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
    groupMemberChanges: {
      description:
        "Result of add_group_members runs (audit record; one version per run, dry runs and applies in separate instances)",
      schema: GroupMemberChangeSchema,
      lifetime: "infinite" as const,
      garbageCollection: AUDIT_VERSIONS,
    },
    roleChanges: {
      description:
        "Result of set_member_roles runs, with previous roles for rollback (audit record; one version per run, dry runs and applies in separate instances)",
      schema: RoleChangeSchema,
      lifetime: "infinite" as const,
      garbageCollection: AUDIT_VERSIONS,
    },
  },

  methods: {
    sync_members: {
      description:
        "Read every organization member with their organization role (read-only).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const members = await clientFor(ctx).listMembers();
        const handle = await ctx.writeResource("members", "members", {
          members,
          count: members.length,
          roleCounts: roleCounts(members),
          ...meta(startMs),
        });
        ctx.logger.info("Synced {count} members: {roles}", {
          count: members.length,
          roles: JSON.stringify(roleCounts(members)),
        });
        return { dataHandles: [handle] };
      },
    },

    sync_access: {
      description:
        "Fan-out, read-only: members, custom roles, and every RBAC group with its attached roles and members, in one call.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) => {
        const startMs = Date.now();
        const client = clientFor(ctx);
        // Read everything before writing anything, so a late failure cannot
        // leave a fresh roster next to stale groups.
        const members = await client.listMembers();
        const roleItems = await client.listCursor(
          "/v1/organizations/rbac_roles",
        );
        const roles = roleItems.map((r) => ({
          id: String(r.id ?? ""),
          name: String(r.display_name ?? r.name ?? ""),
        }));
        const roleName = new Map(roles.map((r) => [r.id, r.name]));
        const orgRole = new Map(members.map((m) => [m.id, m.role]));
        const groupItems = await client.listCursor(
          "/v1/organizations/rbac_groups",
        );
        const groups = [];
        for (const g of groupItems) {
          const id = String(g.id ?? "");
          const groupMembers = await client.listGroupMembers(id);
          const roleIds: string[] | null = Array.isArray(g.role_ids)
            ? g.role_ids
            : null;
          groups.push({
            id,
            name: String(g.name ?? ""),
            source_type: String(g.source_type ?? ""),
            role_ids: roleIds,
            role_names: (roleIds ?? []).map((r) => roleName.get(r) ?? r),
            members: groupMembers,
            member_count: groupMembers.length,
            member_role_counts: countBy(
              groupMembers.map((m) => orgRole.get(m.user_id) ?? "unknown"),
            ),
          });
        }
        const roleCoverage: Record<string, Record<string, number>> = {};
        for (const r of roles) {
          const ids = new Set<string>();
          for (const g of groups) {
            if (g.role_ids?.includes(r.id)) {
              for (const m of g.members) ids.add(m.user_id);
            }
          }
          roleCoverage[r.id] = countBy(
            [...ids].map((id) => orgRole.get(id) ?? "unknown"),
          );
        }
        const handles = [
          await ctx.writeResource("members", "members", {
            members,
            count: members.length,
            roleCounts: roleCounts(members),
            ...meta(startMs),
          }),
          await ctx.writeResource("rbacRoles", "rbacRoles", {
            roles,
            count: roles.length,
            ...meta(startMs),
          }),
          await ctx.writeResource("rbacGroups", "rbacGroups", {
            groups,
            role_coverage: roleCoverage,
            role_data_complete: groups.every((g) => g.role_ids !== null),
            count: groups.length,
            ...meta(startMs),
          }),
        ];
        ctx.logger.info(
          "Synced access: {members} members, {roles} roles, {groups} groups",
          {
            members: members.length,
            roles: roles.length,
            groups: groups.length,
          },
        );
        return { dataHandles: handles };
      },
    },

    add_group_members: {
      description:
        "Add members to a direct RBAC group, selected by organization role (live roster) or explicit user IDs. Skips members already in the group and only ever targets user and managed members. Dry run unless dryRun is false.",
      arguments: z.object({
        groupId: z.string().regex(/^rbac_group_/).describe(
          "Target group (rbac_group_...); must be a direct group",
        ),
        expectRoleId: z.string().regex(/^rbac_role_/).optional().describe(
          "Refuse to run unless this custom role (rbac_role_...) is attached to the group",
        ),
        roles: RoleListArg.optional().describe(
          'Add every member whose organization role is in this list (e.g. ["user","managed"])',
        ),
        userIds: UserIdListArg.optional().describe(
          "Add exactly these members (alternative to roles)",
        ),
        dryRun: z.boolean().default(true).describe(
          "Report what would change without sending writes (default true)",
        ),
      }),
      execute: async (
        args: {
          groupId: string;
          expectRoleId?: string;
          roles?: string[];
          userIds?: string[];
          dryRun?: boolean;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const dryRun = args.dryRun ?? true;
        const client = clientFor(ctx);

        const group = await client.getGroupWithRoles(
          args.groupId,
          args.expectRoleId,
        );
        if (group.sourceType !== "direct") {
          throw new Error(
            `Group ${group.name} (${args.groupId}) has source_type ${group.sourceType}; only direct groups can be changed through the API`,
          );
        }

        const members = await client.listMembers();
        const { targets, skippedIneligible, notFound } = selectTargets(
          members,
          { roles: args.roles, userIds: args.userIds },
        );
        const inGroup = new Set(
          (await client.listGroupMembers(args.groupId)).map((m) => m.user_id),
        );
        const toAdd = targets.filter((m) => !inGroup.has(m.id));
        let alreadyMember = targets.length - toAdd.length;

        ctx.logger.info(
          "{mode}: {toAdd} of {targeted} targets to add to {group} ({already} already members)",
          {
            mode: dryRun ? "Dry run" : "Applying",
            toAdd: toAdd.length,
            targeted: targets.length,
            group: group.name,
            already: alreadyMember,
          },
        );

        const added: GroupMember[] = [];
        const failed: Failure[] = [];
        let aborted: string | null = null;
        if (dryRun) {
          added.push(...toAdd.map(asGroupMember));
        } else {
          const policy = new AbortPolicy();
          for (const m of toAdd) {
            if (ctx.signal?.aborted) {
              aborted = "Cancelled";
              break;
            }
            try {
              await client.request(
                "POST",
                `/v1/organizations/rbac_groups/${
                  encodeURIComponent(args.groupId)
                }/members`,
                { body: { user_id: m.id } },
              );
              added.push(asGroupMember(m));
              policy.success();
            } catch (err) {
              if (ctx.signal?.aborted) {
                // Record only a request that may have reached the API.
                if (!(err instanceof AdminCancelledError) || err.sent) {
                  failed.push(cancelledInFlight(m));
                }
                aborted = "Cancelled";
                break;
              }
              // 400 "already" for a member who joined the group after our
              // read, or for a retry of an add the server had already applied
              // (an earlier attempt got no reply or a 5xx). The second is our
              // change and belongs in the audit record.
              if (
                err instanceof AdminApiError && err.status === 400 &&
                /already/i.test(err.body)
              ) {
                if (err.ambiguous) added.push(asGroupMember(m));
                else alreadyMember++;
                policy.success();
                continue;
              }
              const f = failureOf(m, err);
              failed.push(f);
              aborted = policy.failure(f);
              if (aborted) break;
            }
            if (added.length > 0 && added.length % 100 === 0) {
              ctx.logger.info("Added {n} of {total}", {
                n: added.length,
                total: toAdd.length,
              });
            }
          }
        }

        // Written even on failure: this is the audit record of what changed.
        const handle = await ctx.writeResource(
          "groupMemberChanges",
          `add:${args.groupId}:${runMode(dryRun)}`,
          {
            groupId: args.groupId,
            groupName: group.name,
            groupRoleIds: group.roleIds,
            dryRun,
            selection: args.userIds?.length
              ? { userIds: args.userIds }
              : { roles: args.roles },
            targeted: targets.length,
            added,
            alreadyMember,
            skippedIneligible: skippedIneligible.map(asGroupMember),
            notFound,
            failed,
            aborted,
            ...meta(startMs),
          },
        );
        ctx.logger.info(
          "{mode} {group}: {added} added, {already} already members, {failed} failed, record {record}",
          {
            mode: dryRun ? "Dry run" : "Done",
            group: group.name,
            added: added.length,
            already: alreadyMember,
            failed: failed.length,
            record: handle.name,
          },
        );
        if (aborted || failed.length > 0) {
          throw new Error(
            `add_group_members to ${group.name}: ${added.length} added, ${failed.length} failed${
              aborted ? ` (stopped: ${aborted})` : ""
            }; details in ${handle.name}`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    set_member_roles: {
      description:
        "Set members' organization role to user or managed (Custom), selected by current role (live roster) or explicit user IDs. Switching to managed requires coverage: either requireGroupId + expectRoleId (the group must carry the role; only its members change) or requireRoleId (only members of some group carrying the role change), so nobody becomes Custom without it. Records previous roles for rollback. Dry run unless dryRun is false.",
      arguments: z.object({
        role: z.enum(ASSIGNABLE_ROLES).describe("Role to assign"),
        fromRoles: RoleListArg.optional().describe(
          'Change every member whose current role is in this list (e.g. ["user"])',
        ),
        userIds: UserIdListArg.optional().describe(
          "Change exactly these members (alternative to fromRoles; use for rollback)",
        ),
        requireGroupId: z.string().regex(/^rbac_group_/).optional().describe(
          "Only change members who are in this group. Required when role is managed.",
        ),
        expectRoleId: z.string().regex(/^rbac_role_/).optional().describe(
          "Custom role requireGroupId must carry.",
        ),
        requireRoleId: z.string().regex(/^rbac_role_/).optional().describe(
          "Only change members who are in some group carrying this custom role (alternative to requireGroupId + expectRoleId).",
        ),
        dryRun: z.boolean().default(true).describe(
          "Report what would change without sending writes (default true)",
        ),
      }),
      execute: async (
        args: {
          role: "user" | "managed";
          fromRoles?: string[];
          userIds?: string[];
          requireGroupId?: string;
          expectRoleId?: string;
          requireRoleId?: string;
          dryRun?: boolean;
        },
        ctx: ModelContext,
      ) => {
        const startMs = Date.now();
        const dryRun = args.dryRun ?? true;
        if (args.requireRoleId && (args.requireGroupId || args.expectRoleId)) {
          throw new Error(
            "Pass requireRoleId or requireGroupId + expectRoleId, not both",
          );
        }
        if (args.expectRoleId && !args.requireGroupId) {
          throw new Error("expectRoleId needs requireGroupId");
        }
        if (
          args.role === "managed" && !args.requireRoleId &&
          (!args.requireGroupId || !args.expectRoleId)
        ) {
          throw new Error(
            "role managed requires requireRoleId, or requireGroupId and expectRoleId: a Custom member gets only the roles on their groups",
          );
        }
        const client = clientFor(ctx);
        let coveringGroupIds: string[] = [];
        const members = await client.listMembers();
        const { targets, skippedIneligible, notFound } = selectTargets(
          members,
          { roles: args.fromRoles, userIds: args.userIds },
        );

        // Covered = member of any covering group. Every read re-verifies the
        // role: with requireGroupId the group must still carry expectRoleId
        // (it throws otherwise); with requireRoleId the covering groups are
        // re-derived, so a group losing the role stops covering its members.
        const readGroup = async () => {
          if (args.requireRoleId) {
            coveringGroupIds = await client.listGroupsCarrying(
              args.requireRoleId,
            );
          } else {
            await client.getGroupWithRoles(
              args.requireGroupId!,
              args.expectRoleId,
            );
            coveringGroupIds = [args.requireGroupId!];
          }
          const ids = new Set<string>();
          for (const g of coveringGroupIds) {
            for (const m of await client.listGroupMembers(g)) {
              ids.add(m.user_id);
            }
          }
          return ids;
        };
        const covered = Boolean(args.requireGroupId || args.requireRoleId);
        let inGroup: Set<string> | null = covered ? await readGroup() : null;
        const alreadyInRole =
          targets.filter((m) => m.role === args.role).length;
        const candidates = targets.filter((m) => m.role !== args.role);
        const skippedNotInGroup: Member[] = inGroup
          ? candidates.filter((m) => !inGroup!.has(m.id))
          : [];
        const toChange = inGroup
          ? candidates.filter((m) => inGroup!.has(m.id))
          : candidates;

        ctx.logger.info(
          "{mode}: {n} of {targeted} targets to set to {role} ({skipped} not in required group, {already} already {role})",
          {
            mode: dryRun ? "Dry run" : "Applying",
            n: toChange.length,
            targeted: targets.length,
            role: args.role,
            skipped: skippedNotInGroup.length,
            already: alreadyInRole,
          },
        );

        const changed: z.infer<typeof RoleChangeEntrySchema>[] = [];
        const failed: Failure[] = [];
        let aborted: string | null = null;
        const entry = (m: Member) => ({
          userId: m.id,
          email: m.email,
          previousRole: m.role,
          newRole: args.role,
        });
        if (dryRun) {
          changed.push(...toChange.map(entry));
        } else {
          const policy = new AbortPolicy();
          let attempted = 0;
          let recheckedAt = 0;
          for (const m of toChange) {
            if (ctx.signal?.aborted) {
              aborted = "Cancelled";
              break;
            }
            // A member removed from the group mid-run must not become Custom.
            if (inGroup && attempted - recheckedAt >= GROUP_RECHECK_EVERY) {
              recheckedAt = attempted;
              try {
                inGroup = await readGroup();
              } catch (err) {
                if (ctx.signal?.aborted) {
                  aborted = "Cancelled";
                  break;
                }
                aborted = `Could not re-read covering groups: ${
                  String(err).slice(0, MAX_ERROR_CHARS)
                }`;
                break;
              }
            }
            if (inGroup && !inGroup.has(m.id)) {
              skippedNotInGroup.push(m);
              continue;
            }
            attempted++;
            try {
              const res = await client.request(
                "POST",
                `/v1/organizations/users/${encodeURIComponent(m.id)}`,
                { body: { role: args.role } },
              );
              if (res?.role !== args.role) {
                const f: Failure = {
                  userId: m.id,
                  email: m.email,
                  previousRole: m.role,
                  outcome: "unknown",
                  status: null,
                  error: `API returned role ${
                    JSON.stringify(res?.role)
                  } after update`,
                };
                failed.push(f);
                aborted = policy.failure(f);
                if (aborted) break;
                continue;
              }
              changed.push(entry(m));
              policy.success();
            } catch (err) {
              if (ctx.signal?.aborted) {
                // Record only a request that may have reached the API.
                if (!(err instanceof AdminCancelledError) || err.sent) {
                  failed.push(cancelledInFlight(m));
                }
                aborted = "Cancelled";
                break;
              }
              const f = failureOf(m, err);
              failed.push(f);
              aborted = policy.failure(f);
              if (aborted) break;
            }
            if (changed.length > 0 && changed.length % 100 === 0) {
              ctx.logger.info("Changed {n} of {total}", {
                n: changed.length,
                total: toChange.length,
              });
            }
          }
        }

        // Written even on failure: previousRole is what a rollback needs.
        const handle = await ctx.writeResource(
          "roleChanges",
          `roles:${args.role}:${runMode(dryRun)}`,
          {
            targetRole: args.role,
            requireGroupId: args.requireGroupId ?? null,
            expectRoleId: args.expectRoleId ?? null,
            requireRoleId: args.requireRoleId ?? null,
            coveringGroupIds,
            dryRun,
            selection: args.userIds?.length
              ? { userIds: args.userIds }
              : { fromRoles: args.fromRoles },
            targeted: targets.length,
            changed,
            alreadyInRole,
            skippedNotInGroup: skippedNotInGroup.map(asGroupMember),
            skippedIneligible: skippedIneligible.map(asGroupMember),
            notFound,
            failed,
            aborted,
            ...meta(startMs),
          },
        );
        ctx.logger.info(
          "{mode}: {changed} set to {role}, {skipped} skipped (not in group), {failed} failed, record {record}",
          {
            mode: dryRun ? "Dry run" : "Done",
            changed: changed.length,
            role: args.role,
            skipped: skippedNotInGroup.length,
            failed: failed.length,
            record: handle.name,
          },
        );
        if (aborted || failed.length > 0) {
          throw new Error(
            `set_member_roles ${args.role}: ${changed.length} changed, ${failed.length} failed${
              aborted ? ` (stopped: ${aborted})` : ""
            }; details in ${handle.name}`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
