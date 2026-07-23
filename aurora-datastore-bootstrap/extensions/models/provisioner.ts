/**
 * Aurora Serverless v2 datastore bootstrap provisioner.
 *
 * Creates the AWS infrastructure required by @webframp/postgres-datastore
 * when targeting Aurora Serverless v2: a DB subnet group, VPC security
 * group, Aurora PostgreSQL cluster with a serverless writer instance,
 * and a scoped IAM managed policy for RDS IAM authentication.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("us-east-1")
    .describe("AWS region for Aurora resources"),
  cluster_identifier: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*$/)
    .default("swamp-datastore")
    .describe("Aurora cluster identifier"),
  instance_identifier: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*$/)
    .default("swamp-datastore-writer")
    .describe("Aurora writer instance identifier"),
  master_username: z
    .string()
    .min(1)
    .max(63)
    .default("swamp")
    .describe("Master database username"),
  master_password: z
    .string()
    .min(8)
    .describe("Master database password (8+ chars)"),
  database_name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .default("swamp")
    .describe("Initial database name"),
  vpc_id: z
    .string()
    .regex(/^vpc-[a-f0-9]+$/)
    .optional()
    .describe("VPC ID (uses default VPC if omitted)"),
  subnet_ids: z
    .string()
    .optional()
    .describe(
      "Comma-separated subnet IDs in 2+ AZs (uses default VPC subnets if omitted)",
    ),
  security_group_name: z
    .string()
    .default("swamp-aurora-access")
    .describe("Security group name for database access"),
  subnet_group_name: z
    .string()
    .default("swamp-aurora-subnets")
    .describe("DB subnet group name"),
  policy_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w+=,.@-]+$/)
    .default("SwampAuroraDatastorePolicy")
    .describe("IAM managed policy name"),
  min_acu: z
    .number()
    .min(0.5)
    .default(0.5)
    .describe("Minimum Aurora capacity units (0.5 = scales near zero)"),
  max_acu: z
    .number()
    .min(1)
    .default(8)
    .describe("Maximum Aurora capacity units"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  region: z.string().describe("AWS region"),
  clusterIdentifier: z.string().describe("Aurora cluster identifier"),
  clusterArn: z.string().describe("Aurora cluster ARN"),
  clusterEndpoint: z.string().describe("Cluster writer endpoint"),
  clusterPort: z.number().describe("Cluster port"),
  clusterStatus: z.string().describe("Cluster status after provisioning"),
  clusterCreated: z.boolean().describe("Whether the cluster was newly created"),
  instanceIdentifier: z.string().describe("Writer instance identifier"),
  subnetGroupName: z.string().describe("DB subnet group name"),
  subnetGroupCreated: z
    .boolean()
    .describe("Whether the subnet group was newly created"),
  securityGroupId: z.string().describe("Security group ID"),
  securityGroupCreated: z
    .boolean()
    .describe("Whether the security group was newly created"),
  policyArn: z.string().describe("IAM managed policy ARN"),
  policyCreated: z.boolean().describe("Whether the policy was newly created"),
  connectionString: z
    .string()
    .describe("PostgreSQL connection string for datastore config"),
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

/** Get default VPC ID. */
async function getDefaultVpcId(region: string): Promise<string> {
  const result = await awsCli(
    ["ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"],
    region,
  );
  const vpcs = (result as { Vpcs?: Array<{ VpcId?: string }> }).Vpcs;
  if (!vpcs || vpcs.length === 0) {
    throw new Error("No default VPC found — provide vpc_id explicitly");
  }
  return vpcs[0]?.VpcId ?? "";
}

/** Get subnet IDs for a VPC. */
async function getSubnetIds(
  vpcId: string,
  region: string,
): Promise<string[]> {
  const result = await awsCli(
    ["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`],
    region,
  );
  const subnets = (result as {
    Subnets?: Array<{ SubnetId?: string }>;
  }).Subnets;
  if (!subnets || subnets.length < 2) {
    throw new Error(
      `Need at least 2 subnets in different AZs for Aurora, found ${
        subnets?.length ?? 0
      } in VPC ${vpcId}`,
    );
  }
  return subnets.map((s) => s.SubnetId).filter(Boolean) as string[];
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

/** Create or find a security group. */
async function ensureSecurityGroup(
  name: string,
  vpcId: string,
  region: string,
): Promise<{ id: string; created: boolean }> {
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

  const createResult = await awsCli(
    [
      "ec2",
      "create-security-group",
      "--group-name",
      name,
      "--description",
      "Security group for swamp Aurora Serverless v2 datastore access",
      "--vpc-id",
      vpcId,
    ],
    region,
  );
  const groupId = (createResult as { GroupId?: string }).GroupId;
  if (!groupId) throw new Error("Failed to create security group");

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
      "5432",
      "--cidr",
      vpcCidr,
    ],
    region,
  );

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

/** Create or find a DB subnet group. */
async function ensureSubnetGroup(
  name: string,
  subnetIds: string[],
  region: string,
): Promise<{ name: string; created: boolean }> {
  try {
    await awsCli(
      ["rds", "describe-db-subnet-groups", "--db-subnet-group-name", name],
      region,
    );
    return { name, created: false };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("DBSubnetGroupNotFoundFault")) throw error;
  }

  await awsCli(
    [
      "rds",
      "create-db-subnet-group",
      "--db-subnet-group-name",
      name,
      "--db-subnet-group-description",
      "Subnets for swamp Aurora Serverless v2 datastore",
      "--subnet-ids",
      ...subnetIds,
    ],
    region,
  );
  return { name, created: true };
}

/** Describe an Aurora cluster. Returns null if not found. */
async function describeCluster(
  clusterId: string,
  region: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await awsCli(
      [
        "rds",
        "describe-db-clusters",
        "--db-cluster-identifier",
        clusterId,
      ],
      region,
    );
    const clusters = (result as {
      DBClusters?: Array<Record<string, unknown>>;
    }).DBClusters;
    if (clusters && clusters.length > 0) return clusters[0] ?? null;
    return null;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("DBClusterNotFoundFault")) return null;
    throw error;
  }
}

/** Create an Aurora Serverless v2 cluster. */
async function createCluster(
  clusterId: string,
  masterUsername: string,
  masterPassword: string,
  databaseName: string,
  subnetGroupName: string,
  securityGroupId: string,
  minAcu: number,
  maxAcu: number,
  region: string,
): Promise<void> {
  await awsCli(
    [
      "rds",
      "create-db-cluster",
      "--db-cluster-identifier",
      clusterId,
      "--engine",
      "aurora-postgresql",
      "--engine-version",
      "16.4",
      "--engine-mode",
      "provisioned",
      "--serverless-v2-scaling-configuration",
      JSON.stringify({ MinCapacity: minAcu, MaxCapacity: maxAcu }),
      "--master-username",
      masterUsername,
      "--master-user-password",
      masterPassword,
      "--database-name",
      databaseName,
      "--db-subnet-group-name",
      subnetGroupName,
      "--vpc-security-group-ids",
      securityGroupId,
      "--enable-iam-database-authentication",
      "--storage-encrypted",
      "--copy-tags-to-snapshot",
    ],
    region,
  );
}

/** Create a Serverless v2 writer instance. */
async function createInstance(
  instanceId: string,
  clusterId: string,
  region: string,
): Promise<void> {
  await awsCli(
    [
      "rds",
      "create-db-instance",
      "--db-instance-identifier",
      instanceId,
      "--db-instance-class",
      "db.serverless",
      "--engine",
      "aurora-postgresql",
      "--db-cluster-identifier",
      clusterId,
    ],
    region,
  );
}

/** Wait for a cluster to become available (polls every 15s, up to 10 min). */
async function waitForClusterAvailable(
  clusterId: string,
  region: string,
): Promise<Record<string, unknown>> {
  const maxWaitMs = 600_000;
  const pollIntervalMs = 15_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const cluster = await describeCluster(clusterId, region);
    if (cluster) {
      const status = (cluster as { Status?: string }).Status;
      if (status === "available") return cluster;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Cluster ${clusterId} did not become available within ${maxWaitMs / 1000}s`,
  );
}

/** Get the current AWS account ID. */
async function getAccountId(region: string): Promise<string> {
  const result = await awsCli(["sts", "get-caller-identity"], region);
  const account = (result as { Account?: string }).Account;
  if (!account) throw new Error("Could not determine AWS account ID");
  return account;
}

/** Create or retrieve an IAM managed policy for RDS IAM auth. */
async function ensurePolicy(
  policyName: string,
  clusterArn: string,
  accountId: string,
  clusterId: string,
  masterUsername: string,
  region: string,
): Promise<{ arn: string; created: boolean }> {
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  try {
    await awsCli(["iam", "get-policy", "--policy-arn", policyArn], region);
    return { arn: policyArn, created: false };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("NoSuchEntity")) throw error;
  }

  // Resource ID for rds-db:connect is the DbiResourceId, but we scope to
  // the cluster ARN for DescribeDBClusters and use dbuser/* for connect
  const clusterResourceArn =
    `arn:aws:rds-db:${region}:${accountId}:dbuser:*/${masterUsername}`;

  const policyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SwampAuroraConnect",
        Effect: "Allow",
        Action: "rds-db:connect",
        Resource: clusterResourceArn,
      },
      {
        Sid: "SwampAuroraDescribe",
        Effect: "Allow",
        Action: [
          "rds:DescribeDBClusters",
          "rds:DescribeDBInstances",
        ],
        Resource: [
          clusterArn,
          `arn:aws:rds:${region}:${accountId}:db:${clusterId}-*`,
        ],
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
      "Least-privilege policy for @webframp/postgres-datastore Aurora Serverless v2 access",
    ],
    region,
  );
  const policy = (result as { Policy?: { Arn?: string } }).Policy;
  if (!policy?.Arn) throw new Error("Failed to create IAM policy");
  return { arn: policy.Arn, created: true };
}

/** Provisioner model definition. */
export const model = {
  type: "@webframp/aurora-datastore-bootstrap/provisioner",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "Aurora Serverless v2 cluster + networking + IAM policy provisioned for swamp.",
      schema: ProvisionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    provision: {
      description:
        "Create/verify an Aurora Serverless v2 (PostgreSQL) cluster, networking, and IAM policy for @webframp/postgres-datastore.",
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
          cluster_identifier,
          instance_identifier,
          master_username,
          master_password,
          database_name,
          vpc_id,
          subnet_ids,
          security_group_name,
          subnet_group_name,
          policy_name,
          min_acu,
          max_acu,
        } = context.globalArgs;
        const startMs = Date.now();

        // 1. Resolve VPC and subnets
        const resolvedVpcId = vpc_id ?? await getDefaultVpcId(region);
        const resolvedSubnets = subnet_ids
          ? subnet_ids.split(",").map((s) => s.trim())
          : await getSubnetIds(resolvedVpcId, region);

        // 2. Security group
        const { id: sgId, created: sgCreated } = await ensureSecurityGroup(
          security_group_name,
          resolvedVpcId,
          region,
        );

        // 3. DB subnet group
        const { created: subnetGroupCreated } = await ensureSubnetGroup(
          subnet_group_name,
          resolvedSubnets,
          region,
        );

        // 4. Aurora cluster
        let clusterCreated = false;
        let cluster = await describeCluster(cluster_identifier, region);

        if (!cluster) {
          await createCluster(
            cluster_identifier,
            master_username,
            master_password,
            database_name,
            subnet_group_name,
            sgId,
            min_acu,
            max_acu,
            region,
          );
          clusterCreated = true;

          // Create writer instance
          await createInstance(
            instance_identifier,
            cluster_identifier,
            region,
          );

          cluster = await waitForClusterAvailable(cluster_identifier, region);
        }

        const clusterArn = (cluster as {
          DBClusterArn?: string;
        }).DBClusterArn ?? "";
        const clusterEndpoint = (cluster as { Endpoint?: string })
          .Endpoint ?? "";
        const clusterPort = (cluster as { Port?: number }).Port ?? 5432;
        const clusterStatus = (cluster as { Status?: string }).Status ??
          "unknown";

        // 5. IAM policy
        const accountId = await getAccountId(region);
        const { arn: policyArn, created: policyCreated } = await ensurePolicy(
          policy_name,
          clusterArn,
          accountId,
          cluster_identifier,
          master_username,
          region,
        );

        // 6. Build connection string
        const connectionString = `postgresql://${master_username}:${
          encodeURIComponent(master_password)
        }@${clusterEndpoint}:${clusterPort}/${database_name}`;

        const durationMs = Date.now() - startMs;

        // 7. Write result
        const handle = await context.writeResource("state", "main", {
          region,
          clusterIdentifier: cluster_identifier,
          clusterArn,
          clusterEndpoint,
          clusterPort,
          clusterStatus,
          clusterCreated,
          instanceIdentifier: instance_identifier,
          subnetGroupName: subnet_group_name,
          subnetGroupCreated,
          securityGroupId: sgId,
          securityGroupCreated: sgCreated,
          policyArn,
          policyCreated,
          connectionString,
          provisionedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
