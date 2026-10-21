// ABOUTME: Azure Blob Storage datastore extension for swamp — native blob-lease
// ABOUTME: distributed locking and ETag-conditional shard-index sync, no SDK.

import { z } from "npm:zod@4.6.5";
import { type BlobAuth, BlobClient } from "./rest_client.ts";
import {
  createBlobLock,
  type DistributedLock,
  type LockOptions,
} from "./lock.ts";
import {
  createSyncService as createSync,
  type TwoPhaseSyncService,
} from "./sync.ts";

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

const ACCOUNT_NAME_SCHEMA = z.string().min(3).max(24).regex(
  /^[a-z0-9]+$/,
  "Azure storage account names are 3-24 lowercase letters/digits",
);

const AuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("connectionString"),
    connectionString: z.string().min(1).meta({ sensitive: true }).describe(
      "Azure Storage connection string (it embeds the account key). Supply " +
        'it with "${{ vault.get(azure, STORAGE_CONNECTION_STRING) }}"; never ' +
        "put the literal value in .swamp.yaml or SWAMP_DATASTORE.",
    ),
  }),
  z.object({
    mode: z.literal("sharedKey"),
    accountName: ACCOUNT_NAME_SCHEMA,
    accountKey: z.string().min(1).meta({ sensitive: true }).describe(
      "Base64-encoded storage account key. Supply it with " +
        '"${{ vault.get(azure, STORAGE_ACCOUNT_KEY) }}"; never put the ' +
        "literal value in .swamp.yaml or SWAMP_DATASTORE.",
    ),
    endpointSuffix: z.string().default("core.windows.net"),
  }),
  z.object({
    mode: z.literal("servicePrincipal"),
    accountName: ACCOUNT_NAME_SCHEMA,
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    clientSecret: z.string().min(1).meta({ sensitive: true }).describe(
      "Azure AD client secret. Supply it with " +
        '"${{ vault.get(azure, CLIENT_SECRET) }}"; never put the literal ' +
        "value in .swamp.yaml or SWAMP_DATASTORE.",
    ),
    endpointSuffix: z.string().default("core.windows.net"),
  }),
]);

const ConfigSchema = z.object({
  auth: AuthSchema.describe(
    "Explicit authentication mode — connectionString, sharedKey, or servicePrincipal. " +
      "DefaultAzureCredential/managed-identity chains are intentionally not supported.",
  ),
  container: z.string().min(3).max(63).regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "must be a valid Azure container name",
  ).refine(
    (s) => !s.includes("--"),
    "must not contain consecutive hyphens",
  ).describe(
    "Existing Azure Blob container name. Not auto-created — see README.",
  ),
  prefix: z.string().default("swamp").describe(
    "Blob-name prefix namespace within the container, so multiple swamp datastores can share one container",
  ),
});

type BlobConfig = z.output<typeof ConfigSchema>;

function resolveAuth(parsed: BlobConfig): BlobAuth {
  if (parsed.auth.mode === "connectionString") {
    return {
      mode: "connectionString",
      connectionString: parsed.auth.connectionString,
    };
  }
  if (parsed.auth.mode === "sharedKey") {
    return {
      mode: "sharedKey",
      accountName: parsed.auth.accountName,
      accountKey: parsed.auth.accountKey,
      endpointSuffix: parsed.auth.endpointSuffix,
    };
  }
  return {
    mode: "servicePrincipal",
    accountName: parsed.auth.accountName,
    tenantId: parsed.auth.tenantId,
    clientId: parsed.auth.clientId,
    clientSecret: parsed.auth.clientSecret,
    endpointSuffix: parsed.auth.endpointSuffix,
  };
}

/**
 * Azure Blob Storage datastore provider for swamp.
 *
 * Stores runtime data in Azure Blob Storage using native blob-lease
 * distributed locking (the lease ID doubles as the fencing-token nonce) and
 * ETag-conditional writes on a shard-first path index.
 *
 * The connection string, account key, or client secret is always read from a
 * swamp vault through a `vault.get` expression, never written literally.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * datastore:
 *   type: "@webframp/azure-blob-datastore"
 *   config:
 *     auth:
 *       mode: "connectionString"
 *       connectionString: "${{ vault.get(azure, STORAGE_CONNECTION_STRING) }}"
 *     container: "swamp-datastore"
 * ```
 */
export const datastore = {
  type: "@webframp/azure-blob-datastore",
  name: "Azure Blob Datastore",
  description:
    "Stores swamp runtime data in Azure Blob Storage with native blob-lease distributed locking and ETag-conditional shard-index writes.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>): DatastoreProvider => {
    const parsed = ConfigSchema.parse(config);
    const auth = resolveAuth(parsed);
    const client = BlobClient.fromAuth(auth);

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createBlobLock(
          client,
          parsed.container,
          parsed.prefix,
          datastorePath,
          options,
        );
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            const resp = await client.request({
              op: "getContainerProperties",
              method: "GET",
              path: `/${parsed.container}`,
              query: { restype: "container" },
            });
            const healthy = resp.status === 200;
            return {
              healthy,
              message: healthy
                ? "OK"
                : `Container check returned ${resp.status}`,
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/azure-blob-datastore",
              details: {
                container: parsed.container,
                prefix: parsed.prefix,
              },
            };
          } catch (error) {
            const reason = error instanceof Error
              ? error.message
              : String(error);
            return {
              healthy: false,
              message:
                `getContainerProperties failed for container "${parsed.container}": ${reason}`,
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/azure-blob-datastore",
            };
          }
        },
      }),

      resolveDatastorePath: (_repoDir: string): string =>
        `azblob://${parsed.container}/${parsed.prefix}`,

      createSyncService: (
        _repoDir: string,
        cachePath: string,
      ): TwoPhaseSyncService => {
        return createSync(client, parsed.container, parsed.prefix, cachePath);
      },

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },
    };
  },
};
