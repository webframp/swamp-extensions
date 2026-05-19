// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EC2Client } from "npm:@aws-sdk/client-ec2@3.1010.0";
import { RDSClient } from "npm:@aws-sdk/client-rds@3.1010.0";
import { SecretsManagerClient } from "npm:@aws-sdk/client-secrets-manager@3.1010.0";
import { model } from "./adopt.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

function mockClients(overrides: {
  ec2?: (cmd: unknown) => unknown;
  rds?: (cmd: unknown) => unknown;
  sm?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    ec2: EC2Client.prototype.send,
    rds: RDSClient.prototype.send,
    sm: SecretsManagerClient.prototype.send,
  };
  if (overrides.ec2) {
    // deno-lint-ignore no-explicit-any
    EC2Client.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.ec2!(_c));
    } as typeof originals.ec2;
  }
  if (overrides.rds) {
    // deno-lint-ignore no-explicit-any
    RDSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.rds!(_c));
    } as typeof originals.rds;
  }
  if (overrides.sm) {
    // deno-lint-ignore no-explicit-any
    SecretsManagerClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sm!(_c));
    } as typeof originals.sm;
  }
  return () => {
    EC2Client.prototype.send = originals.ec2;
    RDSClient.prototype.send = originals.rds;
    SecretsManagerClient.prototype.send = originals.sm;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1", vpcId: "vpc-abc123def" },
    definition: {
      id: "test-id",
      name: "adopt-test",
      version: 1,
      tags: {},
    },
  });
}

// deno-lint-ignore no-explicit-any
type ExecuteContext = any;
// deno-lint-ignore no-explicit-any
type WrittenResource = any;

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model type and version are correct", () => {
  assertEquals(model.type, "@webframp/aws/adopt");
  assertEquals(model.version, "2026.05.18.1");
});

// =============================================================================
// discover_vpcs Tests
// =============================================================================

Deno.test({
  name: "discover_vpcs returns mapped VPC with correct fields",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        Vpcs: [
          {
            VpcId: "vpc-abc123def",
            CidrBlock: "10.99.0.0/16",
            State: "available",
            IsDefault: false,
            Tags: [{ Key: "Name", Value: "test-vpc" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_vpcs.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        region: string;
        vpcId: string;
        resourceType: string;
        resources: {
          vpcId: string;
          cidrBlock: string;
          state: string;
          isDefault: boolean;
          tags: Record<string, string>;
          name: string;
        }[];
        count: number;
        fetchedAt: string;
      };
      assertEquals(data.region, "us-east-1");
      assertEquals(data.resourceType, "vpc");
      assertEquals(data.count, 1);
      assertEquals(data.resources.length, 1);
      assertEquals(data.resources[0].vpcId, "vpc-abc123def");
      assertEquals(data.resources[0].cidrBlock, "10.99.0.0/16");
      assertEquals(data.resources[0].state, "available");
      assertEquals(data.resources[0].isDefault, false);
      assertEquals(data.resources[0].tags, { Name: "test-vpc" });
      assertEquals(data.resources[0].name, "test-vpc");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_subnets Tests
// =============================================================================

Deno.test({
  name: "discover_subnets returns mapped subnets with AZs and CIDRs",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        Subnets: [
          {
            SubnetId: "subnet-aaa111",
            VpcId: "vpc-abc123def",
            CidrBlock: "10.99.1.0/24",
            AvailabilityZone: "us-east-1a",
            MapPublicIpOnLaunch: true,
            Tags: [{ Key: "Name", Value: "public-1a" }],
          },
          {
            SubnetId: "subnet-bbb222",
            VpcId: "vpc-abc123def",
            CidrBlock: "10.99.2.0/24",
            AvailabilityZone: "us-east-1b",
            MapPublicIpOnLaunch: false,
            Tags: [{ Key: "Name", Value: "private-1b" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_subnets.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          subnetId: string;
          vpcId: string;
          cidrBlock: string;
          availabilityZone: string;
          mapPublicIpOnLaunch: boolean;
          name: string;
        }[];
      };
      assertEquals(data.resourceType, "subnet");
      assertEquals(data.count, 2);
      assertEquals(data.resources[0].availabilityZone, "us-east-1a");
      assertEquals(data.resources[0].cidrBlock, "10.99.1.0/24");
      assertEquals(data.resources[0].mapPublicIpOnLaunch, true);
      assertEquals(data.resources[1].availabilityZone, "us-east-1b");
      assertEquals(data.resources[1].cidrBlock, "10.99.2.0/24");
      assertEquals(data.resources[1].mapPublicIpOnLaunch, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_gateways Tests
// =============================================================================

Deno.test({
  name: "discover_gateways returns IGW with attachedVpcIds",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        InternetGateways: [
          {
            InternetGatewayId: "igw-12345abcd",
            Attachments: [{ VpcId: "vpc-abc123def", State: "attached" }],
            Tags: [{ Key: "Name", Value: "main-igw" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_gateways.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          internetGatewayId: string;
          attachedVpcIds: string[];
          tags: Record<string, string>;
          name: string;
        }[];
      };
      assertEquals(data.resourceType, "internet-gateway");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].internetGatewayId, "igw-12345abcd");
      assertEquals(data.resources[0].attachedVpcIds, ["vpc-abc123def"]);
      assertEquals(data.resources[0].name, "main-igw");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_security_groups Tests
// =============================================================================

Deno.test({
  name: "discover_security_groups returns SG with ingress/egress rule counts",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        SecurityGroups: [
          {
            GroupId: "sg-abc123def",
            GroupName: "web-sg",
            VpcId: "vpc-abc123def",
            Description: "Web server security group",
            IpPermissions: [
              { IpProtocol: "tcp", FromPort: 80, ToPort: 80 },
              { IpProtocol: "tcp", FromPort: 443, ToPort: 443 },
            ],
            IpPermissionsEgress: [
              { IpProtocol: "-1", FromPort: -1, ToPort: -1 },
            ],
            Tags: [{ Key: "Name", Value: "web-sg" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_security_groups.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          groupId: string;
          groupName: string;
          vpcId: string;
          description: string;
          ingressRuleCount: number;
          egressRuleCount: number;
          name: string;
        }[];
      };
      assertEquals(data.resourceType, "security-group");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].groupId, "sg-abc123def");
      assertEquals(data.resources[0].groupName, "web-sg");
      assertEquals(data.resources[0].vpcId, "vpc-abc123def");
      assertEquals(data.resources[0].ingressRuleCount, 2);
      assertEquals(data.resources[0].egressRuleCount, 1);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_rds_clusters Tests
// =============================================================================

Deno.test({
  name: "discover_rds_clusters returns cluster with identifier and engine",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      rds: () => ({
        DBClusters: [
          {
            DBClusterIdentifier: "prod-aurora-cluster",
            Engine: "aurora-postgresql",
            EngineVersion: "15.4",
            Status: "available",
            Endpoint:
              "prod-aurora-cluster.cluster-abc123.us-east-1.rds.amazonaws.com",
            ReaderEndpoint:
              "prod-aurora-cluster.cluster-ro-abc123.us-east-1.rds.amazonaws.com",
            Port: 5432,
            DBSubnetGroup: "prod-db-subnet-group",
            VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-rds111" }],
            DBClusterMembers: [{ DBInstanceIdentifier: "prod-aurora-1" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_rds_clusters.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          clusterIdentifier: string;
          engine: string;
          engineVersion: string;
          status: string;
          endpoint: string;
          port: number;
          vpcSecurityGroups: string[];
          members: string[];
        }[];
      };
      assertEquals(data.resourceType, "rds-cluster");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].clusterIdentifier, "prod-aurora-cluster");
      assertEquals(data.resources[0].engine, "aurora-postgresql");
      assertEquals(data.resources[0].engineVersion, "15.4");
      assertEquals(data.resources[0].status, "available");
      assertEquals(data.resources[0].port, 5432);
      assertEquals(data.resources[0].vpcSecurityGroups, ["sg-rds111"]);
      assertEquals(data.resources[0].members, ["prod-aurora-1"]);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_secrets Tests
// =============================================================================

Deno.test({
  name: "discover_secrets returns secret with name and ARN",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sm: () => ({
        SecretList: [
          {
            Name: "prod/db/credentials",
            ARN:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db/credentials-AbCdEf",
            Description: "Production database credentials",
            LastChangedDate: new Date("2026-03-15T10:30:00Z"),
            Tags: [{ Key: "Environment", Value: "production" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_secrets.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "partial");
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          name: string;
          arn: string;
          description: string;
          lastChangedDate: string | null;
          tags: Record<string, string>;
        }[];
      };
      assertEquals(data.resourceType, "secret");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].name, "prod/db/credentials");
      assertEquals(
        data.resources[0].arn,
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db/credentials-AbCdEf",
      );
      assertEquals(
        data.resources[0].description,
        "Production database credentials",
      );
      assertEquals(
        data.resources[0].lastChangedDate,
        "2026-03-15T10:30:00.000Z",
      );
      assertEquals(data.resources[0].tags, { Environment: "production" });
    } finally {
      restore();
    }
  },
});

// =============================================================================
// discover_all Tests
// =============================================================================

function allServiceMocks() {
  return {
    ec2: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name.includes("Vpc")) {
        return {
          Vpcs: [
            {
              VpcId: "vpc-abc123def",
              CidrBlock: "10.99.0.0/16",
              State: "available",
              IsDefault: false,
              Tags: [{ Key: "Name", Value: "test-vpc" }],
            },
          ],
        };
      }
      if (name.includes("Subnet")) {
        return {
          Subnets: [
            {
              SubnetId: "subnet-aaa111",
              VpcId: "vpc-abc123def",
              CidrBlock: "10.99.1.0/24",
              AvailabilityZone: "us-east-1a",
              MapPublicIpOnLaunch: true,
              Tags: [{ Key: "Name", Value: "public-1a" }],
            },
          ],
        };
      }
      if (name.includes("InternetGateway")) {
        return {
          InternetGateways: [
            {
              InternetGatewayId: "igw-12345abcd",
              Attachments: [{ VpcId: "vpc-abc123def", State: "attached" }],
              Tags: [{ Key: "Name", Value: "main-igw" }],
            },
          ],
        };
      }
      if (name.includes("RouteTable")) {
        return {
          RouteTables: [
            {
              RouteTableId: "rtb-main1234",
              VpcId: "vpc-abc123def",
              Associations: [{ Main: true }],
              Routes: [
                {
                  DestinationCidrBlock: "10.99.0.0/16",
                  GatewayId: "local",
                  State: "active",
                },
                {
                  DestinationCidrBlock: "0.0.0.0/0",
                  GatewayId: "igw-12345abcd",
                  State: "active",
                },
              ],
              Tags: [{ Key: "Name", Value: "main-rt" }],
            },
          ],
        };
      }
      if (name.includes("SecurityGroup")) {
        return {
          SecurityGroups: [
            {
              GroupId: "sg-abc123def",
              GroupName: "web-sg",
              VpcId: "vpc-abc123def",
              Description: "Web SG",
              IpPermissions: [{
                IpProtocol: "tcp",
                FromPort: 443,
                ToPort: 443,
              }],
              IpPermissionsEgress: [{ IpProtocol: "-1" }],
              Tags: [{ Key: "Name", Value: "web-sg" }],
            },
          ],
        };
      }
      return {};
    },
    rds: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name.includes("DBCluster") && !name.includes("Instance")) {
        return {
          DBClusters: [
            {
              DBClusterIdentifier: "prod-aurora",
              Engine: "aurora-postgresql",
              EngineVersion: "15.4",
              Status: "available",
              Endpoint: "prod-aurora.cluster-abc.us-east-1.rds.amazonaws.com",
              ReaderEndpoint:
                "prod-aurora.cluster-ro-abc.us-east-1.rds.amazonaws.com",
              Port: 5432,
              DBSubnetGroup: "prod-dbsg",
              VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-rds111" }],
              DBClusterMembers: [{ DBInstanceIdentifier: "prod-aurora-1" }],
            },
          ],
        };
      }
      if (name.includes("DBInstance")) {
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: "prod-aurora-1",
              DBInstanceClass: "db.r6g.large",
              Engine: "aurora-postgresql",
              EngineVersion: "15.4",
              DBInstanceStatus: "available",
              AvailabilityZone: "us-east-1a",
              MultiAZ: false,
              StorageType: "aurora",
              AllocatedStorage: 1,
              DBClusterIdentifier: "prod-aurora",
              DBSubnetGroup: { DBSubnetGroupName: "prod-dbsg" },
            },
          ],
        };
      }
      if (name.includes("DBSubnetGroup")) {
        return {
          DBSubnetGroups: [
            {
              DBSubnetGroupName: "prod-dbsg",
              DBSubnetGroupDescription: "Production DB subnet group",
              VpcId: "vpc-abc123def",
              Subnets: [
                { SubnetIdentifier: "subnet-aaa111" },
                { SubnetIdentifier: "subnet-bbb222" },
              ],
              SubnetGroupStatus: "Complete",
            },
          ],
        };
      }
      return {};
    },
    sm: () => ({
      SecretList: [
        {
          Name: "prod/db/creds",
          ARN:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db/creds-XyZ",
          Description: "DB creds",
          LastChangedDate: new Date("2026-03-01T00:00:00Z"),
          Tags: [],
        },
      ],
    }),
  };
}

Deno.test({
  name: "discover_all combines all resources and generates correct summary",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients(allServiceMocks());
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_all.execute(
        { prefix: "adopt" },
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "discovery");
      const data = resources[0].data as {
        region: string;
        vpcId: string;
        discovered: {
          vpcs: unknown[];
          subnets: unknown[];
          internetGateways: unknown[];
          routeTables: unknown[];
          securityGroups: unknown[];
          rdsClusters: unknown[];
          rdsInstances: unknown[];
          dbSubnetGroups: unknown[];
          secrets: unknown[];
        };
        setupCommands: string[];
        workflowCommand: string;
        summary: {
          totalResources: number;
          byType: Record<string, number>;
        };
      };

      // 1 vpc + 1 subnet + 1 igw + 1 rt + 1 sg + 1 cluster + 1 instance + 1 dbsg + 1 secret = 9
      assertEquals(data.summary.totalResources, 9);

      // setupCommands: 1 vpc + 1 subnet + 1 igw + 1 rt + 1 sg + 1 cluster + 1 instance + 1 dbsg + 1 secret = 9
      assertEquals(data.setupCommands.length, 9);

      // Verify correct model type paths in setup commands
      const cmdText = data.setupCommands.join("\n");
      assertEquals(cmdText.includes("@swamp/aws/ec2/vpc"), true);
      assertEquals(cmdText.includes("@swamp/aws/ec2/subnet"), true);
      assertEquals(cmdText.includes("@swamp/aws/ec2/internet-gateway"), true);
      assertEquals(cmdText.includes("@swamp/aws/ec2/route-table"), true);
      assertEquals(cmdText.includes("@swamp/aws/ec2/security-group"), true);
      assertEquals(cmdText.includes("@swamp/aws/rds/cluster"), true);
      assertEquals(cmdText.includes("@swamp/aws/rds/instance"), true);
      assertEquals(cmdText.includes("@swamp/aws/rds/db-subnet-group"), true);
      assertEquals(cmdText.includes("@swamp/aws/secrets-manager/secret"), true);

      // Verify workflow command contains adopt-stack and vpcId
      assertEquals(data.workflowCommand.includes("adopt-stack"), true);
      assertEquals(data.workflowCommand.includes("vpc-abc123def"), true);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "discover_all with custom prefix uses prefix in commands",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients(allServiceMocks());
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.discover_all.execute(
        { prefix: "mystack" },
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      const data = resources[0].data as {
        setupCommands: string[];
        workflowCommand: string;
      };

      // Verify prefix appears in setup commands
      for (const cmd of data.setupCommands) {
        assertEquals(cmd.includes("mystack-"), true);
      }

      // Verify prefix appears in workflow command
      assertEquals(data.workflowCommand.includes("prefix=mystack"), true);
    } finally {
      restore();
    }
  },
});
