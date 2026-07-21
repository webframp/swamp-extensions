## 2026.07.21.1

**Changed:** Bumped AWS SDK dependencies to 3.1091.0 (from 3.1069.0).

**Fixed:** Test task was missing `--allow-sys` permission, causing mock-server
tests to hang in Deno 2.8+ (the SDK's credential provider calls system APIs
that require this permission).

**Upgrade note:** No behavioral changes. Routine dependency maintenance.
