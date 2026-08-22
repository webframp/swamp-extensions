## 2026.08.21.2

**Changed:** `list_repos`, `get_repo_health`, `diff_packages`, and
`get_storage_info` used to raise a bare `HTTP <status>` error on a
non-200 response, discarding the response body. They now include the
request URL and the server's response body in the error message, matching
`query_packages`'s existing behavior, so a failed call says what was
attempted and why the server rejected it instead of just the status code.

`query_packages` and `diff_packages` now reject an empty `query` argument
before making any request, rather than sending it to Artifactory and
surfacing whatever error AQL returns for an empty query string.
