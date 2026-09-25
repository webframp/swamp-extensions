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
