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
  tags: z
    .record(z.string(), z.string())
    .optional()
    .describe("Filter resources by tags"),
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

const DiscoveryResultSchema = z.object({
  region: z.string(),
  vpcId: z.string().optional(),
  resourceType: z.string(),
  resources: z.array(z.unknown()),
  count: z.number(),
  setupCommands: z.array(z.string()).optional(),
  workflowCommand: z.string().optional(),
  fetchedAt: z.string(),
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

function generateSetupCommands(discovered: AllDiscovered): string[] {
  const commands: string[] = [];

  for (const vpc of discovered.vpcs) {
    const suffix = modelNameSuffix(vpc.vpcId);
    commands.push(
      `swamp model create @swamp/aws/ec2/vpc adopt-vpc-${suffix} --global-arg 'name=adopt-vpc-${suffix}' --global-arg 'CidrBlock=${vpc.cidrBlock}'`,
    );
  }

  for (const subnet of discovered.subnets) {
    const suffix = modelNameSuffix(subnet.subnetId);
    commands.push(
      `swamp model create @swamp/aws/ec2/subnet adopt-subnet-${suffix} --global-arg 'name=adopt-subnet-${suffix}' --global-arg 'VpcId=${subnet.vpcId}' --global-arg 'CidrBlock=${subnet.cidrBlock}' --global-arg 'AvailabilityZone=${subnet.availabilityZone}'`,
    );
  }

  for (const igw of discovered.igws) {
    const suffix = modelNameSuffix(igw.internetGatewayId);
    commands.push(
      `swamp model create @swamp/aws/ec2/internet-gateway adopt-igw-${suffix} --global-arg 'name=adopt-igw-${suffix}'`,
    );
  }

  for (const rt of discovered.routeTables) {
    const suffix = modelNameSuffix(rt.routeTableId);
    commands.push(
      `swamp model create @swamp/aws/ec2/route-table adopt-rt-${suffix} --global-arg 'name=adopt-rt-${suffix}' --global-arg 'VpcId=${rt.vpcId}'`,
    );
  }

  for (const sg of discovered.securityGroups) {
    const suffix = modelNameSuffix(sg.groupId);
    commands.push(
      `swamp model create @swamp/aws/ec2/security-group adopt-sg-${suffix} --global-arg 'name=adopt-sg-${suffix}' --global-arg 'VpcId=${sg.vpcId}' --global-arg 'GroupName=${sg.groupName}'`,
    );
  }

  for (const cluster of discovered.rdsClusters) {
    commands.push(
      `swamp model create @swamp/aws/rds/cluster adopt-rds-${cluster.clusterIdentifier} --global-arg 'name=adopt-rds-${cluster.clusterIdentifier}' --global-arg 'Engine=${cluster.engine}' --global-arg 'EngineVersion=${cluster.engineVersion}'`,
    );
  }

  for (const instance of discovered.rdsInstances) {
    commands.push(
      `swamp model create @swamp/aws/rds/instance adopt-rds-${instance.dbInstanceIdentifier} --global-arg 'name=adopt-rds-${instance.dbInstanceIdentifier}' --global-arg 'DBInstanceClass=${instance.dbInstanceClass}' --global-arg 'Engine=${instance.engine}'`,
    );
  }

  for (const dbsg of discovered.dbSubnetGroups) {
    commands.push(
      `swamp model create @swamp/aws/rds/db-subnet-group adopt-dbsg-${dbsg.name} --global-arg 'name=adopt-dbsg-${dbsg.name}' --global-arg 'VpcId=${dbsg.vpcId}'`,
    );
  }

  for (const secret of discovered.secrets) {
    commands.push(
      `swamp model create @swamp/aws/secrets-manager/secret adopt-secret-${secret.name} --global-arg 'name=adopt-secret-${secret.name}'`,
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
  tags?: Record<string, string>;
};

async function discoverVpcs(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<z.infer<typeof VpcSchema>[]> {
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
  return vpcs;
}

async function discoverSubnets(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<z.infer<typeof SubnetSchema>[]> {
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
  return subnets;
}

async function discoverInternetGateways(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<z.infer<typeof InternetGatewaySchema>[]> {
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
  return igws;
}

async function discoverRouteTables(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<z.infer<typeof RouteTableSchema>[]> {
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
  return tables;
}

async function discoverSecurityGroups(
  ec2: EC2Client,
  globalArgs: GlobalArgs,
): Promise<z.infer<typeof SecurityGroupSchema>[]> {
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
  return groups;
}

async function discoverRdsClusters(
  rds: RDSClient,
): Promise<z.infer<typeof RdsClusterSchema>[]> {
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
  return clusters;
}

async function discoverRdsInstances(
  rds: RDSClient,
): Promise<z.infer<typeof RdsInstanceSchema>[]> {
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
  return instances;
}

async function discoverDbSubnetGroups(
  rds: RDSClient,
): Promise<z.infer<typeof DbSubnetGroupSchema>[]> {
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
  return groups;
}

async function discoverSecrets(
  sm: SecretsManagerClient,
): Promise<z.infer<typeof SecretSchema>[]> {
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
  return secrets;
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
      description: "Discovered AWS infrastructure for brownfield adoption",
      schema: DiscoveryResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    discover_vpcs: {
      description: "Discover existing VPCs",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        const vpcs = await discoverVpcs(ec2, context.globalArgs);
        const handle = await context.writeResource(
          "discovery",
          `vpcs-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            vpcId: context.globalArgs.vpcId,
            resourceType: "vpc",
            resources: vpcs,
            count: vpcs.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} VPCs in {region}", {
          count: vpcs.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_subnets: {
      description: "Discover existing subnets",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        const subnets = await discoverSubnets(ec2, context.globalArgs);
        const handle = await context.writeResource(
          "discovery",
          `subnets-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            vpcId: context.globalArgs.vpcId,
            resourceType: "subnet",
            resources: subnets,
            count: subnets.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} subnets in {region}", {
          count: subnets.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_gateways: {
      description: "Discover existing internet gateways",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        const igws = await discoverInternetGateways(ec2, context.globalArgs);
        const handle = await context.writeResource(
          "discovery",
          `igws-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            vpcId: context.globalArgs.vpcId,
            resourceType: "internet-gateway",
            resources: igws,
            count: igws.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Discovered {count} internet gateways in {region}",
          { count: igws.length, region: context.globalArgs.region },
        );
        return { dataHandles: [handle] };
      },
    },

    discover_route_tables: {
      description: "Discover existing route tables",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        const tables = await discoverRouteTables(ec2, context.globalArgs);
        const handle = await context.writeResource(
          "discovery",
          `route-tables-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            vpcId: context.globalArgs.vpcId,
            resourceType: "route-table",
            resources: tables,
            count: tables.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} route tables in {region}", {
          count: tables.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_security_groups: {
      description: "Discover existing security groups",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ec2 = new EC2Client({ region: context.globalArgs.region });
        const groups = await discoverSecurityGroups(ec2, context.globalArgs);
        const handle = await context.writeResource(
          "discovery",
          `security-groups-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            vpcId: context.globalArgs.vpcId,
            resourceType: "security-group",
            resources: groups,
            count: groups.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} security groups in {region}", {
          count: groups.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_rds_clusters: {
      description: "Discover existing RDS clusters",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        const clusters = await discoverRdsClusters(rds);
        const handle = await context.writeResource(
          "discovery",
          `rds-clusters-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "rds-cluster",
            resources: clusters,
            count: clusters.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} RDS clusters in {region}", {
          count: clusters.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_rds_instances: {
      description: "Discover existing RDS instances",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        const instances = await discoverRdsInstances(rds);
        const handle = await context.writeResource(
          "discovery",
          `rds-instances-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "rds-instance",
            resources: instances,
            count: instances.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} RDS instances in {region}", {
          count: instances.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
      },
    },

    discover_db_subnet_groups: {
      description: "Discover existing DB subnet groups",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const rds = new RDSClient({ region: context.globalArgs.region });
        const groups = await discoverDbSubnetGroups(rds);
        const handle = await context.writeResource(
          "discovery",
          `db-subnet-groups-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "db-subnet-group",
            resources: groups,
            count: groups.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Discovered {count} DB subnet groups in {region}",
          { count: groups.length, region: context.globalArgs.region },
        );
        return { dataHandles: [handle] };
      },
    },

    discover_secrets: {
      description: "Discover existing Secrets Manager secrets",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const sm = new SecretsManagerClient({
          region: context.globalArgs.region,
        });
        const secrets = await discoverSecrets(sm);
        const handle = await context.writeResource(
          "discovery",
          `secrets-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "secret",
            resources: secrets,
            count: secrets.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Discovered {count} secrets in {region}", {
          count: secrets.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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

        context.logger.info("Starting full discovery in {region}", { region });

        const vpcs = await discoverVpcs(ec2, context.globalArgs);
        const subnets = await discoverSubnets(ec2, context.globalArgs);
        const igws = await discoverInternetGateways(ec2, context.globalArgs);
        const routeTables = await discoverRouteTables(ec2, context.globalArgs);
        const securityGroups = await discoverSecurityGroups(
          ec2,
          context.globalArgs,
        );
        const rdsClusters = await discoverRdsClusters(rds);
        const rdsInstances = await discoverRdsInstances(rds);
        const dbSubnetGroups = await discoverDbSubnetGroups(rds);
        const secrets = await discoverSecrets(sm);

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

        const setupCommands = generateSetupCommands(discovered);

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
            resourceType: "all",
            resources: {
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
            count: totalCount,
            setupCommands,
            workflowCommand,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Full discovery complete: {count} resources, {cmdCount} setup commands",
          { count: totalCount, cmdCount: setupCommands.length, region },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
