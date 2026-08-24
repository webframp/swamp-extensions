## 2026.08.24.2

**Fixed:** Corrected CLI command syntax in README (`swamp model run` →
`swamp model method run`).

**Added:** Troubleshooting section documenting the `MAX_PAGES = 20` pagination
cap (1,000 records), absence of rate-limit retry logic, silent GraphQL degrade
patterns in WAF and cache analytics, the silent source-code skip in
`get_script`, API token permission requirements per model, and the `accountId`
vs `zoneId` distinction for the worker model.
