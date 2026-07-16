// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EC2Client } from "npm:@aws-sdk/client-ec2@3.1069.0";
import { RDSClient } from "npm:@aws-sdk/client-rds@3.1069.0";
import { SecretsManagerClient } from "npm:@aws-sdk/client-secrets-manager@3.1069.0";
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
    ec2Send: EC2Client.prototype.send,
    rdsSend: RDSClient.prototype.send,
    smSend: SecretsManagerClient.prototype.send,
    ec2Destroy: EC2Client.prototype.destroy,
    rdsDestroy: RDSClient.prototype.destroy,
    smDestroy: SecretsManagerClient.prototype.destroy,
  };
  // Mock destroy to be a no-op
  EC2Client.prototype.destroy = function () {};
  RDSClient.prototype.destroy = function () {};
  SecretsManagerClient.prototype.destroy = function () {};
  if (overrides.ec2) {
    // deno-lint-ignore no-explicit-any
    EC2Client.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.ec2!(_c));
    } as typeof originals.ec2Send;
  }
  if (overrides.rds) {
    // deno-lint-ignore no-explicit-any
    RDSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.rds!(_c));
    } as typeof originals.rdsSend;
  }
  if (overrides.sm) {
    // deno-lint-ignore no-explicit-any
    SecretsManagerClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sm!(_c));
    } as typeof originals.smSend;
  }
  return () => {
    EC2Client.prototype.send = originals.ec2Send;
    RDSClient.prototype.send = originals.rdsSend;
    SecretsManagerClient.prototype.send = originals.smSend;
    EC2Client.prototype.destroy = originals.ec2Destroy;
    RDSClient.prototype.destroy = originals.rdsDestroy;
    SecretsManagerClient.prototype.destroy = originals.smDestroy;
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
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
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
        truncated: boolean;
        fetchedAt: string;
      };
      assertEquals(data.region, "us-east-1");
      assertEquals(data.resourceType, "vpc");
      assertEquals(data.count, 1);
      assertEquals(data.truncated, false);
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
        truncated: boolean;
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
      assertEquals(data.truncated, false);
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
        truncated: boolean;
        resources: {
          internetGatewayId: string;
          attachedVpcIds: string[];
          tags: Record<string, string>;
          name: string;
        }[];
      };
      assertEquals(data.resourceType, "internet-gateway");
      assertEquals(data.count, 1);
      assertEquals(data.truncated, false);
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
        truncated: boolean;
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
      assertEquals(data.truncated, false);
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
        truncated: boolean;
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
      assertEquals(data.truncated, false);
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
        truncated: boolean;
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
      assertEquals(data.truncated, false);
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
      assertEquals(cmdText.includes("@swamp/aws/rds/dbcluster"), true);
      assertEquals(cmdText.includes("@swamp/aws/rds/dbinstance"), true);
      assertEquals(cmdText.includes("@swamp/aws/rds/dbsubnet-group"), true);
      assertEquals(cmdText.includes("@swamp/aws/secretsmanager/secret"), true);

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
      assertEquals(data.workflowCommand.includes("prefix='mystack'"), true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// CloudFormation Stack Adoption Tests
// =============================================================================

import { CloudFormationClient } from "npm:@aws-sdk/client-cloudformation@3.1069.0";
import { CFN_TO_SWAMP_TYPE_MAP, model as modelForCfn } from "./adopt.ts";

/**
 * Mock the CloudFormation client `send` method. Accepts a function that
 * receives each command and returns the response.
 */
function mockCfnClient(
  responseFor: (cmd: unknown) => unknown,
): () => void {
  const originalSend = CloudFormationClient.prototype.send;
  const originalDestroy = CloudFormationClient.prototype.destroy;
  CloudFormationClient.prototype.destroy = function () {};
  // deno-lint-ignore no-explicit-any
  CloudFormationClient.prototype.send = function (cmd: any) {
    return Promise.resolve(responseFor(cmd));
  } as typeof originalSend;
  return () => {
    CloudFormationClient.prototype.send = originalSend;
    CloudFormationClient.prototype.destroy = originalDestroy;
  };
}

// -----------------------------------------------------------------------------
// CFN_TO_SWAMP_TYPE_MAP — static map sanity tests
// -----------------------------------------------------------------------------

Deno.test("CFN_TO_SWAMP_TYPE_MAP includes core EC2 types", () => {
  assertEquals(CFN_TO_SWAMP_TYPE_MAP["AWS::EC2::VPC"], "@swamp/aws/ec2/vpc");
  assertEquals(
    CFN_TO_SWAMP_TYPE_MAP["AWS::EC2::Subnet"],
    "@swamp/aws/ec2/subnet",
  );
  assertEquals(
    CFN_TO_SWAMP_TYPE_MAP["AWS::EC2::SecurityGroup"],
    "@swamp/aws/ec2/security-group",
  );
});

Deno.test("CFN_TO_SWAMP_TYPE_MAP includes RDS types", () => {
  assertEquals(
    CFN_TO_SWAMP_TYPE_MAP["AWS::RDS::DBCluster"],
    "@swamp/aws/rds/dbcluster",
  );
  assertEquals(
    CFN_TO_SWAMP_TYPE_MAP["AWS::RDS::DBInstance"],
    "@swamp/aws/rds/dbinstance",
  );
});

Deno.test("CFN_TO_SWAMP_TYPE_MAP is frozen (cannot be mutated)", () => {
  const map = CFN_TO_SWAMP_TYPE_MAP as Record<string, string>;
  let threw = false;
  try {
    map["AWS::Test::Type"] = "@test/type";
  } catch {
    threw = true;
  }
  // In strict mode, mutation throws; in non-strict, it silently fails.
  // Either way, the map must not have grown.
  assertEquals(threw || map["AWS::Test::Type"] === undefined, true);
});

// -----------------------------------------------------------------------------
// plan_stack_adoption — happy path
// -----------------------------------------------------------------------------

function makeCfnContext() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: {
      id: "test-cfn-id",
      name: "adopt-cfn-test",
      version: 1,
      tags: {},
    },
  });
}

Deno.test({
  name: "plan_stack_adoption maps known CFN types to swamp types",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "MyVpc",
          PhysicalResourceId: "vpc-0b4f6dd0dfd8c5339",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "MySubnet",
          PhysicalResourceId: "subnet-abc1234567890",
          ResourceType: "AWS::EC2::Subnet",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources() as WrittenResource[];
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        mapped: Array<
          { cfnType: string; swampType: string; modelName: string }
        >;
        summary: { mapped: number; unmapped: number; coveragePercent: number };
      };
      assertEquals(data.mapped.length, 2);
      assertEquals(data.mapped[0].cfnType, "AWS::EC2::VPC");
      assertEquals(data.mapped[0].swampType, "@swamp/aws/ec2/vpc");
      assertEquals(data.mapped[0].modelName.startsWith("adopt-vpc-"), true);
      assertEquals(data.summary.coveragePercent, 100);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption flags unknown CFN types as unmapped",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "MyKinesis",
          PhysicalResourceId: "kinesis-stream-1",
          ResourceType: "AWS::Kinesis::Stream",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "MyVpc",
          PhysicalResourceId: "vpc-aaa111",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        mapped: unknown[];
        unmapped: Array<{ cfnType: string; reason: string }>;
      };
      assertEquals(data.mapped.length, 1);
      assertEquals(data.unmapped.length, 1);
      assertEquals(data.unmapped[0].cfnType, "AWS::Kinesis::Stream");
      assertEquals(
        data.unmapped[0].reason.includes("no swamp type"),
        true,
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption skips resources with unstable status",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "PendingVpc",
          PhysicalResourceId: "",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_IN_PROGRESS",
        },
        {
          LogicalResourceId: "GoodVpc",
          PhysicalResourceId: "vpc-good123",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        mapped: unknown[];
        skipped: Array<{ resourceStatus: string; reason: string }>;
      };
      assertEquals(data.mapped.length, 1);
      assertEquals(data.skipped.length, 1);
      assertEquals(data.skipped[0].resourceStatus, "CREATE_IN_PROGRESS");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption flags Custom:: resources as unmapped",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "MyCustom",
          PhysicalResourceId: "custom-abc",
          ResourceType: "Custom::MyResource",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        unmapped: Array<{ reason: string }>;
      };
      assertEquals(data.unmapped.length, 1);
      assertEquals(
        data.unmapped[0].reason.includes("custom resource"),
        true,
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption recurses into nested AWS::CloudFormation::Stack",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((cmd) => {
      // deno-lint-ignore no-explicit-any
      const stackName = (cmd as any).input?.StackName ?? "unknown";
      if (stackName === "parent-stack") {
        return {
          StackResourceSummaries: [
            {
              LogicalResourceId: "ParentVpc",
              PhysicalResourceId: "vpc-parent111",
              ResourceType: "AWS::EC2::VPC",
              ResourceStatus: "CREATE_COMPLETE",
            },
            {
              LogicalResourceId: "ChildStack",
              PhysicalResourceId:
                "arn:aws:cloudformation:us-east-1:123:stack/child-stack/uuid",
              ResourceType: "AWS::CloudFormation::Stack",
              ResourceStatus: "CREATE_COMPLETE",
            },
          ],
        };
      }
      if (stackName === "child-stack") {
        return {
          StackResourceSummaries: [
            {
              LogicalResourceId: "ChildSubnet",
              PhysicalResourceId: "subnet-child222",
              ResourceType: "AWS::EC2::Subnet",
              ResourceStatus: "CREATE_COMPLETE",
            },
          ],
        };
      }
      return { StackResourceSummaries: [] };
    });
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "parent-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        mapped: Array<{ logicalId: string; depth: number }>;
        nestedStacksProcessed: number;
      };
      assertEquals(data.mapped.length, 2);
      assertEquals(data.nestedStacksProcessed, 1);
      const child = data.mapped.find((r) => r.logicalId === "ChildSubnet");
      assertEquals(child?.depth, 1);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption respects maxDepth",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((cmd) => {
      // deno-lint-ignore no-explicit-any
      const stackName = (cmd as any).input?.StackName ?? "unknown";
      if (stackName === "parent-stack") {
        return {
          StackResourceSummaries: [
            {
              LogicalResourceId: "ChildStack",
              PhysicalResourceId:
                "arn:aws:cloudformation:us-east-1:123:stack/child-stack/uuid",
              ResourceType: "AWS::CloudFormation::Stack",
              ResourceStatus: "CREATE_COMPLETE",
            },
          ],
        };
      }
      // Should not be reached when maxDepth=0
      return {
        StackResourceSummaries: [
          {
            LogicalResourceId: "ChildVpc",
            PhysicalResourceId: "vpc-child999",
            ResourceType: "AWS::EC2::VPC",
            ResourceStatus: "CREATE_COMPLETE",
          },
        ],
      };
    });
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "parent-stack",
          includeNested: true,
          maxDepth: 0,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        mapped: unknown[];
        nestedStacksProcessed: number;
      };
      // Nested stack itself filtered out (it's AWS::CloudFormation::Stack).
      // Child resources not fetched because maxDepth=0.
      assertEquals(data.mapped.length, 0);
      assertEquals(data.nestedStacksProcessed, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "plan_stack_adoption detects orphans when previous plan has resources missing from current",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "Vpc1",
          PhysicalResourceId: "vpc-current1",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      // Inject a previous plan via readResource. swamp-testing's
      // createModelTestContext exposes a method to set canned reads;
      // if it doesn't, we wrap context.readResource directly.
      // deno-lint-ignore no-explicit-any
      const ctxAny = context as any;
      ctxAny.readResource = (_instance: string) =>
        Promise.resolve({
          mapped: [
            {
              logicalId: "Vpc1",
              physicalId: "vpc-current1",
              cfnType: "AWS::EC2::VPC",
              swampType: "@swamp/aws/ec2/vpc",
              modelName: "adopt-vpc-e05d7693",
              parentStackName: "my-stack",
              depth: 0,
              getCommand: "",
            },
            {
              logicalId: "OldVpc",
              physicalId: "vpc-removed1",
              cfnType: "AWS::EC2::VPC",
              swampType: "@swamp/aws/ec2/vpc",
              modelName: "adopt-vpc-0eaa033c",
              parentStackName: "my-stack",
              depth: 0,
              getCommand: "",
            },
          ],
        });

      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        ctxAny as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        orphans: Array<{ modelName: string }>;
      };
      assertEquals(data.orphans.length, 1);
      assertEquals(data.orphans[0].modelName, "adopt-vpc-0eaa033c");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption produces shell-quoted setup and get commands",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "MyVpc",
          PhysicalResourceId: "vpc-0b4f6dd0dfd8c5339",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const mapped = ((getWrittenResources() as WrittenResource[])[0].data as {
        mapped: Array<
          { getCommand: string; swampType: string; modelName: string }
        >;
      }).mapped;
      assertEquals(
        mapped[0].swampType,
        "@swamp/aws/ec2/vpc",
      );
      assertEquals(
        mapped[0].modelName.startsWith("adopt-vpc-"),
        true,
      );
      assertEquals(
        mapped[0].getCommand.includes(
          "swamp model method run 'adopt-vpc-",
        ),
        true,
      );
      assertEquals(
        mapped[0].getCommand.includes(
          "--input identifier='vpc-0b4f6dd0dfd8c5339'",
        ),
        true,
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "plan_stack_adoption summary computes coverage percent correctly",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "GoodVpc",
          PhysicalResourceId: "vpc-1",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "BadType",
          PhysicalResourceId: "id-1",
          ResourceType: "AWS::Kinesis::Stream",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "Pending",
          PhysicalResourceId: "",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_IN_PROGRESS",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        context as ExecuteContext,
      );
      const summary = ((getWrittenResources() as WrittenResource[])[0].data as {
        summary: {
          totalResources: number;
          mapped: number;
          unmapped: number;
          skipped: number;
          coveragePercent: number;
        };
      }).summary;
      // 1 mapped + 1 unmapped + 1 skipped = 3 total; 1/3 = 33%
      assertEquals(summary.totalResources, 3);
      assertEquals(summary.mapped, 1);
      assertEquals(summary.unmapped, 1);
      assertEquals(summary.skipped, 1);
      assertEquals(summary.coveragePercent, 33);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "plan_stack_adoption carries forward previously-flagged orphans across runs",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockCfnClient((_cmd) => ({
      StackResourceSummaries: [
        {
          LogicalResourceId: "Vpc1",
          PhysicalResourceId: "vpc-current1",
          ResourceType: "AWS::EC2::VPC",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeCfnContext();
      // Inject a previous plan that ALREADY had an orphan (from run N-1).
      // The current run's mapped does not include the orphan, so the orphan
      // should be carried forward in the new plan's orphans[].
      // deno-lint-ignore no-explicit-any
      const ctxAny = context as any;
      ctxAny.readResource = (_instance: string) =>
        Promise.resolve({
          mapped: [
            {
              logicalId: "Vpc1",
              physicalId: "vpc-current1",
              cfnType: "AWS::EC2::VPC",
              swampType: "@swamp/aws/ec2/vpc",
              modelName: "adopt-vpc-e05d7693",
              parentStackName: "my-stack",
              depth: 0,
              getCommand: "",
            },
          ],
          orphans: [
            {
              modelName: "adopt-vpc-orphan-from-prior-run",
              cfnType: "AWS::EC2::VPC",
              physicalId: "vpc-old999",
              note: "in previous plan but missing from current stack",
            },
          ],
        });

      await modelForCfn.methods.plan_stack_adoption.execute(
        {
          stackName: "my-stack",
          includeNested: true,
          maxDepth: 3,
          prefix: "adopt",
        },
        ctxAny as ExecuteContext,
      );
      const data = (getWrittenResources() as WrittenResource[])[0].data as {
        orphans: Array<{ modelName: string }>;
      };
      // The previously-flagged orphan should still be in orphans[].
      assertEquals(data.orphans.length, 1);
      assertEquals(
        data.orphans[0].modelName,
        "adopt-vpc-orphan-from-prior-run",
      );
    } finally {
      restore();
    }
  },
});

Deno.test("plan_stack_adoption schema rejects ARN as stackName", () => {
  const result = modelForCfn.methods.plan_stack_adoption.arguments.safeParse({
    stackName:
      "arn:aws:cloudformation:us-east-1:123456789012:stack/my-stack/uuid",
    includeNested: true,
    maxDepth: 3,
    prefix: "adopt",
  });
  assertEquals(result.success, false);
});

Deno.test("plan_stack_adoption schema accepts valid CFN stack name", () => {
  const result = modelForCfn.methods.plan_stack_adoption.arguments.safeParse({
    stackName: "my-prod-stack",
    includeNested: true,
    maxDepth: 3,
    prefix: "adopt",
  });
  assertEquals(result.success, true);
});
