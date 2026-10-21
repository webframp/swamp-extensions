## 2026.10.21.1

**Changed:** Documentation only: the README now shows how to create the two
model instances the workflow needs. The Cost Explorer instance uses an AWS SSO
or named profile, and the Anthropic Analytics key is stored with
`swamp vault put anthropic ANALYTICS_KEY` and wired with
`${{ vault.get("anthropic", "ANALYTICS_KEY") }}`. Earlier docs named the
instances but never said how to supply the credentials.

**Upgrade note:** No code, workflow, report, or behavioral changes.
