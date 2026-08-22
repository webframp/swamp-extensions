## 2026.08.21.2

**Changed:** `documentsDir` is now validated as an absolute path at model
creation time, matching what the docstring always required — a relative path
previously slipped through and could produce confusing relative-path output
or unexpected directory resolution deep inside a scan/ingest run instead of
failing immediately with a clear message.

A `Deno.stat` failure on `documentsDir` other than "not found" (e.g. a
permissions error) now raises an error naming the directory and the
underlying cause, instead of propagating the bare Deno error with no
indication of which directory failed.
