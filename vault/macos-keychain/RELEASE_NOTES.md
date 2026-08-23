## 2026.08.23.1

**Fixed:** README's Usage section documented invented CLI flags/subcommands
(`--vault`, `--key`, `--value`) that don't exist. Corrected to the real
`swamp vault put/read-secret/list-keys` command forms.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering the unconditional `list()` rejection
(there's no keychain enumeration API), the Darwin-only platform
restriction, locked-keychain/permission errors surfacing through
`runSecurity`'s wrapped stderr, the 4096-byte `security -i` line-buffer cap
on secret size, a macOS 26 hex-encoding disambiguation failure mode, and
key/service control-character validation.
