## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_hyperdrive`, `update_hyperdrive` and
`patch_hyperdrive`. The README's new "Secrets" section lists them per method.
