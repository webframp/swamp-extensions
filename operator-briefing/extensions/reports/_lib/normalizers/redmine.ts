/**
 * Normalizer: @webframp/redmine -> QueueItem[] + OpsSignal[].
 *
 * `list_issues` with `assignedToId: "me"` produces a cross-project list of
 * open issues assigned to the operator. These are rendered as tier-1 queue
 * items (work waiting on you) plus an ops signal with the total count.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { ageDays, freshness } from "../freshness.ts";
import type {
  Contribution,
  OpsSignal,
  QueueItem,
  SourceInput,
} from "../shapes.ts";

const SOURCE = "redmine";
const MAX_AGE_HOURS = 24;

interface RedmineIssue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assignedTo: { id: number; name: string } | null;
  subject: string;
  updatedOn: string;
  createdOn: string;
}

export function redmineNormalizer(inputs: SourceInput[]): Contribution {
  const queue: QueueItem[] = [];
  const ops: OpsSignal[] = [];
  const notes: string[] = [];

  for (const { data } of inputs) {
    const fetchedAt = typeof data.fetchedAt === "string"
      ? data.fetchedAt
      : null;
    const { stale } = freshness(fetchedAt, MAX_AGE_HOURS);

    const issues = Array.isArray(data.issues)
      ? (data.issues as RedmineIssue[])
      : [];

    // Emit an ops signal with the issue count
    const count = issues.length;
    ops.push({
      source: SOURCE,
      label: "assigned",
      severity: count > 10 ? "warn" : count > 0 ? "info" : "ok",
      detail: count === 0
        ? "no open issues assigned"
        : `${count} open issue(s) assigned`,
      fetchedAt,
      stale,
      degraded: false,
    });

    // Emit queue items for each issue (tier 1 for urgent/immediate, tier 2 otherwise)
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || !issue.id) continue;

      const dateStr = issue.updatedOn ?? issue.createdOn;
      const age = dateStr ? ageDays(dateStr) : 0;
      const priorityName = issue.priority?.name?.toLowerCase() ?? "";
      const isUrgent = priorityName === "urgent" ||
        priorityName === "immediate";
      const tier = isUrgent ? 1 : 2;

      queue.push({
        tier,
        source: SOURCE,
        // TODO: extend QueueItem.kind union to include "issue" for Redmine
        // items. Using "todo" for now as the type constrains to "mr" | "todo".
        kind: "todo",
        reference: `${issue.project?.name ?? "?"}#${issue.id}`,
        title: issue.subject ?? `#${issue.id}`,
        who: issue.author?.name ?? "unknown",
        ageDays: Number.isFinite(age) ? age : 0,
        stale: age > 7,
        actionHint: "resolve",
      });
    }
  }

  if (ops.length === 0) {
    notes.push("Redmine: no recognizable data shape in step output.");
  }

  return { queue, ops, notes };
}
