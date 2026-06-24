// AWS Inventory Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EC2Client } from "npm:@aws-sdk/client-ec2@3.1069.0";
import { RDSClient } from "npm:@aws-sdk/client-rds@3.1069.0";
import { DynamoDBClient } from "npm:@aws-sdk/client-dynamodb@3.1069.0";
import { LambdaClient } from "npm:@aws-sdk/client-lambda@3.1069.0";
import { S3Client } from "npm:@aws-sdk/client-s3@3.1069.0";
import { model } from "./inventory.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

function mockClients(overrides: {
  ec2?: (cmd: unknown) => unknown;
  rds?: (cmd: unknown) => unknown;
  dynamodb?: (cmd: unknown) => unknown;
  lambda?: (cmd: unknown) => unknown;
  s3?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    ec2: EC2Client.prototype.send,
    rds: RDSClient.prototype.send,
    dynamodb: DynamoDBClient.prototype.send,
    lambda: LambdaClient.prototype.send,
    s3: S3Client.prototype.send,
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
  if (overrides.dynamodb) {
    // deno-lint-ignore no-explicit-any
    DynamoDBClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.dynamodb!(_c));
    } as typeof originals.dynamodb;
  }
  if (overrides.lambda) {
    // deno-lint-ignore no-explicit-any
    LambdaClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.lambda!(_c));
    } as typeof originals.lambda;
  }
  if (overrides.s3) {
    // deno-lint-ignore no-explicit-any
    S3Client.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.s3!(_c));
    } as typeof originals.s3;
  }
  return () => {
    EC2Client.prototype.send = originals.ec2;
    RDSClient.prototype.send = originals.rds;
    DynamoDBClient.prototype.send = originals.dynamodb;
    LambdaClient.prototype.send = originals.lambda;
    S3Client.prototype.send = originals.s3;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: { regions: ["us-east-1"] },
    definition: {
      id: "test-id",
      name: "aws-inventory",
      version: 1,
      tags: {},
    },
  });
}

// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

// =============================================================================
// Test Data
// =============================================================================

const ec2Instance = {
  InstanceId: "i-abc123",
  InstanceType: "t3.medium",
  State: { Name: "running" },
  Placement: { AvailabilityZone: "us-east-1a" },
  Platform: undefined,
  Tags: [{ Key: "Name", Value: "web-server" }],
  LaunchTime: new Date("2026-01-01T00:00:00Z"),
};

const rdsInstance = {
  DBInstanceIdentifier: "mydb",
  DBInstanceClass: "db.t3.medium",
  Engine: "postgres",
  EngineVersion: "15.4",
  DBInstanceStatus: "available",
  AvailabilityZone: "us-east-1a",
  MultiAZ: false,
  StorageType: "gp3",
  AllocatedStorage: 100,
};

const lambdaFunction = {
  FunctionName: "my-func",
  Runtime: "nodejs20.x",
  MemorySize: 256,
  Timeout: 30,
  CodeSize: 5000,
  LastModified: "2026-01-01T00:00:00Z",
  Architectures: ["arm64"],
};

const ebsVolumeAttached = {
  VolumeId: "vol-attached",
  VolumeType: "gp3",
  Size: 100,
  State: "in-use",
  AvailabilityZone: "us-east-1a",
  Encrypted: true,
  Attachments: [{
    InstanceId: "i-abc",
    Device: "/dev/xvda",
    State: "attached",
  }],
  CreateTime: new Date("2026-01-01T00:00:00Z"),
  Tags: [],
};

const ebsVolumeOrphan = {
  VolumeId: "vol-orphan",
  VolumeType: "gp2",
  Size: 50,
  State: "available",
  AvailabilityZone: "us-east-1b",
  Encrypted: false,
  Attachments: [],
  CreateTime: new Date("2025-06-01T00:00:00Z"),
  Tags: [],
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/inventory");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has regions with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.regions, ["us-east-1"]);
});

Deno.test("model defines inventory resource", () => {
  assertEquals("inventory" in model.resources, true);
});

Deno.test("model defines all expected methods", () => {
  const expectedMethods = [
    "list_ec2",
    "list_rds",
    "list_dynamodb",
    "list_lambda",
    "list_s3",
    "list_ebs",
    "inventory_all",
    "inventory_scan",
    "inventory_diff",
  ];
  for (const method of expectedMethods) {
    assertEquals(method in model.methods, true, `missing method: ${method}`);
  }
});

// =============================================================================
// list_ec2 Tests
// =============================================================================

Deno.test({
  name: "list_ec2 returns mapped instance with tags",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        Reservations: [{ Instances: [ec2Instance] }],
        NextToken: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_ec2.execute(
        { stateFilter: ["running"] },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          instanceId: string;
          instanceType: string;
          state: string;
          availabilityZone: string;
          platform: string | null;
          tags: Record<string, string>;
          launchTime: string | null;
        }[];
      };
      assertEquals(data.resourceType, "ec2");
      assertEquals(data.count, 1);
      assertEquals(data.resources.length, 1);
      assertEquals(data.resources[0].instanceId, "i-abc123");
      assertEquals(data.resources[0].instanceType, "t3.medium");
      assertEquals(data.resources[0].state, "running");
      assertEquals(data.resources[0].availabilityZone, "us-east-1a");
      assertEquals(data.resources[0].platform, null);
      assertEquals(data.resources[0].tags, { Name: "web-server" });
      assertEquals(data.resources[0].launchTime, "2026-01-01T00:00:00.000Z");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_rds Tests
// =============================================================================

Deno.test({
  name: "list_rds returns mapped RDS instance",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      rds: () => ({
        DBInstances: [rdsInstance],
        Marker: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_rds.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          dbInstanceId: string;
          dbInstanceClass: string;
          engine: string;
          engineVersion: string;
          status: string;
          multiAz: boolean;
          storageType: string;
          allocatedStorage: number;
        }[];
      };
      assertEquals(data.resourceType, "rds");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].dbInstanceId, "mydb");
      assertEquals(data.resources[0].dbInstanceClass, "db.t3.medium");
      assertEquals(data.resources[0].engine, "postgres");
      assertEquals(data.resources[0].engineVersion, "15.4");
      assertEquals(data.resources[0].status, "available");
      assertEquals(data.resources[0].multiAz, false);
      assertEquals(data.resources[0].storageType, "gp3");
      assertEquals(data.resources[0].allocatedStorage, 100);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_lambda Tests
// =============================================================================

Deno.test({
  name: "list_lambda returns mapped function",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      lambda: () => ({
        Functions: [lambdaFunction],
        NextMarker: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_lambda.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          functionName: string;
          runtime: string | null;
          memorySize: number;
          timeout: number;
          codeSize: number;
          lastModified: string;
          architecture: string;
        }[];
      };
      assertEquals(data.resourceType, "lambda");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].functionName, "my-func");
      assertEquals(data.resources[0].runtime, "nodejs20.x");
      assertEquals(data.resources[0].memorySize, 256);
      assertEquals(data.resources[0].timeout, 30);
      assertEquals(data.resources[0].codeSize, 5000);
      assertEquals(data.resources[0].architecture, "arm64");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_ebs Tests
// =============================================================================

Deno.test({
  name: "list_ebs detects attached and unattached volumes",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      ec2: () => ({
        Volumes: [ebsVolumeAttached, ebsVolumeOrphan],
        NextToken: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_ebs.execute(
        { stateFilter: ["available", "in-use"] },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          volumeId: string;
          volumeType: string;
          size: number;
          state: string;
          encrypted: boolean;
          isAttached: boolean;
          attachments: { instanceId: string; device: string; state: string }[];
        }[];
      };
      assertEquals(data.resourceType, "ebs");
      assertEquals(data.count, 2);

      const attached = data.resources.find((v) =>
        v.volumeId === "vol-attached"
      );
      assertEquals(attached?.isAttached, true);
      assertEquals(attached?.encrypted, true);
      assertEquals(attached?.attachments.length, 1);
      assertEquals(attached?.attachments[0].instanceId, "i-abc");

      const orphan = data.resources.find((v) => v.volumeId === "vol-orphan");
      assertEquals(orphan?.isAttached, false);
      assertEquals(orphan?.encrypted, false);
      assertEquals(orphan?.attachments.length, 0);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_dynamodb Tests
// =============================================================================

Deno.test({
  name: "list_dynamodb returns table details with billing mode",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      dynamodb: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "ListTablesCommand") {
          return {
            TableNames: ["test-table"],
            LastEvaluatedTableName: undefined,
          };
        }
        if (name === "DescribeTableCommand") {
          return {
            Table: {
              TableName: "test-table",
              TableStatus: "ACTIVE",
              BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
              ProvisionedThroughput: {
                ReadCapacityUnits: 0,
                WriteCapacityUnits: 0,
              },
              ItemCount: 100n,
              TableSizeBytes: 5000n,
            },
          };
        }
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_dynamodb.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        count: number;
        resources: {
          tableName: string;
          tableStatus: string;
          billingMode: string;
          itemCount: number;
          tableSizeBytes: number;
        }[];
      };
      assertEquals(data.resourceType, "dynamodb");
      assertEquals(data.count, 1);
      assertEquals(data.resources[0].tableName, "test-table");
      assertEquals(data.resources[0].tableStatus, "ACTIVE");
      assertEquals(data.resources[0].billingMode, "PAY_PER_REQUEST");
      assertEquals(data.resources[0].itemCount, 100);
      assertEquals(data.resources[0].tableSizeBytes, 5000);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_s3 Tests
// =============================================================================

Deno.test({
  name: "list_s3 returns buckets with global region",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients({
      s3: () => ({
        Buckets: [
          {
            Name: "my-bucket",
            CreationDate: new Date("2026-01-15T00:00:00Z"),
          },
          { Name: "logs-bucket", CreationDate: undefined },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_s3.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        region: string;
        resourceType: string;
        count: number;
        resources: {
          bucketName: string;
          creationDate: string | null;
        }[];
      };
      assertEquals(data.region, "global");
      assertEquals(data.resourceType, "s3");
      assertEquals(data.count, 2);
      assertEquals(data.resources[0].bucketName, "my-bucket");
      assertEquals(
        data.resources[0].creationDate,
        "2026-01-15T00:00:00.000Z",
      );
      assertEquals(data.resources[1].bucketName, "logs-bucket");
      assertEquals(data.resources[1].creationDate, null);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// inventory_all Tests
// =============================================================================

function allServiceMocks() {
  const dynamoHandler = (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === "ListTablesCommand") {
      return {
        TableNames: ["test-table"],
        LastEvaluatedTableName: undefined,
      };
    }
    if (name === "DescribeTableCommand") {
      return {
        Table: {
          TableName: "test-table",
          TableStatus: "ACTIVE",
          BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
          ProvisionedThroughput: {
            ReadCapacityUnits: 0,
            WriteCapacityUnits: 0,
          },
          ItemCount: 100n,
          TableSizeBytes: 5000n,
        },
      };
    }
    return {};
  };

  return {
    ec2: (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "DescribeVolumesCommand") {
        return {
          Volumes: [ebsVolumeAttached],
          NextToken: undefined,
        };
      }
      return {
        Reservations: [{ Instances: [ec2Instance] }],
        NextToken: undefined,
      };
    },
    rds: () => ({
      DBInstances: [rdsInstance],
      Marker: undefined,
    }),
    dynamodb: dynamoHandler,
    lambda: () => ({
      Functions: [lambdaFunction],
      NextMarker: undefined,
    }),
    s3: () => ({
      Buckets: [{
        Name: "my-bucket",
        CreationDate: new Date("2026-01-15T00:00:00Z"),
      }],
    }),
  };
}

Deno.test({
  name: "inventory_all combines ec2, rds, dynamodb, lambda, and s3",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(allServiceMocks());
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.inventory_all.execute(
        { includeS3: true, includeStoppedEc2: false, includeEbs: false },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resourceType: string;
        resources: {
          ec2: unknown[];
          rds: unknown[];
          dynamodb: unknown[];
          lambda: unknown[];
          s3: unknown[];
          ebs?: unknown[];
        };
        count: number;
      };
      assertEquals(data.resourceType, "all");
      assertEquals(data.resources.ec2.length, 1);
      assertEquals(data.resources.rds.length, 1);
      assertEquals(data.resources.dynamodb.length, 1);
      assertEquals(data.resources.lambda.length, 1);
      assertEquals(data.resources.s3.length, 1);
      assertEquals(data.resources.ebs, undefined);
      assertEquals(data.count, 5);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_all includes ebs when requested",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(allServiceMocks());
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.inventory_all.execute(
        { includeS3: true, includeStoppedEc2: false, includeEbs: true },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        resources: {
          ec2: unknown[];
          rds: unknown[];
          dynamodb: unknown[];
          lambda: unknown[];
          s3: unknown[];
          ebs: unknown[];
        };
        count: number;
      };
      assertEquals(data.resources.ebs.length, 1);
      assertEquals(data.count, 6);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_all excludes s3 when not requested",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockClients(allServiceMocks());
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.inventory_all.execute(
        { includeS3: false, includeStoppedEc2: false, includeEbs: false },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const data = resources[0].data as {
        resources: {
          ec2: unknown[];
          rds: unknown[];
          dynamodb: unknown[];
          lambda: unknown[];
          s3?: unknown[];
        };
        count: number;
      };
      assertEquals(data.resources.s3, undefined);
      assertEquals(data.count, 4);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// inventory_scan and inventory_diff Tests
// =============================================================================

import { ResourceExplorer2Client } from "npm:@aws-sdk/client-resource-explorer-2@3.1069.0";
import { ConfigServiceClient } from "npm:@aws-sdk/client-config-service@3.1069.0";
import { ResourceGroupsTaggingAPIClient } from "npm:@aws-sdk/client-resource-groups-tagging-api@3.1069.0";

function mockScanClients(overrides: {
  re2?: (cmd: unknown) => unknown;
  config?: (cmd: unknown) => unknown;
  tag?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    re2: ResourceExplorer2Client.prototype.send,
    config: ConfigServiceClient.prototype.send,
    tag: ResourceGroupsTaggingAPIClient.prototype.send,
    re2Destroy: ResourceExplorer2Client.prototype.destroy,
    configDestroy: ConfigServiceClient.prototype.destroy,
    tagDestroy: ResourceGroupsTaggingAPIClient.prototype.destroy,
  };
  ResourceExplorer2Client.prototype.destroy = function () {};
  ConfigServiceClient.prototype.destroy = function () {};
  ResourceGroupsTaggingAPIClient.prototype.destroy = function () {};
  if (overrides.re2) {
    // deno-lint-ignore no-explicit-any
    ResourceExplorer2Client.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.re2!(_c));
    } as typeof originals.re2;
  } else {
    // deno-lint-ignore no-explicit-any
    ResourceExplorer2Client.prototype.send = function (_c: any) {
      return Promise.reject(new Error("ResourceExplorer not enabled"));
    } as typeof originals.re2;
  }
  if (overrides.config) {
    // deno-lint-ignore no-explicit-any
    ConfigServiceClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.config!(_c));
    } as typeof originals.config;
  } else {
    // deno-lint-ignore no-explicit-any
    ConfigServiceClient.prototype.send = function (_c: any) {
      return Promise.reject(new Error("Config not enabled"));
    } as typeof originals.config;
  }
  if (overrides.tag) {
    // deno-lint-ignore no-explicit-any
    ResourceGroupsTaggingAPIClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.tag!(_c));
    } as typeof originals.tag;
  }
  return () => {
    ResourceExplorer2Client.prototype.send = originals.re2;
    ConfigServiceClient.prototype.send = originals.config;
    ResourceGroupsTaggingAPIClient.prototype.send = originals.tag;
    ResourceExplorer2Client.prototype.destroy = originals.re2Destroy;
    ConfigServiceClient.prototype.destroy = originals.configDestroy;
    ResourceGroupsTaggingAPIClient.prototype.destroy = originals.tagDestroy;
  };
}

function makeScanContext() {
  return createModelTestContext({
    globalArgs: { regions: ["us-east-1"] },
    definition: {
      id: "test-scan",
      name: "inv-scan-test",
      version: 1,
      tags: {},
    },
  });
}

// deno-lint-ignore no-explicit-any
type AnyContext = any;

Deno.test({
  name: "inventory_scan uses Resource Explorer when available",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      re2: () => ({
        Resources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-abc",
            ResourceType: "ec2:vpc",
            Properties: [],
          },
          {
            Arn: "arn:aws:ecs:us-east-1:123456789012:service/my-svc",
            ResourceType: "ecs:service",
            Properties: [],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      await model.methods.inventory_scan.execute(
        { source: "auto" },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.source, "resource-explorer");
      assertEquals(data.coverage, "full");
      assertEquals(data.summary.total, 2);
      assertEquals(data.summary.modelableCount, 1); // VPC
      assertEquals(data.summary.unmodeledCount, 1); // ECS::Service
      assertEquals(data.unmodeledTypes[0].resourceType, "AWS::ECS::Service");
      assertEquals(data.unmodeledTypes[0].recommendation, "build-extension");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "inventory_scan falls back to Config when Resource Explorer unavailable",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      config: () => ({
        Results: [
          JSON.stringify({
            arn: "arn:aws:s3:::my-bucket",
            resourceType: "AWS::S3::Bucket",
            awsRegion: "us-east-1",
            accountId: "123",
            tags: { Name: "test" },
          }),
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      await model.methods.inventory_scan.execute(
        { source: "auto" },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.source, "config");
      assertEquals(data.coverage, "config-tracked");
      assertEquals(data.summary.total, 1);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "inventory_scan falls back to Tag API when both RE2 and Config unavailable",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      tag: () => ({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:lambda:us-east-1:123:function:my-fn",
            Tags: [{ Key: "env", Value: "prod" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      await model.methods.inventory_scan.execute(
        { source: "auto" },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.source, "tag-api");
      assertEquals(data.coverage, "tagged-only");
      assertEquals(data.summary.total, 1);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_scan classifies unmodeled types with correct hints",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      re2: () => ({
        Resources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-1",
            ResourceType: "ec2:vpc",
            Properties: [],
          },
          {
            Arn: "arn:aws:ec2:us-east-1:123:transit-gateway/tgw-1",
            ResourceType: "ec2:transit-gateway",
            Properties: [],
          },
          {
            Arn: "arn:aws:medialive:us-east-1:123:channel/ch-1",
            ResourceType: "medialive:channel",
            Properties: [],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      await model.methods.inventory_scan.execute(
        { source: "auto" },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      const tgw = data.unmodeledTypes.find((t: { resourceType: string }) =>
        t.resourceType === "AWS::EC2::TransitGateway"
      );
      const ml = data.unmodeledTypes.find((t: { resourceType: string }) =>
        t.resourceType === "AWS::Medialive::Channel"
      );
      assertEquals(tgw.recommendation, "extend-existing"); // EC2 namespace exists
      assertEquals(ml.recommendation, "build-extension"); // MediaLive namespace doesn't exist
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_diff detects new and removed resources",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      re2: () => ({
        Resources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-1",
            ResourceType: "ec2:vpc",
            Properties: [],
          },
          {
            Arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-new",
            ResourceType: "ec2:vpc",
            Properties: [],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      // Inject previous scan via readResource
      // deno-lint-ignore no-explicit-any
      const ctxAny = context as any;
      ctxAny.readResource = (_instance: string) =>
        Promise.resolve({
          fetchedAt: "2026-05-28T00:00:00Z",
          resources: [
            {
              arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-1",
              resourceType: "AWS::EC2::VPC",
              region: "us-east-1",
              accountId: "123",
              tags: {},
            },
            {
              arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-old",
              resourceType: "AWS::EC2::VPC",
              region: "us-east-1",
              accountId: "123",
              tags: {},
            },
          ],
        });

      await model.methods.inventory_diff.execute(
        {},
        ctxAny as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const resources = getWrittenResources() as any[];
      // Find the scanDiff output (not the scan baseline)
      const diffData = resources.find((r) => r.specName === "scanDiff")?.data;
      assertEquals(diffData.summary.newCount, 1); // vpc-new
      assertEquals(diffData.summary.removedCount, 1); // vpc-old
      assertEquals(
        diffData.newResources[0].arn,
        "arn:aws:ec2:us-east-1:123:vpc/vpc-new",
      );
      assertEquals(
        diffData.removedResources[0].arn,
        "arn:aws:ec2:us-east-1:123:vpc/vpc-old",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_diff suppresses output when current scan is truncated",
  sanitizeResources: false,
  fn: async () => {
    // Return enough pages to trigger truncation by returning NextToken
    let callCount = 0;
    const restore = mockScanClients({
      re2: () => {
        callCount++;
        if (callCount <= 20) {
          return {
            Resources: [{
              Arn: `arn:aws:ec2:us-east-1:123:vpc/vpc-${callCount}`,
              ResourceType: "ec2:vpc",
              Properties: [],
            }],
            NextToken: "always-more",
          };
        }
        return { Resources: [] };
      },
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      // deno-lint-ignore no-explicit-any
      const ctxAny = context as any;
      ctxAny.readResource = (_instance: string) =>
        Promise.resolve({
          fetchedAt: "2026-05-28T00:00:00Z",
          resources: [
            {
              arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-old",
              resourceType: "AWS::EC2::VPC",
              region: "us-east-1",
              accountId: "123",
              tags: {},
            },
          ],
        });

      await model.methods.inventory_diff.execute(
        {},
        ctxAny as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const resources = getWrittenResources() as any[];
      const diffData = resources.find((r) => r.specName === "scanDiff")?.data;
      // Truncated → suppressed
      assertEquals(diffData.truncated, true);
      assertEquals(diffData.noBaseline, false);
      assertEquals(diffData.summary.newCount, 0);
      assertEquals(diffData.summary.removedCount, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "inventory_scan Tag API correctly classifies S3 buckets",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockScanClients({
      tag: () => ({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-production-bucket",
            Tags: [{ Key: "env", Value: "prod" }],
          },
          {
            ResourceARN: "arn:aws:s3:::my-staging-bucket",
            Tags: [{ Key: "env", Value: "staging" }],
          },
        ],
      }),
    });
    try {
      const { context, getWrittenResources } = makeScanContext();
      await model.methods.inventory_scan.execute(
        { source: "tag-api" },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      // Both S3 buckets should have the same type, not per-bucket types
      assertEquals(data.resources[0].resourceType, "AWS::S3::Bucket");
      assertEquals(data.resources[1].resourceType, "AWS::S3::Bucket");
      // S3::Bucket is in the type map, so both should be modelable
      assertEquals(data.summary.modelableCount, 2);
      assertEquals(data.summary.unmodeledCount, 0);
    } finally {
      restore();
    }
  },
});
