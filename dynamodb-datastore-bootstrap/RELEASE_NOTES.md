## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a `## Troubleshooting`
section covering the `Deno.errors.NotFound` rewrite when `aws` isn't on PATH,
the 60s `waitForTableActive` timeout, the TOCTOU race handling in `ensurePolicy`
(`EntityAlreadyExists`), and `sts
get-caller-identity` failures from
missing/expired credentials.
