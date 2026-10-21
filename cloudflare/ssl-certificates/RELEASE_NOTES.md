## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_ssl_configuration` and
`update_custom_ssl_for_a_zone_edit_ssl_configuration`. The README's new
"Secrets" section lists them per method.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected: `create_analyze_certificate_analyze_certificate`.

**Upgrade note:** Results earlier versions wrote to the `created` instance stay
there; new runs write under the new names.
