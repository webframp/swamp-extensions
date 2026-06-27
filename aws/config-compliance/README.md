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
