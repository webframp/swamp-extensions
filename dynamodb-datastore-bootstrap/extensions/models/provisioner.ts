/**
 * DynamoDB datastore bootstrap provisioner.
 *
 * Creates the AWS infrastructure required by @webframp/dynamodb-datastore:
 * a DynamoDB table (PAY_PER_REQUEST, GSI, TTL) and a scoped IAM managed
 * policy granting least-privilege runtime actions.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("us-east-1")
    .describe("AWS region for the DynamoDB table"),
  table_name: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .default("swamp-datastore")
    .describe("DynamoDB table name"),
  policy_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w+=,.@-]+$/)
    .default("SwampDynamoDBDatastorePolicy")
    .describe("IAM managed policy name"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  region: z.string().describe("AWS region where resources were created"),
  tableName: z.string().describe("DynamoDB table name"),
  tableArn: z.string().describe("DynamoDB table ARN"),
  tableStatus: z.string().describe("Table status after provisioning"),
  tableCreated: z.boolean().describe("Whether the table was newly created"),
  ttlEnabled: z.boolean().describe("Whether TTL is active on the table"),
  gsiName: z.string().describe("GSI name (gsi1)"),
  policyArn: z.string().describe("IAM managed policy ARN"),
  policyCreated: z.boolean().describe("Whether the policy was newly created"),
  provisionedAt: z.string().describe("ISO 8601 timestamp of provisioning"),
  durationMs: z.number().describe("Total provisioning duration in ms"),
});

/** Run an AWS CLI command and return parsed JSON output. */
async function awsCli(
  args: string[],
  region: string,
): Promise<Record<string, unknown>> {
  const command = new Deno.Command("aws", {
    args: [...args, "--region", region, "--output", "json"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`AWS CLI failed: aws ${args.join(" ")} — ${stderr.trim()}`);
  }
  const stdout = new TextDecoder().decode(output.stdout);
  return stdout.trim() ? JSON.parse(stdout) : {};
}

/** Check if a DynamoDB table exists. Returns the table description or null. */
async function describeTable(
  tableName: string,
  region: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await awsCli(
      ["dynamodb", "describe-table", "--table-name", tableName],
      region,
    );
    return (result as { Table?: Record<string, unknown> }).Table ?? null;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ResourceNotFoundException")) return null;
    throw error;
  }
}

/** Create the DynamoDB table with the required schema. */
async function createTable(
  tableName: string,
  region: string,
): Promise<Record<string, unknown>> {
  const result = await awsCli(
    [
      "dynamodb",
      "create-table",
      "--table-name",
      tableName,
      "--attribute-definitions",
      "AttributeName=pk,AttributeType=S",
      "AttributeName=sk,AttributeType=S",
      "AttributeName=gsi1pk,AttributeType=S",
      "AttributeName=gsi1sk,AttributeType=S",
      "--key-schema",
      "AttributeName=pk,KeyType=HASH",
      "AttributeName=sk,KeyType=RANGE",
      "--billing-mode",
      "PAY_PER_REQUEST",
      "--global-secondary-indexes",
      JSON.stringify([
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ]),
    ],
    region,
  );
  return (result as { TableDescription?: Record<string, unknown> })
    .TableDescription ?? {};
}

/** Wait for a table to become ACTIVE (polls every 2s, up to 60s). */
async function waitForTableActive(
  tableName: string,
  region: string,
): Promise<void> {
  const maxWaitMs = 60_000;
  const pollIntervalMs = 2_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const table = await describeTable(tableName, region);
    if (table && (table as { TableStatus?: string }).TableStatus === "ACTIVE") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Table ${tableName} did not become ACTIVE within ${maxWaitMs / 1000}s`,
  );
}

/** Enable TTL on the table's `ttl` attribute. No-op if already enabled. */
async function enableTtl(
  tableName: string,
  region: string,
): Promise<boolean> {
  // Check current TTL state
  const ttlDesc = await awsCli(
    ["dynamodb", "describe-time-to-live", "--table-name", tableName],
    region,
  );
  const spec = (ttlDesc as {
    TimeToLiveDescription?: { TimeToLiveStatus?: string };
  }).TimeToLiveDescription;
  if (
    spec?.TimeToLiveStatus === "ENABLED" ||
    spec?.TimeToLiveStatus === "ENABLING"
  ) {
    return true;
  }

  // Enable TTL
  await awsCli(
    [
      "dynamodb",
      "update-time-to-live",
      "--table-name",
      tableName,
      "--time-to-live-specification",
      JSON.stringify({
        Enabled: true,
        AttributeName: "ttl",
      }),
    ],
    region,
  );
  return true;
}

/** Get the current AWS account ID. */
async function getAccountId(region: string): Promise<string> {
  const result = await awsCli(
    ["sts", "get-caller-identity"],
    region,
  );
  const account = (result as { Account?: string }).Account;
  if (!account) throw new Error("Could not determine AWS account ID");
  return account;
}

/** Create or retrieve an IAM managed policy. Returns the policy ARN. */
async function ensurePolicy(
  policyName: string,
  tableArn: string,
  region: string,
): Promise<{ arn: string; created: boolean }> {
  const accountId = await getAccountId(region);
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  // Check if policy already exists
  try {
    await awsCli(
      ["iam", "get-policy", "--policy-arn", policyArn],
      region,
    );
    return { arn: policyArn, created: false };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("NoSuchEntity")) throw error;
  }

  // Create the policy
  const policyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SwampDynamoDBDatastoreAccess",
        Effect: "Allow",
        Action: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchWriteItem",
          "dynamodb:DescribeTable",
        ],
        Resource: [tableArn, `${tableArn}/index/*`],
      },
    ],
  });

  try {
    const result = await awsCli(
      [
        "iam",
        "create-policy",
        "--policy-name",
        policyName,
        "--policy-document",
        policyDocument,
        "--description",
        "Least-privilege policy for @webframp/dynamodb-datastore runtime access",
      ],
      region,
    );
    const policy = (result as { Policy?: { Arn?: string } }).Policy;
    if (!policy?.Arn) throw new Error("Failed to create IAM policy");
    return { arn: policy.Arn, created: true };
  } catch (error: unknown) {
    // Handle TOCTOU race: another process created the policy between our
    // get-policy check and this create-policy call.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("EntityAlreadyExists")) {
      return { arn: policyArn, created: false };
    }
    throw error;
  }
}

/** Provisioner model definition. */
export const model = {
  type: "@webframp/dynamodb-datastore-bootstrap/provisioner",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "DynamoDB table + IAM managed policy provisioned for swamp.",
      schema: ProvisionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    provision: {
      description:
        "Create/verify the DynamoDB table and scoped IAM managed policy for @webframp/dynamodb-datastore.",
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
        const { region, table_name, policy_name } = context.globalArgs;
        const startMs = Date.now();

        // 1. Create or verify DynamoDB table
        let tableCreated = false;
        let tableDesc = await describeTable(table_name, region);

        if (!tableDesc) {
          await createTable(table_name, region);
          tableCreated = true;
          await waitForTableActive(table_name, region);
          tableDesc = await describeTable(table_name, region);
        }

        if (!tableDesc) {
          throw new Error(
            `Table ${table_name} does not exist after creation attempt`,
          );
        }

        const tableArn = (tableDesc as { TableArn?: string }).TableArn;
        const tableStatus = (tableDesc as { TableStatus?: string })
          .TableStatus;
        if (!tableArn) throw new Error("Table ARN not found in description");

        // 2. Enable TTL
        const ttlEnabled = await enableTtl(table_name, region);

        // 3. Create or verify IAM policy
        const { arn: policyArn, created: policyCreated } = await ensurePolicy(
          policy_name,
          tableArn,
          region,
        );

        const durationMs = Date.now() - startMs;

        // 4. Write result
        const handle = await context.writeResource("state", "main", {
          region,
          tableName: table_name,
          tableArn,
          tableStatus: tableStatus ?? "UNKNOWN",
          tableCreated,
          ttlEnabled,
          gsiName: "gsi1",
          policyArn,
          policyCreated,
          provisionedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
