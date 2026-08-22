## 2026.08.21.1

**Changed:** Network-level failures (DNS resolution, connection refused, TLS
errors, timeouts) talking to the Vault server now surface as
`Vault <get|put|list> request failed (key: <key>): could not reach <url>:
<reason>` instead of a bare, context-free fetch error. Previously, only
non-2xx HTTP responses were wrapped with the operation and key that was
being attempted — an unreachable server produced a raw runtime error with
no indication of which vault call or key triggered it. HTTP-level failures
(4xx/5xx responses from Vault itself) are unchanged.
