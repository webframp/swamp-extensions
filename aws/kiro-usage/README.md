# @webframp/aws/kiro-usage

Per-user AWS Kiro usage and spend monitoring. Queries the Cost and Usage
Report (CUR) via Athena for seat cost and credit consumption attributed to
each IAM Identity Store principal, resolves principals to names/emails, and
reconciles the account-level enterprise discount (EDP).

## Why CUR, not Cost Explorer

Kiro is billed as a seat subscription (Power / Pro+ / Pro) plus metered credit
consumption. Cost Explorer collapses every Kiro line item to `NoResourceId`,
so it cannot attribute spend or credits to individuals. The CUR carries an IAM
Identity Store principal in `line_item_resource_id`
(`arn:aws:identitystore:::user/<id>`) on every per-user line — so per-user
attribution is only possible through the CUR, queried here via Athena.

The EDP discount is booked at the account level as a distinct `EdpDiscount`
line item with no resource id. Per-user *net* cost is therefore an allocation
(list cost × the account's net/list ratio), never a billed figure. The
account-level gross, discount, and net are reported separately so the numbers
reconcile against the invoice.

## Quick Start

```bash
swamp extension pull @webframp/aws/kiro-usage

swamp model create @webframp/aws/kiro-usage kiro-usage \
  --global-arg 'curProfile=my-root/ReadOnlyPlus' \
  --global-arg 'athenaDatabase=awscurdatabase' \
  --global-arg 'athenaTable=my_cur_table' \
  --global-arg 'athenaWorkgroup=primary' \
  --global-arg 'athenaOutputLocation=s3://aws-athena-query-results-…/' \
  --global-arg 'identityStoreId=d-1234567890'

# Scan the most recent complete month
swamp model method run kiro-usage scan

# Scan a specific billing period (first of month)
swamp model method run kiro-usage scan --input month=2026-08-01

# Inspect the result
swamp data get kiro-usage scan_results --json | jq '.totals'
```

## Configuration

| Global arg | Required | Default | Purpose |
| --- | --- | --- | --- |
| `curProfile` | no | `default` | Profile with Athena + CUR S3 read |
| `identityStoreProfile` | no | `curProfile` | Profile with `identitystore:DescribeUser` |
| `identityStoreId` | when resolving | — | IAM Identity Store id (e.g. `d-1234567890`) |
| `identityStoreRegion` | no | `us-east-1` | Region for Identity Store calls |
| `athenaRegion` | no | `us-east-1` | Region for Athena/CUR |
| `athenaDatabase` | **yes** | — | Glue database with the CUR table |
| `athenaTable` | **yes** | — | CUR table name |
| `athenaWorkgroup` | no | `primary` | Athena workgroup |
| `athenaOutputLocation` | **yes** | — | S3 URI for Athena results |
| `resolveIdentities` | no | `true` | Resolve ids to names/emails (off = anonymized) |
| `mergeAccounts` | no | `{}` | Map of secondary user id → primary to fold duplicates |

## Required IAM Permissions

- `athena:StartQueryExecution`, `athena:GetQueryExecution`,
  `athena:GetQueryResults`
- `s3:GetObject` on the Athena results bucket and the CUR bucket
- `glue:GetTable`, `glue:GetDatabase` for the CUR table
- `identitystore:DescribeUser` (only when `resolveIdentities` is true)

## Output

The `scan` method writes a `scan_results` resource per billing period:

```json
{
  "billingPeriod": "2026-08-01",
  "currency": "USD",
  "resolvedIdentities": true,
  "discount": { "grossCostUsd": 3428.64, "edpDiscountUsd": -480.01, "netCostUsd": 2948.63 },
  "totals": {
    "userCount": 68,
    "netCostUsd": 2948.63,
    "creditsConsumed": 89600,
    "overageUsd": 0
  }
}
```

Each `users[]` entry carries `userId`, resolved `displayName`/`email`, `plan`,
`seatCostListUsd`, allocated `seatCostNetUsd`, and `credits`.

## PII posture

Identity resolution is opt-in via `resolveIdentities` (default `true`). Set it
to `false` — or omit `identityStoreId` — to leave rows keyed by raw user id
with no names or emails.

## Second / duplicate accounts

Some organizations issue secondary Identity Store accounts (e.g. `JJRUMPH2`)
that hold their own seat. Use `mergeAccounts` to fold a secondary id into a
primary so per-person rollups are accurate; it is off by default so raw CUR
data stays faithful. The map is applied one level deep — it does not resolve
chains (`a → b → c`) or cycles. Point every secondary directly at its final
primary id.

## Report

`@webframp/aws/kiro-usage-report` is a method-scope report that runs after
`scan` and renders the per-user table, per-tier rollup, and cost
reconciliation in markdown plus a structured JSON payload.

```bash
swamp report get @webframp/aws/kiro-usage-report --model kiro-usage --markdown
```
