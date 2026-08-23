## 2026.08.23.1

**Fixed:** README's Usage section documented invented CLI flags/subcommands
(`--vault`, `--key`, `--value`) that don't exist. Corrected to the real
`swamp vault put/read-secret/list-keys` command forms.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering missing-binary errors when `gopass`
isn't on PATH, the deliberately terse exit-code error message (namespace is
kept out of it on purpose), `assertSafeKey`'s rejections, `passwordOnly`
defaulting to `true` and truncating multi-line entries, and store-prefix
stripping in `list`.
