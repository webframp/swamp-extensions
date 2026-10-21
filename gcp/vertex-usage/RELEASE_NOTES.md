## 2026.10.21.1

**Fixed:** The README and manifest wired `serviceAccountJson` as
`<vault:gcp/sa-key>`, which swamp does not resolve; the model received that
literal string. They now pipe the key into a vault
(`swamp vault put gcp SA_KEY < key.json`, then delete the file) and wire it with
`${{ vault.get("gcp", "SA_KEY") }}`.

**Changed:** Authentication docs, the `serviceAccountJson` description and the
missing-credentials error now lead with the vault. They document storing an
`authorized_user` ADC file in the vault as an alternative to a service account
key. The `GCP_ACCESS_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS` fallbacks still
work but are described as discouraged, because swamp does not redact them.

**Changed:** The manifest Quick Start creates the vault first with
`swamp vault create local_encryption <name>` (a once-only step for a repo with
no vault yet), so it works in a fresh repo.

**Upgrade note:** No behavioral or schema changes. Only documentation and
message text changed.
