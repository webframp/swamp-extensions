# @webframp/aws/pricing

A swamp model extension for querying the AWS Pricing API. This extension
provides methods to list available AWS services, retrieve attribute values, look
up pricing data with flexible filters, and fetch EC2 instance pricing through a
dedicated convenience method.

## Authentication

The extension uses the default AWS credential chain. The Pricing API serves
public catalog data and does not require special IAM permissions, but valid AWS
credentials must be present in the environment.

The AWS Pricing API is available only in `us-east-1` and `ap-south-1`. Configure
the model's `region` global argument accordingly.

## Installation

```bash
swamp extension pull @webframp/aws/pricing
swamp model create @webframp/aws/pricing aws-pricing
```

## Usage

### List all available services

```bash
swamp model method run aws-pricing list_services
```

### Get attribute values for a service

```bash
swamp model method run aws-pricing get_attribute_values \
  --input serviceCode=AmazonEC2 \
  --input attributeName=instanceType
```

### Look up pricing with filters

```bash
swamp model method run aws-pricing get_price \
  --input serviceCode=AmazonEC2 \
  --input 'filters=[{"field":"instanceType","value":"t3.medium"}]'
```

### Get EC2 instance pricing (convenience method)

```bash
swamp model method run aws-pricing get_ec2_price \
  --input instanceType=t3.medium \
  --input region=us-east-1 \
  --input operatingSystem=Linux
```

## Methods

| Method                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `list_services`        | List all AWS services in the Pricing API catalog |
| `get_attribute_values` | Retrieve possible values for a service attribute |
| `get_price`            | Query pricing data with optional field filters   |
| `get_ec2_price`        | Shortcut for EC2 On-Demand instance pricing      |

## Common Service Codes

- `AmazonEC2` -- Elastic Compute Cloud
- `AmazonRDS` -- Relational Database Service
- `AmazonS3` -- Simple Storage Service
- `AWSLambda` -- Lambda Functions
- `AmazonDynamoDB` -- DynamoDB
- `AmazonElastiCache` -- ElastiCache
- `AmazonEKS` -- Elastic Kubernetes Service

## Troubleshooting

### `get_ec2_price` returns empty items for a valid instance type

The method maps the `region` argument to a Pricing API location string (e.g.
`"us-east-1"` → `"US East (N. Virginia)"`). The mapping covers 17 regions. For
unmapped regions (Milan, Cape Town, Hong Kong, Jakarta, etc.), the raw region
code is used as the location filter, which matches nothing in the API. The
method returns `items: []` without error.

### Malformed price entries silently dropped

Both `get_price` and `get_ec2_price` parse individual price list entries with
`JSON.parse()`. Entries that fail to parse are silently skipped. If all entries
are malformed, the method returns `items: []` successfully. The `truncated`
field does not account for dropped entries — it reflects pagination status only.

### `MAX_PAGES = 10` truncation in `list_services` and `get_attribute_values`

Both methods cap pagination at 10 pages. Services or attribute values beyond
that limit are silently omitted. The `truncated` field is set to `true` when the
cap is reached.

### `get_price` default `maxResults` is 10

The method returns at most 10 items by default. Pass `--input maxResults=100`
(max 1000) to retrieve more. The method paginates automatically up to
`maxResults`.

### `get_ec2_price` does not paginate

This method issues a single API call with `MaxResults: 10`. Results beyond 10
matches are silently truncated with no `truncated` indicator. The tight filter
set (instance type + location + OS + tenancy) should produce a single match, but
edge cases (multiple pre-installed software variants) may not all appear.

### Pricing API region

The API exists only in `us-east-1` and `ap-south-1`. The `region` global arg
defaults to `us-east-1`. This controls the API endpoint, not the pricing target
region. The method-level `region` argument in `get_ec2_price` controls which
region's pricing is returned.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
