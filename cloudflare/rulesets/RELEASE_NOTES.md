## 2026.11.05.1

**Fixed:** The ruleset and rule create/update methods are writes whose success
response carries no body (HTTP 204). Earlier versions declared a resource with an
empty schema for each and wrote an empty `{}` (or a dead instance name) on every
call. Each method now issues the API call for its side effect and returns no data
handles — it stores nothing. Their empty resource specs are gone. Affected:
`createaccountruleset`, `updateaccountentrypointruleset`, `updateaccountruleset`,
`createaccountrulesetrule`, `updateaccountrulesetrule`, `createzoneruleset`,
`updatezoneentrypointruleset`, `updatezoneruleset`, `createzonerulesetrule` and
`updatezonerulesetrule`.

**Upgrade note:** The matching resources are no longer declared. Any data earlier
versions wrote under them is stale; delete it with `swamp data delete`.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected: `createaccountruleset`,
`createaccountrulesetrule`, `createzoneruleset` and `createzonerulesetrule`.

**Upgrade note:** Results earlier versions wrote to the `created` instance stay
there; new runs write under the new names.
