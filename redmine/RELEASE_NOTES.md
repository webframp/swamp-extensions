## 2026.10.20.2

**Fixed:** 2026.10.20.1 gave up on any `Retry-After` longer than 60 seconds. A
rate limiter with a time window asks for up to the whole window: Skipper's
`clusterClientRatelimit` over `"2m"`, for example, sends up to 120 seconds. So
rate-limited calls failed where earlier versions waited. The cap is now 300
seconds; a longer `Retry-After` (a maintenance window, a daily quota) still
fails fast instead of blocking the method.

**Fixed:** 2026.10.20.1 kept `X-Redmine-API-Key` and `X-Redmine-Username` on an
http→https redirect to any port of the same host, so a TLS listener on an
unexpected port received the key. Credentials now survive only the default
upgrade, port 80 to 443, which is what a load balancer such as an AWS ALB
issues. A setup that redirects elsewhere gets the `set host to …` error; set
`host` to the https URL.

**Fixed:** A 307 or 308 redirect of a request with a streamed body resent a
stream the first hop had already consumed. It now fails with a clear error. No
built-in method sends a streamed body.

**Upgrade note:** No schema or `globalArguments` changes; existing instances
move to this version with an identity upgrade.
