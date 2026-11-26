## 2026.11.26.1

**Changed:** `create_structure_deployment` no longer declares the `code_source`
argument, which the current Griptape OpenAPI spec dropped. The README no longer
lists it as a sensitive argument. Regenerated from that spec.

**Upgrade note:** Callers that pass `code_source` must remove it. Other methods
and stored data are unchanged.
