# @webframp/aws/terraform-drift

Terraform drift detection for AWS. This extension compares Terraform state
against live AWS resources to find configuration drift, highlighting missing,
extra, and changed resources across your infrastructure.

The extension orchestrates data collection from `@webframp/terraform` (state via
CLI), `@webframp/aws/inventory` (EC2 instances via SDK), and
`@webframp/aws/networking` (NAT gateways, load balancers, Elastic IPs via SDK).
It then produces a structured drift report with both Markdown and JSON output.

## Supported Resource Types

Drift detection currently compares the following AWS resource types:

- `aws_instance` -- EC2 instances (instance type, tags)
- `aws_nat_gateway` -- NAT gateways (subnet, tags)
- `aws_lb` -- Load balancers (name, internal/scheme)
- `aws_eip` -- Elastic IPs (public IP, tags)

Other resource types appear in the inventory but are not yet compared.

## Quick Start

Install the extension and create the required model instances:

```bash
swamp extension pull @webframp/aws/terraform-drift

swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo
swamp model create @webframp/aws/inventory aws-inventory \
  --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking \
  --global-arg region=us-east-1
```

Then run the drift workflow:

```bash
swamp workflow run @webframp/terraform-drift
```

The workflow runs two parallel jobs -- one gathers Terraform state (resource
list, full state, outputs) and the other collects live AWS data (EC2 inventory,
NAT gateways, load balancers, Elastic IPs). After both jobs complete, the drift
report compares the two data sets and produces a summary.

## Report Output

The drift report generates a Markdown summary table and a JSON payload. The JSON
structure contains a `summary` object with counts and a `findings` array with
per-resource drift details:

```json
{
  "summary": {
    "totalTfResources": 12,
    "comparedResources": 8,
    "driftedResources": 2,
    "missingInAws": 1,
    "fieldDrifts": 1,
    "unsupportedTypes": 4
  },
  "findings": [
    {
      "tfAddress": "aws_instance.web",
      "tfType": "aws_instance",
      "resourceId": "i-abc123",
      "status": "field_drift",
      "fields": [
        { "field": "instance_type", "terraform": "t3.micro", "aws": "t3.large" }
      ]
    }
  ]
}
```

## Troubleshooting

### Report shows "No Drift Detected" when drift exists

The drift report reads data written by upstream model methods
(`tf-infra
read_state`, `aws-inventory`, `aws-networking`). If those methods
were not run before the report, or if they failed (the workflow marks all AWS
steps as `allowFailure: true`), the report silently proceeds with empty
reference data and produces a clean result. Confirm that the workflow's gather
jobs completed successfully via `swamp workflow history search --json` or
`swamp run history`.

### False "missing_in_aws" findings

When an AWS gathering step fails (network error, permission issue), its data is
absent. The report treats every Terraform resource of that type as
"missing_in_aws" because it has no AWS data to compare against. Check the
workflow run history for step failures before acting on these findings.

### Workflow `region` input has no effect

The workflow definition accepts a `region` input (default `us-east-1`), but no
step references it. The actual region comes from the `--global-arg region=...`
set when creating the `aws-inventory` and `aws-networking` model instances. To
target a different region, recreate those model instances — do not rely on the
workflow input.

### Terraform resource skipped without indication

If a Terraform resource lacks an `id`, `arn`, or `allocation_id` in its state
values, the comparison loop skips it without logging or incrementing a skip
counter. Resources with custom ID patterns not covered by the report's field
mapping will silently not appear in the output.

### Data read failures are fully silent

The report's `getData` helper catches all errors (file not found, corrupt JSON,
permission denied) and returns `null`. There is no log entry distinguishing
"data not yet collected" from "data file is corrupted." If the report output
seems incomplete, verify the raw data files exist under `.swamp/data/`.

## Dependencies

This extension requires the following swamp extensions:

- `@webframp/terraform` -- Terraform CLI integration for state reading
- `@webframp/aws/inventory` -- AWS resource inventory via SDK
- `@webframp/aws/networking` -- AWS networking resource queries via SDK

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for the full text.
