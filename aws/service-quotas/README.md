# @webframp/aws/service-quotas

Query and monitor AWS Service Quotas across accounts.

## Usage

```bash
# Create a model instance
swamp model create @webframp/aws/service-quotas quotas \
  --set profiles='["prod-readonly","staging-readonly"]'

# Get a specific quota (e.g. IAM roles per account)
swamp model method run quotas get_quota \
  --input serviceCode=iam --input quotaCode=L-FE177D64

# List all quotas for a service
swamp model method run quotas list_quotas --input serviceCode=iam

# Discover available service codes
swamp model method run quotas list_services

# Find quotas above 80% utilization across all accounts
swamp model method run quotas check_utilization \
  --input serviceCode=iam --input threshold=0.8
```

## Common Quota Codes

| Service | Quota | Code |
|---------|-------|------|
| IAM | Roles per account | L-FE177D64 |
| IAM | Policies per account | L-E95E4862 |
| IAM | Instance profiles | L-6E65F259 |
| Lambda | Concurrent executions | L-B99A9384 |
| VPC | VPCs per region | L-F678F1CE |
| EC2 | Running On-Demand instances | L-1216C47A |

## Resources

| Resource | Description |
|----------|-------------|
| `quota` | Single quota detail with value and usage |
| `quotas` | All quotas for a service in an account |
| `services` | Available service codes |
| `utilization` | Quotas above threshold across accounts |

## Required Permissions

Read-only methods need:

```bash
# Required IAM policy permissions
servicequotas:GetServiceQuota
servicequotas:ListServiceQuotas
servicequotas:ListServices
servicequotas:GetAWSDefaultServiceQuota
cloudwatch:GetMetricData
sts:GetCallerIdentity

# request_increase additionally requires:
servicequotas:RequestServiceQuotaIncrease
```
