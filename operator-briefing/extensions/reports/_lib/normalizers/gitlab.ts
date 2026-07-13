/**
 * Normalizer: @webframp/gitlab dashboard -> QueueItem[].
 *
 * Applies the daily-briefing design §3 tiering and the accuracy rules the old
 * review_dashboard ignored: dedup MRs on `reference`, fold assigned∩authored
 * into tier 4, and DROP items already approved by the operator
 * (`approvedByMe === true` / `myReviewState === "approved"`). Drafts awaiting
 * review are held out of the action list and surfaced as a note.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { ageDays } from "../freshness.ts";
import type { Contribution, QueueItem, SourceInput, Tier } from "../shapes.ts";

const SOURCE = "gitlab";
/** Waiting longer than this many days flags an item stale (design §3). */
const STALE_DAYS = 7;

interface Mr {
  project?: string;
  iid?: number | null;
  reference?: string | null;
  title?: string;
  author?: string;
  updatedAt?: string;
  draft?: boolean;
  labels?: string[];
  commented?: boolean;
  approvedByMe?: boolean;
  myReviewState?: string | null;
}

interface Todo {
  id?: string;
  action?: string;
  body?: string;
  targetType?: string;
  targetUrl?: string;
  iid?: number | null;
  reference?: string | null;
  author?: string;
  createdAt?: string;
}

/** Parse `Review effort N/5` out of an MR's labels. */
function effortFromLabels(labels?: string[]): number | undefined {
  if (!Array.isArray(labels)) return undefined;
  for (const label of labels) {
    const m = /Review effort (\d)\/5/.exec(String(label));
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Operator has already actioned this MR — do not surface it as waiting. */
function isApproved(mr: Mr): boolean {
  return mr.approvedByMe === true || mr.myReviewState === "approved";
}

/**
 * Canonical dedup key for an MR, or `null` when the MR carries no identity at
 * all (no reference, project, or iid). A `null` MR must never be deduped — two
 * unidentifiable MRs are distinct items, not one collision on `"?"`.
 */
function mrCanonical(mr: Mr): string | null {
  if (mr.reference) return mr.reference;
  if (mr.project) return `${mr.project}!${mr.iid ?? "?"}`;
  if (mr.iid != null) return String(mr.iid);
  return null;
}

/**
 * Derive the canonical `group/project!iid` (MR) or `group/project#iid` (issue)
 * reference from a todo's `targetUrl`, so a todo lacking an explicit
 * `reference` still dedups against the same MR's key form. Returns undefined
 * when the URL is not a recognizable MR/issue path.
 */
function referenceFromTargetUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/.exec(
    url,
  );
  if (!m) return undefined;
  const [, path, kind, iid] = m;
  return kind === "merge_requests" ? `${path}!${iid}` : `${path}#${iid}`;
}

/**
 * A dashboard resource carries the four cross-project arrays; other resources
 * for the same modelType (if any) are ignored.
 */
export function isDashboard(data: Record<string, unknown>): boolean {
  return "reviewing" in data || "assigned" in data || "authored" in data ||
    "todos" in data;
}

export function gitlabNormalizer(inputs: SourceInput[]): Contribution {
  const queue: QueueItem[] = [];
  const notes: string[] = [];
  // References already represented in the queue (MR dedup + todo folding).
  const seen = new Set<string>();
  // Approved MRs — a matching review_requested todo is dropped too.
  const suppressed = new Set<string>();

  for (const { data } of inputs) {
    if (!isDashboard(data)) continue;

    const username = String(data.username ?? "");
    // Non-array inputs (a stray string, number, etc.) must yield zero items,
    // never char-by-char junk — guard every array explicitly.
    const reviewing = Array.isArray(data.reviewing)
      ? data.reviewing as Mr[]
      : [];
    const assigned = Array.isArray(data.assigned) ? data.assigned as Mr[] : [];
    const authored = Array.isArray(data.authored) ? data.authored as Mr[] : [];
    const todos = Array.isArray(data.todos) ? data.todos as Todo[] : [];

    let draftHeld = 0;
    let otherTodos = 0;

    const pushMr = (mr: Mr, tier: Tier, actionHint: string) => {
      const canonical = mrCanonical(mr);
      // Only dedup identifiable MRs; an unidentifiable MR is always unique.
      if (canonical !== null) {
        if (seen.has(canonical)) return;
        seen.add(canonical);
      }
      const days = ageDays(mr.updatedAt);
      queue.push({
        tier,
        source: SOURCE,
        kind: "mr",
        reference: canonical ?? "?",
        title: mr.title ?? "(untitled)",
        who: mr.author ?? "?",
        ageDays: days,
        stale: days > STALE_DAYS,
        effort: effortFromLabels(mr.labels),
        draft: mr.draft === true,
        actionHint,
      });
    };

    // Tier 1 — review requests. Drop already-approved; hold drafts out.
    for (const mr of reviewing) {
      const canonical = mrCanonical(mr);
      if (isApproved(mr)) {
        if (canonical !== null) suppressed.add(canonical);
        continue;
      }
      if (mr.draft === true) {
        draftHeld++;
        // Mark seen so a review_requested todo does not re-add the draft.
        if (canonical !== null) seen.add(canonical);
        continue;
      }
      pushMr(mr, 1, "review");
    }

    // Tier 4 — authored MRs. Processed BEFORE assigned so a self-authored MR
    // present in both is already `seen` as tier 4 and the assigned pass dedups
    // it — the fold no longer depends on a known `username` (design §3 Ref. 1).
    for (const mr of authored) {
      pushMr(mr, 4, "your MR");
    }

    // Tier 2 — assigned AND NOT authored by me. Self-authored assigned MRs fold
    // into tier 4: dedup above handles the common case; the `username` check
    // stays as belt-and-suspenders when the MR is only in `assigned`.
    for (const mr of assigned) {
      if (username && mr.author === username) {
        pushMr(mr, 4, "your MR");
      } else {
        pushMr(mr, 2, "merge/close");
      }
    }

    // Todos. review_requested/directly_addressed -> tier 1, mentioned -> tier 3.
    // Anything already represented by an MR (or suppressed as approved) is skipped.
    for (const todo of todos) {
      // A todo lacking an explicit `reference` still dedups against its MR by
      // deriving the canonical reference from `targetUrl`.
      const canonical = todo.reference ??
        referenceFromTargetUrl(todo.targetUrl);
      const key = String(canonical ?? todo.targetUrl ?? todo.id ?? "");
      if (key && (seen.has(key) || suppressed.has(key))) continue;

      const action = todo.action ?? "";
      let tier: Tier;
      let hint: string;
      if (action === "review_requested") {
        tier = 1;
        hint = "review";
      } else if (action === "directly_addressed") {
        tier = 1;
        hint = "reply";
      } else if (action === "mentioned") {
        tier = 3;
        hint = "reply";
      } else {
        otherTodos++;
        continue;
      }

      if (key) seen.add(key);
      const days = ageDays(todo.createdAt);
      queue.push({
        tier,
        source: SOURCE,
        kind: "todo",
        reference: canonical ?? todo.targetType ?? "(todo)",
        title: todo.body ?? todo.targetType ?? "(todo)",
        who: todo.author ?? "?",
        ageDays: days,
        stale: days > STALE_DAYS,
        actionHint: hint,
      });
    }

    if (draftHeld > 0) {
      notes.push(
        `${draftHeld} draft MR(s) awaiting your review held out (not ready).`,
      );
    }
    if (otherTodos > 0) {
      notes.push(
        `${otherTodos} other todo(s) not shown (access requests, CI, etc.).`,
      );
    }
    if (data.truncated === true) {
      notes.push(
        "GitLab queue truncated — more items exist beyond the page limit.",
      );
    }
  }

  return { queue, ops: [], notes };
}
