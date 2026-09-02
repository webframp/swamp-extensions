/**
 * Shared kernel for the DevOps cross-boundary measurement extension.
 *
 * This module is NOT a swamp model. It is the anticorruption core the four
 * collector models funnel through: the uniform `event` vocabulary, the single
 * `newEvent` factory, the one cross-boundary predicate, and the deterministic
 * `eventId` used as an event's resource instance name.
 *
 * Design references (measurement-docs/design):
 * - tactical-model.md: `newEvent` is the single most valuable factory; the
 *   event shape is defined in exactly one place.
 * - ubiquitous-language.md: the event-type vocabulary and cross-boundary rule.
 * - swamp-extension-plan.md DR-1/DR-2: shared module (not a model); event
 *   identity is a deterministic instance name so swamp's versioned data
 *   deduplicates re-observations rather than accumulating them.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adding a new collector? Read COLLECTORS.md in this directory — it documents
 * the contract every collector follows (envelope vs. self-contained upstream
 * shapes, identity canonicalization, stable event identity, crew tagging).
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

/**
 * The closed set of activity kinds the system observes. The discriminator that
 * drives weight lookup (scoring) and edge aggregation (graph). Faithful to the
 * Go `event_type` column and `ubiquitous-language.md`.
 */
export const EventTypeEnum = z.enum([
  "mr_review",
  "mr_comment",
  "commit",
  "teams_message",
  "redmine_comment",
  "cloudtrail",
]);

export type EventType = z.infer<typeof EventTypeEnum>;

/**
 * Per-activity-type weights that encode how much a kind of help is worth.
 * Preserved EXACTLY from the Go `config.yaml` — this is core policy
 * (domain-and-subdomains.md): changing a weight changes who the organization
 * believes its force multipliers are, so it is a deliberate decision, never a
 * quiet edit. Exposed here as the canonical default; the scoring model accepts
 * an override map but defaults to these.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<EventType, number>> = Object
  .freeze(
    {
      mr_review: 3,
      mr_comment: 1,
      commit: 4,
      teams_message: 1,
      redmine_comment: 2,
      cloudtrail: 1,
    },
  );

/**
 * The unified activity record — the shared kernel's central type, the swamp
 * equivalent of the Go `events` row / `dbgen.Event`. An event is a fact about
 * the past: immutable once observed, self-describing across contexts, and
 * carrying the identity of its participants by reference (never embedding the
 * crews or users it names).
 *
 * `metadata` carries source-specific residue and the force-multiplier inputs
 * the Go schema left unpopulated (gap 5): for a review, the paired merge
 * timestamp; for a Redmine comment, first-response timing.
 */
export const EventSchema = z.object({
  eventId: z.string().describe(
    "Deterministic content-hash identity of this event (also its resource " +
      "instance name). Stable across re-observation so versioned data " +
      "deduplicates rather than accumulates.",
  ),
  userId: z.string().describe("Actor's stable identifier (the helper)"),
  username: z.string().describe("Actor's username"),
  eventType: EventTypeEnum.describe("What kind of activity this records"),
  sourceCrew: z.string().describe(
    "Crew of the person who performed the activity; empty if unresolved",
  ),
  targetCrew: z.string().default("").describe(
    "Crew that owns the touched resource; empty when none (e.g. CloudTrail)",
  ),
  targetUser: z.string().default("").describe(
    "The specific person helped, when one exists (e.g. the MR author)",
  ),
  projectId: z.string().default("").describe(
    "Source-specific resource id: repo/project, channel, or AWS service name",
  ),
  timestamp: z.string().describe(
    "ISO 8601 time the activity occurred (the fact's time, not observation time)",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}).describe(
    "Source-specific residue and force-multiplier inputs (merge time, etc.)",
  ),
});

export type Event = z.infer<typeof EventSchema>;

/**
 * The single cross-boundary predicate. Source and target crews must both be
 * present and different. Defined here ONCE, resolving the Go duplication
 * (`collectors.IsCrossBoundary` vs `scoring.isCrossBoundary`) that
 * tactical-model.md flags as the highest-risk core smell — this is *the* core
 * invariant, so it lives in exactly one place.
 */
export function isCrossBoundary(
  sourceCrew: string,
  targetCrew: string,
): boolean {
  return sourceCrew !== "" && targetCrew !== "" && sourceCrew !== targetCrew;
}

/**
 * FNV-1a 64-bit hash rendered as a fixed-length hex string. A non-cryptographic
 * hash is the right tool here: an event's resource instance name only needs to
 * be deterministic and collision-resistant enough to key distinct observations
 * apart — not cryptographically secure. Dependency-free and synchronous, unlike
 * SubtleCrypto.
 */
function fnv1a64(input: string): string {
  // 64-bit FNV-1a using BigInt to stay exact across the full 64-bit range.
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Compute an event's deterministic identity from its STABLE identifying fields.
 *
 * Critically this must NOT include mutable fields. For a review, identity is
 * `(projectId, mrIID, approverUserId, "mr_review")` — never the MR's
 * `updatedAt`, which shifts every time the MR changes and would otherwise mint
 * a "new" event for the same review on every collection (the latent
 * double-count bug in the Go source; see swamp-extension-plan.md DR-2/#4).
 *
 * The activity timestamp lives in the event VALUE for windowing, deliberately
 * separate from identity.
 *
 * @param parts Ordered, stable identifying components. Callers pass the fields
 *   that make this observation unique — order matters and must be consistent.
 */
export function eventId(...parts: (string | number)[]): string {
  return fnv1a64(parts.map((p) => String(p)).join("\u0000"));
}

/**
 * Resolve a source-specific actor identifier (a GitLab username, a Redmine
 * display name, a Teams displayName, an IAM username, a git author) to a
 * canonical member id, so the SAME person is ONE userId across all four
 * sources. Without this, alice-in-GitLab, "Alice Smith"-in-Teams, and
 * alice@corp-in-CloudTrail fragment into three scored users.
 *
 * The crew reference is the identity source of truth. `aliases` maps any known
 * source identifier (username, email, display name) to the canonical member
 * username. An unresolved identifier is returned unchanged (and will also fail
 * crew resolution, so it is surfaced via the unresolved-crew count).
 */
export function canonicalActor(
  raw: string,
  aliases: Map<string, string>,
): string {
  return aliases.get(raw) ?? raw;
}

/**
 * The event factory. Every collector funnels through this so the event shape is
 * defined in one place (the swamp-native `collectors.NewEventParams`). Computes
 * the deterministic `eventId` from the caller-supplied stable identity parts.
 *
 * @param identityParts Stable components uniquely identifying this activity,
 *   used to derive the resource instance name. MUST NOT contain mutable values.
 */
export function newEvent(
  fields: {
    userId: string;
    username: string;
    eventType: EventType;
    sourceCrew: string;
    targetCrew?: string;
    targetUser?: string;
    projectId?: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  },
  identityParts: (string | number)[],
): Event {
  return EventSchema.parse({
    eventId: eventId(...identityParts),
    userId: fields.userId,
    username: fields.username,
    eventType: fields.eventType,
    sourceCrew: fields.sourceCrew,
    targetCrew: fields.targetCrew ?? "",
    targetUser: fields.targetUser ?? "",
    projectId: fields.projectId ?? "",
    timestamp: fields.timestamp,
    metadata: fields.metadata ?? {},
  });
}
