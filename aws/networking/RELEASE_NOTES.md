## 2026.08.23.1

**Changed:** Documentation only — no code changes. Documented the previously
undocumented `profile` global arg and added a `region`-explicit usage
example. Added a `## Troubleshooting` section covering the `region` default
(`us-east-1`), the `MAX_PAGES = 10` pagination cap, an unflagged truncation
gap in `get_data_transfer_metrics` (its own NAT-gateway/LB discovery uses
capped pagination but never sets `truncated`), CloudWatch's `Sum || 0`
fallback masking metrics-lagging resources, and unrecognized
`loadBalancerNames` throwing a wrapped AWS exception.
