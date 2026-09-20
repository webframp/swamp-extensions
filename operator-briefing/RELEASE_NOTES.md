## 2026.09.19.1

**Changed:** The `test` task now runs with `--allow-env` instead of `-A`
(all permissions). The unit tests need no filesystem, network, or subprocess
access — they exercise pure report/model logic through the swamp-testing
factories — so the blanket grant was unnecessary. This matches the scoped
permission convention used by every other model/report extension in the repo.

**Upgrade note:** No schema, method, or resource change. A `deno.json` change
is a shipped-file change, so the version bumps and a no-op upgrade-chain entry
is appended for the `metrics` model.
