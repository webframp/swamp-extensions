## 2026.10.14.2

**Fixed:** `upload_from_url` now writes one resource per `file` path instead of
overwriting a single `upload_from_url-current` instance.

**Upgrade note:** No methods or arguments changed. Data previously stored under
`upload_from_url-current` is not moved; re-run the action to write the new
instance.
