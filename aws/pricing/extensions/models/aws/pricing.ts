// AWS Pricing API Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  DescribeServicesCommand,
  Filter,
  GetAttributeValuesCommand,
  GetProductsCommand,
  PricingClient,
} from "npm:@aws-sdk/client-pricing@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .enum(["us-east-1", "ap-south-1"])
    .default("us-east-1")
    .describe(
      "AWS Pricing API region (only us-east-1 or ap-south-1 available)",
    ),
});

const ServiceSchema = z.object({
  serviceCode: z.string(),
  attributeNames: z.array(z.string()),
});

const ServiceListSchema = z.object({
  services: z.array(ServiceSchema),
  fetchedAt: z.string(),
});

const AttributeValueSchema = z.object({
  serviceCode: z.string(),
  attributeName: z.string(),
  values: z.array(z.string()),
  fetchedAt: z.string(),
});

const PriceItemSchema = z.object({
  serviceCode: z.string(),
  product: z.record(z.string(), z.unknown()),
  terms: z.record(z.string(), z.unknown()),
});

const PriceResultSchema = z.object({
  serviceCode: z.string(),
  filters: z.array(z.object({ field: z.string(), value: z.string() })),
  items: z.array(PriceItemSchema),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/aws/pricing",
  version: "2026.03.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    services: {
      description: "List of available AWS services and their attributes",
      schema: ServiceListSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    attributes: {
      description: "Attribute values for a service",
      schema: AttributeValueSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    prices: {
      description: "Pricing data for a service",
      schema: PriceResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
  },

  methods: {
    list_services: {
      description: "List all AWS services available in the Pricing API",
      arguments: z.object({
        serviceCode: z
          .string()
          .optional()
          .describe("Filter to a specific service code"),
      }),
      execute: async (
        args: { serviceCode?: string },
        context: {
          globalArgs: { region: string };
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
        const client = new PricingClient({ region: context.globalArgs.region });
        const services: Array<
          { serviceCode: string; attributeNames: string[] }
        > = [];
        let nextToken: string | undefined;

        do {
          const command = new DescribeServicesCommand({
            ServiceCode: args.serviceCode,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.Services) {
            for (const svc of response.Services) {
              if (svc.ServiceCode) {
                services.push({
                  serviceCode: svc.ServiceCode,
                  attributeNames: svc.AttributeNames || [],
                });
              }
            }
          }
          nextToken = response.NextToken;
        } while (nextToken);

        const handle = await context.writeResource("services", "all", {
          services,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} AWS services", {
          count: services.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_attribute_values: {
      description: "Get possible values for a service attribute",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g., AmazonEC2)"),
        attributeName: z
          .string()
          .describe("Attribute name (e.g., instanceType)"),
      }),
      execute: async (
        args: { serviceCode: string; attributeName: string },
        context: {
          globalArgs: { region: string };
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
        const client = new PricingClient({ region: context.globalArgs.region });
        const values: string[] = [];
        let nextToken: string | undefined;

        do {
          const command = new GetAttributeValuesCommand({
            ServiceCode: args.serviceCode,
            AttributeName: args.attributeName,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.AttributeValues) {
            for (const av of response.AttributeValues) {
              if (av.Value) {
                values.push(av.Value);
              }
            }
          }
          nextToken = response.NextToken;
        } while (nextToken);

        const instanceName = `${args.serviceCode}-${args.attributeName}`;
        const handle = await context.writeResource("attributes", instanceName, {
          serviceCode: args.serviceCode,
          attributeName: args.attributeName,
          values: values.sort(),
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Found {count} values for {service}.{attribute}",
          {
            count: values.length,
            service: args.serviceCode,
            attribute: args.attributeName,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_price: {
      description: "Get pricing for a service with optional filters",
      arguments: z.object({
        serviceCode: z.string().describe("AWS service code (e.g., AmazonEC2)"),
        filters: z
          .array(
            z.object({
              field: z.string().describe("Attribute name to filter on"),
              value: z.string().describe("Value to match"),
            }),
          )
          .optional()
          .describe("Filters to narrow pricing results"),
        maxResults: z
          .number()
          .default(10)
          .describe("Maximum number of price items to return"),
      }),
      execute: async (
        args: {
          serviceCode: string;
          filters?: Array<{ field: string; value: string }>;
          maxResults: number;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new PricingClient({ region: context.globalArgs.region });

        const apiFilters: Filter[] = (args.filters || []).map((f) => ({
          Type: "TERM_MATCH" as const,
          Field: f.field,
          Value: f.value,
        }));

        const items: Array<{
          serviceCode: string;
          product: Record<string, unknown>;
          terms: Record<string, unknown>;
        }> = [];
        let nextToken: string | undefined;
        let fetched = 0;

        do {
          const command = new GetProductsCommand({
            ServiceCode: args.serviceCode,
            Filters: apiFilters.length > 0 ? apiFilters : undefined,
            NextToken: nextToken,
            MaxResults: Math.min(100, args.maxResults - fetched),
          });
          const response = await client.send(command);

          if (response.PriceList) {
            for (const priceJson of response.PriceList) {
              if (fetched >= args.maxResults) break;
              try {
                const priceData = JSON.parse(priceJson);
                items.push({
                  serviceCode: args.serviceCode,
                  product: priceData.product || {},
                  terms: priceData.terms || {},
                });
                fetched++;
              } catch {
                // Skip malformed entries
              }
            }
          }
          nextToken = response.NextToken;
        } while (nextToken && fetched < args.maxResults);

        const filterStr = (args.filters || [])
          .map((f) => `${f.field}=${f.value}`)
          .join(",");
        const instanceName = `${args.serviceCode}-${filterStr || "all"}`.slice(
          0,
          100,
        );

        const handle = await context.writeResource("prices", instanceName, {
          serviceCode: args.serviceCode,
          filters: args.filters || [],
          items,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} price items for {service}", {
          count: items.length,
          service: args.serviceCode,
        });
        return { dataHandles: [handle] };
      },
    },

    get_ec2_price: {
      description: "Get EC2 instance pricing (convenience method)",
      arguments: z.object({
        instanceType: z.string().describe(
          "EC2 instance type (e.g., t3.medium)",
        ),
        region: z
          .string()
          .default("us-east-1")
          .describe("AWS region for pricing"),
        operatingSystem: z
          .enum(["Linux", "Windows", "RHEL", "SUSE"])
          .default("Linux")
          .describe("Operating system"),
        tenancy: z
          .enum(["Shared", "Dedicated", "Host"])
          .default("Shared")
          .describe("Tenancy type"),
      }),
      execute: async (
        args: {
          instanceType: string;
          region: string;
          operatingSystem: string;
          tenancy: string;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new PricingClient({ region: context.globalArgs.region });

        const command = new GetProductsCommand({
          ServiceCode: "AmazonEC2",
          Filters: [
            {
              Type: "TERM_MATCH",
              Field: "instanceType",
              Value: args.instanceType,
            },
            {
              Type: "TERM_MATCH",
              Field: "location",
              Value: regionToLocation(args.region),
            },
            {
              Type: "TERM_MATCH",
              Field: "operatingSystem",
              Value: args.operatingSystem,
            },
            { Type: "TERM_MATCH", Field: "tenancy", Value: args.tenancy },
            { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
            { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
          ],
          MaxResults: 10,
        });

        const response = await client.send(command);
        const items: Array<{
          serviceCode: string;
          product: Record<string, unknown>;
          terms: Record<string, unknown>;
        }> = [];

        if (response.PriceList) {
          for (const priceJson of response.PriceList) {
            try {
              const priceData = JSON.parse(priceJson);
              items.push({
                serviceCode: "AmazonEC2",
                product: priceData.product || {},
                terms: priceData.terms || {},
              });
            } catch {
              // Skip malformed entries
            }
          }
        }

        const instanceName = `ec2-${args.instanceType}-${args.region}`;
        const handle = await context.writeResource("prices", instanceName, {
          serviceCode: "AmazonEC2",
          filters: [
            { field: "instanceType", value: args.instanceType },
            { field: "region", value: args.region },
            { field: "operatingSystem", value: args.operatingSystem },
          ],
          items,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Found {count} price items for EC2 {type} in {region}",
          {
            count: items.length,
            type: args.instanceType,
            region: args.region,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// Helper to convert region code to location name used in pricing API
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
