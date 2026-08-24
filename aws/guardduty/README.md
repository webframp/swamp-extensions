# @webframp/aws/guardduty

Read-only observability model for GuardDuty findings. Query and inspect findings
from a delegated administrator account, covering all member accounts in an AWS
Organization.

This extension does not manage GuardDuty configuration (detectors, publishing
destinations, IP sets). For infrastructure management, use
`@swamp/aws/guardduty/detector`.

## Prerequisites

GuardDuty must be enabled (a detector must exist) in the target region before
this extension can query findings. If no detector exists, methods fail with an
error describing the required setup steps.

To enable GuardDuty via swamp:

```bash
swamp model create @swamp/aws/guardduty/detector my-detector --global-arg region=us-east-1
swamp model method run my-detector create
```

Alternatively, enable GuardDuty through the AWS console or CLI
(`aws guardduty create-detector --enable`).

## Authentication

Uses the default AWS credential chain. Point at the delegated admin account
(e.g. via `AWS_PROFILE` or the `profile` global argument) to see findings across
all member accounts.

## Required IAM Permissions

- `guardduty:ListDetectors`
- `guardduty:ListFindings`
- `guardduty:GetFindings`
- `guardduty:ListMembers`

## Usage

```bash
# Create guardduty model
swamp model create @webframp/aws/guardduty gd --global-arg region=us-east-1

# With explicit profile
swamp model create @webframp/aws/guardduty gd \
  --global-arg region=us-east-1 --global-arg profile=security-admin

# List recent high-severity findings
swamp model method run gd list_findings --input severityMin=7 --input startTime=7d

# List findings by type
swamp model method run gd list_findings --input typePrefix=UnauthorizedAccess

# Filter to a specific account
swamp model method run gd list_findings --input accountId=238297461743

# Get full details for specific findings
swamp model method run gd get_finding_details --input 'findingIds=["abc123"]'

# List enrolled member accounts
swamp model method run gd list_members
```

## Methods

- **list_findings** — List findings with filters for type, severity, time
  window, and account
- **get_finding_details** — Get full resource and service action details for
  specific findings
- **list_members** — List member accounts and their enrollment status

## Example Workflow Step

```yaml
steps:
  - name: high-severity-findings
    model: gd
    method: list_findings
    input:
      severityMin: 7
      startTime: "24h"
```

## Troubleshooting

### "Failed to list GuardDuty detectors" or no detector found

GuardDuty must be enabled in the target region before this extension can query
findings. The `getDetectorId` helper throws a descriptive error pointing to
`@swamp/aws/guardduty/detector` or the equivalent AWS CLI command
(`aws guardduty create-detector --enable`). Confirm the detector exists with
`aws guardduty list-detectors --region <region>`.

### `list_findings` returns fewer results than expected with `typePrefix`

When `typePrefix` is set (e.g. `Recon:`), the extension fetches up to
`limit * 20` finding IDs from the API and filters client-side. If the ratio of
matching findings is lower than 1-in-20, results will be truncated. The
`truncated` field is set honestly. Narrowing the time window or raising `limit`
(max 500) helps, but extreme type rarity may still produce fewer results.

### Region scope

GuardDuty findings are regional. The default is `us-east-1`. Each model instance
targets one region; create separate instances for multi-region coverage. Pass
`--global-arg profile=<name>` for named-profile or SSO credential resolution.

### `get_finding_details` capped at 50 IDs

The method accepts at most 50 finding IDs per call (enforced by Zod validation
and the `GetFindingsCommand` API limit). Passing more than 50 will fail at input
validation. Batch large ID lists into multiple calls.

### `list_members` only shows associated accounts by default

The `onlyAssociated` parameter defaults to `true`. To see all member accounts
regardless of association status, pass `--input onlyAssociated=false`.
