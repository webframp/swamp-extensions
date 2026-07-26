## 2026.07.26.1

**Fixed:** Keys were interpolated into the request path unvalidated and
unencoded, so `get("../../sys/health")` left the configured mount and reached a
different Vault API entirely — `secret/data/../../sys/health` is not the secret
the caller asked for. Keys containing `.` or `..` path segments, absolute keys,
and empty keys are now rejected.

**Fixed:** Key path segments are percent-encoded. A key containing a space, a
`?`, or a `#` previously changed the request path or started a query string, so
the secret written and the secret read back could be different entries.

**Upgrade note:** If you store keys containing characters that require encoding
and have been relying on the previous unencoded behaviour, the encoded path is
a different Vault path. Read such secrets with the old version and re-write them
with this one.
