## 2026.11.10.1

**Changed:** Bump @swamp/typesafe-ai 2026.09.15.1 → 2026.10.23.1

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README, manifest and missing-key error now lead with the vault:
store the key with `swamp vault put typesafe API_KEY` and wire `apiKey` with
`${{ vault.get("typesafe", "API_KEY") }}`. The manifest Quick Start previously
created the model with no key at all. The `TYPESAFE_API_KEY` environment
variable still works as a fallback, but is described as discouraged because
swamp does not redact it.

**Changed:** The manifest Quick Start creates the vault first with
`swamp vault create local_encryption <name>` (a once-only step for a repo with
no vault yet), so it works in a fresh repo.

**Upgrade note:** No behavioral or schema changes. Only documentation and error
message text changed.
