## 2026.08.21.2

**Changed:** AWS API failures now surface with the operation and identifiers
involved instead of a bare SDK error. `GetServiceQuota`, `ListServiceQuotas`,
`ListServices`, `RequestServiceQuotaIncrease`,
`GetRequestedServiceQuotaChange`, `GetCallerIdentity`, `DescribeCases`, and
`DescribeCommunications` calls in `get_quota`, `list_quotas`, `list_services`,
`request_increase`, `get_request_status`, and `get_case_communications` now
catch failures and rethrow with the service/quota code, profile, or request ID
that was in flight, plus the original error preserved as `cause`. Previously a
throttled or permission-denied call surfaced only the raw AWS SDK exception
with no indication of which quota, profile, or case triggered it. The
fan-out methods (`check_utilization`, `list_pending_requests`) already
recorded per-profile failures and are unchanged.

## 2026.08.21.1

**Changed:** Tightened `serviceCode`, `quotaCode`, `requestId`, and `displayId`
arguments across quota and support-case methods to require non-empty strings —
these are required identifiers the Service Quotas and Support APIs already
reject when empty.

## 2026.08.20.1

**Changed:** Bump @aws-sdk/* 3.1111.0 → 3.1114.0 (5 packages)

## 2026.08.15.1

**Changed:** Bump @aws-sdk/* 3.1104.0 → 3.1111.0 (5 packages)

## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (5 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (5 packages)

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.29.1`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.29.1`.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (5 packages)

## 2026.07.29.1

**Fixed:** Terminate upgrade chain at current version (extension was uninstallable due to broken upgrade chain).

## 2026.07.27.1

**Changed:** Bump @aws-sdk/* 3.1094.0 → 3.1096.0 (5 packages)


## 2026.07.24.1

**Changed:** Bump AWS SDK from 3.1091.0 to 3.1094.0 (patch-level update).
