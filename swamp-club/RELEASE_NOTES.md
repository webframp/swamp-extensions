## 2026.10.12.1

**Fixed:** Repeating an `idempotencyKey` on `post_ripple` no longer fails the
workflow step. The method returned a handle with only a name when the key had
been seen before. The runtime rejected it
(`expected string, received undefined (path: dataId)`), so a workflow that
repeated a key reported failure on every run. Dedup itself was unaffected: no
duplicate ripple was ever posted.

**Changed:** A repeated key now re-writes the existing `ripple` record
unchanged and returns its full handle. Each repeat adds a version of that
record (retention is still 20 versions) whose 30-day lifetime starts from the
repeat. No Swamp Club API call is made on a repeat.
