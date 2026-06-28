## 2026.06.27.3

**Added:** `@webframp/aws/dns-observation` as 5th upstream source. Orphaned DNS
records (pointing at decommissioned ELBs, CloudFront distributions, S3 buckets,
or stale IPs) now surface as drifted resources with `detectionSource: "dns"`.

- `normalizeDnsResources` maps orphan records to NormalizedResource
- `dnsModelName` argument added to `compute_drift`, `set_baseline`, `refresh`
- `drift-state-refresh` workflow gains parallel `refresh-dns` job

## 2026.06.27.2

**Added:** `@webframp/aws/config-compliance` as 4th upstream source. AWS Config
non-compliant resources now appear as drifted with `detectionSource: "config"`.

- Refactored normalizer dispatch into SOURCES/NORMALIZERS registry pattern
- `configModelName` argument added to all methods

## 2026.06.27.1

**Added:** Initial release of `@webframp/aws/drift-state` — unified drift
detection model that composes observations from adopt, inventory, and terraform
models into queryable versioned state.

Methods: `compute_drift`, `set_baseline`, `get_drifted`, `get_drift_timeline`,
`get_drift_velocity`, `refresh`.

Includes companion workflow `@webframp/drift-state-refresh` for automated
upstream sync + drift computation.
