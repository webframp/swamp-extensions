## 2026.10.21.1

**Changed:** The manifest now shows how to wire the `@swamp/typesafe-ai` model's
`apiKey` from a vault (`swamp vault put` plus a `vault.get` expression) instead
of only saying a TypeSafe API key is needed. The README and manifest store the
key as `swamp vault put typesafe API_KEY` and wire
`${{ vault.get("typesafe", "API_KEY") }}`, the same vault and key
`@webframp/typesafe-batch` documents for the same `jev` model, and both show
`swamp vault create` for a repo with no vault yet. The manifest also recommends
an SSO named profile or an attached IAM role for AWS credentials.

**Upgrade note:** Documentation only; no behavioral or schema changes.
