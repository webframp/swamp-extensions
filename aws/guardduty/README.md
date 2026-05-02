# @webframp/aws/guardduty

Query and inspect GuardDuty findings from a delegated administrator account,
covering all member accounts in an AWS Organization.

## Authentication

Uses the default AWS credential chain. Point at the delegated admin account
(e.g. via `AWS_PROFILE`) to see findings across all member accounts.

## Required IAM Permissions

- `guardduty:ListDetectors`
- `guardduty:ListFindings`
- `guardduty:GetFindings`
- `guardduty:ListMembers`

## Usage

```bash
# Create guardduty model
swamp model create @webframp/aws/guardduty gd --global-arg region=us-east-1

# List recent high-severity findings
swamp model method run gd list_findings --input severityMin=7 --input startTime=7d

# List findings by type
swamp model method run gd list_findings --input typePrefix=UnauthorizedAccess

# Get full details for specific findings
swamp model method run gd get_finding_details --input 'findingIds=["abc123"]'

# List enrolled member accounts
swamp model method run gd list_members
```

## Methods

- **list_findings** - List findings with filters for type, severity, time window, and account
- **get_finding_details** - Get full resource and service action details for specific findings
- **list_members** - List member accounts and their enrollment status

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
