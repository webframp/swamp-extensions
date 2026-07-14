## 2026.07.13.1

**Fixed:** Trace resources were written under instance names containing
`Date.now()` (`traces-<ts>`, `traces-filtered-<ts>`, `errors-<type>-<ts>`,
`analysis-<ts>`), so every method run created a brand-new resource instead of
updating the existing one — unbounded data accumulation. Instance names are now
deterministic and keyed on the query that produced them:

- `list` → `traces-all`, or `traces-filtered-<sha1>` (hash of the filter
  expression)
- `errors` → `errors-<errorType>`
- `analyze` → `error-analysis`

**Upgrade note:** After upgrading, the first run of each method writes to the
new stable instance name; the old timestamped instances remain until garbage
collected. Re-runs now overwrite the latest snapshot as intended.
