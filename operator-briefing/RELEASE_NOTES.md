## 2026.09.25.1

**Added:** The briefing contract now carries jev (`@swamp/typesafe-ai`)
enrichment on queue items as `QueueItem.jev` — advisory and additive. Base
per-item `triage-*` answers are joined onto the matching queue item by
reference: MR review `recommendation` (approve / comment / request_changes),
Renovate `bumpRisk`, and Redmine issue assessment (`issueType`, `sourceDomain`,
`describesVulnerability`). A described improper-access mechanism
(`describesVulnerability` noul >= 0.5) also emits an explicit
`issue-vulnerability` ops signal (critical >= 0.75, else warn) so the contract
itself flags it. The markdown queue table gains a `jev` column, shown only for
tiers with enrichment and only for choices at confidence >= 0.5.

**Changed:** The `@swamp/typesafe-ai` normalizer now collects per-item
`triage-*` answers for this advisory attachment instead of discarding them; it
still emits no queue/ops noise for ordinary triage answers.

**Fixed:** A workflow step the engine SKIPPED (its guard fired — e.g. jev
triage guarded off an empty queue) no longer counts as a source failure or
marks the contract `degraded`. This surfaced when the briefing split into a
cheap read-only workflow whose jev grade/assessment steps routinely skip on an
empty queue or no held-back Renovate MRs.

**Note:** jev enrichment is strictly advisory. It NEVER reorders or re-tiers the
queue — deterministic tiering and the existing verified-batch ordering are
unchanged (operator decision, 2026-09-25). The JSON contract is additive: no
field was removed, and all `jev` fields are optional, so existing consumers keep
working and opt in when ready. Raw low-confidence answers remain in the JSON;
only the markdown suppresses labels below 0.5 confidence.

## 2026.09.24.2

**Fixed:** The packaged TypeSafe briefing workflow now preserves the CEL
projection for `triage_batch` as an array-valued input. Previously YAML's
folded scalar form coerced the projection to a string, so queue collection
succeeded but TypeSafe triage failed input validation.

## 2026.09.24.1

**Added:** `triage_batch`, an extension method on `@swamp/typesafe-ai` for
bounded, per-queue TypeSafe evaluation, plus the packaged
`@webframp/daily-briefing-typesafe` workflow. A batch stores answers and
partial-failure status only—never raw item state or question text.

**Fixed:** TypeSafe briefing verdicts now include compact factual evidence
from their projected source state. Security evidence uses the Security Hub
account map to render friendly names only; an unmapped account ID is never
shown. A failed TypeSafe `ask` step now emits a degraded interpretation signal
instead of being mistaken for a clean verdict; expected skipped triage does not.

**Changed:** Each batch carries a deterministic SHA-256 `sourceFingerprint` of
its compact queue. Consumers must verify it before use; on a mismatch or a
partial batch failure, use deterministic queue ordering rather than an old or
incomplete AI classification.

**Upgrade note:** Pull `@swamp/typesafe-ai@2026.09.15.1` and
`@webframp/gitlab@2026.09.23.1` with this release. Existing per-item
`triage-*` resources remain readable; migrate consumers to `triage_batch`.
