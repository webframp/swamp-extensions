/**
 * AWS Inventory Model - Discover running resources across multiple AWS services.
 *
 * Queries EC2, RDS, DynamoDB, Lambda, S3, and EBS to build a unified
 * inventory of cloud infrastructure in a given region. Each method
 * paginates through the full result set and writes typed inventory
 * resources for downstream cost estimation and analysis.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  DescribeDBInstancesCommand,
  RDSClient,
} from "npm:@aws-sdk/client-rds@3.1069.0";
import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "npm:@aws-sdk/client-ec2@3.1069.0";
import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "npm:@aws-sdk/client-dynamodb@3.1069.0";
import {
  LambdaClient,
  ListFunctionsCommand,
} from "npm:@aws-sdk/client-lambda@3.1069.0";
import { ListBucketsCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1069.0";
import {
  ConfigServiceClient,
  SelectResourceConfigCommand,
} from "npm:@aws-sdk/client-config-service@3.1069.0";
import {
  ResourceExplorer2Client,
  SearchCommand as RESearchCommand,
} from "npm:@aws-sdk/client-resource-explorer-2@3.1069.0";
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from "npm:@aws-sdk/client-resource-groups-tagging-api@3.1069.0";

const MAX_PAGES = 10;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region to inventory"),
});

const EC2InstanceSchema = z.object({
  instanceId: z.string(),
  instanceType: z.string(),
  state: z.string(),
  availabilityZone: z.string(),
  platform: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
  launchTime: z.string().nullable(),
});

const RDSInstanceSchema = z.object({
  dbInstanceId: z.string(),
  dbInstanceClass: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  status: z.string(),
  availabilityZone: z.string().nullable(),
  multiAz: z.boolean(),
  storageType: z.string(),
  allocatedStorage: z.number(),
});

const DynamoDBTableSchema = z.object({
  tableName: z.string(),
  tableStatus: z.string(),
  billingMode: z.string(),
  readCapacityUnits: z.number().nullable(),
  writeCapacityUnits: z.number().nullable(),
  itemCount: z.number(),
  tableSizeBytes: z.number(),
});

const LambdaFunctionSchema = z.object({
  functionName: z.string(),
  runtime: z.string().nullable(),
  memorySize: z.number(),
  timeout: z.number(),
  codeSize: z.number(),
  lastModified: z.string(),
  architecture: z.string(),
});

const S3BucketSchema = z.object({
  bucketName: z.string(),
  creationDate: z.string().nullable(),
});

const EBSVolumeSchema = z.object({
  volumeId: z.string(),
  volumeType: z.string(),
  size: z.number(),
  state: z.string(),
  availabilityZone: z.string(),
  encrypted: z.boolean(),
  attachments: z.array(z.object({
    instanceId: z.string(),
    device: z.string(),
    state: z.string(),
  })),
  isAttached: z.boolean(),
  createTime: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
});

const InventoryResultSchema = z.object({
  region: z.string(),
  resourceType: z.string(),
  resources: z.union([
    z.array(z.unknown()),
    z.record(z.string(), z.array(z.unknown())),
  ]),
  count: z.number(),
  fetchedAt: z.string(),
});

// =============================================================================
// Inventory Scan — Cross-type discovery
// =============================================================================

/** Known mapping of AWS resource types to swamp model types. */
const RESOURCE_TYPE_TO_SWAMP: Readonly<Record<string, string>> = Object.freeze({
  "AWS::EC2::VPC": "@swamp/aws/ec2/vpc",
  "AWS::EC2::Subnet": "@swamp/aws/ec2/subnet",
  "AWS::EC2::InternetGateway": "@swamp/aws/ec2/internet-gateway",
  "AWS::EC2::RouteTable": "@swamp/aws/ec2/route-table",
  "AWS::EC2::SecurityGroup": "@swamp/aws/ec2/security-group",
  "AWS::EC2::NatGateway": "@swamp/aws/ec2/nat-gateway",
  "AWS::EC2::EIP": "@swamp/aws/ec2/eip",
  "AWS::EC2::Instance": "@swamp/aws/ec2/instance",
  "AWS::RDS::DBCluster": "@swamp/aws/rds/dbcluster",
  "AWS::RDS::DBInstance": "@swamp/aws/rds/dbinstance",
  "AWS::RDS::DBSubnetGroup": "@swamp/aws/rds/dbsubnet-group",
  "AWS::SecretsManager::Secret": "@swamp/aws/secretsmanager/secret",
  "AWS::S3::Bucket": "@swamp/aws/s3/bucket",
  "AWS::Lambda::Function": "@swamp/aws/lambda/function",
  "AWS::IAM::Role": "@swamp/aws/iam/role",
  "AWS::CloudFormation::Stack": "@swamp/aws/cloudformation/stack",
});

/**
 * Case-insensitive lookup index for RESOURCE_TYPE_TO_SWAMP.
 * Tag API and other sources may produce types with non-standard casing
 * (e.g., "AWS::Ec2::Instance" instead of "AWS::EC2::Instance").
 */
const RESOURCE_TYPE_LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.entries(RESOURCE_TYPE_TO_SWAMP).map(([k, v]) => [k.toLowerCase(), v]),
);

/** Look up a swamp type for a resource type (case-insensitive). */
function lookupSwampType(resourceType: string): string | undefined {
  return RESOURCE_TYPE_TO_SWAMP[resourceType] ??
    RESOURCE_TYPE_LOOKUP.get(resourceType.toLowerCase());
}

/**
 * Normalize a Resource Explorer 2 type (e.g., "ec2:subnet") to CFN format
 * (e.g., "AWS::EC2::Subnet"). RE2 uses lowercase "service:resource" while
 * CFN uses "AWS::Service::Resource" with mixed casing. Some RE2 service
 * names differ from CFN (e.g., "elasticfilesystem" vs "EFS").
 */
const RE2_SERVICE_TO_CFN: Readonly<Record<string, string>> = Object.freeze({
  "elasticfilesystem": "EFS",
  "elasticloadbalancing": "ElasticLoadBalancingV2",
  "elasticloadbalancingv2": "ElasticLoadBalancingV2",
  "elasticache": "ElastiCache",
  "elasticsearch": "Elasticsearch",
  "iam": "IAM",
  "kms": "KMS",
  "rds": "RDS",
  "ec2": "EC2",
  "s3": "S3",
  "sns": "SNS",
  "sqs": "SQS",
  "ecs": "ECS",
  "eks": "EKS",
  "ecr": "ECR",
  "ssm": "SSM",
  "wafv2": "WAFv2",
});

function normalizeRE2Type(re2Type: string): string {
  const [service, resource] = re2Type.split(":");
  if (!service || !resource) return re2Type;
  const capitalize = (s: string) =>
    s.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const cfnService = RE2_SERVICE_TO_CFN[service] ?? capitalize(service);
  return `AWS::${cfnService}::${capitalize(resource)}`;
}

/** A discovered resource from any source (normalized shape). */
const ScannedResourceSchema = z.object({
  arn: z.string(),
  resourceType: z.string(),
  region: z.string(),
  accountId: z.string(),
  tags: z.record(z.string(), z.string()),
});

/** Hint for an unmodeled resource type. */
const UnmodeledTypeHintSchema = z.object({
  resourceType: z.string(),
  count: z.number(),
  sampleArns: z.array(z.string()),
  recommendation: z.enum([
    "use-upstream",
    "extend-existing",
    "build-extension",
  ]),
  hint: z.string(),
});

/** Full scan output schema. */
const ScanResultSchema = z.object({
  source: z.enum(["resource-explorer", "config", "tag-api"]),
  sourceNote: z.string(),
  coverage: z.enum(["full", "config-tracked", "tagged-only"]),
  region: z.string(),
  fetchedAt: z.string(),
  resources: z.array(ScannedResourceSchema),
  summary: z.object({
    total: z.number(),
    byType: z.record(z.string(), z.number()),
    byRegion: z.record(z.string(), z.number()),
    modelableCount: z.number(),
    unmodeledCount: z.number(),
  }),
  unmodeledTypes: z.array(UnmodeledTypeHintSchema),
  truncated: z.boolean(),
});

/** Diff output comparing two scans. */
const ScanDiffSchema = z.object({
  currentScanFetchedAt: z.string(),
  previousScanFetchedAt: z.string(),
  newResources: z.array(ScannedResourceSchema),
  removedResources: z.array(ScannedResourceSchema),
  summary: z.object({
    newCount: z.number(),
    removedCount: z.number(),
    newByType: z.record(z.string(), z.number()),
    removedByType: z.record(z.string(), z.number()),
  }),
  noBaseline: z.boolean(),
  sourceMismatch: z.boolean(),
  truncated: z.boolean(),
});

const MAX_SCAN_PAGES = 20;

/** Parse an ARN to extract region and account ID. */
function parseArn(arn: string): { region: string; accountId: string } {
  const parts = arn.split(":");
  return { region: parts[3] ?? "", accountId: parts[4] ?? "" };
}

/**
 * Determine the recommendation for an unmodeled resource type based on
 * whether a related swamp extension exists in the type map.
 */
function classifyUnmodeledType(
  resourceType: string,
): {
  recommendation: "use-upstream" | "extend-existing" | "build-extension";
  hint: string;
} {
  // Check if the exact type is in our map (shouldn't be if we're here, but defensive)
  const swampType = lookupSwampType(resourceType);
  if (swampType) {
    return {
      recommendation: "use-upstream",
      hint: `Type available at ${swampType}`,
    };
  }
  // Check if the service namespace has any entries in the map
  const parts = resourceType.split("::");
  const serviceNs = parts.length >= 2 ? `${parts[0]}::${parts[1]}` : "";
  const serviceNsLower = serviceNs.toLowerCase();
  const hasRelated = Object.keys(RESOURCE_TYPE_TO_SWAMP).some(
    (k) => k.toLowerCase().startsWith(serviceNsLower + "::"),
  );
  if (hasRelated) {
    return {
      recommendation: "extend-existing",
      hint: `Extension for ${serviceNs} exists but lacks ${
        parts[2] ?? resourceType
      }. Consider extending.`,
    };
  }
  return {
    recommendation: "build-extension",
    hint: serviceNs
      ? `No swamp extension covers ${serviceNs}. Consider building @webframp/aws/${
        (parts[1] ?? "unknown").toLowerCase()
      }.`
      : `Unknown resource type format: ${resourceType}`,
  };
}

/** Try Resource Explorer 2 search. Returns null if not available. */
async function tryResourceExplorer(
  region: string,
): Promise<
  | { resources: z.infer<typeof ScannedResourceSchema>[]; truncated: boolean }
  | null
> {
  const client = new ResourceExplorer2Client({ region });
  try {
    const resources: z.infer<typeof ScannedResourceSchema>[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const resp = await client.send(
        new RESearchCommand({
          QueryString: "*",
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      for (const r of resp.Resources ?? []) {
        if (!r.Arn || !r.ResourceType) continue;
        const { region: rRegion, accountId } = parseArn(r.Arn);
        const resourceType = normalizeRE2Type(r.ResourceType);
        const tags: Record<string, string> = {};
        for (const prop of r.Properties ?? []) {
          if (prop.Name === "tags" && prop.Data) {
            try {
              const parsed = JSON.parse(
                typeof prop.Data === "string"
                  ? prop.Data
                  : JSON.stringify(prop.Data),
              );
              if (Array.isArray(parsed)) {
                for (const t of parsed) {
                  if (t.Key && t.Value !== undefined) {
                    tags[t.Key] = String(t.Value);
                  }
                }
              } else if (typeof parsed === "object") {
                for (const [k, v] of Object.entries(parsed)) {
                  tags[k] = String(v);
                }
              }
            } catch { /* ignore unparseable tags */ }
          }
        }
        resources.push({
          arn: r.Arn,
          resourceType,
          region: rRegion || region,
          accountId,
          tags,
        });
      }
      nextToken = resp.NextToken;
      pages++;
    } while (nextToken && pages < MAX_SCAN_PAGES);

    if (nextToken) truncated = true;
    return { resources, truncated };
  } catch {
    return null;
  } finally {
    client.destroy();
  }
}

/** Try AWS Config select. Returns null if not available. */
async function tryConfig(
  region: string,
): Promise<
  | { resources: z.infer<typeof ScannedResourceSchema>[]; truncated: boolean }
  | null
> {
  const client = new ConfigServiceClient({ region });
  try {
    const resources: z.infer<typeof ScannedResourceSchema>[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const resp = await client.send(
        new SelectResourceConfigCommand({
          Expression:
            "SELECT arn, resourceType, awsRegion, accountId, tags WHERE resourceType LIKE 'AWS::%'",
          NextToken: nextToken,
        }),
      );
      for (const item of resp.Results ?? []) {
        try {
          const parsed = JSON.parse(item);
          if (!parsed.arn || !parsed.resourceType) continue;
          const tags: Record<string, string> = {};
          if (parsed.tags && typeof parsed.tags === "object") {
            for (const [k, v] of Object.entries(parsed.tags)) {
              tags[k] = String(v);
            }
          }
          resources.push({
            arn: parsed.arn,
            resourceType: parsed.resourceType,
            region: parsed.awsRegion ?? region,
            accountId: parsed.accountId ?? parseArn(parsed.arn).accountId,
            tags,
          });
        } catch { /* skip unparseable results */ }
      }
      nextToken = resp.NextToken;
      pages++;
    } while (nextToken && pages < MAX_SCAN_PAGES);

    if (nextToken) truncated = true;
    return { resources, truncated };
  } catch {
    return null;
  } finally {
    client.destroy();
  }
}

/** Try Resource Groups Tagging API. Always available but only sees tagged resources. */
async function tryTagApi(
  region: string,
): Promise<
  { resources: z.infer<typeof ScannedResourceSchema>[]; truncated: boolean }
> {
  const client = new ResourceGroupsTaggingAPIClient({ region });
  try {
    const resources: z.infer<typeof ScannedResourceSchema>[] = [];
    let paginationToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const resp = await client.send(
        new GetResourcesCommand({
          PaginationToken: paginationToken,
        }),
      );
      for (const r of resp.ResourceTagMappingList ?? []) {
        if (!r.ResourceARN) continue;
        const { region: rRegion, accountId } = parseArn(r.ResourceARN);
        const tags: Record<string, string> = {};
        for (const t of r.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? "";
        }
        // Derive resource type from the ARN. Some services (S3, SNS, SQS)
        // have non-standard ARN formats where the resource segment is the
        // resource name, not the resource type. Override those explicitly.
        const arnParts = r.ResourceARN.split(":");
        const service = (arnParts[2] ?? "").toLowerCase();
        const ARN_SERVICE_OVERRIDE: Record<string, string> = {
          s3: "AWS::S3::Bucket",
          sns: "AWS::SNS::Topic",
          sqs: "AWS::SQS::Queue",
          execute_api: "AWS::ApiGateway::RestApi",
        };
        let resourceType: string;
        if (ARN_SERVICE_OVERRIDE[service]) {
          resourceType = ARN_SERVICE_OVERRIDE[service];
        } else {
          const resourceSegment = arnParts.slice(5).join(":");
          const resourcePart = resourceSegment.split(/[/:]/)[0] || service;
          const cfnService = RE2_SERVICE_TO_CFN[service] ??
            (service.charAt(0).toUpperCase() + service.slice(1));
          const resCapitalized = resourcePart.charAt(0).toUpperCase() +
            resourcePart.slice(1);
          resourceType = `AWS::${cfnService}::${resCapitalized}`;
        }
        resources.push({
          arn: r.ResourceARN,
          resourceType,
          region: rRegion || region,
          accountId,
          tags,
        });
      }
      paginationToken = resp.PaginationToken;
      pages++;
    } while (paginationToken && pages < MAX_SCAN_PAGES);

    if (paginationToken) truncated = true;
    return { resources, truncated };
  } catch (e) {
    // Tag API should always be available, but handle gracefully
    throw new Error(
      `Tag API failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    client.destroy();
  }
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * AWS inventory model definition.
 *
 * Provides methods to list EC2 instances, RDS databases, DynamoDB tables,
 * Lambda functions, S3 buckets, and EBS volumes. Results are persisted as
 * typed inventory resources with a one-hour lifetime.
 */
export const model = {
  type: "@webframp/aws/inventory",
  version: "2026.05.29.1",
  upgrades: [
    {
      fromVersion: "2026.03.30.1",
      toVersion: "2026.05.29.1",
      description:
        "Add inventory_scan and inventory_diff methods with scan/scanDiff resource specs. No schema changes to existing inventory spec.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,

  resources: {
    inventory: {
      description: "Inventory of AWS resources",
      schema: InventoryResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    scan: {
      description:
        "Cross-type inventory scan from Resource Explorer, Config, or Tag API",
      schema: ScanResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    scanDiff: {
      description:
        "Diff between two inventory scans showing new and removed resources",
      schema: ScanDiffSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_ec2: {
      description: "List running EC2 instances",
      arguments: z.object({
        stateFilter: z
          .array(z.string())
          .default(["running"])
          .describe("Instance states to include (e.g., running, stopped)"),
      }),
      execute: async (
        args: { stateFilter: string[] },
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
        const client = new EC2Client({ region: context.globalArgs.region });
        try {
          const instances: z.infer<typeof EC2InstanceSchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const command = new DescribeInstancesCommand({
              Filters: [
                {
                  Name: "instance-state-name",
                  Values: args.stateFilter,
                },
              ],
              NextToken: nextToken,
            });
            const response = await client.send(command);

            if (response.Reservations) {
              for (const reservation of response.Reservations) {
                if (reservation.Instances) {
                  for (const instance of reservation.Instances) {
                    if (instance.InstanceId && instance.InstanceType) {
                      const tags: Record<string, string> = {};
                      if (instance.Tags) {
                        for (const tag of instance.Tags) {
                          if (tag.Key && tag.Value) {
                            tags[tag.Key] = tag.Value;
                          }
                        }
                      }
                      instances.push({
                        instanceId: instance.InstanceId,
                        instanceType: instance.InstanceType,
                        state: instance.State?.Name || "unknown",
                        availabilityZone:
                          instance.Placement?.AvailabilityZone ||
                          "unknown",
                        platform: instance.Platform || null,
                        tags,
                        launchTime: instance.LaunchTime?.toISOString() || null,
                      });
                    }
                  }
                }
              }
            }
            nextToken = response.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "inventory",
            `ec2-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "ec2",
              resources: instances,
              count: instances.length,
              truncated: nextToken !== undefined,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Found {count} EC2 instances in {region}", {
            count: instances.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_rds: {
      description: "List RDS database instances",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
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
        const client = new RDSClient({ region: context.globalArgs.region });
        try {
          const instances: z.infer<typeof RDSInstanceSchema>[] = [];
          let marker: string | undefined;
          let pages = 0;

          do {
            const command = new DescribeDBInstancesCommand({
              Marker: marker,
            });
            const response = await client.send(command);

            if (response.DBInstances) {
              for (const db of response.DBInstances) {
                if (db.DBInstanceIdentifier && db.DBInstanceClass) {
                  instances.push({
                    dbInstanceId: db.DBInstanceIdentifier,
                    dbInstanceClass: db.DBInstanceClass,
                    engine: db.Engine || "unknown",
                    engineVersion: db.EngineVersion || "unknown",
                    status: db.DBInstanceStatus || "unknown",
                    availabilityZone: db.AvailabilityZone || null,
                    multiAz: db.MultiAZ || false,
                    storageType: db.StorageType || "standard",
                    allocatedStorage: db.AllocatedStorage || 0,
                  });
                }
              }
            }
            marker = response.Marker;
            pages++;
          } while (marker && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "inventory",
            `rds-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "rds",
              resources: instances,
              count: instances.length,
              truncated: marker !== undefined,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Found {count} RDS instances in {region}", {
            count: instances.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_dynamodb: {
      description: "List DynamoDB tables with capacity details",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
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
        const client = new DynamoDBClient({
          region: context.globalArgs.region,
        });
        try {
          const tables: z.infer<typeof DynamoDBTableSchema>[] = [];
          let lastEvaluatedTableName: string | undefined;

          // First, list all table names
          const tableNames: string[] = [];
          let pages = 0;
          do {
            const listCommand = new ListTablesCommand({
              ExclusiveStartTableName: lastEvaluatedTableName,
            });
            const listResponse = await client.send(listCommand);

            if (listResponse.TableNames) {
              tableNames.push(...listResponse.TableNames);
            }
            lastEvaluatedTableName = listResponse.LastEvaluatedTableName;
            pages++;
          } while (lastEvaluatedTableName && pages < MAX_PAGES);

          // Then describe each table for details
          for (const tableName of tableNames) {
            const describeCommand = new DescribeTableCommand({
              TableName: tableName,
            });
            const describeResponse = await client.send(describeCommand);
            const table = describeResponse.Table;

            if (table) {
              tables.push({
                tableName: table.TableName || tableName,
                tableStatus: table.TableStatus || "unknown",
                billingMode: table.BillingModeSummary?.BillingMode ||
                  "PROVISIONED",
                readCapacityUnits:
                  table.ProvisionedThroughput?.ReadCapacityUnits || null,
                writeCapacityUnits:
                  table.ProvisionedThroughput?.WriteCapacityUnits || null,
                itemCount: Number(table.ItemCount) || 0,
                tableSizeBytes: Number(table.TableSizeBytes) || 0,
              });
            }
          }

          const handle = await context.writeResource(
            "inventory",
            `dynamodb-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "dynamodb",
              resources: tables,
              count: tables.length,
              truncated: lastEvaluatedTableName !== undefined,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Found {count} DynamoDB tables in {region}", {
            count: tables.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_lambda: {
      description: "List Lambda functions",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
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
        const client = new LambdaClient({ region: context.globalArgs.region });
        try {
          const functions: z.infer<typeof LambdaFunctionSchema>[] = [];
          let marker: string | undefined;
          let pages = 0;

          do {
            const command = new ListFunctionsCommand({
              Marker: marker,
            });
            const response = await client.send(command);

            if (response.Functions) {
              for (const fn of response.Functions) {
                if (fn.FunctionName) {
                  functions.push({
                    functionName: fn.FunctionName,
                    runtime: fn.Runtime || null,
                    memorySize: fn.MemorySize || 128,
                    timeout: fn.Timeout || 3,
                    codeSize: fn.CodeSize || 0,
                    lastModified: fn.LastModified || "",
                    architecture: fn.Architectures?.[0] || "x86_64",
                  });
                }
              }
            }
            marker = response.NextMarker;
            pages++;
          } while (marker && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "inventory",
            `lambda-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "lambda",
              resources: functions,
              count: functions.length,
              truncated: marker !== undefined,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Found {count} Lambda functions in {region}", {
            count: functions.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_s3: {
      description: "List S3 buckets (global, ignores region)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
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
        const client = new S3Client({ region: context.globalArgs.region });
        try {
          const buckets: z.infer<typeof S3BucketSchema>[] = [];

          const command = new ListBucketsCommand({});
          const response = await client.send(command);

          if (response.Buckets) {
            for (const bucket of response.Buckets) {
              if (bucket.Name) {
                buckets.push({
                  bucketName: bucket.Name,
                  creationDate: bucket.CreationDate?.toISOString() || null,
                });
              }
            }
          }

          const handle = await context.writeResource("inventory", "s3-global", {
            region: "global",
            resourceType: "s3",
            resources: buckets,
            count: buckets.length,
            fetchedAt: new Date().toISOString(),
          });

          context.logger.info("Found {count} S3 buckets", {
            count: buckets.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_ebs: {
      description: "List EBS volumes with attachment status",
      arguments: z.object({
        stateFilter: z
          .array(z.string())
          .default(["available", "in-use"])
          .describe("Volume states to include"),
      }),
      execute: async (
        args: { stateFilter: string[] },
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
        const client = new EC2Client({ region: context.globalArgs.region });
        try {
          const volumes: z.infer<typeof EBSVolumeSchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const command = new DescribeVolumesCommand({
              Filters: [
                {
                  Name: "status",
                  Values: args.stateFilter,
                },
              ],
              NextToken: nextToken,
            });
            const response = await client.send(command);

            if (response.Volumes) {
              for (const vol of response.Volumes) {
                if (vol.VolumeId) {
                  const tags: Record<string, string> = {};
                  if (vol.Tags) {
                    for (const tag of vol.Tags) {
                      if (tag.Key && tag.Value) {
                        tags[tag.Key] = tag.Value;
                      }
                    }
                  }
                  const attachments = (vol.Attachments || [])
                    .filter((a) => a.InstanceId && a.Device && a.State)
                    .map((a) => ({
                      instanceId: a.InstanceId!,
                      device: a.Device!,
                      state: a.State!,
                    }));
                  volumes.push({
                    volumeId: vol.VolumeId,
                    volumeType: vol.VolumeType || "unknown",
                    size: vol.Size || 0,
                    state: vol.State || "unknown",
                    availabilityZone: vol.AvailabilityZone || "unknown",
                    encrypted: vol.Encrypted || false,
                    attachments,
                    isAttached: attachments.length > 0,
                    createTime: vol.CreateTime?.toISOString() || null,
                    tags,
                  });
                }
              }
            }
            nextToken = response.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "inventory",
            `ebs-${context.globalArgs.region}`,
            {
              region: context.globalArgs.region,
              resourceType: "ebs",
              resources: volumes,
              count: volumes.length,
              truncated: nextToken !== undefined,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Found {count} EBS volumes in {region}", {
            count: volumes.length,
            region: context.globalArgs.region,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    inventory_all: {
      description: "Run full inventory across all supported resource types",
      arguments: z.object({
        includeS3: z
          .boolean()
          .default(true)
          .describe("Include S3 buckets (global)"),
        includeStoppedEc2: z
          .boolean()
          .default(false)
          .describe("Include stopped EC2 instances"),
        includeEbs: z
          .boolean()
          .default(false)
          .describe("Include EBS volumes"),
      }),
      execute: async (
        args: {
          includeS3: boolean;
          includeStoppedEc2: boolean;
          includeEbs: boolean;
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
        const region = context.globalArgs.region;
        const ec2Client = new EC2Client({ region });
        const rdsClient = new RDSClient({ region });
        const ddbClient = new DynamoDBClient({ region });
        const lambdaClient = new LambdaClient({ region });
        let s3Client: S3Client | undefined;

        try {
          const summary: Record<string, number> = {};
          const handles: { name: string }[] = [];

          // EC2
          const ec2Instances: z.infer<typeof EC2InstanceSchema>[] = [];
          let ec2Token: string | undefined;
          let ec2Pages = 0;
          const ec2States = args.includeStoppedEc2
            ? ["running", "stopped"]
            : ["running"];
          do {
            const cmd = new DescribeInstancesCommand({
              Filters: [{ Name: "instance-state-name", Values: ec2States }],
              NextToken: ec2Token,
            });
            const resp = await ec2Client.send(cmd);
            if (resp.Reservations) {
              for (const res of resp.Reservations) {
                for (const inst of res.Instances || []) {
                  if (inst.InstanceId && inst.InstanceType) {
                    const tags: Record<string, string> = {};
                    for (const t of inst.Tags || []) {
                      if (t.Key && t.Value) tags[t.Key] = t.Value;
                    }
                    ec2Instances.push({
                      instanceId: inst.InstanceId,
                      instanceType: inst.InstanceType,
                      state: inst.State?.Name || "unknown",
                      availabilityZone: inst.Placement?.AvailabilityZone ||
                        "unknown",
                      platform: inst.Platform || null,
                      tags,
                      launchTime: inst.LaunchTime?.toISOString() || null,
                    });
                  }
                }
              }
            }
            ec2Token = resp.NextToken;
            ec2Pages++;
          } while (ec2Token && ec2Pages < MAX_PAGES);
          summary.ec2 = ec2Instances.length;

          // RDS
          const rdsInstances: z.infer<typeof RDSInstanceSchema>[] = [];
          let rdsMarker: string | undefined;
          let rdsPages = 0;
          do {
            const cmd = new DescribeDBInstancesCommand({ Marker: rdsMarker });
            const resp = await rdsClient.send(cmd);
            for (const db of resp.DBInstances || []) {
              if (db.DBInstanceIdentifier && db.DBInstanceClass) {
                rdsInstances.push({
                  dbInstanceId: db.DBInstanceIdentifier,
                  dbInstanceClass: db.DBInstanceClass,
                  engine: db.Engine || "unknown",
                  engineVersion: db.EngineVersion || "unknown",
                  status: db.DBInstanceStatus || "unknown",
                  availabilityZone: db.AvailabilityZone || null,
                  multiAz: db.MultiAZ || false,
                  storageType: db.StorageType || "standard",
                  allocatedStorage: db.AllocatedStorage || 0,
                });
              }
            }
            rdsMarker = resp.Marker;
            rdsPages++;
          } while (rdsMarker && rdsPages < MAX_PAGES);
          summary.rds = rdsInstances.length;

          // DynamoDB
          const ddbTables: z.infer<typeof DynamoDBTableSchema>[] = [];
          const tableNames: string[] = [];
          let lastTable: string | undefined;
          let ddbPages = 0;
          do {
            const listCmd = new ListTablesCommand({
              ExclusiveStartTableName: lastTable,
            });
            const listResp = await ddbClient.send(listCmd);
            tableNames.push(...(listResp.TableNames || []));
            lastTable = listResp.LastEvaluatedTableName;
            ddbPages++;
          } while (lastTable && ddbPages < MAX_PAGES);
          for (const tName of tableNames) {
            const descCmd = new DescribeTableCommand({ TableName: tName });
            const descResp = await ddbClient.send(descCmd);
            const t = descResp.Table;
            if (t) {
              ddbTables.push({
                tableName: t.TableName || tName,
                tableStatus: t.TableStatus || "unknown",
                billingMode: t.BillingModeSummary?.BillingMode || "PROVISIONED",
                readCapacityUnits: t.ProvisionedThroughput?.ReadCapacityUnits ||
                  null,
                writeCapacityUnits:
                  t.ProvisionedThroughput?.WriteCapacityUnits ||
                  null,
                itemCount: Number(t.ItemCount) || 0,
                tableSizeBytes: Number(t.TableSizeBytes) || 0,
              });
            }
          }
          summary.dynamodb = ddbTables.length;

          // Lambda
          const lambdaFns: z.infer<typeof LambdaFunctionSchema>[] = [];
          let lambdaMarker: string | undefined;
          let lambdaPages = 0;
          do {
            const cmd = new ListFunctionsCommand({ Marker: lambdaMarker });
            const resp = await lambdaClient.send(cmd);
            for (const fn of resp.Functions || []) {
              if (fn.FunctionName) {
                lambdaFns.push({
                  functionName: fn.FunctionName,
                  runtime: fn.Runtime || null,
                  memorySize: fn.MemorySize || 128,
                  timeout: fn.Timeout || 3,
                  codeSize: fn.CodeSize || 0,
                  lastModified: fn.LastModified || "",
                  architecture: fn.Architectures?.[0] || "x86_64",
                });
              }
            }
            lambdaMarker = resp.NextMarker;
            lambdaPages++;
          } while (lambdaMarker && lambdaPages < MAX_PAGES);
          summary.lambda = lambdaFns.length;

          // S3 (optional)
          const s3Buckets: z.infer<typeof S3BucketSchema>[] = [];
          if (args.includeS3) {
            s3Client = new S3Client({ region });
            const s3Resp = await s3Client.send(new ListBucketsCommand({}));
            for (const b of s3Resp.Buckets || []) {
              if (b.Name) {
                s3Buckets.push({
                  bucketName: b.Name,
                  creationDate: b.CreationDate?.toISOString() || null,
                });
              }
            }
            summary.s3 = s3Buckets.length;
          }

          // EBS (optional)
          const ebsVolumes: z.infer<typeof EBSVolumeSchema>[] = [];
          if (args.includeEbs) {
            let ebsToken: string | undefined;
            let ebsPages = 0;
            do {
              const cmd = new DescribeVolumesCommand({
                NextToken: ebsToken,
              });
              const resp = await ec2Client.send(cmd);
              for (const vol of resp.Volumes || []) {
                if (vol.VolumeId) {
                  const tags: Record<string, string> = {};
                  for (const t of vol.Tags || []) {
                    if (t.Key && t.Value) tags[t.Key] = t.Value;
                  }
                  const attachments = (vol.Attachments || [])
                    .filter((a) => a.InstanceId && a.Device && a.State)
                    .map((a) => ({
                      instanceId: a.InstanceId!,
                      device: a.Device!,
                      state: a.State!,
                    }));
                  ebsVolumes.push({
                    volumeId: vol.VolumeId,
                    volumeType: vol.VolumeType || "unknown",
                    size: vol.Size || 0,
                    state: vol.State || "unknown",
                    availabilityZone: vol.AvailabilityZone || "unknown",
                    encrypted: vol.Encrypted || false,
                    attachments,
                    isAttached: attachments.length > 0,
                    createTime: vol.CreateTime?.toISOString() || null,
                    tags,
                  });
                }
              }
              ebsToken = resp.NextToken;
              ebsPages++;
            } while (ebsToken && ebsPages < MAX_PAGES);
            summary.ebs = ebsVolumes.length;
          }

          // Write combined inventory
          const handle = await context.writeResource(
            "inventory",
            `all-${region}`,
            {
              region,
              resourceType: "all",
              resources: {
                ec2: ec2Instances,
                rds: rdsInstances,
                dynamodb: ddbTables,
                lambda: lambdaFns,
                ...(args.includeS3 ? { s3: s3Buckets } : {}),
                ...(args.includeEbs ? { ebs: ebsVolumes } : {}),
              },
              count: Object.values(summary).reduce((a, b) => a + b, 0),
              fetchedAt: new Date().toISOString(),
            },
          );
          handles.push(handle);

          context.logger.info(
            "Full inventory complete for {region}: {summary}",
            { region, summary: JSON.stringify(summary) },
          );
          return { dataHandles: handles };
        } finally {
          ec2Client.destroy();
          rdsClient.destroy();
          ddbClient.destroy();
          lambdaClient.destroy();
          s3Client?.destroy();
        }
      },
    },

    inventory_scan: {
      description:
        "Discover all resources across all types using Resource Explorer, Config, or Tag API (cascading fallback)",
      arguments: z.object({
        source: z.enum(["auto", "resource-explorer", "config", "tag-api"])
          .default("auto")
          .describe(
            "Data source to use. 'auto' tries Resource Explorer → Config → Tag API",
          ),
      }),
      execute: async (
        args: { source: string },
        context: {
          globalArgs: { region: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn?: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const region = context.globalArgs.region;
        let resources: z.infer<typeof ScannedResourceSchema>[] = [];
        let source: "resource-explorer" | "config" | "tag-api";
        let sourceNote: string;
        let coverage: "full" | "config-tracked" | "tagged-only";
        let truncated = false;

        if (args.source === "resource-explorer" || args.source === "auto") {
          const result = await tryResourceExplorer(region);
          if (result) {
            resources = result.resources;
            truncated = result.truncated;
            source = "resource-explorer";
            sourceNote = `Resource Explorer 2 index queried in ${region}`;
            coverage = "full";
          } else if (args.source === "resource-explorer") {
            throw new Error(
              "Resource Explorer 2 not available in this region/account. " +
                "Use source='auto' to fall back to Config or Tag API.",
            );
          } else {
            // Fall through to Config
            const configResult = await tryConfig(region);
            if (configResult) {
              resources = configResult.resources;
              truncated = configResult.truncated;
              source = "config";
              sourceNote =
                `AWS Config queried in ${region} (Resource Explorer not available)`;
              coverage = "config-tracked";
            } else {
              // Fall through to Tag API
              const tagResult = await tryTagApi(region);
              resources = tagResult.resources;
              truncated = tagResult.truncated;
              source = "tag-api";
              sourceNote =
                `Tag API in ${region} (Resource Explorer and Config not available). Only tagged resources visible.`;
              coverage = "tagged-only";
            }
          }
        } else if (args.source === "config") {
          const result = await tryConfig(region);
          if (!result) {
            throw new Error(
              "AWS Config not available in this region/account. " +
                "Use source='auto' to fall back to Tag API.",
            );
          }
          resources = result.resources;
          truncated = result.truncated;
          source = "config";
          sourceNote = `AWS Config queried in ${region}`;
          coverage = "config-tracked";
        } else {
          const result = await tryTagApi(region);
          resources = result.resources;
          truncated = result.truncated;
          source = "tag-api";
          sourceNote = `Tag API in ${region}. Only tagged resources visible.`;
          coverage = "tagged-only";
        }

        // Build summary
        const byType: Record<string, number> = {};
        const byRegion: Record<string, number> = {};
        for (const r of resources) {
          byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
          byRegion[r.region] = (byRegion[r.region] ?? 0) + 1;
        }

        let modelableCount = 0;
        let unmodeledCount = 0;
        const unmodeledMap: Record<
          string,
          z.infer<typeof ScannedResourceSchema>[]
        > = {};

        for (const r of resources) {
          if (lookupSwampType(r.resourceType)) {
            modelableCount++;
          } else {
            unmodeledCount++;
            if (!unmodeledMap[r.resourceType]) {
              unmodeledMap[r.resourceType] = [];
            }
            if (unmodeledMap[r.resourceType].length < 3) {
              unmodeledMap[r.resourceType].push(r);
            }
          }
        }

        // Build unmodeled type hints
        const unmodeledTypes: z.infer<typeof UnmodeledTypeHintSchema>[] = [];
        for (const [resType, samples] of Object.entries(unmodeledMap)) {
          const count = byType[resType] ?? 0;
          const { recommendation, hint } = classifyUnmodeledType(resType);
          unmodeledTypes.push({
            resourceType: resType,
            count,
            sampleArns: samples.map((s) => s.arn),
            recommendation,
            hint,
          });
        }
        // Sort by count descending so highest-impact types are first
        unmodeledTypes.sort((a, b) => b.count - a.count);

        const handle = await context.writeResource("scan", "result", {
          source,
          sourceNote,
          coverage,
          region,
          fetchedAt: new Date().toISOString(),
          resources,
          summary: {
            total: resources.length,
            byType,
            byRegion,
            modelableCount,
            unmodeledCount,
          },
          unmodeledTypes,
          truncated,
        });

        context.logger.info(
          "Inventory scan complete: {total} resources via {source} ({coverage})",
          { total: resources.length, source, coverage, region },
        );

        return { dataHandles: [handle] };
      },
    },

    inventory_diff: {
      description:
        "Compare current inventory scan against previous scan to detect new and removed resources. Suppresses output when the source changes between runs to prevent false positives from coverage differences.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { region: string };
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
        },
      ) => {
        const region = context.globalArgs.region;

        // Read previous scan (from last inventory_scan or last diff baseline)
        let previousResources: z.infer<typeof ScannedResourceSchema>[] = [];
        let previousFetchedAt = "";
        let previousSource = "";
        if (context.readResource) {
          try {
            // Try diff-baseline first (written by previous inventory_diff),
            // then fall back to scan result (written by inventory_scan).
            let prev = await context.readResource("diff-baseline");
            if (!prev || !Array.isArray(prev.resources)) {
              prev = await context.readResource("result");
            }
            if (prev && Array.isArray(prev.resources)) {
              previousResources = prev.resources as z.infer<
                typeof ScannedResourceSchema
              >[];
              previousFetchedAt = (prev.fetchedAt as string) ?? "";
              previousSource = (prev.source as string) ?? "";
            }
          } catch (e) {
            if (context.logger.warn) {
              context.logger.warn(
                "Failed to read previous scan baseline: {error}",
                { error: (e as Error).message },
              );
            }
          }
        }

        // Run current scan using auto cascade (best available source)
        let currentResources: z.infer<typeof ScannedResourceSchema>[] = [];
        let truncated = false;
        let currentSource = "";

        const re2Result = await tryResourceExplorer(region);
        if (re2Result) {
          currentResources = re2Result.resources;
          truncated = re2Result.truncated;
          currentSource = "resource-explorer";
        } else {
          const configResult = await tryConfig(region);
          if (configResult) {
            currentResources = configResult.resources;
            truncated = configResult.truncated;
            currentSource = "config";
          } else {
            const tagResult = await tryTagApi(region);
            currentResources = tagResult.resources;
            truncated = tagResult.truncated;
            currentSource = "tag-api";
          }
        }

        // Diff by ARN
        const previousArns = new Set(previousResources.map((r) => r.arn));
        const currentArns = new Set(currentResources.map((r) => r.arn));

        const newResources = currentResources.filter((r) =>
          !previousArns.has(r.arn)
        );
        const removedResources = previousResources.filter((r) =>
          !currentArns.has(r.arn)
        );

        // Suppress diff output if scan was truncated (prevents false
        // positives from pagination shifts) or if there's no baseline.
        const noBaseline = previousResources.length === 0 &&
          currentResources.length > 0;
        // Suppress when source degraded between runs (e.g., RE2 available
        // last run but fell back to Tag API this run — coverage difference
        // would produce massive false removed counts).
        const sourceMismatch = previousSource !== "" &&
          currentSource !== "" &&
          previousSource !== currentSource;
        const suppressDiff = truncated || noBaseline || sourceMismatch;

        const effectiveNew = suppressDiff ? [] : newResources;
        const effectiveRemoved = suppressDiff ? [] : removedResources;

        const newByType: Record<string, number> = {};
        for (const r of effectiveNew) {
          newByType[r.resourceType] = (newByType[r.resourceType] ?? 0) + 1;
        }
        const removedByType: Record<string, number> = {};
        for (const r of effectiveRemoved) {
          removedByType[r.resourceType] = (removedByType[r.resourceType] ?? 0) +
            1;
        }

        // Write diff result first, then update baseline. If the method
        // crashes between writes, the baseline stays stale (safe — next run
        // re-diffs against the old baseline rather than silently skipping).
        const diffHandle = await context.writeResource("scanDiff", "diff", {
          currentScanFetchedAt: new Date().toISOString(),
          previousScanFetchedAt: previousFetchedAt,
          newResources: effectiveNew,
          removedResources: effectiveRemoved,
          summary: {
            newCount: effectiveNew.length,
            removedCount: effectiveRemoved.length,
            newByType,
            removedByType,
          },
          noBaseline,
          sourceMismatch,
          truncated,
        });

        // Update baseline for next diff (separate from scan output)
        const baselineCoverage = currentSource === "resource-explorer"
          ? "full"
          : currentSource === "config"
          ? "config-tracked"
          : "tagged-only";
        await context.writeResource("scan", "diff-baseline", {
          source: currentSource,
          sourceNote:
            "Stored by inventory_diff as baseline for next comparison",
          coverage: baselineCoverage,
          region,
          fetchedAt: new Date().toISOString(),
          resources: currentResources,
          summary: {
            total: currentResources.length,
            byType: {},
            byRegion: {},
            modelableCount: 0,
            unmodeledCount: 0,
          },
          unmodeledTypes: [],
          truncated,
        });

        context.logger.info(
          "Inventory diff: {new} new, {removed} removed (suppressed: {suppressed})",
          {
            new: effectiveNew.length,
            removed: effectiveRemoved.length,
            suppressed: suppressDiff,
            region,
          },
        );

        return { dataHandles: [diffHandle] };
      },
    },
  },
};
