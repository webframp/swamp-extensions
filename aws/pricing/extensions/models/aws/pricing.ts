/**
 * AWS Pricing API model for querying service costs, attribute values,
 * and on-demand pricing from the AWS Price List Service.
 *
 * Provides four methods: list_services, get_attribute_values, get_price,
 * and get_ec2_price. The Pricing API is available only in us-east-1 and
 * ap-south-1 and requires valid AWS credentials.
 *
 * @module
 */

// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  DescribeServicesCommand,
  Filter,
  GetAttributeValuesCommand,
  GetProductsCommand,
  PricingClient,
} from "npm:@aws-sdk/client-pricing@3.1121.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1121.0";

const EXTENSION_NAME = "@webframp/aws/pricing";

const MAX_PAGES = 10;

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
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AWS shared-config profile to resolve credentials from (fromIni / SSO " +
        "token cache). Omit to use the default credential chain.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Build base AWS client configuration with region and optional profile credentials.
 * When `profile` is set, credentials resolve via fromIni (supports SSO token
 * cache and shared config). When absent, the default credential chain applies.
 */
function makeClientConfig(
  globalArgs: GlobalArgs,
): { region: string; credentials?: ReturnType<typeof fromIni> } {
  return {
    region: globalArgs.region,
    ...(globalArgs.profile
      ? { credentials: fromIni({ profile: globalArgs.profile }) }
      : {}),
  };
}

const ServiceSchema = z.object({
  serviceCode: z.string(),
  attributeNames: z.array(z.string()),
});

const ServiceListSchema = z.object({
  services: z.array(ServiceSchema),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const AttributeValueSchema = z.object({
  serviceCode: z.string(),
  attributeName: z.string(),
  values: z.array(z.string()),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Model Definition
// =============================================================================

/**
 * AWS Pricing model definition.
 *
 * Exposes resources for caching service lists, attribute values, and price
 * data, along with methods that query the AWS Price List Service API.
 */
export const model = {
  type: "@webframp/aws/pricing",
  version: "2026.08.29.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.30.1",
      description: "Add optional profile global argument for multi-account use",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.05.1",
      description: "Version bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.20.1",
      description: "Dependency bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "Tighten serviceCode/attributeName/instanceType validation, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "Error-message quality and validation improvements, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description: "Fix missing upgrade description metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.28.1",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.28.2",
      description:
        "No schema changes — normalized license to Apache-2.0 and corrected copyright holder to Sean Escriva",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.29.1",
      description:
        "Dependency bump: AWS SDK 3.1120.0 → 3.1121.0, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new PricingClient(makeClientConfig(context.globalArgs));
        try {
          const services: Array<
            { serviceCode: string; attributeNames: string[] }
          > = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const command = new DescribeServicesCommand({
              ServiceCode: args.serviceCode,
              NextToken: nextToken,
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `Failed to describe AWS Pricing services${
                  args.serviceCode ? ` (serviceCode="${args.serviceCode}")` : ""
                }: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }

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
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource("services", "all", {
            services,
            truncated: nextToken !== undefined,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          });

          context.logger.info("Found {count} AWS services", {
            count: services.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_attribute_values: {
      description: "Get possible values for a service attribute",
      arguments: z.object({
        serviceCode: z.string().min(1).describe(
          "AWS service code (e.g., AmazonEC2)",
        ),
        attributeName: z
          .string()
          .min(1)
          .describe("Attribute name (e.g., instanceType)"),
      }),
      execute: async (
        args: { serviceCode: string; attributeName: string },
        context: {
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new PricingClient(makeClientConfig(context.globalArgs));
        try {
          const values: string[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const command = new GetAttributeValuesCommand({
              ServiceCode: args.serviceCode,
              AttributeName: args.attributeName,
              NextToken: nextToken,
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `Failed to get attribute values for "${args.serviceCode}.${args.attributeName}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { cause: err },
              );
            }

            if (response.AttributeValues) {
              for (const av of response.AttributeValues) {
                if (av.Value) {
                  values.push(av.Value);
                }
              }
            }
            nextToken = response.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const instanceName = `${args.serviceCode}-${args.attributeName}`;
          const handle = await context.writeResource(
            "attributes",
            instanceName,
            {
              serviceCode: args.serviceCode,
              attributeName: args.attributeName,
              values: values.sort(),
              truncated: nextToken !== undefined,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );

          context.logger.info(
            "Found {count} values for {service}.{attribute}",
            {
              count: values.length,
              service: args.serviceCode,
              attribute: args.attributeName,
            },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_price: {
      description: "Get pricing for a service with optional filters",
      arguments: z.object({
        serviceCode: z.string().min(1).describe(
          "AWS service code (e.g., AmazonEC2)",
        ),
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
          .int()
          .min(1)
          .max(1000)
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
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new PricingClient(makeClientConfig(context.globalArgs));
        try {
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
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `Failed to get products/pricing for service "${args.serviceCode}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { cause: err },
              );
            }

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
          const instanceName = `${args.serviceCode}-${filterStr || "all"}`
            .slice(
              0,
              100,
            );

          const handle = await context.writeResource("prices", instanceName, {
            serviceCode: args.serviceCode,
            filters: args.filters || [],
            items,
            truncated: nextToken !== undefined,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          });

          context.logger.info("Found {count} price items for {service}", {
            count: items.length,
            service: args.serviceCode,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_ec2_price: {
      description: "Get EC2 instance pricing (convenience method)",
      arguments: z.object({
        instanceType: z.string().min(1).describe(
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
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new PricingClient(makeClientConfig(context.globalArgs));
        try {
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

          let response;
          try {
            response = await client.send(command);
          } catch (err) {
            throw new Error(
              `Failed to get EC2 pricing for instanceType="${args.instanceType}", region="${args.region}", os="${args.operatingSystem}", tenancy="${args.tenancy}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            );
          }
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
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
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
        } finally {
          client.destroy();
        }
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
