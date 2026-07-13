/**
 * Shared data shapes for the operator-briefing report.
 *
 * `QueueItem` and `OpsSignal` are the two flat projections every normalizer
 * produces. They — together with the report's JSON return — are the STABLE
 * CONTRACT downstream renderers (live HTML view, executive R/vellum reports)
 * consume. Treat these types as the durable interface, not the markdown.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** Priority tier from the daily-briefing design §3. */
export type Tier = 1 | 2 | 3 | 4;

/** Ops signal severity, ordered ok < info < warn < critical. */
export type Severity = "ok" | "info" | "warn" | "critical";

/**
 * One actionable item in the operator's queue. GitLab MRs/todos today; Teams
 * `attention` items and GitHub PRs later. The `tier` places it in the four-tier
 * briefing; `actionHint` names the expected next action (review/reply/merge).
 */
export interface QueueItem {
  tier: Tier;
  /** Producing source, e.g. "gitlab". */
  source: string;
  /** "mr" for merge requests, "todo" for GitLab todos. */
  kind: "mr" | "todo";
  /** Canonical reference: `group/project!iid` for MRs, `group/project#iid` for issue todos. */
  reference: string;
  title: string;
  /** The author / requester. */
  who: string;
  ageDays: number;
  /** Waiting longer than the staleness threshold (> 7 days). */
  stale: boolean;
  /** Parsed `Review effort N/5` label, when present. */
  effort?: number;
  draft?: boolean;
  actionHint: string;
}

/**
 * One operational signal (compliance drift, analytics anomaly, AWS quota /
 * pending increase today; Azure/GCP/runway later). `degraded` marks a fetch
 * that failed rather than a real zero; `stale` marks a snapshot older than the
 * freshness budget.
 */
export interface OpsSignal {
  /** Producing source, e.g. "aws-quotas", "analytics", "compliance". */
  source: string;
  /** Short label, e.g. "cost", "seats", "utilization:ec2". */
  label: string;
  severity: Severity;
  detail: string;
  fetchedAt: string | null;
  stale: boolean;
  degraded: boolean;
  degradedReason?: string;
  truncated?: boolean;
}

/** One parsed data resource read from a step's data handle. */
export interface SourceInput {
  dataName: string;
  data: Record<string, unknown>;
}

/** What a single normalizer contributes for one workflow step. */
export interface Contribution {
  queue: QueueItem[];
  ops: OpsSignal[];
  notes: string[];
}

/**
 * A normalizer turns the parsed data resources of one workflow step into a
 * `Contribution`. Registered by `modelType` in the registry.
 */
export type Normalizer = (inputs: SourceInput[]) => Contribution;

/** Human-readable heading per tier. */
export const TIER_LABELS: Record<Tier, string> = {
  1: "Waiting on You",
  2: "Awaiting Your Merge",
  3: "Mentions",
  4: "Your Open MRs",
};

/** An empty contribution, for merging. */
export function emptyContribution(): Contribution {
  return { queue: [], ops: [], notes: [] };
}
