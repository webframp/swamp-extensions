# @webframp/aws/securityhub-findings

Query and manage AWS Security Hub findings from a delegated administrator
account. Leverages cross-region aggregation to cover the entire AWS Organization
in a single API call.

## Relationship to @swamp/aws/securityhub

The upstream `@swamp/aws/securityhub` extension manages Security Hub
**infrastructure** (hubs, aggregators, automation rules, policies, controls)
via CRUD/sync methods.

This extension manages the **findings lifecycle**: query, triage, archive,
resolve, and reopen. They are complementary — use the upstream extension to
configure Security Hub, use this extension to operate on findings.

## Methods

| Method | Description |
|--------|-------------|
| `list_findings` | Query findings with filters for product, severity, account, time |
| `get_finding_details` | Get full ASFF details for specific finding ARNs |
| `get_severity_summary` | Aggregate findings by severity across all accounts |
| `archive_findings` | Suppress findings (false positive / expected behavior) |
| `resolve_findings` | Mark findings as resolved |
| `reopen_findings` | Reopen previously archived/resolved findings |

## Required IAM Permissions

- `securityhub:GetFindings` (read)
- `securityhub:BatchUpdateFindings` (write — for archive/resolve/reopen)

## Usage

```bash
# Create model (pointed at delegated admin account)
AWS_PROFILE="jw-cd-security-tooling/ReadOnlyPlus" \
  swamp model create @webframp/aws/securityhub-findings sh-findings --global-arg region=us-east-1

# List all findings from last 24h
swamp model method run sh-findings list_findings --input startTime=24h

# List only HIGH severity GuardDuty findings
swamp model method run sh-findings list_findings --input productName=GuardDuty --input severityLabel=HIGH

# Get severity summary across org
swamp model method run sh-findings get_severity_summary --input startTime=7d

# Archive false positives
swamp model method run sh-findings archive_findings \
  --input 'findingArns=["arn:aws:securityhub:..."]' \
  --input 'note=Known EKS deployment pattern, suppressing'
```

## License

Apache-2.0
