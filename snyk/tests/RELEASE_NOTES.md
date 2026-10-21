## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

Documentation only: nothing behavioral changed. This API returns no secrets.
