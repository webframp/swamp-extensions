## 2026.07.13.1

**Fixed:** The `query` method wrote its `query_results` resource under an
instance name built from `Date.now()` (`query-<ts>-<firstLogGroup>`), so every
run created a new resource instead of updating the existing one — unbounded
data accumulation, against the repo's "deterministic resource instance names"
rule. It now keys on a collision-resistant SHA-1 hash of the sorted log group
names plus the query string: `query-<sha1>`.

**Changed:** The `analyze_errors` method's `error_analysis` instance name
previously used only the first log group (`errors-<firstLogGroup>`), which
collides when different multi-group analyses share a first group. It now hashes
the full sorted log group set: `errors-<sha1>`.

**Upgrade note:** After upgrading, the first run of `query` / `analyze_errors`
writes to the new stable instance names; old instances remain until garbage
collected. Re-runs then overwrite the latest snapshot as intended.
