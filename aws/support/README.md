# @webframp/aws/support

AWS Support case management model for swamp.

Query, create, and manage AWS Support cases across accounts. Fan-out across
profiles for fleet-wide support case inventory.

## Prerequisites

- AWS Business or Enterprise support plan
- The Support API is only available in us-east-1 (global endpoint)

## Required IAM Permissions

- `support:DescribeCases`
- `support:DescribeCommunications`
- `support:CreateCase`
- `support:AddCommunicationToCase`
- `support:ResolveCase`
- `support:DescribeSeverityLevels`
- `support:DescribeServices`
- `sts:GetCallerIdentity`

## Usage

```bash
# Install
swamp extension pull @webframp/aws/support

# Create model instance
swamp model create @webframp/aws/support support \
  --set profiles='["prod-readonly","staging-readonly"]'
```

```bash
# List open cases
swamp model method run support list_cases

# Get full case details with communications
swamp model method run support get_case --input displayId=178317700500245

# Create a new support case
swamp model method run support create_case \
  --input subject="ECS task placement failure" \
  --input serviceCode=amazon-elastic-container-service \
  --input categoryCode=general-guidance \
  --input severityCode=normal \
  --input body="Tasks are failing to place..."

# Add a reply to a case
swamp model method run support add_communication \
  --input caseId=case-123456 \
  --input body="Here are the requested logs..."

# Resolve a case
swamp model method run support resolve_case \
  --input caseId=case-123456

# Fleet-wide scan of open cases across all profiles
swamp model method run support scan_accounts
```

## Methods

| Method              | Description                             | Mutating |
| ------------------- | --------------------------------------- | -------- |
| `list_cases`        | List cases with status filter and limit | No       |
| `get_case`          | Full case details with communications   | No       |
| `create_case`       | Open a new support case                 | Yes      |
| `add_communication` | Add a reply to a case                   | Yes      |
| `resolve_case`      | Close/resolve a case                    | Yes      |
| `scan_accounts`     | Fleet-wide case inventory               | No       |

## Troubleshooting

### "SubscriptionRequiredException" or access denied

The AWS Support API requires a Business, Enterprise On-Ramp, or Enterprise
support plan. Accounts on Developer or Basic plans cannot use this extension.
The error manifests as an access-denied or subscription-required exception on
any method call.

### `scan_accounts` returns empty entries with all profiles failed

The method catches per-profile errors and adds them to `failedProfiles` without
throwing. If all profiles fail (expired SSO tokens, missing permissions), the
result is `entries: []` with a populated `failedProfiles` array. Check that
field to identify which accounts need credential or permission fixes.

### Mid-pagination failure discards all data for that profile

If `DescribeCasesCommand` fails on page 3 (e.g. throttling), the per-profile
catch discards cases already collected from pages 1 and 2. The entire profile is
marked as failed. Retry the scan; transient throttling typically resolves on the
next attempt.

### `list_cases` limited to 100 cases maximum

The `limit` argument is capped at 100 by the Zod schema. Accounts with more than
100 cases need `scan_accounts` for a full inventory, or use status filters
(`--input status=resolved`) to narrow the set.

### `list_services` and `list_severity_levels` do not exist

The `create_case` description references these methods for discovering valid
service codes and severity levels, but they are not implemented. Use the AWS CLI
(`aws support describe-services`, `aws support describe-severity-levels`) or the
AWS console to find valid codes.

### Region is always us-east-1

The AWS Support API is a global service hosted only in us-east-1. There is no
region configuration — all API calls target us-east-1 regardless of where your
resources are deployed.

### `"default"` profile uses the default credential chain

When a profile name is literally `"default"`, no `fromIni` credentials are
loaded. The SDK falls back to environment variables, shared credentials file, or
instance metadata. Any other profile name triggers `fromIni({ profile })`
resolution.

## License

Apache-2.0
