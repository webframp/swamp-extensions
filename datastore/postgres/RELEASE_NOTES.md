## 2026.07.30.1

**Fixed:** Subtree lookup query in the incremental push path forced sequential
scans on the `files` table. The `WHERE path = $1 OR path LIKE $2` pattern made
PostgreSQL unable to use the btree primary key for the LIKE branch, causing
O(n^2) write latency as the catalog grew past ~30K files.

**Changed:** The subtree query now uses `UNION ALL` to split the exact-match and
prefix-match predicates into independent branches, each with its own query plan.
A new `text_pattern_ops` btree index on the `path` column is created
automatically on first connect, enabling index scans for all prefix-anchored
LIKE queries (both the push and pull paths).

**Upgrade note:** The new index is created via `CREATE INDEX IF NOT EXISTS` on
startup. For large tables (>100K rows) the initial index build may take a few
seconds on first connection after upgrade. Subsequent connections are
instantaneous. No manual migration required.
