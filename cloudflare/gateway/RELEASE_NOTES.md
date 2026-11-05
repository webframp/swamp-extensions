## 2026.11.05.1

**Fixed:** `zero_trust_certificates_activate_zero_trust_certificate` is a
write whose success response carries no body (HTTP 204). Earlier versions
declared a resource with an empty schema and wrote an empty `{}` to it under a
constant instance name on every call. The method now issues the API call for its
side effect and returns no data handles — it stores nothing. The empty resource
spec is gone.

**Upgrade note:** The
`zero_trust_certificates_activate_zero_trust_certificate` resource is no longer
declared. Any data earlier versions wrote under it is stale; delete it with
`swamp data delete`.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Fixed:** `create_zero_trust_account` wrote to a resource the model does not
declare, so it always failed. It now writes the resource the model declares.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected: `create_proxy_endpoint`.

**Upgrade note:** Results earlier versions wrote to the `created` instance stay
there; new runs write under the new names.
