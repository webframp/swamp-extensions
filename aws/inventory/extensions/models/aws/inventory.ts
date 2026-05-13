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

import { z } from "npm:zod@4.3.6";
import {
  DescribeDBInstancesCommand,
  RDSClient,
} from "npm:@aws-sdk/client-rds@3.1010.0";
import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "npm:@aws-sdk/client-ec2@3.1010.0";
import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "npm:@aws-sdk/client-dynamodb@3.1010.0";
import {
  LambdaClient,
  ListFunctionsCommand,
} from "npm:@aws-sdk/client-lambda@3.1010.0";
import { ListBucketsCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1010.0";

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
  version: "2026.03.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    inventory: {
      description: "Inventory of AWS resources",
      schema: InventoryResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
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
        const instances: z.infer<typeof EC2InstanceSchema>[] = [];
        let nextToken: string | undefined;

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
                      availabilityZone: instance.Placement?.AvailabilityZone ||
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
        } while (nextToken);

        const handle = await context.writeResource(
          "inventory",
          `ec2-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "ec2",
            resources: instances,
            count: instances.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} EC2 instances in {region}", {
          count: instances.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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
        const instances: z.infer<typeof RDSInstanceSchema>[] = [];
        let marker: string | undefined;

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
        } while (marker);

        const handle = await context.writeResource(
          "inventory",
          `rds-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "rds",
            resources: instances,
            count: instances.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} RDS instances in {region}", {
          count: instances.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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
        const tables: z.infer<typeof DynamoDBTableSchema>[] = [];
        let lastEvaluatedTableName: string | undefined;

        // First, list all table names
        const tableNames: string[] = [];
        do {
          const listCommand = new ListTablesCommand({
            ExclusiveStartTableName: lastEvaluatedTableName,
          });
          const listResponse = await client.send(listCommand);

          if (listResponse.TableNames) {
            tableNames.push(...listResponse.TableNames);
          }
          lastEvaluatedTableName = listResponse.LastEvaluatedTableName;
        } while (lastEvaluatedTableName);

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
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} DynamoDB tables in {region}", {
          count: tables.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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
        const functions: z.infer<typeof LambdaFunctionSchema>[] = [];
        let marker: string | undefined;

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
        } while (marker);

        const handle = await context.writeResource(
          "inventory",
          `lambda-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "lambda",
            resources: functions,
            count: functions.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} Lambda functions in {region}", {
          count: functions.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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
        const volumes: z.infer<typeof EBSVolumeSchema>[] = [];
        let nextToken: string | undefined;

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
        } while (nextToken);

        const handle = await context.writeResource(
          "inventory",
          `ebs-${context.globalArgs.region}`,
          {
            region: context.globalArgs.region,
            resourceType: "ebs",
            resources: volumes,
            count: volumes.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} EBS volumes in {region}", {
          count: volumes.length,
          region: context.globalArgs.region,
        });
        return { dataHandles: [handle] };
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
        const summary: Record<string, number> = {};
        const handles: { name: string }[] = [];

        // EC2
        const ec2Client = new EC2Client({ region });
        const ec2Instances: z.infer<typeof EC2InstanceSchema>[] = [];
        let ec2Token: string | undefined;
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
        } while (ec2Token);
        summary.ec2 = ec2Instances.length;

        // RDS
        const rdsClient = new RDSClient({ region });
        const rdsInstances: z.infer<typeof RDSInstanceSchema>[] = [];
        let rdsMarker: string | undefined;
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
        } while (rdsMarker);
        summary.rds = rdsInstances.length;

        // DynamoDB
        const ddbClient = new DynamoDBClient({ region });
        const ddbTables: z.infer<typeof DynamoDBTableSchema>[] = [];
        const tableNames: string[] = [];
        let lastTable: string | undefined;
        do {
          const listCmd = new ListTablesCommand({
            ExclusiveStartTableName: lastTable,
          });
          const listResp = await ddbClient.send(listCmd);
          tableNames.push(...(listResp.TableNames || []));
          lastTable = listResp.LastEvaluatedTableName;
        } while (lastTable);
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
              writeCapacityUnits: t.ProvisionedThroughput?.WriteCapacityUnits ||
                null,
              itemCount: Number(t.ItemCount) || 0,
              tableSizeBytes: Number(t.TableSizeBytes) || 0,
            });
          }
        }
        summary.dynamodb = ddbTables.length;

        // Lambda
        const lambdaClient = new LambdaClient({ region });
        const lambdaFns: z.infer<typeof LambdaFunctionSchema>[] = [];
        let lambdaMarker: string | undefined;
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
        } while (lambdaMarker);
        summary.lambda = lambdaFns.length;

        // S3 (optional)
        const s3Buckets: z.infer<typeof S3BucketSchema>[] = [];
        if (args.includeS3) {
          const s3Client = new S3Client({ region });
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
          } while (ebsToken);
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
      },
    },
  },
};
