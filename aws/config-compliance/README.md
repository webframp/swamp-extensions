# @webframp/aws/config-compliance

Observe AWS Config compliance evaluations as typed queryable data. This model
reads evaluation results — it does not manage Config rules or recorders.

## Prerequisites

AWS Config must be enabled with active rules in the target region. Use
`@swamp/aws/config` to manage Config rule infrastructure if needed.

Required IAM permissions:

- `config:DescribeComplianceByConfigRule`
- `config:GetComplianceDetailsByConfigRule`
- `config:DescribeConfigRules`
- `sts:GetCallerIdentity`

## Methods

- **get_non_compliant** — Fetch non-compliant evaluations across all Config rules
- **get_compliance_summary** — Rule-level compliance counts with metadata
- **list_rules** — Active Config rule inventory

## Usage

```bash
swamp extension pull @webframp/aws/config-compliance
swamp model create @webframp/aws/config-compliance aws-config-compliance
swamp model method run aws-config-compliance get_non_compliant
swamp model method run aws-config-compliance get_compliance_summary
```

## Query Examples

```bash
# Find all non-compliant S3 buckets
swamp data query aws-config-compliance \
  'data.latest("aws-config-compliance", "compliance").attributes.evaluations.filter(e, e.resourceType == "AWS::S3::Bucket")'

# Count non-compliant resources by type
swamp data query aws-config-compliance \
  'data.latest("aws-config-compliance", "compliance").attributes.summary.nonCompliantResources'
```

## Integration with drift-state

This model's `compliance` spec is consumed by `@webframp/aws/drift-state` as a
fourth upstream source. Non-compliant resources appear as drifted in the unified
drift surface with `detectionSource: "config"`.

## Troubleshooting

**Every method returns zero rules/evaluations even though Config is
enabled.** `region` defaults to `us-east-1` and AWS Config is a regional
service — pass `--global-arg region=<your-region>` if your Config
recorder and rules live elsewhere. This is the most common cause of an
unexpectedly empty result.

**Auth error mentions `GetCallerIdentity failed`.** This model calls STS
`GetCallerIdentity` first to resolve the account ID, before any Config
API call. A failure here means the credentials (default chain, or the
`profile` you passed) are invalid or unresolvable — it is not a Config
permissions problem. Check the error's `region=`/`profile=` values
against what you intended.

**Results seem incomplete for an account with many Config rules or a
rule with many non-compliant resources.** Pagination is capped at
`MAX_PAGES = 20` per call (both the rule-compliance list and each
rule's evaluation-details fetch) as a safety bound. There is currently
no `truncated` flag on the output — if you suspect truncation, compare
`summary.totalRules`/`summary.nonCompliantResources` against what the
AWS Config console reports for the same region.

**A specific rule's error mentions `GetComplianceDetailsByConfigRule
failed for rule "..."`.** `get_non_compliant` fetches rule-level
compliance first, then evaluation details per non-compliant rule
serially. A permissions gap that only affects certain rule types (e.g.
managed vs. custom Lambda-backed rules) surfaces as a failure on that
specific rule, not the whole method — the rule name in the error
identifies which IAM policy statement to check.
