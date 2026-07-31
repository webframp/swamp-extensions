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
(e.g. via `AWS_PROFILE` or the `profile` global argument) to see findings
across all member accounts.

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
