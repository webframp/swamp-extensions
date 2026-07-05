## 2026.07.04.1

**Added:** `get_request_status` method — check the status of a previously
submitted quota increase request using `GetRequestedServiceQuotaChange` API.
Returns the current status, case ID, desired value, and timestamps.

**Added:** `get_case_communications` method — retrieve support case
correspondence for quota increase requests. Uses the AWS Support
`DescribeCases` and `DescribeCommunications` APIs. Requires AWS Business or
Enterprise support plan.

**Added:** `caseCommunications` resource spec storing case metadata (subject,
status, severity) and the communications array.

**Upgrade note:** Two new IAM permissions required for `get_case_communications`:
`support:DescribeCases` and `support:DescribeCommunications`. Existing methods
are unaffected — the new permissions are only needed if you call the new method.
