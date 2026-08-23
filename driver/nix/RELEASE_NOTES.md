## 2026.08.23.1

**Fixed:** README's "Environment variable passthrough" bullet claimed to
apply generally, but it only applies to bundle mode — command mode inherits
the full parent environment unmodified.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering `describeSpawnError`'s special-cased
message when the `nix` binary is missing from PATH, the
`DEFAULT_TIMEOUT_MS`/SIGTERM/SIGKILL shutdown sequence, the bare exit-code
fallback error text used when stderr is empty, the bundle-mode env allowlist
vs. command mode's unrestricted inheritance, and `parseConfig`'s eager
validation errors.
