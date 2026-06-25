# @webframp/aws/iam

Cross-account IAM observation model for role, user, and policy inventory.

## Usage

```bash
# Create a model instance
swamp model create @webframp/aws/iam iam-fleet \
  --set profiles='["prod-readonly","staging-readonly","dev-readonly"]'

# Discover all IAM state
swamp model @webframp/aws/iam method run discover_all iam-fleet

# Or discover incrementally
swamp model @webframp/aws/iam method run discover_roles iam-fleet
swamp model @webframp/aws/iam method run discover_users iam-fleet
swamp model @webframp/aws/iam method run discover_policies iam-fleet
swamp model @webframp/aws/iam method run discover_trust_map iam-fleet
```

## Query Examples

```bash
# Find roles with external trusts (unknown accounts)
swamp data query iam-fleet 'specName == "trustMap" && size(attributes.externalTrusts) > 0'

# Find users without MFA
swamp data query iam-fleet 'specName == "users" && attributes.users.exists(u, !u.mfaEnabled)'

# Find access keys older than 90 days
swamp data query iam-fleet 'specName == "users" && attributes.users.exists(u, u.accessKeys.exists(k, k.ageDays > 90 && k.status == "Active"))'
```

## Resources

| Resource | Description |
|----------|-------------|
| `roles` | Per-account role inventory with trust policies |
| `users` | Per-account user inventory with credential metadata |
| `policies` | Per-account customer-managed policy metadata |
| `trustMap` | Cross-account trust graph (edges, external, service) |

## Methods

| Method | Description |
|--------|-------------|
| `discover_roles` | Fan-out role discovery across profiles |
| `discover_users` | Fan-out user discovery with MFA and key status |
| `discover_policies` | Customer-managed policy metadata |
| `discover_trust_map` | Build trust graph from discovered roles |
| `discover_all` | Orchestrate all discovery methods |

## Required Permissions

All methods are read-only. The configured profiles need:

- `iam:ListRoles`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`
- `iam:ListUsers`, `iam:ListMFADevices`, `iam:ListAccessKeys`, `iam:GetAccessKeyLastUsed`
- `iam:ListAttachedUserPolicies`, `iam:ListUserPolicies`
- `iam:ListPolicies`
- `sts:GetCallerIdentity`
