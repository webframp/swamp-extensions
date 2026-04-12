// AWS Networking Model - Inspect VPC resources that generate hidden costs
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  EC2Client,
} from "npm:@aws-sdk/client-ec2@3.1010.0";
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "npm:@aws-sdk/client-elastic-load-balancing-v2@3.1010.0";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "npm:@aws-sdk/client-cloudwatch@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region to inspect"),
});

const NatGatewaySchema = z.object({
  natGatewayId: z.string(),
  state: z.string(),
  vpcId: z.string(),
  subnetId: z.string(),
  elasticIps: z.array(z.string()),
  createTime: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
});

const TargetGroupInfoSchema = z.object({
  arn: z.string(),
  name: z.string(),
  healthyCount: z.number(),
  unhealthyCount: z.number(),
});

const LoadBalancerSchema = z.object({
  arn: z.string(),
  name: z.string(),
  type: z.string(),
  scheme: z.string(),
  vpcId: z.string(),
  state: z.string(),
  availabilityZones: z.array(z.string()),
  targetGroups: z.array(TargetGroupInfoSchema),
});

const ElasticIpSchema = z.object({
  allocationId: z.string(),
  publicIp: z.string(),
  associationId: z.string().nullable(),
  instanceId: z.string().nullable(),
  networkInterfaceId: z.string().nullable(),
  isAttached: z.boolean(),
  tags: z.record(z.string(), z.string()),
});

const NetworkingResultSchema = z.object({
  region: z.string(),
  queryType: z.string(),
  data: z.unknown(),
  fetchedAt: z.string(),
});

// =============================================================================
// Context type (inline, matching existing pattern)
// =============================================================================

type MethodContext = {
  globalArgs: { region: string };
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
  type: "@webframp/aws/networking",
  version: "2026.04.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    networking: {
      description: "VPC networking resource data",
      schema: NetworkingResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_nat_gateways: {
      description: "List active NAT Gateways with their Elastic IPs",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const client = new EC2Client({ region: context.globalArgs.region });
        const gateways: z.infer<typeof NatGatewaySchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new DescribeNatGatewaysCommand({
            Filter: [
              {
                Name: "state",
                Values: ["pending", "failed", "available"],
              },
            ],
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.NatGateways) {
            for (const gw of response.NatGateways) {
              if (gw.NatGatewayId) {
                const tags: Record<string, string> = {};
                if (gw.Tags) {
                  for (const tag of gw.Tags) {
                    if (tag.Key && tag.Value) {
                      tags[tag.Key] = tag.Value;
                    }
                  }
                }
                const elasticIps: string[] = [];
                if (gw.NatGatewayAddresses) {
                  for (const addr of gw.NatGatewayAddresses) {
                    if (addr.PublicIp) {
                      elasticIps.push(addr.PublicIp);
                    }
                  }
                }
                gateways.push({
                  natGatewayId: gw.NatGatewayId,
                  state: gw.State || "unknown",
                  vpcId: gw.VpcId || "unknown",
                  subnetId: gw.SubnetId || "unknown",
                  elasticIps,
                  createTime: gw.CreateTime?.toISOString() || null,
                  tags,
                });
              }
            }
          }
          nextToken = response.NextToken;
        } while (nextToken);

        const handle = await context.writeResource(
          "networking",
          `nat-gateways-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            queryType: "nat_gateways",
            data: gateways,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} active NAT Gateways in {region}",
          { count: gateways.length, region: context.globalArgs.region },
        );
        return { dataHandles: [handle] };
      },
    },

    list_load_balancers: {
      description: "List ALBs and NLBs with target group health information",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const client = new ElasticLoadBalancingV2Client({
          region: context.globalArgs.region,
        });
        const loadBalancers: z.infer<typeof LoadBalancerSchema>[] = [];
        let marker: string | undefined;

        do {
          const command = new DescribeLoadBalancersCommand({
            Marker: marker,
          });
          const response = await client.send(command);

          if (response.LoadBalancers) {
            for (const lb of response.LoadBalancers) {
              if (lb.LoadBalancerArn && lb.LoadBalancerName) {
                // Get target groups for this load balancer
                const tgCommand = new DescribeTargetGroupsCommand({
                  LoadBalancerArn: lb.LoadBalancerArn,
                });
                const tgResponse = await client.send(tgCommand);

                const targetGroups: z.infer<typeof TargetGroupInfoSchema>[] =
                  [];
                if (tgResponse.TargetGroups) {
                  for (const tg of tgResponse.TargetGroups) {
                    if (tg.TargetGroupArn && tg.TargetGroupName) {
                      // Get target health for this target group
                      const thCommand = new DescribeTargetHealthCommand({
                        TargetGroupArn: tg.TargetGroupArn,
                      });
                      const thResponse = await client.send(thCommand);

                      let healthyCount = 0;
                      let unhealthyCount = 0;
                      if (thResponse.TargetHealthDescriptions) {
                        for (
                          const desc of thResponse.TargetHealthDescriptions
                        ) {
                          if (desc.TargetHealth?.State === "healthy") {
                            healthyCount++;
                          } else {
                            unhealthyCount++;
                          }
                        }
                      }

                      targetGroups.push({
                        arn: tg.TargetGroupArn,
                        name: tg.TargetGroupName,
                        healthyCount,
                        unhealthyCount,
                      });
                    }
                  }
                }

                const availabilityZones: string[] = [];
                if (lb.AvailabilityZones) {
                  for (const az of lb.AvailabilityZones) {
                    if (az.ZoneName) {
                      availabilityZones.push(az.ZoneName);
                    }
                  }
                }

                loadBalancers.push({
                  arn: lb.LoadBalancerArn,
                  name: lb.LoadBalancerName,
                  type: lb.Type || "unknown",
                  scheme: lb.Scheme || "unknown",
                  vpcId: lb.VpcId || "unknown",
                  state: lb.State?.Code || "unknown",
                  availabilityZones,
                  targetGroups,
                });
              }
            }
          }
          marker = response.NextMarker;
        } while (marker);

        const handle = await context.writeResource(
          "networking",
          `load-balancers-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            queryType: "load_balancers",
            data: loadBalancers,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} load balancers in {region}",
          { count: loadBalancers.length, region: context.globalArgs.region },
        );
        return { dataHandles: [handle] };
      },
    },

    list_elastic_ips: {
      description: "List Elastic IPs and identify unattached ones",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const client = new EC2Client({ region: context.globalArgs.region });

        const command = new DescribeAddressesCommand({});
        const response = await client.send(command);

        const addresses: z.infer<typeof ElasticIpSchema>[] = [];
        if (response.Addresses) {
          for (const addr of response.Addresses) {
            if (addr.AllocationId && addr.PublicIp) {
              const tags: Record<string, string> = {};
              if (addr.Tags) {
                for (const tag of addr.Tags) {
                  if (tag.Key && tag.Value) {
                    tags[tag.Key] = tag.Value;
                  }
                }
              }
              addresses.push({
                allocationId: addr.AllocationId,
                publicIp: addr.PublicIp,
                associationId: addr.AssociationId || null,
                instanceId: addr.InstanceId || null,
                networkInterfaceId: addr.NetworkInterfaceId || null,
                isAttached: !!addr.AssociationId,
                tags,
              });
            }
          }
        }

        const handle = await context.writeResource(
          "networking",
          `elastic-ips-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            queryType: "elastic_ips",
            data: addresses,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} Elastic IPs in {region} ({unattached} unattached)",
          {
            count: addresses.length,
            region: context.globalArgs.region,
            unattached: addresses.filter((a) => !a.isAttached).length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_data_transfer_metrics: {
      description:
        "Get data transfer metrics for NAT Gateways and request counts for ALBs",
      arguments: z.object({
        days: z
          .number()
          .default(7)
          .describe("Number of days to look back"),
        natGatewayIds: z
          .array(z.string())
          .optional()
          .describe(
            "NAT Gateway IDs to query (discovers all if not provided)",
          ),
        loadBalancerNames: z
          .array(z.string())
          .optional()
          .describe(
            "Load balancer names to query (discovers all if not provided)",
          ),
      }),
      execute: async (
        args: {
          days: number;
          natGatewayIds?: string[];
          loadBalancerNames?: string[];
        },
        context: MethodContext,
      ) => {
        const region = context.globalArgs.region;
        const cwClient = new CloudWatchClient({ region });

        const endTime = new Date();
        const startTime = new Date();
        startTime.setDate(startTime.getDate() - args.days);

        // Discover or use provided NAT Gateway IDs
        let natGatewayIds = args.natGatewayIds;
        if (!natGatewayIds) {
          const ec2Client = new EC2Client({ region });
          natGatewayIds = [];
          let nextToken: string | undefined;
          do {
            const natResp = await ec2Client.send(
              new DescribeNatGatewaysCommand({
                Filter: [{ Name: "state", Values: ["available"] }],
                NextToken: nextToken,
              }),
            );
            for (const gw of natResp.NatGateways || []) {
              if (gw.NatGatewayId) natGatewayIds.push(gw.NatGatewayId);
            }
            nextToken = natResp.NextToken;
          } while (nextToken);
        }

        // Discover or use provided load balancer info
        type LbInfo = { name: string; arn: string };
        const elbClient = new ElasticLoadBalancingV2Client({ region });
        const lbInfos: LbInfo[] = [];
        let lbMarker: string | undefined;
        do {
          const lbResp = await elbClient.send(
            new DescribeLoadBalancersCommand({
              ...(args.loadBalancerNames
                ? { Names: args.loadBalancerNames }
                : {}),
              Marker: lbMarker,
            }),
          );
          for (const lb of lbResp.LoadBalancers || []) {
            if (lb.LoadBalancerName && lb.LoadBalancerArn) {
              lbInfos.push({
                name: lb.LoadBalancerName,
                arn: lb.LoadBalancerArn,
              });
            }
          }
          lbMarker = lbResp.NextMarker;
        } while (lbMarker);

        // Gather NAT Gateway metrics
        const natGatewayMetrics: {
          id: string;
          bytesIn: number;
          bytesOut: number;
          totalBytes: number;
          periodDays: number;
        }[] = [];

        for (const natId of natGatewayIds) {
          const bytesOutCmd = new GetMetricStatisticsCommand({
            Namespace: "AWS/NATGateway",
            MetricName: "BytesOutToDestination",
            Dimensions: [{ Name: "NatGatewayId", Value: natId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ["Sum"],
          });
          const bytesInCmd = new GetMetricStatisticsCommand({
            Namespace: "AWS/NATGateway",
            MetricName: "BytesInFromSource",
            Dimensions: [{ Name: "NatGatewayId", Value: natId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ["Sum"],
          });

          const [bytesOutResp, bytesInResp] = await Promise.all([
            cwClient.send(bytesOutCmd),
            cwClient.send(bytesInCmd),
          ]);

          const bytesOut = (bytesOutResp.Datapoints || [])
            .reduce((sum, dp) => sum + (dp.Sum || 0), 0);
          const bytesIn = (bytesInResp.Datapoints || [])
            .reduce((sum, dp) => sum + (dp.Sum || 0), 0);

          natGatewayMetrics.push({
            id: natId,
            bytesIn,
            bytesOut,
            totalBytes: bytesIn + bytesOut,
            periodDays: args.days,
          });
        }

        // Gather ALB request count metrics
        const loadBalancerMetrics: {
          name: string;
          arn: string;
          requestCount: number;
          periodDays: number;
        }[] = [];

        for (const lb of lbInfos) {
          // Extract the ARN suffix after "loadbalancer/"
          const arnSuffix = lb.arn.split(":loadbalancer/")[1] || lb.arn;

          const reqCountCmd = new GetMetricStatisticsCommand({
            Namespace: "AWS/ApplicationELB",
            MetricName: "RequestCount",
            Dimensions: [{ Name: "LoadBalancer", Value: arnSuffix }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ["Sum"],
          });
          const reqResp = await cwClient.send(reqCountCmd);

          const requestCount = (reqResp.Datapoints || [])
            .reduce((sum, dp) => sum + (dp.Sum || 0), 0);

          loadBalancerMetrics.push({
            name: lb.name,
            arn: lb.arn,
            requestCount,
            periodDays: args.days,
          });
        }

        const data = {
          natGateways: natGatewayMetrics,
          loadBalancers: loadBalancerMetrics,
        };

        const handle = await context.writeResource(
          "networking",
          `data-transfer-${args.days}d-${region}`,
          {
            region,
            queryType: "data_transfer_metrics",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Collected metrics for {natCount} NAT Gateways and {lbCount} load balancers over {days} days",
          {
            natCount: natGatewayMetrics.length,
            lbCount: loadBalancerMetrics.length,
            days: args.days,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
