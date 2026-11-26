## 2026.11.26.1

**Added:** Optional `cases` and `hasCase` fields on security signal attributes,
reporting the cases linked to a signal, regenerated from the current Datadog v2
OpenAPI spec.

**Upgrade note:** Additive only. The new fields are optional, so stored signals
written by earlier versions still validate.
