## 2026.10.21.1

**Changed:** The README now stores the API token with
`swamp vault put cloudflare API_TOKEN` and wires it with
`--global-arg 'apiToken=${{ vault.get("cloudflare", "API_TOKEN") }}'`. The
previous example used a `vault://` string, which swamp does not resolve and
would have been sent to Cloudflare as a literal token. The `apiToken`
description on every model says the same.

**Changed:** The worker model's `deploy` method now marks binding values
sensitive, so a `secret_text` binding's value is redacted from logs and run
records. Pass it as a `vault.get` expression. Non-secret binding values in the
same call (namespace IDs, bucket names) are redacted too.

**Upgrade note:** No schema or behavioral changes beyond the redaction above.
Model versions move to 2026.10.21.1 with no-op upgrade entries.
