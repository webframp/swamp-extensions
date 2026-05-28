// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CloudFormationClient,
  ListStackResourcesCommand,
} from "npm:@aws-sdk/client-cloudformation@3.1010.0";
import {
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from "npm:@aws-sdk/client-ec2@3.1010.0";
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  RDSClient,
} from "npm:@aws-sdk/client-rds@3.1010.0";
import {
  ListSecretsCommand,
  SecretsManagerClient,
} from "npm:@aws-sdk/client-secrets-manager@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

/** Validates global arguments for region and optional VPC filter. */
const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region to discover"),
  vpcId: z
    .string()
    .optional()
    .describe("Filter discovery to a specific VPC"),
});

/** Schema for a discovered VPC resource. */
const VpcSchema = z.object({
  vpcId: z.string(),
  cidrBlock: z.string(),
  state: z.string(),
  isDefault: z.boolean(),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

/** Schema for a discovered subnet resource. */
const SubnetSchema = z.object({
  subnetId: z.string(),
  vpcId: z.string(),
  cidrBlock: z.string(),
  availabilityZone: z.string(),
  mapPublicIpOnLaunch: z.boolean(),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

/** Schema for a discovered internet gateway resource. */
const InternetGatewaySchema = z.object({
  internetGatewayId: z.string(),
  attachedVpcIds: z.array(z.string()),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

/** Schema for a discovered route table resource. */
const RouteTableSchema = z.object({
  routeTableId: z.string(),
  vpcId: z.string(),
  isMain: z.boolean(),
  routes: z.array(z.object({
    destination: z.string(),
    target: z.string(),
    state: z.string(),
  })),
  associatedSubnets: z.array(z.string()),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

/** Schema for a discovered security group resource. */
const SecurityGroupSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  vpcId: z.string(),
  description: z.string(),
  ingressRuleCount: z.number(),
  egressRuleCount: z.number(),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

/** Schema for a discovered RDS cluster. */
const RdsClusterSchema = z.object({
  clusterIdentifier: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  status: z.string(),
  endpoint: z.string(),
  readerEndpoint: z.string(),
  port: z.number(),
  dbSubnetGroup: z.string(),
  vpcSecurityGroups: z.array(z.string()),
  members: z.array(z.string()),
});

/** Schema for a discovered RDS instance. */
const RdsInstanceSchema = z.object({
  dbInstanceIdentifier: z.string(),
  dbInstanceClass: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  status: z.string(),
  availabilityZone: z.string(),
  multiAz: z.boolean(),
  storageType: z.string(),
  allocatedStorage: z.number(),
  clusterIdentifier: z.string(),
  dbSubnetGroup: z.string(),
});

/** Schema for a discovered DB subnet group. */
const DbSubnetGroupSchema = z.object({
  name: z.string(),
  description: z.string(),
  vpcId: z.string(),
  subnetIds: z.array(z.string()),
  status: z.string(),
});

/** Schema for a discovered Secrets Manager secret. */
const SecretSchema = z.object({
  name: z.string(),
  arn: z.string(),
  description: z.string(),
  lastChangedDate: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
});

/** Schema for a single resource-type discovery result. */
const PartialDiscoverySchema = z.object({
  region: z.string(),
  vpcId: z.string().optional(),
  resourceType: z.string(),
  resources: z.array(z.unknown()),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

/** Schema for the full discovery result including setup commands. */
const DiscoveryResultSchema = z.object({
  region: z.string(),
  vpcId: z.string().optional(),
  truncated: z.boolean(),
  discovered: z.object({
    vpcs: z.array(VpcSchema),
    subnets: z.array(SubnetSchema),
    internetGateways: z.array(InternetGatewaySchema),
    routeTables: z.array(RouteTableSchema),
    securityGroups: z.array(SecurityGroupSchema),
    rdsClusters: z.array(RdsClusterSchema),
    rdsInstances: z.array(RdsInstanceSchema),
    dbSubnetGroups: z.array(DbSubnetGroupSchema),
    secrets: z.array(SecretSchema),
  }),
  setupCommands: z.array(z.string()),
  workflowCommand: z.string(),
  summary: z.object({
    totalResources: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
});

// =============================================================================
// Helpers
// =============================================================================

/** Extract a specific tag value from an AWS Tags array. */
function getTag(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
  key: string,
): string {
  if (!tags) return "";
  const tag = tags.find((t) => t.Key === key);
  return tag?.Value ?? "";
}

/** Convert an AWS Tags array to a flat key-value record. */
function tagsToRecord(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!tags) return result;
  for (const tag of tags) {
    if (tag.Key) {
      result[tag.Key] = tag.Value ?? "";
    }
  }
  return result;
}

/** Derive a short suffix from a resource ID for model naming. */
function modelNameSuffix(resourceId: string): string {
  return resourceId.slice(-9);
}

/** Safely quote a string for shell command interpolation. */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Build a deterministic resource instance name suffix from region and optional VPC. */
function instanceSuffix(region: string, vpcId?: string): string {
  return vpcId ? `${region}-${vpcId}` : region;
}

/** Minimal VPC data needed for setup command generation. */
interface DiscoveredVpc {
  vpcId: string;
  cidrBlock: string;
  name: string;
}

/** Minimal subnet data needed for setup command generation. */
interface DiscoveredSubnet {
  subnetId: string;
  vpcId: string;
  cidrBlock: string;
  availabilityZone: string;
  name: string;
}

/** Minimal internet gateway data needed for setup command generation. */
interface DiscoveredIgw {
  internetGatewayId: string;
  name: string;
}

/** Minimal route table data needed for setup command generation. */
interface DiscoveredRouteTable {
  routeTableId: string;
  vpcId: string;
  name: string;
}

/** Minimal security group data needed for setup command generation. */
interface DiscoveredSecurityGroup {
  groupId: string;
  groupName: string;
  vpcId: string;
  name: string;
}

/** Minimal RDS cluster data needed for setup command generation. */
interface DiscoveredRdsCluster {
  clusterIdentifier: string;
  engine: string;
  engineVersion: string;
  endpoint: string;
  port: number;
}

/** Minimal RDS instance data needed for setup command generation. */
interface DiscoveredRdsInstance {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  engine: string;
  clusterIdentifier: string;
}

/** Minimal DB subnet group data needed for setup command generation. */
interface DiscoveredDbSubnetGroup {
  name: string;
  vpcId: string;
  subnetIds: string[];
}

/** Minimal secret data needed for setup command generation. */
interface DiscoveredSecret {
  name: string;
  arn: string;
}

/** Aggregated discovery results across all resource types. */
interface AllDiscovered {
  vpcs: DiscoveredVpc[];
  subnets: DiscoveredSubnet[];
  igws: DiscoveredIgw[];
  routeTables: DiscoveredRouteTable[];
  securityGroups: DiscoveredSecurityGroup[];
  rdsClusters: DiscoveredRdsCluster[];
  rdsInstances: DiscoveredRdsInstance[];
  dbSubnetGroups: DiscoveredDbSubnetGroup[];
  secrets: DiscoveredSecret[];
}

/** Generate swamp model create commands for all discovered resources. */
function generateSetupCommands(
  discovered: AllDiscovered,
  prefix: string,
): string[] {
  const commands: string[] = [];

  for (const vpc of discovered.vpcs) {
    const suffix = modelNameSuffix(vpc.vpcId);
    const name = `${prefix}-vpc-${suffix}`;
    commands.push(
      `swamp model create @swamp/aws/ec2/vpc ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg CidrBlock=${
        shellQuote(vpc.cidrBlock)
      }`,
    );
  }

  for (const subnet of discovered.subnets) {
    const suffix = modelNameSuffix(subnet.subnetId);
    const name = `${prefix}-subnet-${suffix}`;
    commands.push(
      `swamp model create @swamp/aws/ec2/subnet ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg VpcId=${
        shellQuote(subnet.vpcId)
      } --global-arg CidrBlock=${
        shellQuote(subnet.cidrBlock)
      } --global-arg AvailabilityZone=${shellQuote(subnet.availabilityZone)}`,
    );
  }

  for (const igw of discovered.igws) {
    const suffix = modelNameSuffix(igw.internetGatewayId);
    const name = `${prefix}-igw-${suffix}`;
    commands.push(
      `swamp model create @swamp/aws/ec2/internet-gateway ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)}`,
    );
  }

  for (const rt of discovered.routeTables) {
    const suffix = modelNameSuffix(rt.routeTableId);
    const name = `${prefix}-rt-${suffix}`;
    commands.push(
      `swamp model create @swamp/aws/ec2/route-table ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg VpcId=${
        shellQuote(rt.vpcId)
      }`,
    );
  }

  for (const sg of discovered.securityGroups) {
    const suffix = modelNameSuffix(sg.groupId);
    const name = `${prefix}-sg-${suffix}`;
    commands.push(
      `swamp model create @swamp/aws/ec2/security-group ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg VpcId=${
        shellQuote(sg.vpcId)
      } --global-arg GroupName=${shellQuote(sg.groupName)}`,
    );
  }

  for (const cluster of discovered.rdsClusters) {
    const name = `${prefix}-cluster-${cluster.clusterIdentifier}`;
    commands.push(
      `swamp model create @swamp/aws/rds/dbcluster ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg Engine=${
        shellQuote(cluster.engine)
      } --global-arg EngineVersion=${shellQuote(cluster.engineVersion)}`,
    );
  }

  for (const instance of discovered.rdsInstances) {
    const name = `${prefix}-instance-${instance.dbInstanceIdentifier}`;
    commands.push(
      `swamp model create @swamp/aws/rds/dbinstance ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg DBInstanceClass=${
        shellQuote(instance.dbInstanceClass)
      } --global-arg Engine=${shellQuote(instance.engine)}`,
    );
  }

  for (const dbsg of discovered.dbSubnetGroups) {
    const name = `${prefix}-dbsubnet-${dbsg.name}`;
    commands.push(
      `swamp model create @swamp/aws/rds/dbsubnet-group ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)} --global-arg VpcId=${
        shellQuote(dbsg.vpcId)
      }`,
    );
  }

  for (const secret of discovered.secrets) {
    const safeName = secret.name.replace(/\//g, "%2F");
    const name = `${prefix}-secret-${safeName}`;
    commands.push(
      `swamp model create @swamp/aws/secretsmanager/secret ${
        shellQuote(name)
      } --global-arg name=${shellQuote(name)}`,
    );
  }

  return commands;
}

// =============================================================================
// Discovery Functions
// =============================================================================

/** Parsed global arguments passed to each discovery method. */
type GlobalArgs = {
  region: string;
  vpcId?: string;
};

/** Maximum pagination pages to fetch per API call to prevent unbounded loops. */
const MAX_PAGES = 5;

/** Discover VPCs in the target region, optionally filtered by VPC ID. */
async function discoverVpcs(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<{ results: z.infer<typeof VpcSchema>[]; truncated: boolean }> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const vpcs: z.infer<typeof VpcSchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await ec2.send(
      new DescribeVpcsCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        NextToken: nextToken,
      }),
    );
    for (const vpc of response.Vpcs ?? []) {
      if (!vpc.VpcId) continue;
      vpcs.push({
        vpcId: vpc.VpcId,
        cidrBlock: vpc.CidrBlock ?? "",
        state: vpc.State ?? "",
        isDefault: vpc.IsDefault ?? false,
        tags: tagsToRecord(vpc.Tags),
        name: getTag(vpc.Tags, "Name"),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: vpcs, truncated: !!nextToken };
}

/** Discover subnets in the target region, optionally filtered by VPC ID. */
async function discoverSubnets(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<{ results: z.infer<typeof SubnetSchema>[]; truncated: boolean }> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const subnets: z.infer<typeof SubnetSchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await ec2.send(
      new DescribeSubnetsCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        NextToken: nextToken,
      }),
    );
    for (const subnet of response.Subnets ?? []) {
      if (!subnet.SubnetId) continue;
      subnets.push({
        subnetId: subnet.SubnetId,
        vpcId: subnet.VpcId ?? "",
        cidrBlock: subnet.CidrBlock ?? "",
        availabilityZone: subnet.AvailabilityZone ?? "",
        mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
        tags: tagsToRecord(subnet.Tags),
        name: getTag(subnet.Tags, "Name"),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: subnets, truncated: !!nextToken };
}

/** Discover internet gateways attached to the target VPC or region. */
async function discoverInternetGateways(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<
  { results: z.infer<typeof InternetGatewaySchema>[]; truncated: boolean }
> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "attachment.vpc-id", Values: [globalArgs.vpcId] });
  }
  const igws: z.infer<typeof InternetGatewaySchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await ec2.send(
      new DescribeInternetGatewaysCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        NextToken: nextToken,
      }),
    );
    for (const igw of response.InternetGateways ?? []) {
      if (!igw.InternetGatewayId) continue;
      igws.push({
        internetGatewayId: igw.InternetGatewayId,
        attachedVpcIds: (igw.Attachments ?? [])
          .map((a) => a.VpcId ?? "")
          .filter((id) => id !== ""),
        tags: tagsToRecord(igw.Tags),
        name: getTag(igw.Tags, "Name"),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: igws, truncated: !!nextToken };
}

/** Discover route tables in the target region, optionally filtered by VPC. */
async function discoverRouteTables(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<
  { results: z.infer<typeof RouteTableSchema>[]; truncated: boolean }
> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const tables: z.infer<typeof RouteTableSchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await ec2.send(
      new DescribeRouteTablesCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        NextToken: nextToken,
      }),
    );
    for (const rt of response.RouteTables ?? []) {
      if (!rt.RouteTableId) continue;
      const isMain = (rt.Associations ?? []).some((a) => a.Main === true);
      const routes = (rt.Routes ?? []).map((r) => ({
        destination: r.DestinationCidrBlock ?? r.DestinationIpv6CidrBlock ?? "",
        target: r.GatewayId ?? r.NatGatewayId ?? r.TransitGatewayId ?? "local",
        state: r.State ?? "",
      }));
      const associatedSubnets = (rt.Associations ?? [])
        .map((a) => a.SubnetId ?? "")
        .filter((id) => id !== "");
      tables.push({
        routeTableId: rt.RouteTableId,
        vpcId: rt.VpcId ?? "",
        isMain,
        routes,
        associatedSubnets,
        tags: tagsToRecord(rt.Tags),
        name: getTag(rt.Tags, "Name"),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: tables, truncated: !!nextToken };
}

/** Discover security groups in the target region, optionally filtered by VPC. */
async function discoverSecurityGroups(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<
  { results: z.infer<typeof SecurityGroupSchema>[]; truncated: boolean }
> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const groups: z.infer<typeof SecurityGroupSchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await ec2.send(
      new DescribeSecurityGroupsCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        NextToken: nextToken,
      }),
    );
    for (const sg of response.SecurityGroups ?? []) {
      if (!sg.GroupId) continue;
      groups.push({
        groupId: sg.GroupId,
        groupName: sg.GroupName ?? "",
        vpcId: sg.VpcId ?? "",
        description: sg.Description ?? "",
        ingressRuleCount: (sg.IpPermissions ?? []).length,
        egressRuleCount: (sg.IpPermissionsEgress ?? []).length,
        tags: tagsToRecord(sg.Tags),
        name: getTag(sg.Tags, "Name"),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: groups, truncated: !!nextToken };
}

/** Discover RDS Aurora clusters in the target region. */
async function discoverRdsClusters(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof RdsClusterSchema>[]; truncated: boolean }
> {
  const clusters: z.infer<typeof RdsClusterSchema>[] = [];
  let marker: string | undefined;
  let pages = 0;

  do {
    const response = await rds.send(
      new DescribeDBClustersCommand({ Marker: marker }),
    );
    for (const cluster of response.DBClusters ?? []) {
      if (!cluster.DBClusterIdentifier) continue;
      clusters.push({
        clusterIdentifier: cluster.DBClusterIdentifier,
        engine: cluster.Engine ?? "",
        engineVersion: cluster.EngineVersion ?? "",
        status: cluster.Status ?? "",
        endpoint: cluster.Endpoint ?? "",
        readerEndpoint: cluster.ReaderEndpoint ?? "",
        port: cluster.Port ?? 0,
        dbSubnetGroup: cluster.DBSubnetGroup ?? "",
        vpcSecurityGroups: (cluster.VpcSecurityGroups ?? [])
          .map((sg: { VpcSecurityGroupId?: string }) =>
            sg.VpcSecurityGroupId ?? ""
          )
          .filter((id: string) => id !== ""),
        members: (cluster.DBClusterMembers ?? [])
          .map((m: { DBInstanceIdentifier?: string }) =>
            m.DBInstanceIdentifier ?? ""
          )
          .filter((id: string) => id !== ""),
      });
    }
    marker = response.Marker;
    pages++;
  } while (marker && pages < MAX_PAGES);

  return { results: clusters, truncated: !!marker };
}

/** Discover RDS DB instances in the target region. */
async function discoverRdsInstances(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof RdsInstanceSchema>[]; truncated: boolean }
> {
  const instances: z.infer<typeof RdsInstanceSchema>[] = [];
  let marker: string | undefined;
  let pages = 0;

  do {
    const response = await rds.send(
      new DescribeDBInstancesCommand({ Marker: marker }),
    );
    for (const db of response.DBInstances ?? []) {
      if (!db.DBInstanceIdentifier) continue;
      instances.push({
        dbInstanceIdentifier: db.DBInstanceIdentifier,
        dbInstanceClass: db.DBInstanceClass ?? "",
        engine: db.Engine ?? "",
        engineVersion: db.EngineVersion ?? "",
        status: db.DBInstanceStatus ?? "",
        availabilityZone: db.AvailabilityZone ?? "",
        multiAz: db.MultiAZ ?? false,
        storageType: db.StorageType ?? "",
        allocatedStorage: db.AllocatedStorage ?? 0,
        clusterIdentifier: db.DBClusterIdentifier ?? "",
        dbSubnetGroup: db.DBSubnetGroup?.DBSubnetGroupName ?? "",
      });
    }
    marker = response.Marker;
    pages++;
  } while (marker && pages < MAX_PAGES);

  return { results: instances, truncated: !!marker };
}

/** Discover DB subnet groups in the target region. */
async function discoverDbSubnetGroups(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof DbSubnetGroupSchema>[]; truncated: boolean }
> {
  const groups: z.infer<typeof DbSubnetGroupSchema>[] = [];
  let marker: string | undefined;
  let pages = 0;

  do {
    const response = await rds.send(
      new DescribeDBSubnetGroupsCommand({ Marker: marker }),
    );
    for (const g of response.DBSubnetGroups ?? []) {
      if (!g.DBSubnetGroupName) continue;
      groups.push({
        name: g.DBSubnetGroupName,
        description: g.DBSubnetGroupDescription ?? "",
        vpcId: g.VpcId ?? "",
        subnetIds: (g.Subnets ?? [])
          .map((s: { SubnetIdentifier?: string }) => s.SubnetIdentifier ?? "")
          .filter((id: string) => id !== ""),
        status: g.SubnetGroupStatus ?? "",
      });
    }
    marker = response.Marker;
    pages++;
  } while (marker && pages < MAX_PAGES);

  return { results: groups, truncated: !!marker };
}

/** Discover Secrets Manager secrets in the target region. */
async function discoverSecrets(
  sm: SecretsManagerClient,
): Promise<{ results: z.infer<typeof SecretSchema>[]; truncated: boolean }> {
  const secrets: z.infer<typeof SecretSchema>[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await sm.send(
      new ListSecretsCommand({ NextToken: nextToken }),
    );
    for (const s of response.SecretList ?? []) {
      if (!s.Name) continue;
      secrets.push({
        name: s.Name,
        arn: s.ARN ?? "",
        description: s.Description ?? "",
        lastChangedDate: s.LastChangedDate?.toISOString() ?? null,
        tags: tagsToRecord(s.Tags),
      });
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return { results: secrets, truncated: !!nextToken };
}

// =============================================================================
// Context type
// =============================================================================

/** Execution context provided to each model method by the swamp runtime. */
type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn?: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// CloudFormation Stack Adoption
// =============================================================================

/**
 * Static map of CloudFormation resource types to swamp model types.
 *
 * This map is intentionally manual: swamp method context does not expose
 * a runtime type registry. Adding a new entry is a one-line PR.
 *
 * Types not in this map will surface in the plan's `unmapped[]` list,
 * with a clear reason — they are not silent.
 */
export const CFN_TO_SWAMP_TYPE_MAP: Readonly<Record<string, string>> = Object
  .freeze({
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
  });

/**
 * Short-name suffix derived from a CFN resource type. Used to construct
 * deterministic swamp model names from a stack's logical IDs.
 */
function shortNameForCfnType(cfnType: string): string {
  // "AWS::EC2::VPC" -> "vpc", "AWS::SecretsManager::Secret" -> "secret"
  const parts = cfnType.split("::");
  const last = parts[parts.length - 1] ?? cfnType;
  return last.toLowerCase();
}

/**
 * Compute a deterministic collision-resistant suffix for a model name from
 * a physical resource ID. Uses FNV-1a hash of the full ID to avoid collisions
 * when multiple resources share trailing characters (e.g., Lambda functions
 * with common suffixes like "service-handler").
 */
function modelNameSuffixFromPhysicalId(
  physicalId: string,
  _logicalId: string,
): string {
  // FNV-1a 32-bit hash → 8 hex chars. Collision-resistant for typical
  // stack sizes (< 500 resources).
  let hash = 0x811c9dc5;
  for (let i = 0; i < physicalId.length; i++) {
    hash ^= physicalId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Resource statuses where PhysicalResourceId may be unreliable or missing.
 * Resources in these states are placed in `skipped[]` rather than `mapped[]`
 * so the operator can re-run the plan after the stack stabilizes.
 */
const UNSTABLE_RESOURCE_STATUSES: ReadonlySet<string> = new Set([
  "CREATE_IN_PROGRESS",
  "CREATE_FAILED",
  "DELETE_IN_PROGRESS",
  "DELETE_COMPLETE",
  "DELETE_FAILED",
  "UPDATE_IN_PROGRESS",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_FAILED",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "IMPORT_IN_PROGRESS",
  "IMPORT_FAILED",
  "IMPORT_ROLLBACK_IN_PROGRESS",
  "IMPORT_ROLLBACK_FAILED",
]);

/** A single stack resource as returned by ListStackResources. */
interface RawStackResource {
  logicalId: string;
  physicalId: string;
  cfnType: string;
  resourceStatus: string;
  parentStackName: string;
  depth: number;
}

/** Schema for a mapped resource entry in the plan output. */
const MappedResourceSchema = z.object({
  logicalId: z.string(),
  physicalId: z.string(),
  cfnType: z.string(),
  swampType: z.string(),
  modelName: z.string(),
  parentStackName: z.string(),
  depth: z.number(),
  getCommand: z.string(),
});

/** Schema for an unmapped resource (no swamp type known). */
const UnmappedResourceSchema = z.object({
  logicalId: z.string(),
  physicalId: z.string(),
  cfnType: z.string(),
  parentStackName: z.string(),
  depth: z.number(),
  reason: z.string(),
});

/** Schema for a skipped resource (unstable status, missing physical ID). */
const SkippedResourceSchema = z.object({
  logicalId: z.string(),
  cfnType: z.string(),
  resourceStatus: z.string(),
  parentStackName: z.string(),
  reason: z.string(),
});

/** Schema for an orphan: present in previous plan but missing from current. */
const OrphanResourceSchema = z.object({
  modelName: z.string(),
  cfnType: z.string(),
  physicalId: z.string(),
  note: z.string(),
});

/** Schema for the full stack adoption plan stored as data. */
const StackAdoptionPlanSchema = z.object({
  stackName: z.string(),
  region: z.string(),
  fetchedAt: z.string(),
  truncated: z.boolean(),
  nestedStacksProcessed: z.number(),
  mapped: z.array(MappedResourceSchema),
  unmapped: z.array(UnmappedResourceSchema),
  skipped: z.array(SkippedResourceSchema),
  orphans: z.array(OrphanResourceSchema),
  summary: z.object({
    totalResources: z.number(),
    mapped: z.number(),
    unmapped: z.number(),
    skipped: z.number(),
    orphans: z.number(),
    coveragePercent: z.number(),
    byCfnType: z.record(z.string(), z.number()),
  }),
});

/**
 * Maximum number of pages to fetch per ListStackResources call.
 * AWS returns up to 100 resources per page; 5 pages = 500 resources per
 * stack, which is well above CFN's per-stack limit (500). We still cap to
 * surface unexpectedly large results as `truncated`.
 */
const MAX_LIST_RESOURCES_PAGES = 10;

/**
 * Recursively list all resources in a CloudFormation stack and its nested
 * stacks. Filters resources with unstable statuses into a separate list
 * with their reason recorded.
 *
 * Returns:
 * - resources[]: stable resources usable for mapping
 * - skipped[]: resources with unstable status or missing physicalId
 * - truncated: true if any single stack hit MAX_LIST_RESOURCES_PAGES
 * - nestedCount: number of nested stacks recursed into
 */
async function listStackResourcesRecursive(
  cfn: CloudFormationClient,
  stackName: string,
  options: {
    includeNested: boolean;
    maxDepth: number;
    currentDepth?: number;
    visited?: Set<string>;
  },
): Promise<{
  resources: RawStackResource[];
  skipped: z.infer<typeof SkippedResourceSchema>[];
  truncated: boolean;
  nestedCount: number;
}> {
  const currentDepth = options.currentDepth ?? 0;
  const visited = options.visited ?? new Set<string>();

  if (visited.has(stackName)) {
    return { resources: [], skipped: [], truncated: false, nestedCount: 0 };
  }
  visited.add(stackName);

  const resources: RawStackResource[] = [];
  const skipped: z.infer<typeof SkippedResourceSchema>[] = [];
  const nestedStackNames: string[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  let truncated = false;
  let nestedCount = 0;

  do {
    const response = await cfn.send(
      new ListStackResourcesCommand({
        StackName: stackName,
        NextToken: nextToken,
      }),
    );
    for (const r of response.StackResourceSummaries ?? []) {
      if (!r.LogicalResourceId || !r.ResourceType) continue;
      const status = r.ResourceStatus ?? "UNKNOWN";
      const physicalId = r.PhysicalResourceId ?? "";

      if (!physicalId || UNSTABLE_RESOURCE_STATUSES.has(status)) {
        skipped.push({
          logicalId: r.LogicalResourceId,
          cfnType: r.ResourceType,
          resourceStatus: status,
          parentStackName: stackName,
          reason: !physicalId
            ? `no PhysicalResourceId (status: ${status})`
            : `unstable status: ${status}`,
        });
        continue;
      }

      resources.push({
        logicalId: r.LogicalResourceId,
        physicalId,
        cfnType: r.ResourceType,
        resourceStatus: status,
        parentStackName: stackName,
        depth: currentDepth,
      });

      if (
        r.ResourceType === "AWS::CloudFormation::Stack" &&
        options.includeNested &&
        currentDepth < options.maxDepth
      ) {
        // PhysicalResourceId for a nested stack is its full ARN:
        // arn:aws:cloudformation:region:account:stack/<name>/<uuid>
        // Extract the stack name (second-to-last segment after splitting on /).
        const arnParts = physicalId.split("/");
        const nestedName = arnParts.length >= 2
          ? arnParts[arnParts.length - 2]
          : physicalId;
        if (nestedName) nestedStackNames.push(nestedName);
      }
    }
    nextToken = response.NextToken;
    pages++;
  } while (nextToken && pages < MAX_LIST_RESOURCES_PAGES);

  if (nextToken) truncated = true;

  for (const nested of nestedStackNames) {
    nestedCount++;
    const sub = await listStackResourcesRecursive(cfn, nested, {
      includeNested: options.includeNested,
      maxDepth: options.maxDepth,
      currentDepth: currentDepth + 1,
      visited,
    });
    resources.push(...sub.resources);
    skipped.push(...sub.skipped);
    if (sub.truncated) truncated = true;
    nestedCount += sub.nestedCount;
  }

  return { resources, skipped, truncated, nestedCount };
}

/**
 * Build a swamp `model method run get` command for a mapped resource.
 * The identifier is the CFN PhysicalResourceId.
 */
function buildGetCommand(
  modelName: string,
  physicalId: string,
): string {
  return `swamp model method run ${shellQuote(modelName)} get ` +
    `--input identifier=${shellQuote(physicalId)}`;
}

/**
 * Compare a previous plan's `mapped[]` against the current one and return
 * orphans — resources that were in the previous plan but are no longer
 * present in the current stack. Comparison key is `modelName`.
 */
function findOrphans(
  previous: z.infer<typeof MappedResourceSchema>[] | undefined,
  current: z.infer<typeof MappedResourceSchema>[],
): z.infer<typeof OrphanResourceSchema>[] {
  if (!previous || previous.length === 0) return [];
  const currentNames = new Set(current.map((r) => r.modelName));
  const orphans: z.infer<typeof OrphanResourceSchema>[] = [];
  for (const prev of previous) {
    if (!currentNames.has(prev.modelName)) {
      orphans.push({
        modelName: prev.modelName,
        cfnType: prev.cfnType,
        physicalId: prev.physicalId,
        note: "in previous plan but missing from current stack",
      });
    }
  }
  return orphans;
}

/**
 * Sanitize a stack name for use as a swamp data instance name.
 *
 * CloudFormation stack names are restricted to `[a-zA-Z][-a-zA-Z0-9]*`
 * (max 128 chars), which is already a valid swamp instance name. This
 * function is a defense-in-depth no-op for valid inputs; it only matters
 * if a caller bypasses the input schema and passes a stack ARN or other
 * non-standard identifier. The workflow CEL expression in
 * `@webframp/adopt-cfn-stack` constructs the same name without
 * sanitization, so passing non-standard inputs will cause the workflow's
 * data lookup to miss — the input schema rejects such inputs to prevent
 * that mismatch.
 */
function planInstanceName(stackName: string): string {
  return `plan-${stackName.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/** Brownfield adoption model for discovering and importing existing AWS infrastructure. */
export const model = {
  type: "@webframp/aws/adopt",
  version: "2026.05.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    discovery: {
      description:
        "Full discovery result with setup commands and workflow guidance",
      schema: DiscoveryResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    partial: {
      description: "Single resource-type discovery result",
      schema: PartialDiscoverySchema,
      lifetime: "24h" as const,
      garbageCollection: 10,
    },
    stackPlan: {
      description:
        "CloudFormation stack adoption plan with mapped/unmapped/skipped/orphan resources",
      schema: StackAdoptionPlanSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    discover_vpcs: {
      description: "Discover existing VPCs",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        try {
          const { results: vpcs, truncated } = await discoverVpcs(
            ec2,
            context.globalArgs,
          );
          const handle = await context.writeResource(
            "partial",
            `vpcs-${
              instanceSuffix(
                context.globalArgs.region,
                context.globalArgs.vpcId,
              )
            }`,
            {
              region: context.globalArgs.region,
              vpcId: context.globalArgs.vpcId,
              resourceType: "vpc",
              resources: vpcs,
              count: vpcs.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} VPCs in {region}", {
            count: vpcs.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
        }
      },
    },

    discover_subnets: {
      description: "Discover existing subnets",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        try {
          const { results: subnets, truncated } = await discoverSubnets(
            ec2,
            context.globalArgs,
          );
          const handle = await context.writeResource(
            "partial",
            `subnets-${
              instanceSuffix(
                context.globalArgs.region,
                context.globalArgs.vpcId,
              )
            }`,
            {
              region: context.globalArgs.region,
              vpcId: context.globalArgs.vpcId,
              resourceType: "subnet",
              resources: subnets,
              count: subnets.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} subnets in {region}", {
            count: subnets.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
        }
      },
    },

    discover_gateways: {
      description: "Discover existing internet gateways",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        try {
          const { results: igws, truncated } = await discoverInternetGateways(
            ec2,
            context.globalArgs,
          );
          const handle = await context.writeResource(
            "partial",
            `igws-${
              instanceSuffix(
                context.globalArgs.region,
                context.globalArgs.vpcId,
              )
            }`,
            {
              region: context.globalArgs.region,
              vpcId: context.globalArgs.vpcId,
              resourceType: "internet-gateway",
              resources: igws,
              count: igws.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info(
            "Discovered {count} internet gateways in {region}",
            { count: igws.length, region: context.globalArgs.region },
          );
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
        }
      },
    },

    discover_route_tables: {
      description: "Discover existing route tables",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        try {
          const { results: tables, truncated } = await discoverRouteTables(
            ec2,
            context.globalArgs,
          );
          const handle = await context.writeResource(
            "partial",
            `route-tables-${
              instanceSuffix(
                context.globalArgs.region,
                context.globalArgs.vpcId,
              )
            }`,
            {
              region: context.globalArgs.region,
              vpcId: context.globalArgs.vpcId,
              resourceType: "route-table",
              resources: tables,
              count: tables.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} route tables in {region}", {
            count: tables.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
        }
      },
    },

    discover_security_groups: {
      description: "Discover existing security groups",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        try {
          const { results: groups, truncated } = await discoverSecurityGroups(
            ec2,
            context.globalArgs,
          );
          const handle = await context.writeResource(
            "partial",
            `security-groups-${
              instanceSuffix(
                context.globalArgs.region,
                context.globalArgs.vpcId,
              )
            }`,
            {
              region: context.globalArgs.region,
              vpcId: context.globalArgs.vpcId,
              resourceType: "security-group",
              resources: groups,
              count: groups.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info(
            "Discovered {count} security groups in {region}",
            { count: groups.length, region: context.globalArgs.region },
          );
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
        }
      },
    },

    discover_rds_clusters: {
      description: "Discover existing RDS clusters",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        try {
          const { results: clusters, truncated } = await discoverRdsClusters(
            rds,
          );
          const handle = await context.writeResource(
            "partial",
            `rds-clusters-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "rds-cluster",
              resources: clusters,
              count: clusters.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} RDS clusters in {region}", {
            count: clusters.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          rds.destroy();
        }
      },
    },

    discover_rds_instances: {
      description: "Discover existing RDS instances",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        try {
          const { results: instances, truncated } = await discoverRdsInstances(
            rds,
          );
          const handle = await context.writeResource(
            "partial",
            `rds-instances-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "rds-instance",
              resources: instances,
              count: instances.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} RDS instances in {region}", {
            count: instances.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          rds.destroy();
        }
      },
    },

    discover_db_subnet_groups: {
      description: "Discover existing DB subnet groups",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        try {
          const { results: groups, truncated } = await discoverDbSubnetGroups(
            rds,
          );
          const handle = await context.writeResource(
            "partial",
            `db-subnet-groups-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "db-subnet-group",
              resources: groups,
              count: groups.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info(
            "Discovered {count} DB subnet groups in {region}",
            { count: groups.length, region: context.globalArgs.region },
          );
          return { dataHandles: [handle] };
        } finally {
          rds.destroy();
        }
      },
    },

    discover_secrets: {
      description: "Discover existing Secrets Manager secrets",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const sm = new SecretsManagerClient({
          region: context.globalArgs.region,
        });
        try {
          const { results: secrets, truncated } = await discoverSecrets(sm);
          const handle = await context.writeResource(
            "partial",
            `secrets-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "secret",
              resources: secrets,
              count: secrets.length,
              truncated,
              fetchedAt: new Date().toISOString(),
            },
          );
          context.logger.info("Discovered {count} secrets in {region}", {
            count: secrets.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          sm.destroy();
        }
      },
    },

    discover_all: {
      description:
        "Run full discovery and generate setup commands for brownfield adoption",
      arguments: z.object({
        prefix: z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9-]*$/,
            "prefix must be lowercase alphanumeric and hyphens only",
          )
          .default("adopt")
          .describe("Prefix for generated model names"),
      }),
      execute: async (
        args: { prefix: string },
        context: MethodContext,
      ) => {
        const region = context.globalArgs.region;
        const ec2 = new EC2Client({ region });
        const rds = new RDSClient({ region });
        const sm = new SecretsManagerClient({ region });

        try {
          context.logger.info("Starting full discovery in {region}", {
            region,
          });

          const vpcsResult = await discoverVpcs(ec2, context.globalArgs);
          const subnetsResult = await discoverSubnets(ec2, context.globalArgs);
          const igwsResult = await discoverInternetGateways(
            ec2,
            context.globalArgs,
          );
          const routeTablesResult = await discoverRouteTables(
            ec2,
            context.globalArgs,
          );
          const securityGroupsResult = await discoverSecurityGroups(
            ec2,
            context.globalArgs,
          );
          const rdsClustersResult = await discoverRdsClusters(rds);
          const rdsInstancesResult = await discoverRdsInstances(rds);
          const dbSubnetGroupsResult = await discoverDbSubnetGroups(rds);
          const secretsResult = await discoverSecrets(sm);

          const vpcs = vpcsResult.results;
          const subnets = subnetsResult.results;
          const igws = igwsResult.results;
          const routeTables = routeTablesResult.results;
          const securityGroups = securityGroupsResult.results;
          const rdsClusters = rdsClustersResult.results;
          const rdsInstances = rdsInstancesResult.results;
          const dbSubnetGroups = dbSubnetGroupsResult.results;
          const secrets = secretsResult.results;

          const truncated = vpcsResult.truncated ||
            subnetsResult.truncated ||
            igwsResult.truncated ||
            routeTablesResult.truncated ||
            securityGroupsResult.truncated ||
            rdsClustersResult.truncated ||
            rdsInstancesResult.truncated ||
            dbSubnetGroupsResult.truncated ||
            secretsResult.truncated;

          const discovered: AllDiscovered = {
            vpcs: vpcs.map((v) => ({
              vpcId: v.vpcId,
              cidrBlock: v.cidrBlock,
              name: v.name,
            })),
            subnets: subnets.map((s) => ({
              subnetId: s.subnetId,
              vpcId: s.vpcId,
              cidrBlock: s.cidrBlock,
              availabilityZone: s.availabilityZone,
              name: s.name,
            })),
            igws: igws.map((i) => ({
              internetGatewayId: i.internetGatewayId,
              name: i.name,
            })),
            routeTables: routeTables.map((r) => ({
              routeTableId: r.routeTableId,
              vpcId: r.vpcId,
              name: r.name,
            })),
            securityGroups: securityGroups.map((sg) => ({
              groupId: sg.groupId,
              groupName: sg.groupName,
              vpcId: sg.vpcId,
              name: sg.name,
            })),
            rdsClusters: rdsClusters.map((c) => ({
              clusterIdentifier: c.clusterIdentifier,
              engine: c.engine,
              engineVersion: c.engineVersion,
              endpoint: c.endpoint,
              port: c.port,
            })),
            rdsInstances: rdsInstances.map((i) => ({
              dbInstanceIdentifier: i.dbInstanceIdentifier,
              dbInstanceClass: i.dbInstanceClass,
              engine: i.engine,
              clusterIdentifier: i.clusterIdentifier,
            })),
            dbSubnetGroups: dbSubnetGroups.map((g) => ({
              name: g.name,
              vpcId: g.vpcId,
              subnetIds: g.subnetIds,
            })),
            secrets: secrets.map((s) => ({ name: s.name, arn: s.arn })),
          };

          const setupCommands = generateSetupCommands(discovered, args.prefix);

          const vpcId = context.globalArgs.vpcId ?? vpcs[0]?.vpcId ?? "";
          if (!vpcId) {
            context.logger.info(
              "No VPC found — workflow command omitted",
              {},
            );
          }
          const vpcSuffix = vpcId ? modelNameSuffix(vpcId) : "";
          const firstCluster = rdsClusters[0]?.clusterIdentifier ?? "";
          const firstDbSubnetGroup = dbSubnetGroups[0]?.name ?? "";
          const firstSecret = secrets[0]?.name ?? "";
          const firstSecretArn = secrets[0]?.arn ?? "";
          const safeSecretName = firstSecret.replace(/\//g, "%2F");

          let workflowCommand = "";
          if (vpcId) {
            workflowCommand =
              `swamp workflow run @webframp/adopt-stack --input vpcId=${
                shellQuote(vpcId)
              } --input vpcSuffix=${shellQuote(vpcSuffix)}`;
            if (firstCluster) {
              workflowCommand += ` --input clusterIdentifier=${
                shellQuote(firstCluster)
              }`;
            }
            if (firstDbSubnetGroup) {
              workflowCommand += ` --input dbSubnetGroupName=${
                shellQuote(firstDbSubnetGroup)
              }`;
            }
            if (safeSecretName) {
              workflowCommand += ` --input secretName=${
                shellQuote(safeSecretName)
              }`;
            }
            if (firstSecretArn) {
              workflowCommand += ` --input secretArn=${
                shellQuote(firstSecretArn)
              }`;
            }
            if (args.prefix !== "adopt") {
              workflowCommand += ` --input prefix=${shellQuote(args.prefix)}`;
            }
          }

          const totalCount = vpcs.length + subnets.length + igws.length +
            routeTables.length + securityGroups.length + rdsClusters.length +
            rdsInstances.length + dbSubnetGroups.length + secrets.length;

          const handle = await context.writeResource(
            "discovery",
            `all-${instanceSuffix(region, context.globalArgs.vpcId)}`,
            {
              region,
              vpcId: context.globalArgs.vpcId,
              truncated,
              discovered: {
                vpcs,
                subnets,
                internetGateways: igws,
                routeTables,
                securityGroups,
                rdsClusters,
                rdsInstances,
                dbSubnetGroups,
                secrets,
              },
              setupCommands,
              workflowCommand,
              summary: {
                totalResources: totalCount,
                byType: {
                  vpcs: vpcs.length,
                  subnets: subnets.length,
                  internetGateways: igws.length,
                  routeTables: routeTables.length,
                  securityGroups: securityGroups.length,
                  rdsClusters: rdsClusters.length,
                  rdsInstances: rdsInstances.length,
                  dbSubnetGroups: dbSubnetGroups.length,
                  secrets: secrets.length,
                },
              },
            },
          );

          context.logger.info(
            "Full discovery complete: {count} resources, {cmdCount} setup commands",
            { count: totalCount, cmdCount: setupCommands.length, region },
          );
          return { dataHandles: [handle] };
        } finally {
          ec2.destroy();
          rds.destroy();
          sm.destroy();
        }
      },
    },

    plan_stack_adoption: {
      description:
        "Enumerate all resources in a CloudFormation stack, map to swamp types, and build an adoption plan",
      arguments: z.object({
        stackName: z.string()
          .min(1)
          .max(128)
          .regex(
            /^[a-zA-Z][-a-zA-Z0-9]*$/,
            "stackName must match CloudFormation stack name format: " +
              "start with a letter, then alphanumerics and hyphens. " +
              "Pass the stack name, not its ARN.",
          )
          .describe("CloudFormation stack name (not ARN)"),
        includeNested: z.boolean()
          .default(true)
          .describe("Recurse into AWS::CloudFormation::Stack resources"),
        maxDepth: z.number()
          .int()
          .min(0)
          .max(10)
          .default(3)
          .describe("Nested stack recursion limit"),
        prefix: z.string()
          .regex(
            /^[a-z0-9][a-z0-9-]*$/,
            "prefix must be lowercase alphanumeric and hyphens only",
          )
          .default("adopt")
          .describe("Prefix for generated swamp model names"),
      }),
      execute: async (
        args: {
          stackName: string;
          includeNested: boolean;
          maxDepth: number;
          prefix: string;
        },
        context: MethodContext,
      ) => {
        const region = context.globalArgs.region;
        const cfn = new CloudFormationClient({ region });

        try {
          context.logger.info(
            "Planning CFN stack adoption: {stackName} ({region})",
            { stackName: args.stackName, region },
          );

          // Read previous plan for orphan detection (best-effort).
          // Orphans are computed against the union of the previous plan's
          // mapped[] and orphans[] so resources stay flagged across runs
          // until the operator either adopts them or removes the model
          // manually. If we only checked mapped[], an orphan flagged in
          // run N would silently disappear from run N+1's plan.
          const instanceName = planInstanceName(args.stackName);
          let previousMapped:
            | z.infer<typeof MappedResourceSchema>[]
            | undefined;
          let previousOrphans:
            | z.infer<typeof OrphanResourceSchema>[]
            | undefined;
          if (context.readResource) {
            try {
              const prev = await context.readResource(instanceName);
              if (prev && Array.isArray(prev.mapped)) {
                previousMapped = prev.mapped as z.infer<
                  typeof MappedResourceSchema
                >[];
              }
              if (prev && Array.isArray(prev.orphans)) {
                previousOrphans = prev.orphans as z.infer<
                  typeof OrphanResourceSchema
                >[];
              }
            } catch {
              // No previous plan, or unreadable. Proceed without orphan info.
            }
          }

          // Enumerate stack resources (recursive into nested stacks).
          const { resources, skipped, truncated, nestedCount } =
            await listStackResourcesRecursive(cfn, args.stackName, {
              includeNested: args.includeNested,
              maxDepth: args.maxDepth,
            });

          // Map each resource to a swamp type or mark as unmapped.
          const mapped: z.infer<typeof MappedResourceSchema>[] = [];
          const unmapped: z.infer<typeof UnmappedResourceSchema>[] = [];
          for (const r of resources) {
            // Nested stacks are recursed into, not adopted as a model.
            if (r.cfnType === "AWS::CloudFormation::Stack") continue;
            // Custom resources (no AWS:: prefix or Custom:: prefix) are not
            // mappable to a generic swamp type — flag for operator review.
            if (r.cfnType.startsWith("Custom::")) {
              unmapped.push({
                logicalId: r.logicalId,
                physicalId: r.physicalId,
                cfnType: r.cfnType,
                parentStackName: r.parentStackName,
                depth: r.depth,
                reason: "custom resource (no swamp type)",
              });
              continue;
            }
            const swampType = CFN_TO_SWAMP_TYPE_MAP[r.cfnType];
            if (!swampType) {
              unmapped.push({
                logicalId: r.logicalId,
                physicalId: r.physicalId,
                cfnType: r.cfnType,
                parentStackName: r.parentStackName,
                depth: r.depth,
                reason: `no swamp type registered for ${r.cfnType}`,
              });
              continue;
            }
            const shortName = shortNameForCfnType(r.cfnType);
            const suffix = modelNameSuffixFromPhysicalId(
              r.physicalId,
              r.logicalId,
            );
            const modelName = `${args.prefix}-${shortName}-${suffix}`;
            mapped.push({
              logicalId: r.logicalId,
              physicalId: r.physicalId,
              cfnType: r.cfnType,
              swampType,
              modelName,
              parentStackName: r.parentStackName,
              depth: r.depth,
              getCommand: buildGetCommand(modelName, r.physicalId),
            });
          }

          // Detect orphans: in previous plan but not in current.
          // Carry forward previously-flagged orphans that are still missing
          // so the operator sees them every run until acted upon.
          const newOrphans = findOrphans(previousMapped, mapped);
          const currentNames = new Set(mapped.map((r) => r.modelName));
          const carriedOrphans = (previousOrphans ?? []).filter(
            (o) => !currentNames.has(o.modelName),
          );
          // Merge by modelName, preferring the new orphan entry (fresher note).
          const orphanMap = new Map<
            string,
            z.infer<typeof OrphanResourceSchema>
          >();
          for (const o of carriedOrphans) orphanMap.set(o.modelName, o);
          for (const o of newOrphans) orphanMap.set(o.modelName, o);
          const orphans = Array.from(orphanMap.values());

          // Build summary.
          // byCfnType counts only resources that contributed to the plan
          // (mapped, unmapped, skipped). AWS::CloudFormation::Stack
          // containers are filtered (recursed into, not adopted) so they
          // are intentionally excluded from this count to keep the
          // totalResources sum consistent.
          const byCfnType: Record<string, number> = {};
          for (const r of resources) {
            if (r.cfnType === "AWS::CloudFormation::Stack") continue;
            byCfnType[r.cfnType] = (byCfnType[r.cfnType] ?? 0) + 1;
          }
          for (const r of skipped) {
            if (r.cfnType === "AWS::CloudFormation::Stack") continue;
            byCfnType[r.cfnType] = (byCfnType[r.cfnType] ?? 0) + 1;
          }
          // totalResources excludes AWS::CloudFormation::Stack entries
          // (they are recursed into, not adopted) so the sum of byCfnType
          // values equals totalResources and coveragePercent is accurate.
          const skippedCount = skipped.filter(
            (r) => r.cfnType !== "AWS::CloudFormation::Stack",
          ).length;
          const totalResources = mapped.length + unmapped.length +
            skippedCount;
          const coveragePercent = totalResources > 0
            ? Math.round((mapped.length / totalResources) * 100)
            : 0;

          const handle = await context.writeResource(
            "stackPlan",
            instanceName,
            {
              stackName: args.stackName,
              region,
              fetchedAt: new Date().toISOString(),
              truncated,
              nestedStacksProcessed: nestedCount,
              mapped,
              unmapped,
              skipped,
              orphans,
              summary: {
                totalResources,
                mapped: mapped.length,
                unmapped: unmapped.length,
                skipped: skippedCount,
                orphans: orphans.length,
                coveragePercent,
                byCfnType,
              },
            },
          );

          context.logger.info(
            "Stack adoption plan ready: {mapped} mapped, {unmapped} unmapped, " +
              "{skipped} skipped, {orphans} orphans ({coverage}% coverage)",
            {
              mapped: mapped.length,
              unmapped: unmapped.length,
              skipped: skipped.length,
              orphans: orphans.length,
              coverage: coveragePercent,
              stackName: args.stackName,
            },
          );

          if (truncated && context.logger.warn) {
            context.logger.warn(
              "Stack resource listing was truncated — increase MAX_LIST_RESOURCES_PAGES or reduce stack size",
              { stackName: args.stackName },
            );
          }

          return { dataHandles: [handle] };
        } finally {
          cfn.destroy();
        }
      },
    },
  },
};
