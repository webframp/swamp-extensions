// AWS Cost Estimate Model - Calculate costs from inventory + pricing
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  GetProductsCommand,
  PricingClient,
} from "npm:@aws-sdk/client-pricing@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  pricingRegion: z
    .enum(["us-east-1", "ap-south-1"])
    .default("us-east-1")
    .describe("AWS Pricing API region (only us-east-1 or ap-south-1)"),
});

const EC2CostItemSchema = z.object({
  instanceId: z.string(),
  instanceType: z.string(),
  region: z.string(),
  platform: z.string(),
  hourlyRate: z.number(),
  monthlyEstimate: z.number(),
  tags: z.record(z.string(), z.string()),
});

const RDSCostItemSchema = z.object({
  dbInstanceId: z.string(),
  dbInstanceClass: z.string(),
  engine: z.string(),
  region: z.string(),
  multiAz: z.boolean(),
  storageGb: z.number(),
  hourlyRate: z.number(),
  monthlyEstimate: z.number(),
});

const CostEstimateResultSchema = z.object({
  resourceType: z.string(),
  region: z.string(),
  items: z.array(z.unknown()),
  totalMonthly: z.number(),
  currency: z.string(),
  estimatedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

function regionToLocation(region: string): string {
  const mapping: Record<string, string> = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)",
    "us-west-2": "US West (Oregon)",
    "eu-west-1": "EU (Ireland)",
    "eu-west-2": "EU (London)",
    "eu-west-3": "EU (Paris)",
    "eu-central-1": "EU (Frankfurt)",
    "eu-north-1": "EU (Stockholm)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-northeast-2": "Asia Pacific (Seoul)",
    "ap-northeast-3": "Asia Pacific (Osaka)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "sa-east-1": "South America (Sao Paulo)",
    "ca-central-1": "Canada (Central)",
  };
  return mapping[region] || region;
}

async function getEC2HourlyRate(
  client: PricingClient,
  instanceType: string,
  region: string,
  platform: string,
): Promise<number> {
  const os = platform === "windows" ? "Windows" : "Linux";
  const location = regionToLocation(region);

  const command = new GetProductsCommand({
    ServiceCode: "AmazonEC2",
    Filters: [
      { Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
      { Type: "TERM_MATCH", Field: "location", Value: location },
      { Type: "TERM_MATCH", Field: "operatingSystem", Value: os },
      { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
      { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
      { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
    ],
    MaxResults: 1,
  });

  const response = await client.send(command);

  if (response.PriceList && response.PriceList.length > 0) {
    const priceData = JSON.parse(response.PriceList[0]);
    const terms = priceData.terms?.OnDemand;
    if (terms) {
      const termKey = Object.keys(terms)[0];
      const priceDimensions = terms[termKey]?.priceDimensions;
      if (priceDimensions) {
        const dimKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = priceDimensions[dimKey]?.pricePerUnit?.USD;
        if (pricePerUnit) {
          return parseFloat(pricePerUnit);
        }
      }
    }
  }

  return 0;
}

async function getRDSHourlyRate(
  client: PricingClient,
  dbInstanceClass: string,
  engine: string,
  region: string,
  multiAz: boolean,
): Promise<number> {
  const location = regionToLocation(region);

  // Map engine names to pricing API values
  const engineMapping: Record<string, string> = {
    mysql: "MySQL",
    postgres: "PostgreSQL",
    mariadb: "MariaDB",
    "aurora-mysql": "Aurora MySQL",
    "aurora-postgresql": "Aurora PostgreSQL",
    "oracle-se2": "Oracle",
    "sqlserver-ex": "SQL Server",
    "sqlserver-web": "SQL Server",
    "sqlserver-se": "SQL Server",
    "sqlserver-ee": "SQL Server",
  };

  const dbEngine = engineMapping[engine.toLowerCase()] || engine;
  const deploymentOption = multiAz ? "Multi-AZ" : "Single-AZ";

  const command = new GetProductsCommand({
    ServiceCode: "AmazonRDS",
    Filters: [
      { Type: "TERM_MATCH", Field: "instanceType", Value: dbInstanceClass },
      { Type: "TERM_MATCH", Field: "location", Value: location },
      { Type: "TERM_MATCH", Field: "databaseEngine", Value: dbEngine },
      {
        Type: "TERM_MATCH",
        Field: "deploymentOption",
        Value: deploymentOption,
      },
    ],
    MaxResults: 1,
  });

  const response = await client.send(command);

  if (response.PriceList && response.PriceList.length > 0) {
    const priceData = JSON.parse(response.PriceList[0]);
    const terms = priceData.terms?.OnDemand;
    if (terms) {
      const termKey = Object.keys(terms)[0];
      const priceDimensions = terms[termKey]?.priceDimensions;
      if (priceDimensions) {
        const dimKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = priceDimensions[dimKey]?.pricePerUnit?.USD;
        if (pricePerUnit) {
          return parseFloat(pricePerUnit);
        }
      }
    }
  }

  return 0;
}

// =============================================================================
// Model Definition
// =============================================================================

const HOURS_PER_MONTH = 730;

export const model = {
  type: "@webframp/aws/cost-estimate",
  version: "2026.03.30.4",
  globalArguments: GlobalArgsSchema,
  reports: ["@webframp/aws/cost-report"],

  resources: {
    estimate: {
      description: "Cost estimate for AWS resources",
      schema: CostEstimateResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    estimate_ec2: {
      description: "Estimate EC2 costs from inventory data",
      arguments: z.object({
        inventory: z
          .array(
            z.object({
              instanceId: z.string(),
              instanceType: z.string(),
              availabilityZone: z.string(),
              platform: z.string().nullable(),
              tags: z.record(z.string(), z.string()).optional(),
            }),
          )
          .describe("EC2 inventory data from @webframp/aws/inventory"),
      }),
      execute: async (
        args: {
          inventory: Array<{
            instanceId: string;
            instanceType: string;
            availabilityZone: string;
            platform: string | null;
            tags?: Record<string, string>;
          }>;
        },
        context: {
          globalArgs: { pricingRegion: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const client = new PricingClient({
          region: context.globalArgs.pricingRegion,
        });
        const items: z.infer<typeof EC2CostItemSchema>[] = [];
        let totalMonthly = 0;

        // Group by instance type and region for efficient pricing lookups
        const priceCache = new Map<string, number>();

        for (const instance of args.inventory) {
          const region = instance.availabilityZone.slice(0, -1);
          const platform = instance.platform || "linux";
          const cacheKey = `${instance.instanceType}:${region}:${platform}`;

          let hourlyRate = priceCache.get(cacheKey);
          if (hourlyRate === undefined) {
            hourlyRate = await getEC2HourlyRate(
              client,
              instance.instanceType,
              region,
              platform,
            );
            priceCache.set(cacheKey, hourlyRate);
          }

          const monthlyEstimate = hourlyRate * HOURS_PER_MONTH;
          totalMonthly += monthlyEstimate;

          items.push({
            instanceId: instance.instanceId,
            instanceType: instance.instanceType,
            region,
            platform,
            hourlyRate,
            monthlyEstimate,
            tags: instance.tags || {},
          });
        }

        const handle = await context.writeResource("estimate", "ec2", {
          resourceType: "ec2",
          region: "mixed",
          items,
          totalMonthly,
          currency: "USD",
          estimatedAt: new Date().toISOString(),
        });

        context.logger.info(
          "EC2 cost estimate: {count} instances, ${total}/month",
          { count: items.length, total: totalMonthly.toFixed(2) },
        );
        return { dataHandles: [handle] };
      },
    },

    estimate_rds: {
      description: "Estimate RDS costs from inventory data",
      arguments: z.object({
        inventory: z
          .array(
            z.object({
              dbInstanceId: z.string(),
              dbInstanceClass: z.string(),
              engine: z.string(),
              availabilityZone: z.string().nullable(),
              multiAz: z.boolean(),
              allocatedStorage: z.number(),
            }),
          )
          .describe("RDS inventory data from @webframp/aws/inventory"),
        storageRatePerGb: z
          .number()
          .default(0.115)
          .describe("Storage rate per GB/month (default: gp2 rate)"),
      }),
      execute: async (
        args: {
          inventory: Array<{
            dbInstanceId: string;
            dbInstanceClass: string;
            engine: string;
            availabilityZone: string | null;
            multiAz: boolean;
            allocatedStorage: number;
          }>;
          storageRatePerGb: number;
        },
        context: {
          globalArgs: { pricingRegion: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const client = new PricingClient({
          region: context.globalArgs.pricingRegion,
        });
        const items: z.infer<typeof RDSCostItemSchema>[] = [];
        let totalMonthly = 0;

        const priceCache = new Map<string, number>();

        for (const db of args.inventory) {
          const region = db.availabilityZone
            ? db.availabilityZone.slice(0, -1)
            : "us-east-1";
          const cacheKey =
            `${db.dbInstanceClass}:${db.engine}:${region}:${db.multiAz}`;

          let hourlyRate = priceCache.get(cacheKey);
          if (hourlyRate === undefined) {
            hourlyRate = await getRDSHourlyRate(
              client,
              db.dbInstanceClass,
              db.engine,
              region,
              db.multiAz,
            );
            priceCache.set(cacheKey, hourlyRate);
          }

          const computeMonthly = hourlyRate * HOURS_PER_MONTH;
          const storageMonthly = db.allocatedStorage * args.storageRatePerGb;
          const monthlyEstimate = computeMonthly + storageMonthly;
          totalMonthly += monthlyEstimate;

          items.push({
            dbInstanceId: db.dbInstanceId,
            dbInstanceClass: db.dbInstanceClass,
            engine: db.engine,
            region,
            multiAz: db.multiAz,
            storageGb: db.allocatedStorage,
            hourlyRate,
            monthlyEstimate,
          });
        }

        const handle = await context.writeResource("estimate", "rds", {
          resourceType: "rds",
          region: "mixed",
          items,
          totalMonthly,
          currency: "USD",
          estimatedAt: new Date().toISOString(),
        });

        context.logger.info(
          "RDS cost estimate: {count} instances, ${total}/month",
          { count: items.length, total: totalMonthly.toFixed(2) },
        );
        return { dataHandles: [handle] };
      },
    },

    estimate_from_spec: {
      description: "Estimate costs for planned infrastructure (pre-deployment)",
      arguments: z.object({
        ec2Instances: z
          .array(
            z.object({
              name: z.string().describe("Instance identifier/name"),
              instanceType: z.string().describe("EC2 instance type"),
              region: z.string().default("us-east-1"),
              platform: z
                .enum(["linux", "windows"])
                .default("linux"),
              count: z.number().default(1).describe("Number of instances"),
            }),
          )
          .optional()
          .describe("Planned EC2 instances"),
        rdsInstances: z
          .array(
            z.object({
              name: z.string().describe("DB instance identifier"),
              dbInstanceClass: z.string().describe("RDS instance class"),
              engine: z.string().describe("Database engine"),
              region: z.string().default("us-east-1"),
              multiAz: z.boolean().default(false),
              storageGb: z.number().default(20),
            }),
          )
          .optional()
          .describe("Planned RDS instances"),
      }),
      execute: async (
        args: {
          ec2Instances?: Array<{
            name: string;
            instanceType: string;
            region: string;
            platform: "linux" | "windows";
            count: number;
          }>;
          rdsInstances?: Array<{
            name: string;
            dbInstanceClass: string;
            engine: string;
            region: string;
            multiAz: boolean;
            storageGb: number;
          }>;
        },
        context: {
          globalArgs: { pricingRegion: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const client = new PricingClient({
          region: context.globalArgs.pricingRegion,
        });

        const estimates: Array<{
          name: string;
          type: string;
          spec: string;
          count: number;
          hourlyRate: number;
          monthlyPerUnit: number;
          monthlyTotal: number;
        }> = [];

        let grandTotal = 0;

        // Process EC2 instances
        if (args.ec2Instances) {
          for (const ec2 of args.ec2Instances) {
            const hourlyRate = await getEC2HourlyRate(
              client,
              ec2.instanceType,
              ec2.region,
              ec2.platform,
            );
            const monthlyPerUnit = hourlyRate * HOURS_PER_MONTH;
            const monthlyTotal = monthlyPerUnit * ec2.count;
            grandTotal += monthlyTotal;

            estimates.push({
              name: ec2.name,
              type: "ec2",
              spec: `${ec2.instanceType} (${ec2.platform})`,
              count: ec2.count,
              hourlyRate,
              monthlyPerUnit,
              monthlyTotal,
            });
          }
        }

        // Process RDS instances
        if (args.rdsInstances) {
          const storageRate = 0.115; // gp2 default
          for (const rds of args.rdsInstances) {
            const hourlyRate = await getRDSHourlyRate(
              client,
              rds.dbInstanceClass,
              rds.engine,
              rds.region,
              rds.multiAz,
            );
            const computeMonthly = hourlyRate * HOURS_PER_MONTH;
            const storageMonthly = rds.storageGb * storageRate;
            const monthlyPerUnit = computeMonthly + storageMonthly;
            grandTotal += monthlyPerUnit;

            estimates.push({
              name: rds.name,
              type: "rds",
              spec: `${rds.dbInstanceClass} (${rds.engine}${
                rds.multiAz ? ", Multi-AZ" : ""
              })`,
              count: 1,
              hourlyRate,
              monthlyPerUnit,
              monthlyTotal: monthlyPerUnit,
            });
          }
        }

        const handle = await context.writeResource("estimate", "spec", {
          resourceType: "spec",
          region: "mixed",
          items: estimates,
          totalMonthly: grandTotal,
          currency: "USD",
          estimatedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Spec cost estimate: {count} resources, ${total}/month",
          { count: estimates.length, total: grandTotal.toFixed(2) },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
