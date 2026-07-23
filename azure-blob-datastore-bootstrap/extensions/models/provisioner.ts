/**
 * Azure Blob Storage datastore bootstrap provisioner.
 *
 * Creates the Azure infrastructure required by @webframp/azure-blob-datastore:
 * a resource group, storage account (StorageV2, LRS), and blob container,
 * then retrieves the connection string for datastore configuration.
 *
 * Uses the Azure CLI (`az`) which must be authenticated via `az login`.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  location: z
    .string()
    .min(1)
    .default("eastus")
    .describe("Azure region (e.g., eastus, westus2, westeurope)"),
  resource_group: z
    .string()
    .min(1)
    .max(90)
    .regex(/^[a-zA-Z0-9._()-]+[a-zA-Z0-9_()-]$/)
    .default("swamp-datastore-rg")
    .describe("Azure resource group name"),
  storage_account: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9]+$/)
    .default("swampdatastore")
    .describe(
      "Storage account name (3-24 chars, lowercase alphanumeric only, globally unique)",
    ),
  container_name: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .default("swamp-datastore")
    .describe("Blob container name"),
  blob_prefix: z
    .string()
    .min(1)
    .default("swamp")
    .describe("Blob-name prefix namespace within the container"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  location: z.string().describe("Azure region"),
  resourceGroup: z.string().describe("Resource group name"),
  resourceGroupCreated: z
    .boolean()
    .describe("Whether the resource group was newly created"),
  storageAccount: z.string().describe("Storage account name"),
  storageAccountCreated: z
    .boolean()
    .describe("Whether the storage account was newly created"),
  containerName: z.string().describe("Blob container name"),
  containerCreated: z
    .boolean()
    .describe("Whether the container was newly created"),
  connectionString: z.string().describe("Storage account connection string"),
  datastoreConfig: z
    .string()
    .describe("JSON config for swamp datastore setup command"),
  provisionedAt: z.string().describe("ISO 8601 timestamp"),
  durationMs: z.number().describe("Total provisioning duration in ms"),
});

/** Run an Azure CLI command and return parsed JSON output. */
async function azCli(args: string[]): Promise<Record<string, unknown>> {
  const command = new Deno.Command("az", {
    args: [...args, "--output", "json"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `Azure CLI failed: az ${args.join(" ")} — ${stderr.trim()}`,
    );
  }
  const stdout = new TextDecoder().decode(output.stdout);
  return stdout.trim() ? JSON.parse(stdout) : {};
}

/** Check if a resource group exists. */
async function resourceGroupExists(name: string): Promise<boolean> {
  try {
    await azCli(["group", "show", "--name", name]);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ResourceGroupNotFound") || msg.includes("not found")) {
      return false;
    }
    throw error;
  }
}

/** Create a resource group. */
async function createResourceGroup(
  name: string,
  location: string,
): Promise<void> {
  await azCli([
    "group",
    "create",
    "--name",
    name,
    "--location",
    location,
    "--tags",
    "ManagedBy=swamp",
  ]);
}

/** Check if a storage account exists. */
async function storageAccountExists(
  name: string,
  resourceGroup: string,
): Promise<boolean> {
  try {
    await azCli([
      "storage",
      "account",
      "show",
      "--name",
      name,
      "--resource-group",
      resourceGroup,
    ]);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("not found") || msg.includes("ResourceNotFound")) {
      return false;
    }
    throw error;
  }
}

/** Create a storage account (StorageV2, LRS, no public blob access). */
async function createStorageAccount(
  name: string,
  resourceGroup: string,
  location: string,
): Promise<void> {
  await azCli([
    "storage",
    "account",
    "create",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
    "--location",
    location,
    "--sku",
    "Standard_LRS",
    "--kind",
    "StorageV2",
    "--allow-blob-public-access",
    "false",
    "--min-tls-version",
    "TLS1_2",
    "--tags",
    "ManagedBy=swamp",
  ]);
}

/** Check if a blob container exists. */
async function containerExists(
  containerName: string,
  accountName: string,
): Promise<boolean> {
  try {
    await azCli([
      "storage",
      "container",
      "show",
      "--name",
      containerName,
      "--account-name",
      accountName,
      "--auth-mode",
      "login",
    ]);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ContainerNotFound") || msg.includes("not found")) {
      return false;
    }
    throw error;
  }
}

/** Create a blob container. */
async function createContainer(
  containerName: string,
  accountName: string,
): Promise<void> {
  await azCli([
    "storage",
    "container",
    "create",
    "--name",
    containerName,
    "--account-name",
    accountName,
    "--auth-mode",
    "login",
  ]);
}

/** Get the storage account connection string. */
async function getConnectionString(
  accountName: string,
  resourceGroup: string,
): Promise<string> {
  const result = await azCli([
    "storage",
    "account",
    "show-connection-string",
    "--name",
    accountName,
    "--resource-group",
    resourceGroup,
  ]);
  const connStr = (result as { connectionString?: string }).connectionString;
  if (!connStr) {
    throw new Error(
      `Could not retrieve connection string for storage account ${accountName}`,
    );
  }
  return connStr;
}

/** Provisioner model definition. */
export const model = {
  type: "@webframp/azure-blob-datastore-bootstrap/provisioner",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "Azure Storage account + blob container provisioned for swamp.",
      schema: ProvisionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    provision: {
      description:
        "Create/verify an Azure Storage account and blob container for @webframp/azure-blob-datastore.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const {
          location,
          resource_group,
          storage_account,
          container_name,
          blob_prefix,
        } = context.globalArgs;
        const startMs = Date.now();

        // 1. Resource group
        let rgCreated = false;
        if (!await resourceGroupExists(resource_group)) {
          await createResourceGroup(resource_group, location);
          rgCreated = true;
        }

        // 2. Storage account
        let saCreated = false;
        if (!await storageAccountExists(storage_account, resource_group)) {
          await createStorageAccount(storage_account, resource_group, location);
          saCreated = true;
        }

        // 3. Blob container
        let containerCreated = false;
        if (!await containerExists(container_name, storage_account)) {
          await createContainer(container_name, storage_account);
          containerCreated = true;
        }

        // 4. Get connection string
        const connectionString = await getConnectionString(
          storage_account,
          resource_group,
        );

        // 5. Build datastore config
        const datastoreConfig = JSON.stringify({
          auth: {
            mode: "connectionString",
            connectionString,
          },
          container: container_name,
          prefix: blob_prefix,
        });

        const durationMs = Date.now() - startMs;

        // 6. Write result
        const handle = await context.writeResource("state", "main", {
          location,
          resourceGroup: resource_group,
          resourceGroupCreated: rgCreated,
          storageAccount: storage_account,
          storageAccountCreated: saCreated,
          containerName: container_name,
          containerCreated,
          connectionString,
          datastoreConfig,
          provisionedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
