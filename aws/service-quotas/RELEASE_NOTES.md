## 2026.07.09.1

**Added:** `list_pending_requests` method — read-only fan-out across all
configured profiles listing quota-increase requests still open (`PENDING` or
`CASE_OPENED`) via the `ListRequestedServiceQuotaChangeHistory` API. Produces one
`pendingRequests` resource aggregating every open request across accounts.

**Changed:** `check_utilization` now accepts `serviceCodes` (an array) in
addition to the single `serviceCode`. It sweeps all requested services in one
run — acquiring the per-model lock once — and writes one `utilization` snapshot
per service. Passing a single `serviceCode` is unchanged and fully
back-compatible. Duplicate service codes are de-duplicated.

**Added:** Per-profile fault tolerance. A single unreachable account (expired
credentials, `AccessDenied`, throttling) no longer aborts the whole sweep. The
failure is recorded in a new `failedProfiles` field and the snapshot is still
emitted, so a large multi-account run degrades gracefully instead of producing
nothing. `failedProfiles` was added to the `utilization` resource and the new
`pendingRequests` resource. Persisted error text has ARNs and account ids
redacted.

**Upgrade note:** One new IAM permission is required for `list_pending_requests`:
`servicequotas:ListRequestedServiceQuotaChangeHistory`. Existing methods are
unaffected — the permission is only needed if you call the new method.
