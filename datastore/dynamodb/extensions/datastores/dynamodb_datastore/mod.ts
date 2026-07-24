// ABOUTME: DynamoDB datastore extension for swamp — single-table design with
// ABOUTME: conditional-write distributed locking and chunked blob storage.

import { z } from "npm:zod@4.4.3";
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from "npm:@aws-sdk/client-dynamodb@3.1094.0";
import type { DynamoDBDocumentClient } from "npm:@aws-sdk/lib-dynamodb@3.1094.0";
import { createClients } from "./client.ts";
import {
  createDynamoLock,
  type DistributedLock,
  type LockOptions,
} from "./lock.ts";
import {
  createSyncService as createSync,
  type TwoPhaseSyncService,
} from "./sync.ts";
import { GSI_NAME } from "./keys.ts";

interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(
    repoDir: string,
    cachePath: string,
  ): TwoPhaseSyncService;
  resolveDatastorePath(repoDir: string): string;
  resolveCachePath?(repoDir: string): string | undefined;
}

const ConfigSchema = z.object({
  region: z.string().min(1).default("us-east-1").describe(
    "AWS region for the DynamoDB table",
  ),
  tableName: z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/, {
    message:
      "Must be a valid DynamoDB table name (3-255 chars, alphanumeric/._-)",
  }).default("swamp-datastore").describe(
    "DynamoDB table name (single-table design: locks, file chunks/metadata, sync state)",
  ),
  endpoint: z.string().url().optional().describe(
    "Custom endpoint URL — for DynamoDB Local or VPC endpoints only. Leave unset for production AWS.",
  ),
  autoCreateTable: z.boolean().default(false).describe(
    "Create the table (with GSI and TTL) on first use if missing. Requires " +
      "dynamodb:CreateTable/DescribeTable/UpdateTimeToLive IAM permissions. " +
      "Default false — production tables should be provisioned via IaC.",
  ),
  maxChunkBytes: z.number().int().positive().max(300 * 1024).default(
    256 * 1024,
  ).describe(
    "Max raw bytes per chunk item before splitting a file across multiple DynamoDB items.",
  ),
}).refine(
  (data) =>
    !data.endpoint || data.endpoint.startsWith("http://") ||
    data.endpoint.startsWith("https://"),
  { message: "endpoint must be an http(s) URL", path: ["endpoint"] },
);

type DynamoConfig = z.output<typeof ConfigSchema>;

async function waitForTableActive(
  base: DynamoDBClient,
  tableName: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { Table } = await base.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    if (Table?.TableStatus === "ACTIVE") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Table ${tableName} did not become ACTIVE within 60s`);
}

function createInfrastructureEnsurer(
  base: DynamoDBClient,
  parsed: DynamoConfig,
): () => Promise<void> {
  let infraPromise: Promise<void> | undefined;
  return function ensureInfrastructure(): Promise<void> {
    if (!parsed.autoCreateTable) return Promise.resolve();
    if (!infraPromise) {
      infraPromise = (async () => {
        try {
          await base.send(
            new DescribeTableCommand({ TableName: parsed.tableName }),
          );
          return;
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) throw err;
        }
        await base.send(
          new CreateTableCommand({
            TableName: parsed.tableName,
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
              { AttributeName: "gsi1pk", AttributeType: "S" },
              { AttributeName: "gsi1sk", AttributeType: "S" },
            ],
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            GlobalSecondaryIndexes: [
              {
                IndexName: GSI_NAME,
                KeySchema: [
                  { AttributeName: "gsi1pk", KeyType: "HASH" },
                  { AttributeName: "gsi1sk", KeyType: "RANGE" },
                ],
                // ALL, not KEYS_ONLY — collectFullWalkDiff needs hash/updatedAt/
                // deletedAt from the index itself without a follow-up GetItem per key.
                // Only META items carry gsi1pk/gsi1sk, so chunk content never leaks in.
                Projection: { ProjectionType: "ALL" },
              },
            ],
          }),
        );
        await waitForTableActive(base, parsed.tableName);
        await base.send(
          new UpdateTimeToLiveCommand({
            TableName: parsed.tableName,
            TimeToLiveSpecification: {
              AttributeName: "ttl",
              Enabled: true,
            },
          }),
        );
      })().catch((e) => {
        infraPromise = undefined;
        throw e;
      });
    }
    return infraPromise;
  };
}

/**
 * DynamoDB datastore provider for swamp.
 *
 * Stores runtime data in a single DynamoDB table using conditional-write
 * distributed locking with fencing tokens. Serverless, zero-ops.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * datastore:
 *   type: "@webframp/dynamodb-datastore"
 *   config:
 *     tableName: "swamp-datastore"
 *     region: "us-east-1"
 * ```
 */
export const datastore = {
  type: "@webframp/dynamodb-datastore",
  name: "DynamoDB Datastore",
  description:
    "Stores swamp runtime data in AWS DynamoDB with conditional-write distributed locking and chunked blob storage.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>): DatastoreProvider => {
    const parsed = ConfigSchema.parse(config);
    const { base, doc } = createClients({
      region: parsed.region,
      endpoint: parsed.endpoint,
    });
    const ensureInfrastructure = createInfrastructureEnsurer(base, parsed);

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createDynamoLock(
          doc,
          parsed.tableName,
          datastorePath,
          options,
          ensureInfrastructure,
        );
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            await ensureInfrastructure();
            const { Table } = await base.send(
              new DescribeTableCommand({ TableName: parsed.tableName }),
            );
            const healthy = Table?.TableStatus === "ACTIVE";
            return {
              healthy,
              message: healthy
                ? "OK"
                : `Table status: ${Table?.TableStatus ?? "UNKNOWN"}`,
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/dynamodb-datastore",
              details: {
                tableName: parsed.tableName,
                tableStatus: String(Table?.TableStatus),
                billingMode: Table?.BillingModeSummary?.BillingMode ??
                  "unknown",
                itemCount: String(Table?.ItemCount ?? 0),
              },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/dynamodb-datastore",
            };
          }
        },
      }),

      resolveDatastorePath: (_repoDir: string): string =>
        `dynamodb://${parsed.tableName}`,

      createSyncService: (
        _repoDir: string,
        cachePath: string,
      ): TwoPhaseSyncService => {
        return createSync(
          doc as DynamoDBDocumentClient,
          parsed.tableName,
          cachePath,
          parsed.maxChunkBytes,
          ensureInfrastructure,
        );
      },

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },
    };
  },
};
