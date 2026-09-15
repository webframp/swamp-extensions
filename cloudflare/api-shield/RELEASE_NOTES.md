## 2026.09.15.1

**Changed:** Bump zod 4.4.3 → 4.6.5

## 2026.08.28.2

Hardened codegen: instance names sanitized against path traversal; 429
rate-limit retry with Retry-After; string schema patterns emit regex validation;
output schemas passthrough unknown fields; apiToken now optional and
vault-wireable with CLOUDFLARE_API_TOKEN env fallback.
