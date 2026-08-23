## 2026.08.23.1

**Fixed:** README's Usage section documented invented CLI flags/subcommands
(`--vault`, `--key`, `--value`) that don't exist. Corrected to the real
`swamp vault put/read-secret/list-keys` command forms.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering the narrowed subprocess environment
(`ENV_ALLOWLIST` plus `clearEnv: true`, with `extraEnv` as the escape hatch),
the `find`-exit-code-vs-empty-store distinction in `list`, `assertSafeKey`,
and the breaking prefix-migration behavior from `2026.04.22.1` (`prefix: ""`
to read legacy unprefixed secrets).
