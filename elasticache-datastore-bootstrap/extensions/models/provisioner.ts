/**
 * Valkey ElastiCache Serverless bootstrap provisioner.
 *
 * Creates the AWS infrastructure required by @webframp/valkey-datastore
 * when targeting AWS ElastiCache Serverless: a serverless cache (Valkey
 * engine), a VPC security group for access, and a scoped IAM managed
 * policy.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("us-east-1")
    .describe("AWS region for ElastiCache resources"),
  cache_name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/)
    .default("swamp-valkey")
    .describe("ElastiCache Serverless cache name"),
  vpc_id: z
    .string()
    .regex(/^vpc-[a-f0-9]+$/)
    .optional()
    .describe("VPC ID (uses default VPC if omitted)"),
  subnet_ids: z
    .string()
    .optional()
    .describe(
      "Comma-separated subnet IDs (uses default VPC subnets if omitted)",
    ),
  security_group_name: z
    .string()
    .default("swamp-valkey-access")
    .describe("Security group name for cache access"),
  policy_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w+=,.@-]+$/)
    .default("SwampValkeyDatastorePolicy")
    .describe("IAM managed policy name"),
  key_prefix: z
    .string()
    .min(1)
    .default("swamp")
    .describe("Key namespace prefix for swamp data in Valkey"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  region: z.string().describe("AWS region"),
  cacheName: z.string().describe("ElastiCache Serverless cache name"),
  cacheArn: z.string().describe("Cache ARN"),
  cacheEndpoint: z.string().describe("Cache endpoint URL (rediss://)"),
  cachePort: z.number().describe("Cache port"),
  cacheStatus: z.string().describe("Cache status after provisioning"),
  cacheCreated: z.boolean().describe("Whether the cache was newly created"),
  securityGroupId: z
    .string()
    .describe("Security group ID created for cache access"),
  securityGroupCreated: z
    .boolean()
    .describe("Whether the security group was newly created"),
  policyArn: z.string().describe("IAM managed policy ARN"),
  policyCreated: z.boolean().describe("Whether the policy was newly created"),
  datastoreConfig: z
    .string()
    .describe("JSON config for swamp datastore setup command"),
  provisionedAt: z.string().describe("ISO 8601 timestamp"),
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

/** Get the default VPC ID for the region. */
async function getDefaultVpcId(region: string): Promise<string> {
  const result = await awsCli(
    [
      "ec2",
      "describe-vpcs",
      "--filters",
      "Name=is-default,Values=true",
    ],
    region,
  );
  const vpcs = (result as { Vpcs?: Array<{ VpcId?: string }> }).Vpcs;
  if (!vpcs || vpcs.length === 0) {
    throw new Error("No default VPC found — provide vpc_id explicitly");
  }
  const vpcId = vpcs[0]?.VpcId;
  if (!vpcId) throw new Error("Default VPC has no VpcId");
  return vpcId;
}

/** Get subnet IDs for a VPC. */
async function getSubnetIds(
  vpcId: string,
  region: string,
): Promise<string[]> {
  const result = await awsCli(
    [
      "ec2",
      "describe-subnets",
      "--filters",
      `Name=vpc-id,Values=${vpcId}`,
    ],
    region,
  );
  const subnets = (result as {
    Subnets?: Array<{ SubnetId?: string }>;
  }).Subnets;
  if (!subnets || subnets.length === 0) {
    throw new Error(`No subnets found for VPC ${vpcId}`);
  }
  return subnets.map((s) => s.SubnetId).filter(Boolean) as string[];
}

/** Create or find a security group by name in a VPC. */
async function ensureSecurityGroup(
  name: string,
  vpcId: string,
  region: string,
): Promise<{ id: string; created: boolean }> {
  // Check if it already exists
  const existing = await awsCli(
    [
      "ec2",
      "describe-security-groups",
      "--filters",
      `Name=group-name,Values=${name}`,
      `Name=vpc-id,Values=${vpcId}`,
    ],
    region,
  );
  const groups = (existing as {
    SecurityGroups?: Array<{ GroupId?: string }>;
  }).SecurityGroups;
  if (groups && groups.length > 0 && groups[0]?.GroupId) {
    return { id: groups[0].GroupId, created: false };
  }

  // Create security group
  const createResult = await awsCli(
    [
      "ec2",
      "create-security-group",
      "--group-name",
      name,
      "--description",
      "Security group for swamp Valkey ElastiCache Serverless access",
      "--vpc-id",
      vpcId,
    ],
    region,
  );
  const groupId = (createResult as { GroupId?: string }).GroupId;
  if (!groupId) throw new Error("Failed to create security group");

  // Add inbound rule for Valkey port from within VPC
  const vpcCidr = await getVpcCidr(vpcId, region);
  await awsCli(
    [
      "ec2",
      "authorize-security-group-ingress",
      "--group-id",
      groupId,
      "--protocol",
      "tcp",
      "--port",
      "6379",
      "--cidr",
      vpcCidr,
    ],
    region,
  );

  // Tag for identification
  await awsCli(
    [
      "ec2",
      "create-tags",
      "--resources",
      groupId,
      "--tags",
      `Key=Name,Value=${name}`,
      "Key=ManagedBy,Value=swamp",
    ],
    region,
  );

  return { id: groupId, created: true };
}

/** Get VPC CIDR block. */
async function getVpcCidr(vpcId: string, region: string): Promise<string> {
  const result = await awsCli(
    ["ec2", "describe-vpcs", "--vpc-ids", vpcId],
    region,
  );
  const vpcs = (result as { Vpcs?: Array<{ CidrBlock?: string }> }).Vpcs;
  if (!vpcs || vpcs.length === 0 || !vpcs[0]?.CidrBlock) {
    throw new Error(`Could not determine CIDR for VPC ${vpcId}`);
  }
  return vpcs[0].CidrBlock;
}

/** Describe an ElastiCache Serverless cache. Returns null if not found. */
async function describeServerlessCache(
  cacheName: string,
  region: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await awsCli(
      [
        "elasticache",
        "describe-serverless-caches",
        "--serverless-cache-name",
        cacheName,
      ],
      region,
    );
    const caches = (result as {
      ServerlessCaches?: Array<Record<string, unknown>>;
    }).ServerlessCaches;
    if (caches && caches.length > 0) return caches[0] ?? null;
    return null;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("ServerlessCacheNotFoundFault") ||
      msg.includes("not found")
    ) {
      return null;
    }
    throw error;
  }
}

/** Create an ElastiCache Serverless cache. */
async function createServerlessCache(
  cacheName: string,
  subnetIds: string[],
  securityGroupId: string,
  region: string,
): Promise<Record<string, unknown>> {
  const result = await awsCli(
    [
      "elasticache",
      "create-serverless-cache",
      "--serverless-cache-name",
      cacheName,
      "--engine",
      "valkey",
      "--subnet-ids",
      ...subnetIds,
      "--security-group-ids",
      securityGroupId,
    ],
    region,
  );
  return (result as { ServerlessCache?: Record<string, unknown> })
    .ServerlessCache ?? {};
}

/** Wait for a serverless cache to become available (polls every 15s, up to 10 min). */
async function waitForCacheAvailable(
  cacheName: string,
  region: string,
): Promise<Record<string, unknown>> {
  const maxWaitMs = 600_000;
  const pollIntervalMs = 15_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const cache = await describeServerlessCache(cacheName, region);
    if (cache) {
      const status = (cache as { Status?: string }).Status;
      if (status === "available") return cache;
      if (status === "create-failed") {
        throw new Error(
          `ElastiCache Serverless cache ${cacheName} creation failed`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Cache ${cacheName} did not become available within ${maxWaitMs / 1000}s`,
  );
}

/** Get the current AWS account ID. */
async function getAccountId(region: string): Promise<string> {
  const result = await awsCli(["sts", "get-caller-identity"], region);
  const account = (result as { Account?: string }).Account;
  if (!account) throw new Error("Could not determine AWS account ID");
  return account;
}

/** Create or retrieve an IAM managed policy. */
async function ensurePolicy(
  policyName: string,
  cacheArn: string,
  region: string,
): Promise<{ arn: string; created: boolean }> {
  const accountId = await getAccountId(region);
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  try {
    await awsCli(["iam", "get-policy", "--policy-arn", policyArn], region);
    return { arn: policyArn, created: false };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("NoSuchEntity")) throw error;
  }

  const policyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SwampValkeyElastiCacheAccess",
        Effect: "Allow",
        Action: [
          "elasticache:Connect",
          "elasticache:DescribeServerlessCaches",
        ],
        Resource: [cacheArn],
      },
    ],
  });

  const result = await awsCli(
    [
      "iam",
      "create-policy",
      "--policy-name",
      policyName,
      "--policy-document",
      policyDocument,
      "--description",
      "Least-privilege policy for @webframp/valkey-datastore ElastiCache Serverless access",
    ],
    region,
  );
  const policy = (result as { Policy?: { Arn?: string } }).Policy;
  if (!policy?.Arn) throw new Error("Failed to create IAM policy");
  return { arn: policy.Arn, created: true };
}

/** Provisioner model definition. */
export const model = {
  type: "@webframp/elasticache-datastore-bootstrap/provisioner",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "ElastiCache Serverless cache + security group + IAM policy provisioned for swamp.",
      schema: ProvisionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    provision: {
      description:
        "Create/verify an ElastiCache Serverless (Valkey) cache, security group, and IAM policy for @webframp/valkey-datastore.",
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
          region,
          cache_name,
          vpc_id,
          subnet_ids,
          security_group_name,
          policy_name,
          key_prefix,
        } = context.globalArgs;
        const startMs = Date.now();

        // 1. Resolve VPC
        const resolvedVpcId = vpc_id ?? await getDefaultVpcId(region);

        // 2. Resolve subnets
        const resolvedSubnets = subnet_ids
          ? subnet_ids.split(",").map((s) => s.trim())
          : await getSubnetIds(resolvedVpcId, region);

        // 3. Create or find security group
        const { id: sgId, created: sgCreated } = await ensureSecurityGroup(
          security_group_name,
          resolvedVpcId,
          region,
        );

        // 4. Create or find ElastiCache Serverless cache
        let cacheCreated = false;
        let cache = await describeServerlessCache(cache_name, region);

        if (!cache) {
          await createServerlessCache(
            cache_name,
            resolvedSubnets,
            sgId,
            region,
          );
          cacheCreated = true;
          cache = await waitForCacheAvailable(cache_name, region);
        }

        const cacheArn = (cache as { ARN?: string }).ARN ?? "";
        const cacheStatus = (cache as { Status?: string }).Status ?? "unknown";
        const endpoint = (cache as {
          Endpoint?: { Address?: string; Port?: number };
        }).Endpoint;
        const cacheHost = endpoint?.Address ?? "";
        const cachePort = endpoint?.Port ?? 6379;
        const cacheEndpoint = `rediss://${cacheHost}:${cachePort}`;

        // 5. Create or verify IAM policy
        const { arn: policyArn, created: policyCreated } = await ensurePolicy(
          policy_name,
          cacheArn,
          region,
        );

        // 6. Build datastore config JSON
        const datastoreConfig = JSON.stringify({
          url: cacheEndpoint,
          prefix: key_prefix,
        });

        const durationMs = Date.now() - startMs;

        // 7. Write result
        const handle = await context.writeResource("state", "main", {
          region,
          cacheName: cache_name,
          cacheArn,
          cacheEndpoint,
          cachePort,
          cacheStatus,
          cacheCreated,
          securityGroupId: sgId,
          securityGroupCreated: sgCreated,
          policyArn,
          policyCreated,
          datastoreConfig,
          provisionedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
