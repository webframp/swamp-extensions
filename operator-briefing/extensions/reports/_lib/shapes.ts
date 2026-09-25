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
  /**
   * Deep link to the item (MR `webUrl` / todo `targetUrl`), so a renderer can
   * make the reference clickable. Undefined when the source carries no URL —
   * never fabricated.
   */
  url?: string;
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
  /**
   * jev (`@swamp/typesafe-ai`) enrichment, attached by the report after
   * normalizers run. ADVISORY AND ADDITIVE ONLY: these fields are rendered next
   * to the deterministic facts but NEVER reorder the queue or change a tier.
   * Absent when no jev grade exists for this item (the common case).
   *
   * jev judges only the item's described content (an MR's visible fields, an
   * issue's subject + description) — never tracker/priority/author/date
   * metadata. The report join renders the answers; it does not re-introduce
   * metadata into the judgment.
   */
  jev?: {
    /** MR review recommendation (from `triage_reviews`). */
    recommendation?: { choice: string; confidence: number };
    /** Renovate held-back bump-risk grade (from `renovate_grade`). */
    bumpRisk?: { score: number; confidence: number };
    /** Redmine issue type (from `issue_assessment`). */
    issueType?: { choice: string; confidence: number };
    /** Redmine issue architectural domain (from `issue_assessment`). */
    sourceDomain?: { choice: string; confidence: number };
    /**
     * Strict 0/1 probability that the issue text describes a specific,
     * concrete improper-access mechanism. A noul — no confidence field. When
     * >= 0.5, renderers surface it prominently as an explicit jev flag; it does
     * NOT reorder or re-tier the item (operator decision, 2026-09-25).
     */
    describesVulnerability?: number;
  };
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
  /**
   * Structured, chartable facts backing this signal — the AWS quota rows for a
   * utilization or pending signal. One shape spans both kinds; only the fields
   * relevant to the kind are set (utilization sets `utilizationPct`/`usageValue`
   * /`value`/`adjustable`; pending sets `serviceCode`/`desiredValue`/`status`).
   * REDACTED: never carries an account identifier (`profile`, `accountId`,
   * `requestId`, `caseId`, or a bare account number) — CLAUDE.md forbids
   * exposing internal account IDs. Empty/absent when the fetch was degraded
   * (nothing was actually observed).
   *
   * `kind` discriminates the two row shapes so a consumer iterating entries
   * without the parent signal's label never misreads a pending row's absent
   * `utilizationPct` as `0`.
   */
  entries?: Array<{
    kind: "utilization" | "pending";
    quotaName: string;
    utilizationPct?: number;
    usageValue?: number;
    value?: number;
    adjustable?: boolean;
    serviceCode?: string;
    desiredValue?: number;
    status?: string;
  }>;
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
 * Read-only enrichment shared by normalizers for one briefing run.
 *
 * Account identifiers never leave this map. Normalizers may use it to render a
 * friendly account name, but must omit an unmapped identifier rather than
 * falling back to the raw value.
 */
export interface NormalizerContext {
  accountNames: ReadonlyMap<string, string>;
  /** Fingerprint of this run's compact GitLab queue, when present. */
  triageFingerprint?: string;
  /** Verified TypeSafe answers, keyed by MR reference, used only for ordering. */
  triageAnswers?: Map<string, Record<string, unknown>>;
  /**
   * jev triage/grade/assessment answers keyed by item id (MR reference or
   * `string(issue.id)`), collected from base `triage-*` resources for ADVISORY
   * ATTACHMENT ONLY. The report joins these onto queue items as `QueueItem.jev`
   * after normalizers run; they never feed ordering (distinct from
   * `triageAnswers`, which the verified batch path uses for within-tier
   * ordering). Each value is the raw `content.answers` map, partitioned by the
   * caller on its answer-key set.
   */
  jevAnswers?: Map<string, Record<string, unknown>>;
}

/**
 * A normalizer turns the parsed data resources of one workflow step into a
 * `Contribution`. Registered by `modelType` in the registry.
 */
export type Normalizer = (
  inputs: SourceInput[],
  context?: NormalizerContext,
) => Contribution;

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
