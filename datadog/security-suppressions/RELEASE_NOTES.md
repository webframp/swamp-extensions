## 2026.11.05.2

**Fixed:** `validate_security_monitoring_suppression` no longer writes an empty
resource under a constant `"created"` instance name. The endpoint returns
`204 No Content`, so there is nothing to persist — the method now issues the
validation call and returns no data handles, and the
`validate_security_monitoring_suppression` resource spec is removed. The request
body is also sent in the correct JSON:API envelope
(`{data: {type: "suppressions", attributes: {...}}}`) the endpoint expects.

**Upgrade note:** `validate_security_monitoring_suppression` previously stored
an empty `{}` resource on every call; it now stores nothing. No other method is
affected.

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
