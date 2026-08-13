## 2026.08.12.2

**Fixed:** `ingest` no longer aborts the whole run when a file is deleted or
becomes inaccessible between directory enumeration and `Deno.stat`. Previously
the `stat` call could throw `NotFound` or `PermissionDenied` inside `walkDir`,
bypassing the per-document try/catch and dropping the `status` writeResource
so nothing about the run was recorded. Missing entries are now silently
skipped in `walkDir` and will resurface on the next run if they exist.

**Fixed:** The `MAX_INGEST_FILES` cap now counts documents that fail in the
outer catch (hashFile errors, writeResource failures) alongside successes
and skips. A directory of 10,000+ unreadable files could previously iterate
without bound because every doc landed in `errors` and neither `ingested`
nor `skipped` incremented, so the cap never triggered.

**Added:** `status` resource now carries `totalConverted` alongside
`totalIngested`. `totalIngested` counts every `document` resource written
this run — including failed conversions that left `markdown: ""` and set the
`error` field. `totalConverted` counts only the documents that produced
non-empty markdown. Trend dashboards should switch to `totalConverted` for
the success signal.

**Upgrade note:** `totalConverted` is a new field on the `status` resource
with a Zod default of `0`. Existing stored `status` resources written by
`2026.08.12.1` will read back cleanly. When the `status` method re-writes an
older resource, it seeds `totalConverted` from the historical `totalIngested`
so timelines don't show a synthetic drop to zero.
