// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "jsr:@std/assert@1.0.19";
import {
  ADOPTION_TIERS,
  ADOPTION_TYPES,
  ADOPTION_TYPES_BY_CFN,
  AdoptionCandidateSchema,
  type AdoptionType,
  arnFor,
  candidateModelName,
  cfnToSwampTypeMap,
  classifySweepError,
  deterministicFlags,
  FLAG_DESCRIPTIONS,
  getPath,
  hasJudgeAttributes,
  identifierFromProperties,
  identityKeys,
  listingIsComplete,
  managedKeys,
  normalizeTags,
  parseArn,
  projectJudgeState,
  resolveDependsOn,
  scopeFromIdentifier,
  selectSweepTypes,
  stackShortName,
  stackUnmappableReason,
  tagsFor,
} from "./adoption.ts";

function type(cfnType: string): AdoptionType {
  const t = ADOPTION_TYPES_BY_CFN.get(cfnType);
  if (!t) throw new Error(`missing registry type ${cfnType}`);
  return t;
}

const noDefaults = { defaultVpcIds: new Set<string>() };
const EAST = { accountId: "111111111111", region: "us-east-1" };
const WEST = { accountId: "111111111111", region: "us-west-2" };

// =============================================================================
// Registry invariants
// =============================================================================

Deno.test("registry covers the planned starting set (~40 types)", () => {
  assert(ADOPTION_TYPES.length >= 40, `only ${ADOPTION_TYPES.length} types`);
});

Deno.test("registry cfnType and swampType are unique", () => {
  const cfn = new Set(ADOPTION_TYPES.map((t) => t.cfnType));
  const swamp = new Set(ADOPTION_TYPES.map((t) => t.swampType));
  assertEquals(cfn.size, ADOPTION_TYPES.length);
  assertEquals(swamp.size, ADOPTION_TYPES.length);
});

Deno.test("registry rows are well formed", () => {
  for (const t of ADOPTION_TYPES) {
    assert(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(t.cfnType), t.cfnType);
    assert(t.swampPackage.startsWith("@swamp/aws/"), t.swampPackage);
    assert(t.swampType.startsWith(`${t.swampPackage}/`), t.swampType);
    assert((ADOPTION_TIERS as readonly string[]).includes(t.tier), t.tier);
    assert(t.identifierProperties.length > 0, `${t.cfnType} has no id`);
    assert(t.judgeAttributes.length > 0, `${t.cfnType} has no judge attrs`);
  }
});

Deno.test("registry parents and references point at registry types ranked earlier", () => {
  for (const t of ADOPTION_TYPES) {
    if (t.parent) {
      const parent = type(t.parent.cfnType);
      assert(parent.rank < t.rank, `${t.cfnType} ranks before its parent`);
      assertEquals(parent.parent, null, "parents must be top-level types");
    }
    for (const target of Object.values(t.references)) {
      const ref = type(target);
      assert(
        ref.rank < t.rank,
        `${t.cfnType} (${t.rank}) references ${target} (${ref.rank})`,
      );
    }
  }
});

Deno.test("registry judgeAttributes never include secret-bearing properties", () => {
  const forbidden =
    /(^|\.)(Environment|UserData|ContainerDefinitions|Value|SecretString|SecureString|Code|AuthToken|Password|MasterUserPassword)$/;
  for (const t of ADOPTION_TYPES) {
    for (const attr of t.judgeAttributes) {
      assert(!forbidden.test(attr), `${t.cfnType} projects ${attr}`);
    }
  }
});

Deno.test("registry is frozen", () => {
  assert(Object.isFrozen(ADOPTION_TYPES));
  assert(Object.isFrozen(ADOPTION_TYPES[0]));
});

Deno.test("cfnToSwampTypeMap keeps every legacy mapping", () => {
  const map = cfnToSwampTypeMap();
  const legacy: Record<string, string> = {
    "AWS::EC2::VPC": "@swamp/aws/ec2/vpc",
    "AWS::EC2::Subnet": "@swamp/aws/ec2/subnet",
    "AWS::EC2::InternetGateway": "@swamp/aws/ec2/internet-gateway",
    "AWS::EC2::RouteTable": "@swamp/aws/ec2/route-table",
    "AWS::EC2::SecurityGroup": "@swamp/aws/ec2/security-group",
    "AWS::EC2::NatGateway": "@swamp/aws/ec2/nat-gateway",
    "AWS::EC2::EIP": "@swamp/aws/ec2/eip",
    "AWS::RDS::DBCluster": "@swamp/aws/rds/dbcluster",
    "AWS::RDS::DBInstance": "@swamp/aws/rds/dbinstance",
    "AWS::RDS::DBSubnetGroup": "@swamp/aws/rds/dbsubnet-group",
    "AWS::SecretsManager::Secret": "@swamp/aws/secretsmanager/secret",
    "AWS::S3::Bucket": "@swamp/aws/s3/bucket",
    "AWS::Lambda::Function": "@swamp/aws/lambda/function",
    "AWS::IAM::Role": "@swamp/aws/iam/role",
  };
  for (const [cfn, swamp] of Object.entries(legacy)) {
    assertEquals(map[cfn], swamp, cfn);
  }
  assert(Object.isFrozen(map));
});

Deno.test("every flag rule has a description", () => {
  for (
    const flag of [
      "asg-managed",
      "eks-managed",
      "service-linked-role",
      "cdk-assets",
      "default-vpc",
      "control-tower",
      "cfn-stack",
      "read-failed",
    ]
  ) {
    assert(FLAG_DESCRIPTIONS[flag], flag);
  }
});

// =============================================================================
// getPath / projection
// =============================================================================

Deno.test("getPath reads nested objects and flattens arrays of objects", () => {
  const props = {
    A: { B: "x" },
    L: [{ T: "tg-1" }, { T: "tg-2" }, { other: 1 }],
    S: ["s-1", "s-2"],
  };
  assertEquals(getPath(props, "A.B"), "x");
  assertEquals(getPath(props, "L[].T"), ["tg-1", "tg-2"]);
  assertEquals(getPath(props, "S"), ["s-1", "s-2"]);
  assertEquals(getPath(props, "A.Missing"), undefined);
  assertEquals(getPath(props, "Missing[].T"), []);
});

Deno.test("projectJudgeState keeps only present judge attributes", () => {
  const bucket = type("AWS::S3::Bucket");
  const state = projectJudgeState(bucket, {
    BucketName: "b",
    VersioningConfiguration: { Status: "Enabled" },
    Unrelated: "drop me",
  });
  assertEquals(state, {
    BucketName: "b",
    VersioningConfiguration: { Status: "Enabled" },
  });
});

Deno.test("projectJudgeState keys nested paths by their path", () => {
  const lt = type("AWS::EC2::LaunchTemplate");
  const state = projectJudgeState(lt, {
    LaunchTemplateName: "lt",
    LaunchTemplateData: {
      MetadataOptions: { HttpTokens: "required" },
      UserData: "c2VjcmV0",
    },
  });
  assertEquals(state["LaunchTemplateData.MetadataOptions"], {
    HttpTokens: "required",
  });
  assertEquals(JSON.stringify(state).includes("UserData"), false);
});

Deno.test("hasJudgeAttributes is false when any attribute is missing", () => {
  const alarm = type("AWS::CloudWatch::Alarm");
  assertEquals(hasJudgeAttributes(alarm, undefined), false);
  assertEquals(hasJudgeAttributes(alarm, { AlarmName: "a" }), false);
  assertEquals(
    hasJudgeAttributes(alarm, {
      AlarmName: "a",
      Namespace: "n",
      MetricName: "m",
      ActionsEnabled: true,
      AlarmActions: [],
    }),
    true,
  );
});

// =============================================================================
// Tags and identifiers
// =============================================================================

Deno.test("normalizeTags accepts both list and map forms", () => {
  assertEquals(normalizeTags([{ Key: "a", Value: "1" }, { Key: "b" }]), {
    a: "1",
    b: "",
  });
  assertEquals(normalizeTags({ a: "1", n: 2 }), { a: "1" });
  assertEquals(normalizeTags(undefined), {});
});

Deno.test("identifierFromProperties joins composite identifiers with |", () => {
  const service = type("AWS::ECS::Service");
  assertEquals(
    identifierFromProperties(service, {
      ServiceArn: "arn:aws:ecs:us-east-1:111111111111:service/prod/web",
      Cluster: "prod",
    }),
    "arn:aws:ecs:us-east-1:111111111111:service/prod/web|prod",
  );
  assertEquals(identifierFromProperties(service, { Cluster: "prod" }), null);
});

Deno.test("candidateModelName separates types that share an identifier", () => {
  const ecs = candidateModelName(
    "adopt",
    type("AWS::ECS::Cluster"),
    "prod",
    EAST,
  );
  const eks = candidateModelName(
    "adopt",
    type("AWS::EKS::Cluster"),
    "prod",
    EAST,
  );
  assertNotEquals(ecs, eks);
  assert(ecs.startsWith("adopt-ecs-cluster-"), ecs);
  assert(eks.startsWith("adopt-eks-cluster-"), eks);
  assertEquals(
    candidateModelName("adopt", type("AWS::ECS::Cluster"), "prod", EAST),
    ecs,
    "names are deterministic",
  );
  assert(
    candidateModelName(
      "x",
      type("AWS::ElasticLoadBalancingV2::LoadBalancer"),
      "arn",
      EAST,
    ).startsWith("x-elbv2-load-balancer-"),
  );
});

// =============================================================================
// Flags
// =============================================================================

Deno.test("deterministicFlags recognises controller-owned resources", () => {
  const instanceTags = { "aws:autoscaling:groupName": "asg" };
  assertEquals(
    deterministicFlags(
      type("AWS::EC2::SecurityGroup"),
      "sg-1",
      {},
      instanceTags,
      noDefaults,
    ),
    ["asg-managed"],
  );
  assertEquals(
    deterministicFlags(
      type("AWS::EC2::SecurityGroup"),
      "sg-2",
      {},
      { "eks:cluster-name": "prod" },
      noDefaults,
    ),
    ["eks-managed"],
  );
  assertEquals(
    deterministicFlags(
      type("AWS::IAM::Role"),
      "AWSServiceRoleForECS",
      { Path: "/aws-service-role/ecs.amazonaws.com/" },
      {},
      noDefaults,
    ),
    ["service-linked-role"],
  );
  assertEquals(
    deterministicFlags(
      type("AWS::S3::Bucket"),
      "cdk-hnb659fds-assets-111111111111-us-east-1",
      {},
      {},
      noDefaults,
    ),
    ["cdk-assets"],
  );
  assertEquals(
    deterministicFlags(
      type("AWS::IAM::Role"),
      "aws-controltower-AdministratorExecutionRole",
      {},
      {},
      noDefaults,
    ),
    ["control-tower"],
  );
});

Deno.test("deterministicFlags marks the default VPC and stack members", () => {
  assertEquals(
    deterministicFlags(type("AWS::EC2::VPC"), "vpc-1", {}, {}, {
      defaultVpcIds: new Set(["vpc-1"]),
    }),
    ["default-vpc"],
  );
  assertEquals(
    deterministicFlags(
      type("AWS::S3::Bucket"),
      "data",
      {},
      { "aws:cloudformation:stack-name": "app" },
      noDefaults,
    ),
    ["cfn-stack"],
  );
  assertEquals(
    deterministicFlags(type("AWS::S3::Bucket"), "data", {}, {}, noDefaults),
    [],
  );
});

// =============================================================================
// Dependencies and managed matching
// =============================================================================

Deno.test("resolveDependsOn links by identifier, ARN, and parent", () => {
  const roleArn = "arn:aws:iam::111111111111:role/app";
  const deps = resolveDependsOn([
    {
      id: "AWS::EC2::VPC/vpc-1",
      type: type("AWS::EC2::VPC"),
      identifier: "vpc-1",
      properties: {},
    },
    {
      id: "AWS::EC2::Subnet/subnet-1",
      type: type("AWS::EC2::Subnet"),
      identifier: "subnet-1",
      properties: { VpcId: "vpc-1" },
    },
    {
      id: "AWS::IAM::Role/app",
      type: type("AWS::IAM::Role"),
      identifier: "app",
      arn: roleArn,
      properties: {},
    },
    {
      id: "AWS::Lambda::Function/fn",
      type: type("AWS::Lambda::Function"),
      identifier: "fn",
      properties: {
        Role: roleArn,
        VpcConfig: { SubnetIds: ["subnet-1", "subnet-outside-sweep"] },
      },
    },
    {
      id: "AWS::ECS::Service/svc|prod",
      type: type("AWS::ECS::Service"),
      identifier: "svc|prod",
      properties: {},
      parentId: "AWS::ECS::Cluster/prod",
    },
  ]);
  assertEquals(deps.get("AWS::EC2::Subnet/subnet-1"), ["AWS::EC2::VPC/vpc-1"]);
  assertEquals(deps.get("AWS::Lambda::Function/fn"), [
    "AWS::EC2::Subnet/subnet-1",
    "AWS::IAM::Role/app",
  ]);
  assertEquals(deps.get("AWS::ECS::Service/svc|prod"), [
    "AWS::ECS::Cluster/prod",
  ]);
  assertEquals(deps.get("AWS::EC2::VPC/vpc-1"), []);
});

Deno.test("managedKeys matches on identifier, _identifier, and own ARN", () => {
  const serviceArn = "arn:aws:ecs:us-east-1:111111111111:service/prod/web";
  const keys = managedKeys([
    { modelType: "@swamp/aws/ec2/vpc", attributes: { VpcId: "vpc-1" } },
    {
      modelType: "@swamp/aws/ecs/service",
      attributes: { ServiceArn: serviceArn, _identifier: `${serviceArn}|prod` },
    },
    {
      modelType: "@swamp/aws/iam/role",
      attributes: {
        RoleName: "app",
        Arn: "arn:aws:iam::111111111111:role/app",
      },
    },
    { modelType: "@webframp/aws/adopt", attributes: { VpcId: "vpc-9" } },
    { modelType: "@swamp/aws/ec2/subnet", attributes: null },
  ], EAST).keys;
  assert(keys.has("@swamp/aws/ec2/vpc|vpc-1"));
  assert(keys.has(`@swamp/aws/ecs/service|${serviceArn}|prod`));
  assert(keys.has(`@swamp/aws/ecs/service|${serviceArn}`));
  assert(keys.has("@swamp/aws/iam/role|app"));
  assert(keys.has("@swamp/aws/iam/role|arn:aws:iam::111111111111:role/app"));
  assertEquals(keys.size, 5);
});

Deno.test("managedKeys never keys a service on its cluster's ARN", () => {
  const clusterArn = "arn:aws:ecs:us-east-1:111111111111:cluster/prod";
  const svc = (name: string) =>
    `arn:aws:ecs:us-east-1:111111111111:service/prod/${name}`;
  const keys = managedKeys([{
    modelType: "@swamp/aws/ecs/service",
    attributes: {
      ServiceArn: svc("web"),
      Cluster: clusterArn,
      _identifier: `${svc("web")}|${clusterArn}`,
    },
  }], EAST).keys;
  const sibling = identityKeys(
    "@swamp/aws/ecs/service",
    `${svc("worker")}|${clusterArn}`,
    svc("worker"),
  );
  assertEquals(sibling.some((k) => keys.has(k)), false);
  // The same service stored with Cluster as a name still matches on its ARN.
  const same = identityKeys(
    "@swamp/aws/ecs/service",
    `${svc("web")}|${clusterArn}`,
    svc("web"),
  );
  assert(same.some((k) => keys.has(k)));
});

Deno.test("managedKeys scopes RDS records by their DBInstanceArn", () => {
  const db = (arn: string) => ({
    modelType: "@swamp/aws/rds/dbinstance",
    attributes: { DBInstanceIdentifier: "prod-db", DBInstanceArn: arn },
  });
  assertEquals(
    managedKeys([db("arn:aws:rds:us-west-2:111111111111:db:prod-db")], EAST)
      .keys
      .size,
    0,
  );
  assert(
    managedKeys([db("arn:aws:rds:us-east-1:111111111111:db:prod-db")], EAST)
      .keys
      .has("@swamp/aws/rds/dbinstance|prod-db"),
  );
});

Deno.test("managedKeys skips ARN-less records unless the identifier is globally unique", () => {
  assertEquals(
    managedKeys([{
      modelType: "@swamp/aws/elasticache/replication-group",
      attributes: { ReplicationGroupId: "cache" },
    }], EAST).keys.size,
    0,
  );
  assert(
    managedKeys([{
      modelType: "@swamp/aws/ec2/subnet",
      attributes: { SubnetId: "subnet-1" },
    }], EAST).keys.has("@swamp/aws/ec2/subnet|subnet-1"),
  );
});

Deno.test("managedKeys ignores records whose ARN names another region or account", () => {
  const fn = (arn: string) => ({
    modelType: "@swamp/aws/lambda/function",
    attributes: { FunctionName: "api", Arn: arn },
  });
  const east = "arn:aws:lambda:us-east-1:111111111111:function:api";
  assert(
    managedKeys([fn(east)], EAST).keys.has("@swamp/aws/lambda/function|api"),
  );
  assertEquals(managedKeys([fn(east)], WEST).keys.size, 0);
  assertEquals(
    managedKeys([
      fn("arn:aws:lambda:us-east-1:222222222222:function:api"),
    ], EAST).keys.size,
    0,
  );
  // IAM ARNs carry no region; they still scope by account.
  const role = (account: string) => ({
    modelType: "@swamp/aws/iam/role",
    attributes: { RoleName: "app", Arn: `arn:aws:iam::${account}:role/app` },
  });
  assert(
    managedKeys([role("111111111111")], WEST).keys.has(
      "@swamp/aws/iam/role|app",
    ),
  );
  assertEquals(managedKeys([role("222222222222")], WEST).keys.size, 0);
});

Deno.test("candidateModelName differs by region and account", () => {
  const fn = type("AWS::Lambda::Function");
  const east = candidateModelName("adopt", fn, "api", EAST);
  assertNotEquals(east, candidateModelName("adopt", fn, "api", WEST));
  assertNotEquals(
    east,
    candidateModelName("adopt", fn, "api", {
      accountId: "222222222222",
      region: "us-east-1",
    }),
  );
});

Deno.test("parseArn reads region and account, including global ARNs", () => {
  assertEquals(parseArn("arn:aws:iam::111111111111:role/app"), {
    region: "",
    accountId: "111111111111",
  });
  assertEquals(parseArn("arn:aws:s3:::bucket"), { region: "", accountId: "" });
  assertEquals(parseArn("not-an-arn"), null);
});

// =============================================================================
// Stack adoption helpers
// =============================================================================

Deno.test("stackShortName keeps every legacy name and separates shared ones", () => {
  const legacy: Record<string, string> = {
    "AWS::EC2::VPC": "vpc",
    "AWS::EC2::Subnet": "subnet",
    "AWS::EC2::InternetGateway": "internetgateway",
    "AWS::EC2::RouteTable": "routetable",
    "AWS::EC2::SecurityGroup": "securitygroup",
    "AWS::EC2::NatGateway": "natgateway",
    "AWS::EC2::EIP": "eip",
    "AWS::RDS::DBCluster": "dbcluster",
    "AWS::RDS::DBInstance": "dbinstance",
    "AWS::RDS::DBSubnetGroup": "dbsubnetgroup",
    "AWS::SecretsManager::Secret": "secret",
    "AWS::S3::Bucket": "bucket",
    "AWS::Lambda::Function": "function",
    "AWS::IAM::Role": "role",
  };
  for (const [cfn, short] of Object.entries(legacy)) {
    assertEquals(stackShortName(cfn), short, cfn);
  }
  assertEquals(stackShortName("AWS::ECS::Cluster"), "ecs-cluster");
  assertEquals(stackShortName("AWS::EKS::Cluster"), "eks-cluster");
});

Deno.test("tagsFor reads launch-template TagSpecifications and tagless types", () => {
  assertEquals(
    tagsFor(type("AWS::EC2::LaunchTemplate"), {
      TagSpecifications: [
        { ResourceType: "instance", Tags: [{ Key: "x", Value: "1" }] },
        {
          ResourceType: "launch-template",
          Tags: [{ Key: "eks:cluster-name", Value: "prod" }],
        },
      ],
    }),
    { "eks:cluster-name": "prod" },
  );
  assertEquals(
    tagsFor(type("AWS::KMS::Alias"), { Tags: [{ Key: "a", Value: "b" }] }),
    {},
  );
});

Deno.test("listingIsComplete also needs the own ARN and tags", () => {
  const alarm = type("AWS::CloudWatch::Alarm");
  const judge = {
    AlarmName: "a",
    Namespace: "n",
    MetricName: "m",
    ActionsEnabled: true,
    AlarmActions: [],
  };
  assertEquals(listingIsComplete(alarm, judge), false);
  assertEquals(
    listingIsComplete(alarm, { ...judge, Arn: "arn:x", Tags: [] }),
    true,
  );
});

Deno.test("managedKeys counts unmatchable and unidentified records, only for swept types", () => {
  const result = managedKeys(
    [
      {
        modelType: "@swamp/aws/kms/alias",
        attributes: { AliasName: "alias/app", TargetKeyId: "k" },
      },
      {
        modelType: "@swamp/aws/route53/record-set",
        attributes: { Name: "a.example.com.", HostedZoneId: "Z1", Type: "A" },
      },
      {
        modelType: "@swamp/aws/lambda/function",
        attributes: { FunctionName: "api", _identifier: "api" },
      },
    ],
    EAST,
    new Set(["@swamp/aws/kms/alias", "@swamp/aws/route53/record-set"]),
  );
  assertEquals(result.unmatchable, 1);
  assertEquals(result.unidentified, 1);
  assertEquals(result.unscoped, 0, "lambda was not swept");
});

Deno.test("stackUnmappableReason flags composite Cloud Control identifiers", () => {
  assertEquals(stackUnmappableReason(type("AWS::EC2::VPC")), null);
  for (
    const cfn of [
      "AWS::ECS::Service",
      "AWS::Route53::RecordSet",
      "AWS::EC2::EIP",
    ]
  ) {
    const reason = stackUnmappableReason(type(cfn));
    assert(reason && reason.includes("composite"), cfn);
  }
  assertMatch(
    stackUnmappableReason(type("AWS::Events::Rule")) ?? "",
    /rule name/,
  );
});

Deno.test("arnFor reads the type's own ARN property, not referenced ARNs", () => {
  assertEquals(
    arnFor(type("AWS::RDS::DBInstance"), "prod-db", {
      DBInstanceArn: "arn:aws:rds:us-east-1:111111111111:db:prod-db",
      MonitoringRoleArn: "arn:aws:iam::111111111111:role/mon",
    }),
    "arn:aws:rds:us-east-1:111111111111:db:prod-db",
  );
  assertEquals(
    arnFor(type("AWS::EC2::Subnet"), "subnet-1", {
      OutpostArn: "arn:aws:outposts:us-east-1:111111111111:outpost/op-1",
    }),
    undefined,
  );
});

Deno.test("registry arnProperty is pinned per type", () => {
  const expected: Record<string, string | null> = {
    "AWS::EC2::VPC": null,
    "AWS::EC2::InternetGateway": null,
    "AWS::EC2::EIP": null,
    "AWS::EC2::Subnet": null,
    "AWS::EC2::RouteTable": null,
    "AWS::EC2::SecurityGroup": null,
    "AWS::EC2::NatGateway": null,
    "AWS::EC2::VPCEndpoint": null,
    "AWS::KMS::Key": "Arn",
    "AWS::KMS::Alias": null,
    "AWS::IAM::ManagedPolicy": "PolicyArn",
    "AWS::IAM::Role": "Arn",
    "AWS::SecretsManager::Secret": "Id",
    "AWS::SSM::Parameter": "Arn",
    "AWS::S3::Bucket": "Arn",
    "AWS::EFS::FileSystem": "Arn",
    "AWS::RDS::DBSubnetGroup": "DBSubnetGroupArn",
    "AWS::RDS::DBCluster": "DBClusterArn",
    "AWS::ElastiCache::ReplicationGroup": null,
    "AWS::RDS::DBInstance": "DBInstanceArn",
    "AWS::SQS::Queue": "Arn",
    "AWS::SNS::Topic": "TopicArn",
    "AWS::ElasticLoadBalancingV2::TargetGroup": "TargetGroupArn",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "LoadBalancerArn",
    "AWS::ElasticLoadBalancingV2::Listener": "ListenerArn",
    "AWS::ECR::Repository": "Arn",
    "AWS::EC2::LaunchTemplate": null,
    "AWS::Lambda::Function": "Arn",
    "AWS::ECS::Cluster": "Arn",
    "AWS::EKS::Cluster": "Arn",
    "AWS::ECS::TaskDefinition": "TaskDefinitionArn",
    "AWS::ECS::Service": "ServiceArn",
    "AWS::EKS::Nodegroup": "Arn",
    "AWS::AutoScaling::AutoScalingGroup": "AutoScalingGroupARN",
    "AWS::Events::Rule": "Arn",
    "AWS::Route53::HostedZone": null,
    "AWS::CloudFront::Distribution": null,
    "AWS::ApiGatewayV2::Api": "ExecuteApiArn",
    "AWS::Route53::RecordSet": null,
    "AWS::Logs::LogGroup": "Arn",
    "AWS::CloudWatch::Alarm": "Arn",
  };
  assertEquals(
    Object.fromEntries(ADOPTION_TYPES.map((t) => [t.cfnType, t.arnProperty])),
    expected,
  );
});

Deno.test("list-shaped records match for globally unique names and SQS URLs", () => {
  const { keys, unscoped } = managedKeys([
    { modelType: "@swamp/aws/s3/bucket", attributes: { _identifier: "data" } },
    {
      modelType: "@swamp/aws/efs/file-system",
      attributes: { FileSystemId: "fs-0123", _identifier: "fs-0123" },
    },
    {
      modelType: "@swamp/aws/sqs/queue",
      attributes: {
        _identifier: "https://sqs.us-east-1.amazonaws.com/111111111111/jobs",
      },
    },
    {
      modelType: "@swamp/aws/sqs/queue",
      attributes: {
        _identifier: "https://sqs.us-west-2.amazonaws.com/111111111111/jobs",
      },
    },
    // Name-identified, no ARN: cannot be scoped, so it is counted.
    {
      modelType: "@swamp/aws/eks/cluster",
      attributes: { Name: "prod", _identifier: "prod" },
    },
  ], EAST);
  assert(keys.has("@swamp/aws/s3/bucket|data"));
  assert(keys.has("@swamp/aws/efs/file-system|fs-0123"));
  assert(
    keys.has(
      "@swamp/aws/sqs/queue|https://sqs.us-east-1.amazonaws.com/111111111111/jobs",
    ),
  );
  assertEquals(
    keys.has(
      "@swamp/aws/sqs/queue|https://sqs.us-west-2.amazonaws.com/111111111111/jobs",
    ),
    false,
  );
  assertEquals(keys.has("@swamp/aws/eks/cluster|prod"), false);
  assertEquals(unscoped, 1);
});

Deno.test("scopeFromIdentifier reads SQS queue URLs only", () => {
  assertEquals(
    scopeFromIdentifier("https://sqs.eu-west-1.amazonaws.com/111111111111/q"),
    { region: "eu-west-1", accountId: "111111111111" },
  );
  assertEquals(scopeFromIdentifier("prod"), null);
});

Deno.test("arnFor never reports a composite identifier as an ARN", () => {
  const service = type("AWS::ECS::Service");
  assertEquals(
    arnFor(
      service,
      "arn:aws:ecs:us-east-1:111111111111:service/c/s|arn:aws:ecs:us-east-1:111111111111:cluster/c",
      {},
    ),
    undefined,
  );
});

Deno.test("global types keep one model name across regions", () => {
  const role = type("AWS::IAM::Role");
  assertEquals(
    candidateModelName("adopt", role, "app", EAST),
    candidateModelName("adopt", role, "app", WEST),
  );
});

// =============================================================================
// Sweep selection and error classification
// =============================================================================

Deno.test("selectSweepTypes filters by type and tier, ordered by rank", () => {
  const all = selectSweepTypes(undefined, undefined);
  assertEquals(all.length, ADOPTION_TYPES.length);
  for (let i = 1; i < all.length; i++) {
    assert(all[i - 1].rank <= all[i].rank);
  }
  assertEquals(
    selectSweepTypes(["AWS::S3::Bucket", "AWS::EC2::VPC"], undefined).map((t) =>
      t.cfnType
    ),
    ["AWS::EC2::VPC", "AWS::S3::Bucket"],
  );
  assert(
    selectSweepTypes(undefined, ["network"]).every((t) => t.tier === "network"),
  );
});

Deno.test("classifySweepError maps Cloud Control failures to gap reasons", () => {
  const named = (name: string, message: string) => {
    const e = new Error(message);
    e.name = name;
    return e;
  };
  assertEquals(
    classifySweepError(named("UnsupportedActionException", "no LIST")),
    "no-list-handler",
  );
  assertEquals(
    classifySweepError(named("TypeNotFoundException", "not in region")),
    "unsupported-in-region",
  );
  assertEquals(
    classifySweepError(named("AccessDeniedException", "denied")),
    "access-denied",
  );
  assertEquals(
    classifySweepError(named("ThrottlingException", "Rate exceeded")),
    "throttled",
  );
  assertEquals(classifySweepError(new Error("socket hang up")), "error");
});

Deno.test("AdoptionCandidateSchema accepts a minimal sweep candidate", () => {
  const result = AdoptionCandidateSchema.safeParse({
    id: "AWS::EC2::VPC/vpc-1",
    swampType: "@swamp/aws/ec2/vpc",
    cfnType: "AWS::EC2::VPC",
    identifier: "vpc-1",
    region: "us-east-1",
    scope: "sweep",
    dependsOn: [],
    tags: {},
    modelName: "adopt-ec2-vpc-00000000",
    cfnStack: null,
    swampManaged: false,
    flags: [],
    judgeState: {},
  });
  assertEquals(result.success, true);
});
