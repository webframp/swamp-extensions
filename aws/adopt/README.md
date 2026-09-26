# @webframp/aws/adopt

Brownfield adoption of AWS resources into swamp models. adopt cares about what
is running in an account and region, not what created it: Terraform,
CloudFormation, the console, and scripts all look the same. The question it
answers is whether swamp manages a resource yet.

Three sources find resources:

- `plan_account_sweep` enumerates every [registry type](#adoption-types) in the
  region through Cloud Control and writes adoption candidates with flags,
  dependencies, and coverage gaps.
- `plan_stack_adoption` scopes the same question to one CloudFormation stack.
- The `discover_*` methods keep the original VPC-centric SDK discovery.

## Authentication

This extension uses the default AWS credential chain, or the shared-config
profile named by the optional `profile` global argument. Export `AWS_PROFILE`
before running any method:

```bash
export AWS_PROFILE=my-account-ReadOnlyPlus
```

The region comes from the `region` global argument, not `AWS_REGION` (see
[Troubleshooting](#aws_region-environment-variable-has-no-effect)).

The official `@swamp/aws/*` types that observe adopted resources take no
`profile` argument. They always use the environment's credential chain, so set
`AWS_PROFILE` in the shell that runs the workflow.

The credentials need the read permissions listed under
[IAM Permissions Required](#iam-permissions-required): Cloud Control and the
underlying service reads for a sweep, CloudFormation for stack adoption, and
EC2, RDS, and Secrets Manager for the `discover_*` methods.

## Quick Start

```bash
# Install the extension
swamp extension pull @webframp/aws/adopt

# Create a discovery model scoped to a VPC
swamp model create @webframp/aws/adopt my-discovery \
  --global-arg region=us-east-1 \
  --global-arg vpcId=vpc-0b4f6dd0dfd8c5339

# Run full discovery
swamp model method run my-discovery discover_all --arg prefix=swamp-pg-test

# Execute the generated setup commands (from discover_all output)
swamp model create @swamp/aws/ec2/vpc swamp-pg-test-vpc-0dfd8c5339 \
  --global-arg 'name=swamp-pg-test-vpc-0dfd8c5339' \
  --global-arg 'CidrBlock=10.0.0.0/16'
# ... (repeat for each resource in setupCommands)

# Run the adoption workflow
swamp workflow run @webframp/adopt-stack \
  --input vpcId=vpc-0b4f6dd0dfd8c5339 \
  --input clusterIdentifier=my-cluster \
  --input prefix=swamp-pg-test

# View the adoption report
swamp report get @webframp/adopt-report --latest
```

## Account Sweep

`plan_account_sweep` lists every registry type in the region with Cloud Control
`ListResources`, then calls `GetResource` for any resource whose listing lacks
the attributes judgement needs. It resolves the account with STS
`GetCallerIdentity` first and fails if it cannot, because the account scopes
model names and managed matching. It writes one `adoptionPlan` resource named
`sweep-<region>`, which records `accountId` and `region`.

The sweep covers the whole region; the `vpcId` global argument applies only to
the `discover_*` methods.

A sweep limited with `types` or `tiers` writes the same `sweep-<region>`
instance and replaces the previous plan; `coverage.typesRequested` records what
it covered.

Most listings return only identifier properties, so expect one `GetResource`
call per resource. Keep `readConcurrency` low on large accounts.

```bash
swamp model create @webframp/aws/adopt acct --global-arg region=us-east-1
swamp model method run acct plan_account_sweep
swamp data get acct sweep-us-east-1 --json
```

### Arguments

| Argument              | Default | Meaning                                                   |
| --------------------- | ------- | --------------------------------------------------------- |
| `prefix`              | `adopt` | Prefix for generated model names                          |
| `types`               | all     | Limit to these CloudFormation types (must be in registry) |
| `tiers`               | all     | Limit to these tiers (`network`, `identity`, `data`, …)   |
| `maxPagesPerType`     | `5`     | `ListResources` page cap per type, and per parent         |
| `maxResourcesPerType` | `200`   | Resource cap per type; the excess marks it truncated      |
| `readConcurrency`     | `4`     | Concurrent `GetResource` calls                            |
| `managed`             | `[]`    | Stored swamp state to match against (see below)           |

### Candidates

Each entry in `candidates[]` has the same shape whichever source produced it:

| Field          | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `id`           | `<cfnType>/<identifier>`, stable across runs                          |
| `swampType`    | The official type that manages the resource                           |
| `identifier`   | Cloud Control primary identifier (`\|`-joined when composite)         |
| `arn`          | The resource's own ARN, when it has one                               |
| `dependsOn`    | Candidate ids this resource references live (subnet → vpc)            |
| `tags`         | Resource tags as a map                                                |
| `modelName`    | `<prefix>-<service>-<resource>-<hash>`, deterministic                 |
| `cfnStack`     | The `aws:cloudformation:stack-name` tag, or `null`                    |
| `swampManaged` | A swamp definition already observes the resource                      |
| `flags`        | Deterministic findings, listed below                                  |
| `judgeState`   | The type's judge attributes only; never environment variables or data |

`modelName` hashes the account, region, type, and identifier together. An ECS
cluster and an EKS cluster that are both named `prod` get different names, and
so does a function named `api` in two regions. Global types (IAM, CloudFront,
Route 53) hash without the region, so sweeps of two regions name the same role
the same way.

### Flags

| Flag                  | Set when                                                  |
| --------------------- | --------------------------------------------------------- |
| `asg-managed`         | tagged `aws:autoscaling:groupName`                        |
| `eks-managed`         | tagged `eks:cluster-name`                                 |
| `service-linked-role` | IAM role under `/aws-service-role/`                       |
| `cdk-assets`          | S3 bucket named `cdk-*-assets-*`                          |
| `default-vpc`         | the region's default VPC                                  |
| `control-tower`       | identifier or ARN contains `aws-controltower-`            |
| `cfn-stack`           | tagged `aws:cloudformation:stack-name`                    |
| `read-failed`         | listed, but `GetResource` failed; `judgeState` is partial |

### Matching what swamp already manages

The sweep does not query AWS to decide `swampManaged`. It matches identifiers
against stored state from the official types, passed in through `managed`. From
a workflow step:

```yaml
inputs:
  managed: >-
    ${{ data.query('modelType.startsWith("@swamp/aws/") && specName == "state"',
    '{"modelType": modelType, "attributes": attributes}') }}
```

Each record matches on its type's primary identifier properties, the
`_identifier` that an official `list` method stores, or its own ARN. The
registry's `arnProperty` names where that ARN lives (`Arn`, `DBInstanceArn`,
`ServiceArn`, …); ARNs of other resources a record references never count. A
record whose type is not in the registry is ignored.

Matching is scoped to the sweep's account and region. A record is scoped by its
own ARN, or by an identifier that embeds account and region (an SQS queue URL),
and never matches when that names another account or region: `api` in us-east-1
does not mark `api` in us-west-2 as managed. A record with neither matches only
when its type's identifier is unique everywhere (`uniqueIdentifier` in the
registry: VPCs, subnets, security groups, S3 buckets, EFS file systems, hosted
zones, and the like).

Official `list` methods store only the listed properties and `_identifier`, so
their records often lack an ARN. Such a record for a name-identified type (an
EKS cluster, a Lambda function) cannot be scoped and is not matched: the
resource shows as unmanaged rather than being hidden, and `coverage.warnings`
counts the skipped records. Running `get` or `sync` on those models stores the
full state, ARN included. KMS aliases and ElastiCache replication groups never
store an ARN or region, so they are never matched; `coverage.warnings` counts
those records separately.

The sweep only considers stored records for the types it swept.

### Coverage and gaps

`coverage` says what the sweep looked at and what it could not see:

- `typesRequested` and `typesSwept` list the registry types asked for and the
  types that listed cleanly.
- `gaps[]` records each type that could not be listed, with a `reason`:
  `no-list-handler`, `unsupported-in-region`, `access-denied`, `throttled`,
  `parent-not-swept`, or `error`. The sweep continues past every gap. A child
  type that fails under some parents keeps the resources it did list and still
  records a gap, with the count of failed parents in `detail`.
- `truncatedTypes` names the types that hit a page or resource cap. The
  top-level `truncated` is true when any did.
- `readFailures` counts `GetResource` failures; those candidates carry
  `read-failed`.

Child types need a parent identifier to list. ECS services list per cluster, ELB
listeners per load balancer, Route 53 record sets per hosted zone, and EKS
nodegroups per cluster. A child type swept without its parent type records a
`parent-not-swept` gap.

## Adoption Types

`ADOPTION_TYPES` in `extensions/models/aws/_lib/adoption.ts` is the registry.
Each row names the CloudFormation type, the official swamp type and package, the
tier, the dependency `rank` (lower adopts first), whether the resource is
stateful, its primary identifier properties, an optional parent for child types,
its live references, and the attributes projected into `judgeState`.

| Tier          | Types                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| network       | VPC, InternetGateway, EIP, Subnet, RouteTable, SecurityGroup, NatGateway, VPCEndpoint                                                           |
| identity      | KMS Key, KMS Alias, IAM ManagedPolicy, IAM Role, SecretsManager Secret, SSM Parameter                                                           |
| data          | S3 Bucket, EFS FileSystem, RDS DBSubnetGroup, RDS DBCluster, ElastiCache ReplicationGroup, RDS DBInstance                                       |
| messaging     | SQS Queue, SNS Topic, Events Rule                                                                                                               |
| compute       | ECR Repository, EC2 LaunchTemplate, Lambda Function, ECS Cluster, EKS Cluster, ECS TaskDefinition, ECS Service, EKS Nodegroup, AutoScalingGroup |
| edge          | ELBv2 TargetGroup, LoadBalancer, Listener, Route53 HostedZone, Route53 RecordSet, CloudFront Distribution, ApiGatewayV2 Api                     |
| observability | Logs LogGroup, CloudWatch Alarm                                                                                                                 |

`AWS::DynamoDB::Table` is absent because no official swamp type manages it yet.

To add a type, add a row and run the release check:

```bash
deno task check:registry
```

The check pulls every package in the registry into a throwaway swamp repo and
fails when a type is missing, wraps a different CloudFormation type, or uses
different identifier properties. It also fails when the ARN, tags, judge, or
reference properties a row names are not top-level keys of the official
`StateSchema`; nested paths such as `LaunchTemplateData.MetadataOptions` are not
checked below the first segment. It needs the `swamp` CLI and network access.

## Discovery Methods

| Method                      | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `discover_all`              | Full discovery with setup commands and workflow guidance |
| `discover_vpcs`             | Discover existing VPCs                                   |
| `discover_subnets`          | Discover existing subnets                                |
| `discover_gateways`         | Discover existing internet gateways                      |
| `discover_route_tables`     | Discover existing route tables                           |
| `discover_security_groups`  | Discover existing security groups                        |
| `discover_rds_clusters`     | Discover existing RDS clusters                           |
| `discover_rds_instances`    | Discover existing RDS instances                          |
| `discover_db_subnet_groups` | Discover existing DB subnet groups                       |
| `discover_secrets`          | Discover existing Secrets Manager secrets                |

All methods respect the `vpcId` global argument for filtering EC2 resources. RDS
and Secrets Manager methods discover all resources in the region regardless of
VPC filter.

## CloudFormation Stack Adoption

For environments managed by CloudFormation, `plan_stack_adoption` enumerates a
stack's resources and produces an adoption plan that maps each `AWS::*` type to
its corresponding `@swamp/aws/*` model.

### Method

| Method                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `plan_stack_adoption` | Map all stack resources (recursive into nested) to swamp types |

Inputs:

- `stackName` (required): CloudFormation stack name or ID
- `includeNested` (default: `true`): recurse into `AWS::CloudFormation::Stack`
  children
- `maxDepth` (default: `3`): nested stack recursion limit
- `prefix` (default: `adopt`): prefix for generated swamp model names

Output (stored as the `stackPlan` resource):

- `mapped[]` — resources with a known swamp type, model name, physical ID, and
  `getCommand` for adoption
- `unmapped[]` — resources with no swamp equivalent (e.g.,
  `AWS::Kinesis::Stream`, `Custom::*` resources)
- `skipped[]` — resources in unstable states (`CREATE_IN_PROGRESS`,
  `DELETE_IN_PROGRESS`, etc.) where `PhysicalResourceId` is unreliable
- `orphans[]` — resources from a previous plan that are missing from the current
  stack (compared against the previous run's plan stored in this model)
- `summary` — counts and `coveragePercent`

### Workflow

`@webframp/adopt-cfn-stack` orchestrates the two-phase adoption:

```bash
swamp workflow run @webframp/adopt-cfn-stack \
  --input modelName=my-adopt \
  --input stackName=my-prod-stack
```

The workflow produces the plan, then runs `get` on each mapped resource's swamp
model. Models that don't yet exist will surface as failed steps (with
`allowFailure: true` so the workflow continues). Create the required models
using `swamp model type describe <swampType>` to determine required global-args,
then re-run the workflow — on the second pass, all `get` calls succeed and live
state is captured.

### Supported CloudFormation types

Stack adoption maps 36 of the 41 [registry](#adoption-types) types. A `get`
built from a stack's physical ID cannot address the other five, so they appear
in `unmapped[]` with the reason:

- `AWS::EC2::EIP`, `AWS::ECS::Service`, and `AWS::Route53::RecordSet` have
  composite Cloud Control identifiers.
- `AWS::Events::Rule`: the physical ID is the rule name, but Cloud Control
  identifies rules by ARN.
- `AWS::EKS::Nodegroup`: the physical ID is not confirmed to equal the Cloud
  Control `Id`.

A resource that moves to `unmapped[]` this way is still in the stack, so it is
not reported as an orphan. `CFN_TO_SWAMP_TYPE_MAP` is derived from
`ADOPTION_TYPES` and stays exported. `AWS::CloudFormation::Stack` resources are
recursed into, not adopted as models.

## Model Naming Convention

`plan_account_sweep` names models `{prefix}-{service}-{resource}-{hash}` (see
[Candidates](#candidates)). `plan_stack_adoption` uses
`{prefix}-{type-short}-{hash}`, where `type-short` gains the service when two
registry types share a name (`ecs-cluster`, `eks-cluster`). The `discover_*`
methods name models this way:

```
{prefix}-{type-short}-{identifier-suffix}
```

Examples:

- `swamp-pg-test-vpc-0dfd8c5339` (last 9 characters of the VPC ID)
- `swamp-pg-test-subnet-0a1b2c3d4` (last 9 characters of the subnet ID)
- `swamp-pg-test-rds-my-cluster` (full cluster identifier)
- `swamp-pg-test-secret-db-creds` (full secret name)

EC2 resources use the last 9 characters of the resource ID as the suffix. RDS
and Secrets Manager resources use the full identifier or name.

## IAM Permissions Required

**Account sweep (read-only):**

- `cloudcontrol:ListResources`
- `cloudcontrol:GetResource`
- The read permissions Cloud Control uses for each registry type (for example
  `s3:ListAllMyBuckets` and `s3:GetBucket*`, `iam:ListRoles` and `iam:GetRole`).
  Cloud Control calls each service with the caller's credentials. The AWS
  managed `ReadOnlyAccess` policy covers them. A missing permission becomes an
  `access-denied` gap for that type, not a failed sweep.
- `ec2:DescribeVpcs` (default VPC lookup)
- `sts:GetCallerIdentity` (needs no grant)

**CloudFormation stack adoption (read-only):**

- `cloudformation:ListStackResources`

**Discovery methods (read-only):**

- `ec2:DescribeVpcs`
- `ec2:DescribeSubnets`
- `ec2:DescribeInternetGateways`
- `ec2:DescribeRouteTables`
- `ec2:DescribeSecurityGroups`
- `rds:DescribeDBClusters`
- `rds:DescribeDBInstances`
- `rds:DescribeDBSubnetGroups`
- `secretsmanager:ListSecrets`

**Management (workflow adoption):**

- All discovery permissions above
- `ec2:DescribeVpcAttribute`
- `rds:DescribeDBClusterEndpoints`
- `rds:ListTagsForResource`
- `secretsmanager:DescribeSecret`

## Troubleshooting

### `AWS_REGION` environment variable has no effect

The model always uses the `region` global arg (default `us-east-1`), passed
explicitly to every SDK client. The `AWS_REGION` environment variable is not
read. To target a different region, use `--global-arg region=<your-region>` when
creating the model instance.

### Discovery returns zero resources in a non-empty VPC

If the `vpcId` global arg is set, all EC2 discovery filters to that VPC. A typo
in the VPC ID (must match `vpc-[a-f0-9]+`) produces zero results without error.
If `vpcId` is unset, discovery scans all VPCs in the configured region.

### `MAX_PAGES = 5` truncation

EC2 discovery (VPCs, subnets, IGWs, route tables, security groups) caps at 5
pages. EC2 returns up to 1,000 items per page, so the cap is ~5,000 resources
per type. RDS and Secrets Manager return ~100 per page, capping at ~500. The
`truncated` field in the output is `true` when any discovery function hit its
cap. Narrow the scope with the `vpcId` global arg if you exceed these limits.

### `plan_stack_adoption` shows no orphans on first run

Orphan detection compares the current plan against a previously stored plan. On
the first run (or if the previous plan is unreadable), orphan detection silently
degrades to an empty list. Run `plan_stack_adoption` twice to get meaningful
orphan data.

### Resources without primary identifiers silently omitted

If the AWS API returns a resource lacking its primary identifier field (e.g. a
VPC with no `VpcId`), the resource is skipped without warning. The `count` field
in the output reflects only resources that passed this filter.

### A sweep reports gaps

Read `coverage.gaps[]`. `access-denied` means the credentials lack the
underlying service read for that type. `throttled` means Cloud Control kept
throttling after the client's adaptive retries; lower `readConcurrency` or sweep
fewer `types` at a time. `no-list-handler` and `unsupported-in-region` are
properties of the type and region, not of the account.

### A sweep is truncated

`coverage.truncatedTypes` names the types that hit `maxPagesPerType` or
`maxResourcesPerType`. Raise the cap, or sweep that type on its own with
`types`.

### CloudFormation stack adoption and nested stacks

`plan_stack_adoption` recurses into nested stacks using
`MAX_LIST_RESOURCES_PAGES = 10` per stack. Very deeply nested stack trees (10+
levels or 1,000+ resources per stack) may hit this cap. The method logs a
warning when truncated.

## Dependencies

`manifest.yaml` pins the packages the shipped workflows run:

- `@swamp/aws/ec2@2026.09.24.1`
- `@swamp/aws/rds@2026.09.25.1`
- `@swamp/aws/secretsmanager@2026.09.25.1`

Observing other registry types needs their packages installed:
`swamp extension pull <swampPackage>`.
