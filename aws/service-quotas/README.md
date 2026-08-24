# @webframp/aws/service-quotas

Query and monitor AWS Service Quotas across accounts.

## Usage

```bash
# Create a model instance
swamp model create @webframp/aws/service-quotas quotas \
  --set profiles='["prod-readonly","staging-readonly"]'

# Get a specific quota (e.g. IAM roles per account)
swamp model method run quotas get_quota \
  --input serviceCode=iam --input quotaCode=L-FE177D64

# List all quotas for a service
swamp model method run quotas list_quotas --input serviceCode=iam

# Discover available service codes
swamp model method run quotas list_services

# Find quotas above 80% utilization across all accounts
swamp model method run quotas check_utilization \
  --input serviceCode=iam --input threshold=0.8

# Sweep several services in one fan-out — writes one utilization snapshot per service
swamp model method run quotas check_utilization \
  --input serviceCodes='["ec2","vpc","eks"]' --input threshold=0.8

# List open quota-increase requests (PENDING/CASE_OPENED) across all accounts
swamp model method run quotas list_pending_requests
```

## Querying Stored Data

```cel
# Find all quotas above 90% utilization
data.latest("quotas", "utilization").attributes.entries.filter(
  e, e.utilizationPct > 90.0
)
```

## Common Quota Codes

| Service | Quota                       | Code       |
| ------- | --------------------------- | ---------- |
| IAM     | Roles per account           | L-FE177D64 |
| IAM     | Policies per account        | L-E95E4862 |
| IAM     | Instance profiles           | L-6E65F259 |
| Lambda  | Concurrent executions       | L-B99A9384 |
| VPC     | VPCs per region             | L-F678F1CE |
| EC2     | Running On-Demand instances | L-1216C47A |

## Resources

| Resource          | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `quota`           | Single quota detail with value and usage                           |
| `quotas`          | All quotas for a service in an account                             |
| `services`        | Available service codes                                            |
| `utilization`     | Quotas above threshold across accounts                             |
| `increaseRequest` | Record of a submitted quota increase request                       |
| `pendingRequests` | Open quota-increase requests (PENDING/CASE_OPENED) across accounts |

## Required Permissions

Read-only methods need:

```bash
# Required IAM policy permissions
servicequotas:GetServiceQuota
servicequotas:ListServiceQuotas
servicequotas:ListServices
servicequotas:ListRequestedServiceQuotaChangeHistory
servicequotas:GetAWSDefaultServiceQuota
cloudwatch:GetMetricData
sts:GetCallerIdentity

# request_increase additionally requires:
servicequotas:RequestServiceQuotaIncrease
```

## Troubleshooting

### `check_utilization` reports zero quotas above threshold

The utilization scan only reports quotas that: (1) expose a CloudWatch usage
metric, (2) return a non-null metric value, and (3) have a non-zero limit. Many
service quotas do not publish CloudWatch metrics and are silently skipped. If
you expect results but see none, try lowering `--input threshold=0.5` or use
`list_quotas` with a specific `serviceCode` to confirm the quotas exist.

### Individual profile fails but scan continues

`check_utilization` and `list_pending_requests` catch per-profile errors and
record them in the `failedProfiles` array. Expired SSO tokens, missing
permissions, or network errors for a single profile do not halt the scan. Check
the `failedProfiles` field in the output resource to identify which accounts
were incomplete.

### CloudWatch usage metric unavailable (silent null)

The `getUsageMetric()` helper catches all CloudWatch errors and returns `null`.
A quota whose CloudWatch metric fails (throttling, permission denied, metric not
yet published) is skipped from the utilization report without any log entry. The
`cloudwatch:GetMetricData` permission is required for full utilization data but
the extension does not fail without it.

### `MAX_PAGES = 20` truncation

All paginated methods cap at 20 pages (100 items per page). Services or quotas
beyond 2,000 per service/account are silently omitted. The `truncated` field is
set to `true` when the cap is reached.

### `get_case_communications` requires Business or Enterprise Support

The AWS Support API (used by `get_case_communications`) is only available to
accounts with Business, Enterprise On-Ramp, or Enterprise support plans.
Developer and Basic plans will get an access error.
