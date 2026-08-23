## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a
`## Troubleshooting` section covering the `command` global arg's default
(`"docker"`) and missing-binary spawn errors, `--load` failing on
multi-platform builds (always appended for non-buildah CLIs), post-push
digest-inspect failures when the local image store hasn't synced yet,
`push.size` silently going `null` on parse failure, and the explicit
`"unknown"`/`null` fallback values in `inspect` for images never pushed.
