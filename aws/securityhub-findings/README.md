# @webframp/aws/securityhub-findings

Query and manage AWS Security Hub findings from a delegated administrator
account. Leverages cross-region aggregation to cover the entire AWS Organization
in a single API call — replacing per-account GuardDuty sweeps (396 API calls)
with a single query that returns more findings from more accounts.

## Why This Extension

| Approach                     | API Calls                      | Accounts Covered     | Findings        |
| ---------------------------- | ------------------------------ | -------------------- | --------------- |
| Per-account GuardDuty sweep  | 396 (33 accounts × 12 regions) | 33                   | ~53 (truncated) |
| **This extension** (1 query) | **1**                          | **All org accounts** | **81+**         |

Security Hub aggregates findings from GuardDuty, Inspector, Macie, Config, and
Security Hub controls into a single pane. This extension queries that aggregated
view and provides operational lifecycle management (archive, resolve, reopen).

## Relationship to @swamp/aws/securityhub

The upstream `@swamp/aws/securityhub` extension manages Security Hub
**infrastructure** (hubs, aggregators, automation rules, policies, controls) via
CRUD/sync methods.

This extension manages the **findings lifecycle**: query, triage, archive,
resolve, and reopen. They are complementary.

## Methods

### Query Methods

| Method                  | Description                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `list_findings`         | Query findings with filters for product, severity, account, time, workflow status                            |
| `get_finding_details`   | Get full ASFF details for specific finding ARNs (with `notFound` tracking)                                   |
| `get_severity_summary`  | Aggregate findings by severity across all accounts with per-account breakdown                                |
| `list_findings_by_type` | Group findings by type with severity breakdown per group                                                     |
| `diff_findings`         | Compare current findings vs previous run — surfaces new findings (suppresses false positives when truncated) |
| `list_all_findings`     | Paginated full export (up to 500 findings across multiple pages)                                             |
| `resolve_accounts`      | Map AWS account IDs to friendly names via Organizations API                                                  |

### Lifecycle Methods

| Method             | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `archive_findings` | Suppress findings (mark as false positive / expected behavior) |
| `resolve_findings` | Mark findings as resolved                                      |
| `reopen_findings`  | Reopen previously archived/resolved findings                   |

All lifecycle methods require a `note` (max 512 chars) for audit trail and
retrieve the actual `ProductArn` from each finding before updating.

## Included Workflow

### @webframp/securityhub-triage

On-demand triage workflow that collects all security data in one run:

```bash
AWS_PROFILE="jw-cd-security-tooling/ReadOnlyPlus" \
  swamp workflow run @webframp/securityhub-triage --input modelName=sh-findings

# Custom time window:
swamp workflow run @webframp/securityhub-triage --input modelName=sh-findings --input startTime=7d
```

Steps: severity summary → CRITICAL findings → HIGH findings → diff since last
run → findings by type. Produces a triage report with severity dashboard,
affected accounts, new/resolved changes, and top finding types.

## Included Report

### @webframp/securityhub-triage-report

Workflow-scope report that aggregates triage data into actionable markdown:

- Severity dashboard (CRITICAL/HIGH/MEDIUM/LOW/INFO/Total)
- Top affected accounts sorted by critical+high count
- Changes since last run (new + resolved, with truncation warnings)
- Critical & High findings detail table
- Top finding types with severity breakdown

## Required IAM Permissions

- `securityhub:GetFindings` (read — all query methods)
- `securityhub:BatchUpdateFindings` (write — archive/resolve/reopen)
- `organizations:ListAccounts` (read — resolve_accounts only)

## Prerequisites

- Security Hub enabled with a **delegated administrator** account
- Cross-region **finding aggregator** configured (aggregates all regions to one)
- AWS credentials for the delegated admin account (via `AWS_PROFILE` or env)

## Quick Start

```bash
# Install
swamp extension pull @webframp/aws/securityhub-findings

# Create model instance (pointed at delegated admin)
AWS_PROFILE="jw-cd-security-tooling/ReadOnlyPlus" \
  swamp model create @webframp/aws/securityhub-findings sh-findings --global-arg region=us-east-1

# List all findings from last 24h
swamp model method run sh-findings list_findings --input startTime=24h

# Severity summary across the org
swamp model method run sh-findings get_severity_summary --input startTime=7d

# GuardDuty HIGH findings only
swamp model method run sh-findings list_findings \
  --input productName=GuardDuty --input severityLabel=HIGH --input startTime=7d

# View archived findings
swamp model method run sh-findings list_findings \
  --input workflowStatus=SUPPRESSED --input startTime=30d

# Full triage workflow
swamp workflow run @webframp/securityhub-triage --input modelName=sh-findings

# Archive false positives
swamp model method run sh-findings archive_findings \
  --input 'findingArns:json=["arn:aws:securityhub:..."]' \
  --input 'note=Known EKS deployment pattern, suppressing'

# Map account IDs to names
swamp model method run sh-findings resolve_accounts

# What's new since last check?
swamp model method run sh-findings diff_findings --input startTime=24h

# Full export for offline analysis
swamp model method run sh-findings list_all_findings --input startTime=7d --input maxPages=5
```

## Design Decisions

- **Single model instance** covers the entire org (no per-account instances
  needed)
- **Cross-region via aggregator** — one query in us-east-1 covers all regions
- **Truncation honesty** — all methods report `truncated: true` when results are
  capped, and `diff_findings` suppresses both new and resolved counts when
  either snapshot was truncated (prevents false positives from pagination
  shifts)
- **Full metadata in snapshots** — `diff_findings` stores complete finding
  objects so resolved findings retain their account/severity/type for downstream
  analysis
- **ProductArn from source** — lifecycle methods retrieve the actual ProductArn
  via GetFindings before calling BatchUpdateFindings (not constructed from ARN
  parts)

## License

Apache-2.0
