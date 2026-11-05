## 2026.11.05.1

**Changed:** The `aggregate_logs` action now wraps its stored instance name in
`sanitizeInstanceName` and keys its no-`id` fallback on the resource name rather
than the method name. `aggregate_logs` takes no path parameter, so the fallback
remains a single stable instance — this is a consistency/hardening change, not a
behavioral one.

**Upgrade note:** No schema change; stored data continues to validate. No
migration required.

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
