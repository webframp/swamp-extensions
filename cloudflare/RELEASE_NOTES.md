## 2026.06.26.1

**Fixed:** `get_analytics` (cache model) and `get_security_events` (waf model) now use
parameterized GraphQL variables. Previously these methods failed silently due to a query
syntax error — they returned empty/zero data instead of actual analytics. After upgrading,
expect to see real cache hit-rate and security event data where there was none before.

**Added:** All paginated methods (zone list, DNS list, WAF rules, WAF packages, worker
scripts, worker routes) now log a WARNING when results are truncated at the 1000-item
pagination cap. Previously truncation was silent.

**Changed:** Zod imports normalized to bare `"zod"` specifier resolved via deno.json import
map. No change to runtime behavior or data shapes.

**Upgrade note:** If you use `@webframp/cloudflare-audit`, pull both extensions together —
cloudflare-audit@2026.06.26.1 requires cloudflare@2026.06.26.1.
