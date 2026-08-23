## 2026.08.23.1

**Fixed:** README's Usage section documented invented CLI flags/subcommands
(`--vault`, `--key`, `--value`) that don't exist. Corrected to the real
`swamp vault put/read-secret/list-keys` command forms.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering the three-source token resolution
error message from `resolveToken`, `vaultFetch`'s network-vs-HTTP error
distinction, the KV v1/v2 nesting mismatch that produces a false "not
found," `assertSafeKey`'s path-escape checks, the silent
`MAX_DEPTH`/`MAX_KEYS` list truncation (only visible via a span attribute),
and how Vault's own JSON error array surfaces through `handleResponse`.
