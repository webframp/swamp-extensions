// AWS Networking Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EC2Client } from "npm:@aws-sdk/client-ec2@3.1010.0";
import { ElasticLoadBalancingV2Client } from "npm:@aws-sdk/client-elastic-load-balancing-v2@3.1010.0";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import { model } from "./networking.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockClients(overrides: {
  ec2?: (cmd: unknown) => unknown;
  elbv2?: (cmd: unknown) => unknown;
  cw?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    ec2: EC2Client.prototype.send,
    elbv2: ElasticLoadBalancingV2Client.prototype.send,
    cw: CloudWatchClient.prototype.send,
  };

  if (overrides.ec2) {
    // deno-lint-ignore no-explicit-any
    EC2Client.prototype.send = function (_command: any) {
      return Promise.resolve(overrides.ec2!(_command));
    } as typeof originals.ec2;
  }
  if (overrides.elbv2) {
    // deno-lint-ignore no-explicit-any
    ElasticLoadBalancingV2Client.prototype.send = function (_command: any) {
      return Promise.resolve(overrides.elbv2!(_command));
    } as typeof originals.elbv2;
  }
  if (overrides.cw) {
    // deno-lint-ignore no-explicit-any
    CloudWatchClient.prototype.send = function (_command: any) {
      return Promise.resolve(overrides.cw!(_command));
    } as typeof originals.cw;
  }

  return () => {
    EC2Client.prototype.send = originals.ec2;
    ElasticLoadBalancingV2Client.prototype.send = originals.elbv2;
    CloudWatchClient.prototype.send = originals.cw;
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/networking");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region defaulting to us-east-1", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertEquals("networking" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("list_nat_gateways" in model.methods, true);
  assertEquals("list_load_balancers" in model.methods, true);
  assertEquals("list_elastic_ips" in model.methods, true);
  assertEquals("get_data_transfer_metrics" in model.methods, true);
});

// =============================================================================
// list_nat_gateways Tests
// =============================================================================

Deno.test({
  name: "list_nat_gateways returns gateways and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        NatGateways: [{
          NatGatewayId: "nat-123abc",
          State: "available",
          VpcId: "vpc-abc",
          SubnetId: "subnet-abc",
          NatGatewayAddresses: [{ PublicIp: "54.1.2.3" }],
          CreateTime: new Date("2026-01-01T00:00:00Z"),
          Tags: [{ Key: "Name", Value: "prod-nat" }],
        }],
        NextToken: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-networking",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.list_nat_gateways.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_nat_gateways.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "networking");
      assertEquals(resources[0].name, "nat-gateways-us-east-1");

      const data = resources[0].data as {
        region: string;
        queryType: string;
        data: Array<{
          natGatewayId: string;
          state: string;
          vpcId: string;
          subnetId: string;
          elasticIps: string[];
          createTime: string | null;
          tags: Record<string, string>;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.queryType, "nat_gateways");
      assertEquals(data.region, "us-east-1");
      assertEquals(data.data.length, 1);

      const gw = data.data[0];
      assertEquals(gw.natGatewayId, "nat-123abc");
      assertEquals(gw.state, "available");
      assertEquals(gw.vpcId, "vpc-abc");
      assertEquals(gw.subnetId, "subnet-abc");
      assertEquals(gw.elasticIps, ["54.1.2.3"]);
      assertEquals(gw.createTime, "2026-01-01T00:00:00.000Z");
      assertEquals(gw.tags, { Name: "prod-nat" });
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_load_balancers Tests
// =============================================================================

Deno.test({
  name: "list_load_balancers returns LBs with target group health",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      elbv2: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "DescribeLoadBalancersCommand") {
          return {
            LoadBalancers: [{
              LoadBalancerArn:
                "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc123",
              LoadBalancerName: "my-alb",
              Type: "application",
              Scheme: "internet-facing",
              VpcId: "vpc-abc",
              State: { Code: "active" },
              AvailabilityZones: [
                { ZoneName: "us-east-1a" },
                { ZoneName: "us-east-1b" },
              ],
            }],
            NextMarker: undefined,
          };
        }
        if (name === "DescribeTargetGroupsCommand") {
          return {
            TargetGroups: [{
              TargetGroupArn:
                "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg/def456",
              TargetGroupName: "my-tg",
            }],
          };
        }
        if (name === "DescribeTargetHealthCommand") {
          return {
            TargetHealthDescriptions: [
              { TargetHealth: { State: "healthy" } },
              { TargetHealth: { State: "unhealthy" } },
            ],
          };
        }
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-networking",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.list_load_balancers.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_load_balancers.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "networking");
      assertEquals(resources[0].name, "load-balancers-us-east-1");

      const data = resources[0].data as {
        region: string;
        queryType: string;
        data: Array<{
          arn: string;
          name: string;
          type: string;
          scheme: string;
          vpcId: string;
          state: string;
          availabilityZones: string[];
          targetGroups: Array<{
            arn: string;
            name: string;
            healthyCount: number;
            unhealthyCount: number;
          }>;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.queryType, "load_balancers");
      assertEquals(data.data.length, 1);

      const lb = data.data[0];
      assertEquals(lb.name, "my-alb");
      assertEquals(lb.type, "application");
      assertEquals(lb.scheme, "internet-facing");
      assertEquals(lb.vpcId, "vpc-abc");
      assertEquals(lb.state, "active");
      assertEquals(lb.availabilityZones, ["us-east-1a", "us-east-1b"]);
      assertEquals(lb.targetGroups.length, 1);
      assertEquals(lb.targetGroups[0].name, "my-tg");
      assertEquals(lb.targetGroups[0].healthyCount, 1);
      assertEquals(lb.targetGroups[0].unhealthyCount, 1);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_elastic_ips Tests
// =============================================================================

Deno.test({
  name: "list_elastic_ips returns attached and unattached EIPs",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        Addresses: [
          {
            AllocationId: "eipalloc-attached",
            PublicIp: "54.10.20.30",
            AssociationId: "eipassoc-123",
            InstanceId: "i-abc",
            NetworkInterfaceId: "eni-123",
            Tags: [{ Key: "Name", Value: "web-eip" }],
          },
          {
            AllocationId: "eipalloc-unattached",
            PublicIp: "54.10.20.31",
            Tags: [],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-networking",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.list_elastic_ips.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_elastic_ips.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "networking");
      assertEquals(resources[0].name, "elastic-ips-us-east-1");

      const data = resources[0].data as {
        region: string;
        queryType: string;
        data: Array<{
          allocationId: string;
          publicIp: string;
          associationId: string | null;
          instanceId: string | null;
          networkInterfaceId: string | null;
          isAttached: boolean;
          tags: Record<string, string>;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.queryType, "elastic_ips");
      assertEquals(data.data.length, 2);

      const attached = data.data[0];
      assertEquals(attached.allocationId, "eipalloc-attached");
      assertEquals(attached.publicIp, "54.10.20.30");
      assertEquals(attached.isAttached, true);
      assertEquals(attached.associationId, "eipassoc-123");
      assertEquals(attached.instanceId, "i-abc");
      assertEquals(attached.networkInterfaceId, "eni-123");
      assertEquals(attached.tags, { Name: "web-eip" });

      const unattached = data.data[1];
      assertEquals(unattached.allocationId, "eipalloc-unattached");
      assertEquals(unattached.publicIp, "54.10.20.31");
      assertEquals(unattached.isAttached, false);
      assertEquals(unattached.associationId, null);
      assertEquals(unattached.tags, {});
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_data_transfer_metrics Tests
// =============================================================================

Deno.test({
  name:
    "get_data_transfer_metrics aggregates NAT and LB metrics with provided IDs",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      elbv2: () => ({
        LoadBalancers: [{
          LoadBalancerName: "my-alb",
          LoadBalancerArn:
            "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc123",
        }],
        NextMarker: undefined,
      }),
      cw: (cmd: unknown) => {
        const input = (cmd as { input: { MetricName: string } }).input;
        if (input.MetricName === "BytesOutToDestination") {
          return { Datapoints: [{ Sum: 1000000 }, { Sum: 2000000 }] };
        }
        if (input.MetricName === "BytesInFromSource") {
          return { Datapoints: [{ Sum: 500000 }, { Sum: 500000 }] };
        }
        if (input.MetricName === "RequestCount") {
          return { Datapoints: [{ Sum: 10000 }, { Sum: 20000 }] };
        }
        return { Datapoints: [] };
      },
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-networking",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_data_transfer_metrics.execute(
        {
          days: 7,
          natGatewayIds: ["nat-123"],
          loadBalancerNames: ["my-alb"],
        },
        context as unknown as Parameters<
          typeof model.methods.get_data_transfer_metrics.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "networking");
      assertEquals(resources[0].name, "data-transfer-7d-us-east-1");

      const data = resources[0].data as {
        region: string;
        queryType: string;
        data: {
          natGateways: Array<{
            id: string;
            bytesIn: number;
            bytesOut: number;
            totalBytes: number;
            periodDays: number;
          }>;
          loadBalancers: Array<{
            name: string;
            arn: string;
            requestCount: number;
            periodDays: number;
          }>;
        };
        fetchedAt: string;
      };
      assertEquals(data.queryType, "data_transfer_metrics");

      assertEquals(data.data.natGateways.length, 1);
      assertEquals(data.data.natGateways[0].id, "nat-123");
      assertEquals(data.data.natGateways[0].bytesOut, 3000000);
      assertEquals(data.data.natGateways[0].bytesIn, 1000000);
      assertEquals(data.data.natGateways[0].totalBytes, 4000000);
      assertEquals(data.data.natGateways[0].periodDays, 7);

      assertEquals(data.data.loadBalancers.length, 1);
      assertEquals(data.data.loadBalancers[0].name, "my-alb");
      assertEquals(data.data.loadBalancers[0].requestCount, 30000);
      assertEquals(data.data.loadBalancers[0].periodDays, 7);
    } finally {
      restore();
    }
  },
});
