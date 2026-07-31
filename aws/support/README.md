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

| Method | Description | Mutating |
|--------|-------------|----------|
| `list_cases` | List cases with status filter and limit | No |
| `get_case` | Full case details with communications | No |
| `create_case` | Open a new support case | Yes |
| `add_communication` | Add a reply to a case | Yes |
| `resolve_case` | Close/resolve a case | Yes |
| `scan_accounts` | Fleet-wide case inventory | No |

## License

Apache-2.0
