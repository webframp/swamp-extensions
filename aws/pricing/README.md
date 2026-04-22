# @webframp/aws/pricing

A swamp model extension for querying the AWS Pricing API. This extension
provides methods to list available AWS services, retrieve attribute values,
look up pricing data with flexible filters, and fetch EC2 instance pricing
through a dedicated convenience method.

## Authentication

The extension uses the default AWS credential chain. The Pricing API serves
public catalog data and does not require special IAM permissions, but valid
AWS credentials must be present in the environment.

The AWS Pricing API is available only in `us-east-1` and `ap-south-1`.
Configure the model's `region` global argument accordingly.

## Installation

```bash
swamp extension install @webframp/aws/pricing
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
|------------------------|--------------------------------------------------|
| `list_services`        | List all AWS services in the Pricing API catalog  |
| `get_attribute_values` | Retrieve possible values for a service attribute  |
| `get_price`            | Query pricing data with optional field filters    |
| `get_ec2_price`        | Shortcut for EC2 On-Demand instance pricing       |

## Common Service Codes

- `AmazonEC2` -- Elastic Compute Cloud
- `AmazonRDS` -- Relational Database Service
- `AmazonS3` -- Simple Storage Service
- `AWSLambda` -- Lambda Functions
- `AmazonDynamoDB` -- DynamoDB
- `AmazonElastiCache` -- ElastiCache
- `AmazonEKS` -- Elastic Kubernetes Service

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
