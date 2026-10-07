## 2026.10.07.1

**Added:** `get_cost_for_period` method and `costForPeriod` spec. Queries an
explicit date range (e.g. a calendar month via `start`/`end`, where `end` is
exclusive per Cost Explorer semantics), with an optional `service` filter and a
`granularity` of `MONTHLY` (default) or `DAILY`. When a service filter is
applied, results group by usage type; otherwise by service. Each range is a
distinct versioned snapshot keyed by `start_end[_service]`, so historical
months persist independently. Uses `UnblendedCost`. Results paginate via
`NextPageToken` (bounded by a page cap) and carry a `truncated` flag that is
true only if the cap was hit before all pages were read. Additive change —
existing specs and stored resources are unaffected.

## 2026.09.24.1

**Changed:** Bump @aws-sdk/* 3.1133.0 → 3.1139.0 (2 packages)

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
