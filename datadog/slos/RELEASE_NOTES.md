## 2026.10.07.1

**Fixed:** The shared API helper no longer throws on a successful response with
an empty body (such as 202 Accepted); it returns an empty result. Paginated list
requests tolerate an empty page body the same way. A body that is not valid JSON
now fails with an error naming the HTTP method, path, and status, with a snippet
of the body. Rate-limit retry no longer breaks on a non-numeric `Retry-After`
header; it waits 5 seconds instead.

**Upgrade note:** Only the shared helper changed. No methods, arguments,
schemas, or resources changed, so no migration is needed and existing stored
resources remain valid.
