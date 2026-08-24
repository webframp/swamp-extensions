## 2026.08.24.1

**Fixed:** Corrected installation command (`swamp extension install` →
`swamp extension pull`).

**Added:** Troubleshooting section documenting the `regions` (array) vs `region`
(string) global-arg change, `inventory_scan` single-region limitation, silent
Resource Explorer / Config fallback behavior, `MAX_PAGES = 10` truncation per
service method, first-run empty diff behavior, S3 region handling, and the
silent `reservedConcurrency` catch in Lambda inventory.
