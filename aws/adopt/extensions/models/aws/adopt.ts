// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
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

const VpcSchema = z.object({
  vpcId: z.string(),
  cidrBlock: z.string(),
  state: z.string(),
  isDefault: z.boolean(),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

const SubnetSchema = z.object({
  subnetId: z.string(),
  vpcId: z.string(),
  cidrBlock: z.string(),
  availabilityZone: z.string(),
  mapPublicIpOnLaunch: z.boolean(),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

const InternetGatewaySchema = z.object({
  internetGatewayId: z.string(),
  attachedVpcIds: z.array(z.string()),
  tags: z.record(z.string(), z.string()),
  name: z.string(),
});

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

const DbSubnetGroupSchema = z.object({
  name: z.string(),
  description: z.string(),
  vpcId: z.string(),
  subnetIds: z.array(z.string()),
  status: z.string(),
});

const SecretSchema = z.object({
  name: z.string(),
  arn: z.string(),
  description: z.string(),
  lastChangedDate: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
});

const PartialDiscoverySchema = z.object({
  region: z.string(),
  vpcId: z.string().optional(),
  resourceType: z.string(),
  resources: z.array(z.unknown()),
  count: z.number(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

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

function getTag(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
  key: string,
): string {
  if (!tags) return "";
  const tag = tags.find((t) => t.Key === key);
  return tag?.Value ?? "";
}

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

function modelNameSuffix(resourceId: string): string {
  return resourceId.slice(-9);
}

interface DiscoveredVpc {
  vpcId: string;
  cidrBlock: string;
  name: string;
}

interface DiscoveredSubnet {
  subnetId: string;
  vpcId: string;
  cidrBlock: string;
  availabilityZone: string;
  name: string;
}

interface DiscoveredIgw {
  internetGatewayId: string;
  name: string;
}

interface DiscoveredRouteTable {
  routeTableId: string;
  vpcId: string;
  name: string;
}

interface DiscoveredSecurityGroup {
  groupId: string;
  groupName: string;
  vpcId: string;
  name: string;
}

interface DiscoveredRdsCluster {
  clusterIdentifier: string;
  engine: string;
  engineVersion: string;
  endpoint: string;
  port: number;
}

interface DiscoveredRdsInstance {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  engine: string;
  clusterIdentifier: string;
}

interface DiscoveredDbSubnetGroup {
  name: string;
  vpcId: string;
  subnetIds: string[];
}

interface DiscoveredSecret {
  name: string;
  arn: string;
}

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

function generateSetupCommands(
  discovered: AllDiscovered,
  prefix: string,
): string[] {
  const commands: string[] = [];

  for (const vpc of discovered.vpcs) {
    const suffix = modelNameSuffix(vpc.vpcId);
    commands.push(
      `swamp model create @swamp/aws/ec2/vpc ${prefix}-vpc-${suffix} --global-arg 'name=${prefix}-vpc-${suffix}' --global-arg 'CidrBlock=${vpc.cidrBlock}'`,
    );
  }

  for (const subnet of discovered.subnets) {
    const suffix = modelNameSuffix(subnet.subnetId);
    commands.push(
      `swamp model create @swamp/aws/ec2/subnet ${prefix}-subnet-${suffix} --global-arg 'name=${prefix}-subnet-${suffix}' --global-arg 'VpcId=${subnet.vpcId}' --global-arg 'CidrBlock=${subnet.cidrBlock}' --global-arg 'AvailabilityZone=${subnet.availabilityZone}'`,
    );
  }

  for (const igw of discovered.igws) {
    const suffix = modelNameSuffix(igw.internetGatewayId);
    commands.push(
      `swamp model create @swamp/aws/ec2/internet-gateway ${prefix}-igw-${suffix} --global-arg 'name=${prefix}-igw-${suffix}'`,
    );
  }

  for (const rt of discovered.routeTables) {
    const suffix = modelNameSuffix(rt.routeTableId);
    commands.push(
      `swamp model create @swamp/aws/ec2/route-table ${prefix}-rt-${suffix} --global-arg 'name=${prefix}-rt-${suffix}' --global-arg 'VpcId=${rt.vpcId}'`,
    );
  }

  for (const sg of discovered.securityGroups) {
    const suffix = modelNameSuffix(sg.groupId);
    commands.push(
      `swamp model create @swamp/aws/ec2/security-group ${prefix}-sg-${suffix} --global-arg 'name=${prefix}-sg-${suffix}' --global-arg 'VpcId=${sg.vpcId}' --global-arg 'GroupName=${sg.groupName}'`,
    );
  }

  for (const cluster of discovered.rdsClusters) {
    commands.push(
      `swamp model create @swamp/aws/rds/dbcluster ${prefix}-cluster-${cluster.clusterIdentifier} --global-arg 'name=${prefix}-cluster-${cluster.clusterIdentifier}' --global-arg 'Engine=${cluster.engine}' --global-arg 'EngineVersion=${cluster.engineVersion}'`,
    );
  }

  for (const instance of discovered.rdsInstances) {
    commands.push(
      `swamp model create @swamp/aws/rds/dbinstance ${prefix}-instance-${instance.dbInstanceIdentifier} --global-arg 'name=${prefix}-instance-${instance.dbInstanceIdentifier}' --global-arg 'DBInstanceClass=${instance.dbInstanceClass}' --global-arg 'Engine=${instance.engine}'`,
    );
  }

  for (const dbsg of discovered.dbSubnetGroups) {
    commands.push(
      `swamp model create @swamp/aws/rds/dbsubnet-group ${prefix}-dbsubnet-${dbsg.name} --global-arg 'name=${prefix}-dbsubnet-${dbsg.name}' --global-arg 'VpcId=${dbsg.vpcId}'`,
    );
  }

  for (const secret of discovered.secrets) {
    const safeName = secret.name.replace(/\//g, "-");
    commands.push(
      `swamp model create @swamp/aws/secretsmanager/secret ${prefix}-secret-${safeName} --global-arg 'name=${prefix}-secret-${safeName}'`,
    );
  }

  return commands;
}

// =============================================================================
// Discovery Functions
// =============================================================================

type GlobalArgs = {
  region: string;
  vpcId?: string;
};

async function discoverVpcs(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<{ results: z.infer<typeof VpcSchema>[]; truncated: boolean }> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const command = new DescribeVpcsCommand(
    filters.length > 0 ? { Filters: filters } : {},
  );
  const response = await ec2.send(command);
  const vpcs: z.infer<typeof VpcSchema>[] = [];
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
  return { results: vpcs, truncated: !!response.NextToken };
}

async function discoverSubnets(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<{ results: z.infer<typeof SubnetSchema>[]; truncated: boolean }> {
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (globalArgs.vpcId) {
    filters.push({ Name: "vpc-id", Values: [globalArgs.vpcId] });
  }
  const command = new DescribeSubnetsCommand(
    filters.length > 0 ? { Filters: filters } : {},
  );
  const response = await ec2.send(command);
  const subnets: z.infer<typeof SubnetSchema>[] = [];
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
  return { results: subnets, truncated: !!response.NextToken };
}

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
  const command = new DescribeInternetGatewaysCommand(
    filters.length > 0 ? { Filters: filters } : {},
  );
  const response = await ec2.send(command);
  const igws: z.infer<typeof InternetGatewaySchema>[] = [];
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
  return { results: igws, truncated: !!response.NextToken };
}

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
  const command = new DescribeRouteTablesCommand(
    filters.length > 0 ? { Filters: filters } : {},
  );
  const response = await ec2.send(command);
  const tables: z.infer<typeof RouteTableSchema>[] = [];
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
  return { results: tables, truncated: !!response.NextToken };
}

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
  const command = new DescribeSecurityGroupsCommand(
    filters.length > 0 ? { Filters: filters } : {},
  );
  const response = await ec2.send(command);
  const groups: z.infer<typeof SecurityGroupSchema>[] = [];
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
  return { results: groups, truncated: !!response.NextToken };
}

async function discoverRdsClusters(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof RdsClusterSchema>[]; truncated: boolean }
> {
  const command = new DescribeDBClustersCommand({});
  const response = await rds.send(command);
  const clusters: z.infer<typeof RdsClusterSchema>[] = [];
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
        .map((sg) => sg.VpcSecurityGroupId ?? "")
        .filter((id) => id !== ""),
      members: (cluster.DBClusterMembers ?? [])
        .map((m) => m.DBInstanceIdentifier ?? "")
        .filter((id) => id !== ""),
    });
  }
  return { results: clusters, truncated: !!response.Marker };
}

async function discoverRdsInstances(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof RdsInstanceSchema>[]; truncated: boolean }
> {
  const command = new DescribeDBInstancesCommand({});
  const response = await rds.send(command);
  const instances: z.infer<typeof RdsInstanceSchema>[] = [];
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
  return { results: instances, truncated: !!response.Marker };
}

async function discoverDbSubnetGroups(
  rds: RDSClient,
): Promise<
  { results: z.infer<typeof DbSubnetGroupSchema>[]; truncated: boolean }
> {
  const command = new DescribeDBSubnetGroupsCommand({});
  const response = await rds.send(command);
  const groups: z.infer<typeof DbSubnetGroupSchema>[] = [];
  for (const g of response.DBSubnetGroups ?? []) {
    if (!g.DBSubnetGroupName) continue;
    groups.push({
      name: g.DBSubnetGroupName,
      description: g.DBSubnetGroupDescription ?? "",
      vpcId: g.VpcId ?? "",
      subnetIds: (g.Subnets ?? [])
        .map((s) => s.SubnetIdentifier ?? "")
        .filter((id) => id !== ""),
      status: g.SubnetGroupStatus ?? "",
    });
  }
  return { results: groups, truncated: !!response.Marker };
}

async function discoverSecrets(
  sm: SecretsManagerClient,
): Promise<{ results: z.infer<typeof SecretSchema>[]; truncated: boolean }> {
  const command = new ListSecretsCommand({});
  const response = await sm.send(command);
  const secrets: z.infer<typeof SecretSchema>[] = [];
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
  return { results: secrets, truncated: !!response.NextToken };
}

// =============================================================================
// Context type
// =============================================================================

type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/aws/adopt",
  version: "2026.05.18.1",
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
            `vpcs-${context.globalArgs.region}`,
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
            `subnets-${context.globalArgs.region}`,
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
            `igws-${context.globalArgs.region}`,
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
            `route-tables-${context.globalArgs.region}`,
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
            `security-groups-${context.globalArgs.region}`,
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
          const firstCluster = rdsClusters[0]?.clusterIdentifier ?? "";
          let workflowCommand =
            `swamp workflow run @webframp/adopt-stack --input vpcId=${vpcId}`;
          if (firstCluster) {
            workflowCommand += ` --input clusterIdentifier=${firstCluster}`;
          }
          if (args.prefix !== "adopt") {
            workflowCommand += ` --input prefix=${args.prefix}`;
          }

          const totalCount = vpcs.length + subnets.length + igws.length +
            routeTables.length + securityGroups.length + rdsClusters.length +
            rdsInstances.length + dbSubnetGroups.length + secrets.length;

          const handle = await context.writeResource(
            "discovery",
            `all-${region}`,
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
  },
};
