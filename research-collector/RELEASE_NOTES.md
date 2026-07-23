## 2026.07.23.1

**Added:** New `digest` method builds a compact daily digest from the latest
research brief: top items per source (normalized 0-100 prominence score),
cross-source topic clusters (keywords appearing in 2+ sources), and a delta
against the previous digest (new vs carried items). Writes a new `digest`
resource (24h lifetime) for downstream journal/briefing workflows.

**Changed:** The model now reads prior resources via the `readResource` context
method. `digest` requires a `gather` run first — it throws if no brief exists.

**Upgrade note:** No changes to the `research` brief schema or existing global
args. Existing instances upgrade in place (no attribute migration needed). The
new `digest` resource is additive and safe to ignore for workflows that only
use `gather`.
