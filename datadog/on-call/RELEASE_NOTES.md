## 2026.11.05.2

**Fixed:** Path-scoped list methods (those that take a path parameter such as a
metric name, team, or rule ID) now key their stored resource instance on that
path parameter instead of the constant `"main"`. Previously, calling such a
method for one scope and then another silently overwrote the first scope's
result under the shared `"main"` instance, and the stored resource carried no
indication of which scope it held. Each scope now writes its own instance.

**Upgrade note:** Any data earlier versions wrote under the `"main"` instance
for a path-scoped list remains there; new runs write under the scope-derived
name. Global (unscoped) lists are unchanged. No schema change — stored data
continues to validate.

## 2026.11.05.1

**Added:** Regenerated from the current Datadog OpenAPI spec. New read methods
`list_on_call_pages`, `get_on_call_page`, and
`list_on_call_escalation_policies`, with matching `on_call_pages`,
`on_call_page`, and `on_call_escalation_policies` resources.

**Upgrade note:** Additive only — existing methods, arguments, and resource
schemas are unchanged, so stored data continues to validate. No migration
required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows how to store the API key and application key
in a `datadog` vault and wire them with `${{ vault.get("datadog", "API_KEY") }}`
and `${{ vault.get("datadog", "APP_KEY") }}`. The previous example passed
`DD_API_KEY` and `DD_APP_KEY` as literal global arguments, which swamp rejects
for sensitive arguments.

**Changed:** The `apiKey` and `appKey` descriptions now say to supply them with
a `vault.get` expression. Both were already marked sensitive.

**Upgrade note:** Documentation and argument descriptions only. Methods,
arguments, resource schemas and stored data are unchanged.
