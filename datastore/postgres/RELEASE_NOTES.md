## 2026.08.21.1

**Changed:** SQL failures now say which operation and table they were acting on instead of surfacing the bare driver error (e.g. "relation does not exist" now reads as `PostgreSQL insertFile on "swamp.files" failed: relation does not exist`). The original error's name and Postgres error code are preserved, so retry classification and `instanceof` checks are unaffected. The lock heartbeat — deliberately unspanned to avoid flooding traces — now wraps a failed renewal with the lock key it was trying to renew, rather than raising a bare connection error with no indication of which lock was affected.

## 2026.08.20.1

**Upgrade note:** Pinned zod to exact version 4.4.3 (was unpinned range `npm:zod@4`). No behavioral changes — dependency version alignment only.
