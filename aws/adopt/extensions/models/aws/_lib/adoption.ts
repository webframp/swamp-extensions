/**
 * Adoption type registry and candidate helpers.
 *
 * `ADOPTION_TYPES` is the single table that says which AWS resource types
 * adopt can bring under swamp management, which `@swamp/aws/*` type manages
 * each one, and what the sweep needs to know to list, order, and judge them.
 * Everything here is pure: no AWS SDK, no I/O.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";

// =============================================================================
// Registry
// =============================================================================

/** Coarse grouping used for reporting and for filtering a sweep. */
export const ADOPTION_TIERS = [
  "network",
  "identity",
  "data",
  "compute",
  "messaging",
  "edge",
  "observability",
] as const;

/** One of {@link ADOPTION_TIERS}. */
export type AdoptionTier = typeof ADOPTION_TIERS[number];

/**
 * A child type that Cloud Control can only list with a parent identifier,
 * e.g. ECS services within a cluster. The sweep lists the parent type first,
 * then lists the child once per parent with `ResourceModel` set to
 * `{ [listKey]: <parent identifier> }`.
 */
export interface AdoptionParent {
  /** CloudFormation type of the parent; must also be in the registry. */
  cfnType: string;
  /** Property name Cloud Control expects in `ResourceModel` for listing. */
  listKey: string;
}

/** Registry entry for one adoptable AWS resource type. */
export interface AdoptionType {
  /** CloudFormation / Cloud Control type name, e.g. `AWS::S3::Bucket`. */
  cfnType: string;
  /** The official swamp model type that manages this resource. */
  swampType: string;
  /** The published package that ships `swampType`. */
  swampPackage: string;
  /** Coarse grouping for reporting and sweep filters. */
  tier: AdoptionTier;
  /** Dependency order; lower adopts first. */
  rank: number;
  /** True when deleting or replacing the resource loses data. */
  stateful: boolean;
  /**
   * Properties that make up the Cloud Control primary identifier, in schema
   * order. Composite identifiers are these values joined with `|`, matching
   * both Cloud Control and the official swamp types.
   */
  identifierProperties: readonly string[];
  /** Set for child types that need a parent identifier to list. */
  parent: AdoptionParent | null;
  /**
   * Property paths projected into `judgeState`: only the attributes a risk
   * or disposition call depends on. Paths use `.` for nesting. Never list
   * properties that can carry secret material (environment variables,
   * user data, container definitions, parameter values).
   */
  judgeAttributes: readonly string[];
  /**
   * Live references to other registry types: property path → cfnType.
   * `a[].b` flattens arrays of objects. Values may be identifiers or ARNs.
   */
  references: Readonly<Record<string, string>>;
  /**
   * Property holding the resource's tags, when it is not `Tags`; null when
   * the type has no tags. `TagSpecifications` reads the launch-template entry.
   */
  tagsProperty?: string | null;
  /**
   * Property holding the resource's own ARN, or null when its model has
   * none. Never a property that holds some other resource's ARN.
   */
  arnProperty: string | null;
  /**
   * True when the identifier is AWS-generated and unique across regions and
   * accounts (`vpc-…`, `subnet-…`, a hosted zone id), so a stored record
   * with no ARN can still be matched safely.
   */
  uniqueIdentifier: boolean;
  /**
   * True for global types (IAM, CloudFront, Route 53) that Cloud Control
   * lists the same way from every region; their model names omit region.
   */
  global: boolean;
  /**
   * Set when `plan_stack_adoption` cannot adopt this type from a stack's
   * physical ID for a reason other than a composite identifier.
   */
  stackUnaddressable?: string;
}

/** Options for {@link entry}; everything a registry row needs beyond its keys. */
interface EntryOptions {
  tier: AdoptionTier;
  rank: number;
  stateful?: boolean;
  id: string[];
  parent?: AdoptionParent;
  judge: string[];
  refs?: Record<string, string>;
  tagsProperty?: string | null;
  arn?: string | null;
  unique?: boolean;
  global?: boolean;
  stackUnaddressable?: string;
}

/** Build a frozen registry row, deriving `swampPackage` from `swampType`. */
function entry(
  cfnType: string,
  swampType: string,
  o: EntryOptions,
): AdoptionType {
  const swampPackage = swampType.split("/").slice(0, 3).join("/");
  return Object.freeze({
    cfnType,
    swampType,
    swampPackage,
    tier: o.tier,
    rank: o.rank,
    stateful: o.stateful ?? false,
    identifierProperties: Object.freeze([...o.id]),
    parent: o.parent ? Object.freeze({ ...o.parent }) : null,
    judgeAttributes: Object.freeze([...o.judge]),
    references: Object.freeze({ ...(o.refs ?? {}) }),
    ...(o.tagsProperty !== undefined ? { tagsProperty: o.tagsProperty } : {}),
    arnProperty: o.arn === undefined ? "Arn" : o.arn,
    uniqueIdentifier: o.unique ?? false,
    global: o.global ?? false,
    ...(o.stackUnaddressable
      ? { stackUnaddressable: o.stackUnaddressable }
      : {}),
  });
}

const VPC = "AWS::EC2::VPC";
const SUBNET = "AWS::EC2::Subnet";
const SG = "AWS::EC2::SecurityGroup";
const KMS_KEY = "AWS::KMS::Key";
const IAM_ROLE = "AWS::IAM::Role";
const TARGET_GROUP = "AWS::ElasticLoadBalancingV2::TargetGroup";

/**
 * Every AWS resource type adopt can bring under swamp management.
 *
 * Identifier properties were checked against the official `@swamp/aws/*`
 * types; `deno task check:registry` re-checks them before a release.
 * `AWS::DynamoDB::Table` is absent because no official swamp type manages
 * it yet (`@swamp/aws/dynamodb` ships only `global-table`).
 */
export const ADOPTION_TYPES: readonly AdoptionType[] = Object.freeze([
  // --- network --------------------------------------------------------------
  entry(VPC, "@swamp/aws/ec2/vpc", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 10,
    id: ["VpcId"],
    judge: [
      "CidrBlock",
      "EnableDnsSupport",
      "EnableDnsHostnames",
      "InstanceTenancy",
      "Tags",
    ],
  }),
  entry("AWS::EC2::InternetGateway", "@swamp/aws/ec2/internet-gateway", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 11,
    id: ["InternetGatewayId"],
    judge: ["Tags"],
  }),
  entry("AWS::EC2::EIP", "@swamp/aws/ec2/eip", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 11,
    id: ["PublicIp", "AllocationId"],
    judge: ["Domain", "InstanceId", "NetworkBorderGroup", "Tags"],
  }),
  entry(SUBNET, "@swamp/aws/ec2/subnet", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 12,
    id: ["SubnetId"],
    judge: [
      "VpcId",
      "CidrBlock",
      "AvailabilityZone",
      "MapPublicIpOnLaunch",
      "Tags",
    ],
    refs: { VpcId: VPC },
  }),
  entry("AWS::EC2::RouteTable", "@swamp/aws/ec2/route-table", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 13,
    id: ["RouteTableId"],
    judge: ["VpcId", "Tags"],
    refs: { VpcId: VPC },
  }),
  entry(SG, "@swamp/aws/ec2/security-group", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 13,
    id: ["Id"],
    judge: [
      "GroupName",
      "GroupDescription",
      "VpcId",
      "SecurityGroupIngress",
      "SecurityGroupEgress",
      "Tags",
    ],
    refs: { VpcId: VPC },
  }),
  entry("AWS::EC2::NatGateway", "@swamp/aws/ec2/nat-gateway", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 14,
    id: ["NatGatewayId"],
    judge: ["SubnetId", "ConnectivityType", "Tags"],
    refs: { SubnetId: SUBNET },
  }),
  entry("AWS::EC2::VPCEndpoint", "@swamp/aws/ec2/vpcendpoint", {
    arn: null,
    unique: true,
    tier: "network",
    rank: 15,
    id: ["Id"],
    judge: [
      "VpcEndpointType",
      "ServiceName",
      "PolicyDocument",
      "PrivateDnsEnabled",
      "VpcId",
    ],
    refs: {
      VpcId: VPC,
      SubnetIds: SUBNET,
      SecurityGroupIds: SG,
      RouteTableIds: "AWS::EC2::RouteTable",
    },
  }),

  // --- identity -------------------------------------------------------------
  entry(KMS_KEY, "@swamp/aws/kms/key", {
    tier: "identity",
    rank: 20,
    stateful: true,
    id: ["KeyId"],
    judge: [
      "Description",
      "Enabled",
      "KeyPolicy",
      "KeySpec",
      "KeyUsage",
      "EnableKeyRotation",
      "MultiRegion",
      "Tags",
    ],
  }),
  entry("AWS::KMS::Alias", "@swamp/aws/kms/alias", {
    tagsProperty: null,
    arn: null,
    tier: "identity",
    rank: 21,
    id: ["AliasName"],
    judge: ["AliasName", "TargetKeyId"],
    refs: { TargetKeyId: KMS_KEY },
  }),
  entry("AWS::IAM::ManagedPolicy", "@swamp/aws/iam/managed-policy", {
    tagsProperty: null,
    global: true,
    arn: "PolicyArn",
    tier: "identity",
    rank: 22,
    id: ["PolicyArn"],
    judge: ["ManagedPolicyName", "Path", "PolicyDocument", "Roles"],
  }),
  entry(IAM_ROLE, "@swamp/aws/iam/role", {
    global: true,
    tier: "identity",
    rank: 23,
    id: ["RoleName"],
    judge: [
      "RoleName",
      "Path",
      "AssumeRolePolicyDocument",
      "ManagedPolicyArns",
      "Policies",
      "PermissionsBoundary",
      "MaxSessionDuration",
      "Tags",
    ],
    refs: {
      ManagedPolicyArns: "AWS::IAM::ManagedPolicy",
    },
  }),
  entry("AWS::SecretsManager::Secret", "@swamp/aws/secretsmanager/secret", {
    arn: "Id",
    tier: "identity",
    rank: 24,
    stateful: true,
    id: ["Id"],
    judge: ["Name", "Description", "KmsKeyId", "Tags"],
    refs: { KmsKeyId: KMS_KEY },
  }),
  entry("AWS::SSM::Parameter", "@swamp/aws/ssm/parameter", {
    tier: "identity",
    rank: 24,
    stateful: true,
    id: ["Name"],
    judge: ["Name", "Type", "Tier", "DataType", "Description", "Tags"],
  }),

  // --- data -----------------------------------------------------------------
  entry("AWS::S3::Bucket", "@swamp/aws/s3/bucket", {
    unique: true,
    tier: "data",
    rank: 30,
    stateful: true,
    id: ["BucketName"],
    judge: [
      "BucketName",
      "PublicAccessBlockConfiguration",
      "BucketEncryption",
      "VersioningConfiguration",
      "OwnershipControls",
      "LoggingConfiguration",
      "Tags",
    ],
  }),
  entry("AWS::EFS::FileSystem", "@swamp/aws/efs/file-system", {
    unique: true,
    tier: "data",
    rank: 31,
    stateful: true,
    id: ["FileSystemId"],
    judge: [
      "Encrypted",
      "KmsKeyId",
      "BackupPolicy",
      "FileSystemPolicy",
      "PerformanceMode",
      "FileSystemTags",
    ],
    refs: { KmsKeyId: KMS_KEY },
    tagsProperty: "FileSystemTags",
  }),
  entry("AWS::RDS::DBSubnetGroup", "@swamp/aws/rds/dbsubnet-group", {
    arn: "DBSubnetGroupArn",
    tier: "data",
    rank: 31,
    id: ["DBSubnetGroupName"],
    judge: ["DBSubnetGroupName", "SubnetIds", "Tags"],
    refs: { SubnetIds: SUBNET },
  }),
  entry("AWS::RDS::DBCluster", "@swamp/aws/rds/dbcluster", {
    arn: "DBClusterArn",
    tier: "data",
    rank: 32,
    stateful: true,
    id: ["DBClusterIdentifier"],
    judge: [
      "Engine",
      "EngineVersion",
      "StorageEncrypted",
      "KmsKeyId",
      "DeletionProtection",
      "BackupRetentionPeriod",
      "PubliclyAccessible",
      "EnableIAMDatabaseAuthentication",
      "VpcSecurityGroupIds",
      "Tags",
    ],
    refs: {
      DBSubnetGroupName: "AWS::RDS::DBSubnetGroup",
      VpcSecurityGroupIds: SG,
      KmsKeyId: KMS_KEY,
    },
  }),
  entry(
    "AWS::ElastiCache::ReplicationGroup",
    "@swamp/aws/elasticache/replication-group",
    {
      arn: null,
      tier: "data",
      rank: 32,
      stateful: true,
      id: ["ReplicationGroupId"],
      judge: [
        "Engine",
        "CacheNodeType",
        "AtRestEncryptionEnabled",
        "TransitEncryptionEnabled",
        "AutomaticFailoverEnabled",
        "SnapshotRetentionLimit",
        "Tags",
      ],
      refs: { SecurityGroupIds: SG, KmsKeyId: KMS_KEY },
    },
  ),
  entry("AWS::RDS::DBInstance", "@swamp/aws/rds/dbinstance", {
    arn: "DBInstanceArn",
    tier: "data",
    rank: 33,
    stateful: true,
    id: ["DBInstanceIdentifier"],
    judge: [
      "DBInstanceClass",
      "Engine",
      "EngineVersion",
      "PubliclyAccessible",
      "StorageEncrypted",
      "KmsKeyId",
      "DeletionProtection",
      "BackupRetentionPeriod",
      "MultiAZ",
      "DBClusterIdentifier",
      "Tags",
    ],
    refs: {
      DBClusterIdentifier: "AWS::RDS::DBCluster",
      DBSubnetGroupName: "AWS::RDS::DBSubnetGroup",
      VPCSecurityGroups: SG,
      KmsKeyId: KMS_KEY,
    },
  }),

  // --- messaging ------------------------------------------------------------
  entry("AWS::SQS::Queue", "@swamp/aws/sqs/queue", {
    tier: "messaging",
    rank: 35,
    stateful: true,
    id: ["QueueUrl"],
    judge: [
      "QueueName",
      "KmsMasterKeyId",
      "SqsManagedSseEnabled",
      "MessageRetentionPeriod",
      "RedrivePolicy",
      "Tags",
    ],
    refs: { KmsMasterKeyId: KMS_KEY },
  }),
  entry("AWS::SNS::Topic", "@swamp/aws/sns/topic", {
    arn: "TopicArn",
    tier: "messaging",
    rank: 35,
    id: ["TopicArn"],
    judge: ["TopicName", "KmsMasterKeyId", "FifoTopic", "Tags"],
    refs: { KmsMasterKeyId: KMS_KEY },
  }),

  // --- edge (load balancing first: compute references target groups) -------
  entry(TARGET_GROUP, "@swamp/aws/elasticloadbalancingv2/target-group", {
    arn: "TargetGroupArn",
    tier: "edge",
    rank: 40,
    id: ["TargetGroupArn"],
    judge: [
      "Name",
      "Protocol",
      "Port",
      "TargetType",
      "VpcId",
      "HealthCheckPath",
      "Tags",
    ],
    refs: { VpcId: VPC },
  }),
  entry(
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "@swamp/aws/elasticloadbalancingv2/load-balancer",
    {
      arn: "LoadBalancerArn",
      tier: "edge",
      rank: 41,
      id: ["LoadBalancerArn"],
      judge: [
        "Name",
        "Scheme",
        "Type",
        "Subnets",
        "SecurityGroups",
        "LoadBalancerAttributes",
        "Tags",
      ],
      refs: { Subnets: SUBNET, SecurityGroups: SG },
    },
  ),
  entry(
    "AWS::ElasticLoadBalancingV2::Listener",
    "@swamp/aws/elasticloadbalancingv2/listener",
    {
      arn: "ListenerArn",
      tier: "edge",
      rank: 42,
      id: ["ListenerArn"],
      parent: {
        cfnType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        listKey: "LoadBalancerArn",
      },
      judge: [
        "LoadBalancerArn",
        "Port",
        "Protocol",
        "SslPolicy",
        "DefaultActions",
      ],
      refs: {
        LoadBalancerArn: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        "DefaultActions[].TargetGroupArn": TARGET_GROUP,
      },
    },
  ),

  // --- compute --------------------------------------------------------------
  entry("AWS::ECR::Repository", "@swamp/aws/ecr/repository", {
    tier: "compute",
    rank: 43,
    stateful: true,
    id: ["RepositoryName"],
    judge: [
      "RepositoryName",
      "ImageScanningConfiguration",
      "ImageTagMutability",
      "EncryptionConfiguration",
      "RepositoryPolicyText",
      "Tags",
    ],
  }),
  entry("AWS::EC2::LaunchTemplate", "@swamp/aws/ec2/launch-template", {
    tagsProperty: "TagSpecifications",
    arn: null,
    unique: true,
    tier: "compute",
    rank: 44,
    id: ["LaunchTemplateId"],
    judge: [
      "LaunchTemplateName",
      "LaunchTemplateData.MetadataOptions",
      "LaunchTemplateData.IamInstanceProfile",
      "LaunchTemplateData.NetworkInterfaces",
    ],
  }),
  entry("AWS::Lambda::Function", "@swamp/aws/lambda/function", {
    tier: "compute",
    rank: 45,
    id: ["FunctionName"],
    judge: [
      "FunctionName",
      "Runtime",
      "Role",
      "VpcConfig",
      "KmsKeyArn",
      "PackageType",
      "Architectures",
      "Tags",
    ],
    refs: {
      Role: IAM_ROLE,
      "VpcConfig.SubnetIds": SUBNET,
      "VpcConfig.SecurityGroupIds": SG,
      KmsKeyArn: KMS_KEY,
    },
  }),
  entry("AWS::ECS::Cluster", "@swamp/aws/ecs/cluster", {
    tier: "compute",
    rank: 45,
    id: ["ClusterName"],
    judge: ["ClusterName", "ClusterSettings", "CapacityProviders", "Tags"],
  }),
  entry("AWS::EKS::Cluster", "@swamp/aws/eks/cluster", {
    tier: "compute",
    rank: 45,
    id: ["Name"],
    judge: [
      "Name",
      "Version",
      "RoleArn",
      "ResourcesVpcConfig",
      "EncryptionConfig",
      "Logging",
      "AccessConfig",
      "Tags",
    ],
    refs: {
      RoleArn: IAM_ROLE,
      "ResourcesVpcConfig.SubnetIds": SUBNET,
      "ResourcesVpcConfig.SecurityGroupIds": SG,
    },
  }),
  entry("AWS::ECS::TaskDefinition", "@swamp/aws/ecs/task-definition", {
    arn: "TaskDefinitionArn",
    tier: "compute",
    rank: 46,
    id: ["TaskDefinitionArn"],
    judge: [
      "Family",
      "TaskRoleArn",
      "ExecutionRoleArn",
      "NetworkMode",
      "RequiresCompatibilities",
      "Cpu",
      "Memory",
      "Tags",
    ],
    refs: { TaskRoleArn: IAM_ROLE, ExecutionRoleArn: IAM_ROLE },
  }),
  entry("AWS::ECS::Service", "@swamp/aws/ecs/service", {
    arn: "ServiceArn",
    tier: "compute",
    rank: 47,
    id: ["ServiceArn", "Cluster"],
    parent: { cfnType: "AWS::ECS::Cluster", listKey: "Cluster" },
    judge: [
      "ServiceName",
      "Cluster",
      "LaunchType",
      "DesiredCount",
      "NetworkConfiguration",
      "LoadBalancers",
      "TaskDefinition",
      "Tags",
    ],
    refs: {
      Cluster: "AWS::ECS::Cluster",
      TaskDefinition: "AWS::ECS::TaskDefinition",
      "LoadBalancers[].TargetGroupArn": TARGET_GROUP,
      "NetworkConfiguration.AwsvpcConfiguration.Subnets": SUBNET,
      "NetworkConfiguration.AwsvpcConfiguration.SecurityGroups": SG,
    },
  }),
  entry("AWS::EKS::Nodegroup", "@swamp/aws/eks/nodegroup", {
    stackUnaddressable:
      "the stack physical ID is not confirmed to equal the Cloud Control Id",
    tier: "compute",
    rank: 47,
    id: ["Id"],
    parent: { cfnType: "AWS::EKS::Cluster", listKey: "ClusterName" },
    judge: [
      "ClusterName",
      "NodegroupName",
      "NodeRole",
      "Subnets",
      "ScalingConfig",
      "AmiType",
      "CapacityType",
      "Tags",
    ],
    refs: {
      ClusterName: "AWS::EKS::Cluster",
      NodeRole: IAM_ROLE,
      Subnets: SUBNET,
      "LaunchTemplate.Id": "AWS::EC2::LaunchTemplate",
    },
  }),
  entry(
    "AWS::AutoScaling::AutoScalingGroup",
    "@swamp/aws/autoscaling/auto-scaling-group",
    {
      arn: "AutoScalingGroupARN",
      tier: "compute",
      rank: 47,
      id: ["AutoScalingGroupName"],
      judge: [
        "AutoScalingGroupName",
        "MinSize",
        "MaxSize",
        "DesiredCapacity",
        "VPCZoneIdentifier",
        "LaunchTemplate",
        "TargetGroupARNs",
        "Tags",
      ],
      refs: {
        VPCZoneIdentifier: SUBNET,
        "LaunchTemplate.LaunchTemplateId": "AWS::EC2::LaunchTemplate",
        TargetGroupARNs: TARGET_GROUP,
      },
    },
  ),
  entry("AWS::Events::Rule", "@swamp/aws/events/rule", {
    stackUnaddressable:
      "the stack physical ID is the rule name; Cloud Control identifies rules by Arn",
    tier: "messaging",
    rank: 50,
    id: ["Arn"],
    judge: [
      "Name",
      "EventBusName",
      "EventPattern",
      "ScheduleExpression",
      "State",
      "RoleArn",
    ],
    refs: { RoleArn: IAM_ROLE },
  }),

  // --- edge (public entry points) -------------------------------------------
  entry("AWS::Route53::HostedZone", "@swamp/aws/route53/hosted-zone", {
    global: true,
    arn: null,
    unique: true,
    tier: "edge",
    rank: 60,
    id: ["Id"],
    judge: ["Name", "HostedZoneConfig", "VPCs", "HostedZoneTags"],
    refs: { "VPCs[].VPCId": VPC },
    tagsProperty: "HostedZoneTags",
  }),
  entry("AWS::CloudFront::Distribution", "@swamp/aws/cloudfront/distribution", {
    global: true,
    arn: null,
    unique: true,
    tier: "edge",
    rank: 60,
    id: ["Id"],
    judge: [
      "DistributionConfig.Enabled",
      "DistributionConfig.Aliases",
      "DistributionConfig.ViewerCertificate",
      "DistributionConfig.WebACLId",
      "DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy",
      "DistributionConfig.Logging",
      "Tags",
    ],
  }),
  entry("AWS::ApiGatewayV2::Api", "@swamp/aws/apigatewayv2/api", {
    arn: "ExecuteApiArn",
    tier: "edge",
    rank: 60,
    id: ["ApiId"],
    judge: [
      "Name",
      "ProtocolType",
      "DisableExecuteApiEndpoint",
      "CorsConfiguration",
      "Tags",
    ],
  }),
  entry("AWS::Route53::RecordSet", "@swamp/aws/route53/record-set", {
    tagsProperty: null,
    global: true,
    arn: null,
    unique: true,
    tier: "edge",
    rank: 61,
    id: ["Name", "HostedZoneId", "Type", "SetIdentifier"],
    parent: { cfnType: "AWS::Route53::HostedZone", listKey: "HostedZoneId" },
    judge: ["Name", "Type", "HostedZoneId", "AliasTarget", "TTL"],
    refs: { HostedZoneId: "AWS::Route53::HostedZone" },
  }),

  // --- observability --------------------------------------------------------
  entry("AWS::Logs::LogGroup", "@swamp/aws/logs/log-group", {
    tier: "observability",
    rank: 70,
    stateful: true,
    id: ["LogGroupName"],
    judge: [
      "LogGroupName",
      "RetentionInDays",
      "KmsKeyId",
      "DataProtectionPolicy",
      "Tags",
    ],
    refs: { KmsKeyId: KMS_KEY },
  }),
  entry("AWS::CloudWatch::Alarm", "@swamp/aws/cloudwatch/alarm", {
    tier: "observability",
    rank: 71,
    id: ["AlarmName"],
    judge: [
      "AlarmName",
      "Namespace",
      "MetricName",
      "ActionsEnabled",
      "AlarmActions",
    ],
  }),
]);

/** Registry rows keyed by CloudFormation type. */
export const ADOPTION_TYPES_BY_CFN: ReadonlyMap<string, AdoptionType> = new Map(
  ADOPTION_TYPES.map((t) => [t.cfnType, t]),
);

/** Registry rows keyed by swamp model type. */
export const ADOPTION_TYPES_BY_SWAMP: ReadonlyMap<string, AdoptionType> =
  new Map(ADOPTION_TYPES.map((t) => [t.swampType, t]));

/** CloudFormation type → swamp type, derived from {@link ADOPTION_TYPES}. */
export function cfnToSwampTypeMap(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(ADOPTION_TYPES.map((t) => [t.cfnType, t.swampType])),
  );
}

// =============================================================================
// Candidate and plan schemas
// =============================================================================

/**
 * Deterministic findings set before any AI call. Each is a live AWS fact,
 * not a guess about who created the resource.
 */
export const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = Object
  .freeze({
    "asg-managed": "tagged aws:autoscaling:groupName; an Auto Scaling group " +
      "creates and replaces it",
    "eks-managed": "tagged eks:cluster-name; EKS creates and reconciles it",
    "service-linked-role": "IAM path /aws-service-role/; owned by an AWS " +
      "service",
    "cdk-assets": "cdk-*-assets-* bucket created by CDK bootstrap",
    "default-vpc": "the region's default VPC",
    "control-tower": "aws-controltower-* resource managed by Control Tower",
    "cfn-stack":
      "belongs to a CloudFormation stack (aws:cloudformation:* tags)",
    "read-failed": "listed, but GetResource failed; judgeState is incomplete",
  });

/** One resource the sweep found, in the shape every source emits. */
export const AdoptionCandidateSchema = z.object({
  id: z.string().describe("Stable candidate id: `<cfnType>/<identifier>`"),
  swampType: z.string(),
  cfnType: z.string(),
  identifier: z.string().describe("Cloud Control primary identifier"),
  arn: z.string().optional(),
  region: z.string(),
  scope: z.enum(["sweep", "stack"]),
  dependsOn: z.array(z.string()).describe(
    "Candidate ids this resource references live (subnet → vpc)",
  ),
  tags: z.record(z.string(), z.string()),
  modelName: z.string(),
  cfnStack: z.string().nullable().describe(
    "aws:cloudformation:stack-name tag, a live fact; not an ownership claim",
  ),
  swampManaged: z.boolean().describe(
    "A swamp definition already observes this resource",
  ),
  flags: z.array(z.string()),
  judgeState: z.record(z.string(), z.unknown()).describe(
    "judgeAttributes projection sent to jev",
  ),
});

/** Inferred candidate type. */
export type AdoptionCandidate = z.infer<typeof AdoptionCandidateSchema>;

/** Why a registry type was not (fully) swept. */
export const GAP_REASONS = [
  "no-list-handler",
  "unsupported-in-region",
  "access-denied",
  "throttled",
  "parent-not-swept",
  "error",
] as const;

/** One of {@link GAP_REASONS}. */
export type GapReason = typeof GAP_REASONS[number];

/** A registry type the sweep could not list, with the reason. */
export const CoverageGapSchema = z.object({
  cfnType: z.string(),
  reason: z.enum(GAP_REASONS),
  detail: z.string(),
});

/** What the sweep looked at and what it could not see. */
export const CoverageSchema = z.object({
  typesRequested: z.array(z.string()),
  typesSwept: z.array(z.string()),
  gaps: z.array(CoverageGapSchema),
  truncatedTypes: z.array(z.string()),
  readFailures: z.number(),
  warnings: z.array(z.string()),
});

/** The `adoptionPlan` resource written by every adoption source. */
export const AdoptionPlanSchema = z.object({
  scope: z.enum(["sweep", "stack"]),
  accountId: z.string(),
  region: z.string(),
  stackName: z.string().nullable(),
  prefix: z.string(),
  truncated: z.boolean(),
  candidates: z.array(AdoptionCandidateSchema),
  coverage: CoverageSchema,
  summary: z.object({
    total: z.number(),
    swampManaged: z.number(),
    unmanaged: z.number(),
    flagged: z.number(),
    byCfnType: z.record(z.string(), z.number()),
    byTier: z.record(z.string(), z.number()),
  }),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Read a property path from a resource model. `a.b` descends into objects;
 * `a[].b` flattens an array of objects. Returns `undefined` when absent, and
 * an array whenever a `[]` segment was crossed.
 */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown[] = [obj];
  let flattened = false;
  for (const segment of path.split(".")) {
    const flatten = segment.endsWith("[]");
    const key = flatten ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const value = (node as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (flatten) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    if (flatten) flattened = true;
    current = next;
  }
  if (flattened) return current;
  return current[0];
}

/** Project a resource model down to its type's `judgeAttributes`. */
export function projectJudgeState(
  type: AdoptionType,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of type.judgeAttributes) {
    const value = getPath(properties, path);
    if (value !== undefined) out[path] = value;
  }
  return out;
}

/** True when every judge attribute is already present in `properties`. */
export function hasJudgeAttributes(
  type: AdoptionType,
  properties: Record<string, unknown> | undefined,
): boolean {
  if (!properties) return false;
  return type.judgeAttributes.every((p) =>
    getPath(properties, p) !== undefined
  );
}

/**
 * Normalise Cloud Control tags. Most types use `[{Key, Value}]`; some
 * (SSM, EKS nodegroups, API Gateway) use a plain map.
 */
export function normalizeTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const tag of raw) {
      if (tag === null || typeof tag !== "object") continue;
      const t = tag as Record<string, unknown>;
      const key = t.Key ?? t.key;
      const value = t.Value ?? t.value;
      if (typeof key === "string") {
        out[key] = typeof value === "string" ? value : String(value ?? "");
      }
    }
  } else if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/** Tags for a resource model, honouring the type's `tagsProperty`. */
export function tagsFor(
  type: AdoptionType,
  properties: Record<string, unknown>,
): Record<string, string> {
  const prop = type.tagsProperty === undefined ? "Tags" : type.tagsProperty;
  if (prop === null) return {};
  if (prop === "TagSpecifications") {
    const specs = properties.TagSpecifications;
    const spec = Array.isArray(specs)
      ? specs.find((s) =>
        s && typeof s === "object" &&
        (s as Record<string, unknown>).ResourceType === "launch-template"
      )
      : undefined;
    return normalizeTags((spec as Record<string, unknown> | undefined)?.Tags);
  }
  return normalizeTags(properties[prop]);
}

/**
 * True when a listing already carries everything the sweep stores: every
 * judge attribute, the type's own ARN, and its tags. Only then is the
 * `GetResource` call skipped.
 */
export function listingIsComplete(
  type: AdoptionType,
  properties: Record<string, unknown> | undefined,
): boolean {
  if (!properties || !hasJudgeAttributes(type, properties)) return false;
  if (type.arnProperty && properties[type.arnProperty] === undefined) {
    return false;
  }
  const tags = type.tagsProperty === undefined ? "Tags" : type.tagsProperty;
  return tags === null || properties[tags] !== undefined;
}

/**
 * Rebuild a Cloud Control primary identifier from a resource model, or
 * return null when any part is missing. Used to match stored swamp state
 * against swept resources.
 */
export function identifierFromProperties(
  type: AdoptionType,
  properties: Record<string, unknown>,
): string | null {
  const parts: string[] = [];
  for (const prop of type.identifierProperties) {
    const value = properties[prop];
    if (value === undefined || value === null || value === "") return null;
    parts.push(String(value));
  }
  return parts.join("|");
}

/**
 * The resource's own ARN: its type's `arnProperty`, or the identifier when
 * the identifier is an ARN. Never an ARN the resource merely references.
 */
export function arnFor(
  type: AdoptionType,
  identifier: string,
  properties: Record<string, unknown>,
): string | undefined {
  const arn = type.arnProperty ? properties[type.arnProperty] : undefined;
  if (typeof arn === "string" && arn.startsWith("arn:")) return arn;
  if (type.identifierProperties.length === 1 && identifier.startsWith("arn:")) {
    return identifier;
  }
  return undefined;
}

/** Context the flag rules need beyond a single resource. */
export interface FlagContext {
  defaultVpcIds: ReadonlySet<string>;
}

/** Deterministic flags for one resource; see {@link FLAG_DESCRIPTIONS}. */
export function deterministicFlags(
  type: AdoptionType,
  identifier: string,
  properties: Record<string, unknown>,
  tags: Record<string, string>,
  context: FlagContext,
): string[] {
  const flags: string[] = [];
  if (tags["aws:autoscaling:groupName"]) flags.push("asg-managed");
  if (tags["eks:cluster-name"]) flags.push("eks-managed");
  if (type.cfnType === "AWS::IAM::Role") {
    const path = properties.Path;
    const arn = properties.Arn;
    if (
      (typeof path === "string" && path.startsWith("/aws-service-role/")) ||
      (typeof arn === "string" && arn.includes(":role/aws-service-role/"))
    ) {
      flags.push("service-linked-role");
    }
  }
  if (
    type.cfnType === "AWS::S3::Bucket" &&
    /^cdk-[a-z0-9]+-assets-/.test(identifier)
  ) {
    flags.push("cdk-assets");
  }
  if (
    type.cfnType === "AWS::EC2::VPC" && context.defaultVpcIds.has(identifier)
  ) {
    flags.push("default-vpc");
  }
  const arn = arnFor(type, identifier, properties) ?? "";
  if (
    /aws-controltower[-/]/i.test(identifier) ||
    /aws-controltower[-/]/i.test(arn)
  ) {
    flags.push("control-tower");
  }
  if (tags["aws:cloudformation:stack-name"]) flags.push("cfn-stack");
  return flags;
}

/** Service abbreviations that keep generated model names readable. */
const SERVICE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  elasticloadbalancingv2: "elbv2",
  apigatewayv2: "apigwv2",
};

/** Where a resource lives: the account and region a sweep ran against. */
export interface SweepScope {
  accountId: string;
  region: string;
}

/**
 * Deterministic model name for a swept resource:
 * `<prefix>-<service>-<resource>-<fnv1a(account|region|cfnType|identifier)>`.
 * Hashing the type keeps two types that share an identifier (an ECS and an
 * EKS cluster both named `prod`) apart; hashing account and region keeps the
 * same name in two regions or accounts apart.
 */
export function candidateModelName(
  prefix: string,
  type: AdoptionType,
  identifier: string,
  scope: SweepScope,
): string {
  const [, , service = "aws", resource = "resource"] = type.swampType.split(
    "/",
  );
  const svc = SERVICE_ABBREVIATIONS[service] ?? service;
  const where = type.global ? "global" : scope.region;
  const key = `${scope.accountId}|${where}|${type.cfnType}|${identifier}`;
  return `${prefix}-${svc}-${resource}-${fnv1a(key)}`;
}

/** FNV-1a 32-bit hash as 8 hex characters. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable candidate id. */
export function candidateId(cfnType: string, identifier: string): string {
  return `${cfnType}/${identifier}`;
}

/** Collect the string values found at a reference path. */
function referenceValues(properties: Record<string, unknown>, path: string) {
  const raw = getPath(properties, path);
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((v): v is string => typeof v === "string" && v !== "");
}

/**
 * Resolve each candidate's `references` against the other candidates, by
 * identifier or ARN, and return candidate id → sorted `dependsOn` ids.
 * References to resources outside the sweep are dropped.
 */
export function resolveDependsOn(
  items: ReadonlyArray<{
    id: string;
    type: AdoptionType;
    identifier: string;
    arn?: string;
    properties: Record<string, unknown>;
    parentId?: string;
  }>,
): Map<string, string[]> {
  const index = new Map<string, string>();
  for (const item of items) {
    index.set(`${item.type.cfnType}|${item.identifier}`, item.id);
    if (item.arn) index.set(`${item.type.cfnType}|${item.arn}`, item.id);
  }
  const result = new Map<string, string[]>();
  for (const item of items) {
    const deps = new Set<string>();
    if (item.parentId) deps.add(item.parentId);
    for (const [path, target] of Object.entries(item.type.references)) {
      for (const value of referenceValues(item.properties, path)) {
        const id = index.get(`${target}|${value}`);
        if (id && id !== item.id) deps.add(id);
      }
    }
    result.set(item.id, [...deps].sort());
  }
  return result;
}

/** A stored swamp state record, as projected by the workflow's data query. */
export interface ManagedRecord {
  modelType: string;
  attributes: Record<string, unknown> | null;
}

/** Account and region parsed from an ARN; empty strings for global ARNs. */
export function parseArn(
  arn: string,
): { region: string; accountId: string } | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  return { region: parts[3], accountId: parts[4] };
}

/** True when an ARN names a different account or region than `scope`. */
function arnOutsideScope(arn: string, scope: SweepScope): boolean {
  const parsed = parseArn(arn);
  if (!parsed) return false;
  if (parsed.region && parsed.region !== scope.region) return true;
  if (parsed.accountId && parsed.accountId !== scope.accountId) return true;
  return false;
}

/** Keys that identify one resource of one type: its identifier and own ARN. */
export function identityKeys(
  swampType: string,
  identifier: string | null,
  arn: string | undefined,
): string[] {
  const keys: string[] = [];
  if (identifier) keys.push(`${swampType}|${identifier}`);
  if (arn) keys.push(`${swampType}|${arn}`);
  return keys;
}

/**
 * Account and region embedded in an identifier that is not an ARN. Only SQS
 * queue URLs (`https://sqs.<region>.amazonaws.com/<account>/<name>`) carry
 * them today.
 */
export function scopeFromIdentifier(
  identifier: string,
): { region: string; accountId: string } | null {
  const m = identifier.match(
    /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com[^/]*\/(\d{12})\//,
  );
  return m ? { region: m[1], accountId: m[2] } : null;
}

/** Result of {@link managedKeys}. */
export interface ManagedMatch {
  /** Identity keys swamp already observes in scope. */
  keys: Set<string>;
  /**
   * Records skipped because nothing in them names a scope, though their
   * type's full state would (`get` or `sync` stores it).
   */
  unscoped: number;
  /**
   * Records of types whose state never carries an ARN or scope and whose
   * identifier is not unique (KMS aliases, ElastiCache replication groups):
   * never matchable.
   */
  unmatchable: number;
  /** Records with no usable identifier at all. */
  unidentified: number;
}

/** True when no stored record of this type can ever be scoped. */
function neverScoped(type: AdoptionType): boolean {
  return type.arnProperty === null && !type.uniqueIdentifier &&
    type.cfnType !== "AWS::SQS::Queue";
}

/**
 * Build the set of identity keys swamp already observes in `scope`. Only
 * registry types count. A record is scoped by its type's own ARN (see
 * `arnProperty`), or by an identifier that embeds account and region (an SQS
 * queue URL), and skipped when that names another account or region, so a
 * function named `api` in us-east-1 never marks `api` in us-west-2 as
 * managed. A record with neither matches only when the type's identifier is
 * globally unique (`uniqueIdentifier`); otherwise it is counted in
 * `unscoped` and the resource stays unmanaged rather than hidden.
 */
export function managedKeys(
  records: ReadonlyArray<ManagedRecord>,
  scope: SweepScope,
  swampTypes?: ReadonlySet<string>,
): ManagedMatch {
  const keys = new Set<string>();
  let unscoped = 0;
  let unmatchable = 0;
  let unidentified = 0;
  for (const record of records) {
    const type = ADOPTION_TYPES_BY_SWAMP.get(record.modelType);
    const attrs = record.attributes;
    if (!type || !attrs) continue;
    if (swampTypes && !swampTypes.has(type.swampType)) continue;
    const listed = typeof attrs._identifier === "string" && attrs._identifier
      ? attrs._identifier
      : null;
    const identifier = identifierFromProperties(type, attrs) ?? listed;
    if (!identifier) {
      unidentified++;
      continue;
    }
    const arn = arnFor(type, identifier, attrs);
    const embedded = scopeFromIdentifier(identifier);
    if (arn) {
      if (arnOutsideScope(arn, scope)) continue;
    } else if (embedded) {
      if (
        embedded.region !== scope.region ||
        embedded.accountId !== scope.accountId
      ) continue;
    } else if (!type.uniqueIdentifier) {
      if (neverScoped(type)) unmatchable++;
      else unscoped++;
      continue;
    }
    for (const key of identityKeys(type.swampType, identifier, arn)) {
      keys.add(key);
    }
    if (listed && listed !== identifier) {
      keys.add(`${type.swampType}|${listed}`);
    }
  }
  return { keys, unscoped, unmatchable, unidentified };
}

/** Map a Cloud Control error onto a coverage gap reason. */
export function classifySweepError(err: unknown): GapReason {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (
    name === "UnsupportedActionException" ||
    /UnsupportedAction|does not support LIST/i.test(message)
  ) {
    return "no-list-handler";
  }
  if (name === "TypeNotFoundException" || /TypeNotFound/i.test(message)) {
    return "unsupported-in-region";
  }
  if (
    /AccessDenied|UnauthorizedOperation|not authorized/i.test(
      `${name} ${message}`,
    )
  ) {
    return "access-denied";
  }
  if (
    /Throttl|RequestLimitExceeded|TooManyRequests|Rate exceeded/i.test(
      `${name} ${message}`,
    )
  ) {
    return "throttled";
  }
  return "error";
}

/** Choose registry types for a sweep, in rank order. */
export function selectSweepTypes(
  types: readonly string[] | undefined,
  tiers: readonly string[] | undefined,
): AdoptionType[] {
  const typeSet = types && types.length > 0 ? new Set(types) : null;
  const tierSet = tiers && tiers.length > 0 ? new Set(tiers) : null;
  return ADOPTION_TYPES
    .filter((t) => !typeSet || typeSet.has(t.cfnType))
    .filter((t) => !tierSet || tierSet.has(t.tier))
    .slice()
    .sort((a, b) => a.rank - b.rank || a.cfnType.localeCompare(b.cfnType));
}

/**
 * Why `plan_stack_adoption` cannot adopt this type from a stack's physical
 * ID, or null when it can. A composite Cloud Control identifier (an ECS
 * service is `ServiceArn|Cluster`) is never equal to the single physical ID
 * CloudFormation reports, so a `get` built from it cannot succeed.
 */
export function stackUnmappableReason(type: AdoptionType): string | null {
  if (type.stackUnaddressable) return type.stackUnaddressable;
  if (type.identifierProperties.length <= 1) return null;
  return `Cloud Control identifier is composite (${
    type.identifierProperties.join("|")
  }); the stack's physical ID cannot address it`;
}

/**
 * Short name used in stack-adoption model names. The last segment of the
 * CloudFormation type, lowercased (`AWS::EC2::VPC` → `vpc`), prefixed with
 * the service only when two registry types share it (`ecs-cluster`,
 * `eks-cluster`), so existing stack model names stay unchanged.
 */
export function stackShortName(cfnType: string): string {
  const parts = cfnType.split("::");
  const last = (parts[parts.length - 1] ?? cfnType).toLowerCase();
  const shared =
    ADOPTION_TYPES.filter((t) =>
      t.cfnType.split("::").pop()?.toLowerCase() === last
    ).length > 1;
  return shared ? `${(parts[1] ?? "").toLowerCase()}-${last}` : last;
}
