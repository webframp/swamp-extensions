/**
 * AgentCore bootstrap provisioner.
 *
 * Creates the AWS infrastructure required to run the @webframp/agentcore
 * execution driver: ECR repository, worker container image, IAM role,
 * S3 coordination bucket, and AgentCore runtime.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("us-east-1")
    .describe("AWS region for all resources"),
  bucket_name: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/)
    .describe("S3 bucket name for task coordination"),
  ecr_repo_name: z
    .string()
    .default("swamp-agentcore-worker")
    .describe("ECR repository name for the worker image"),
  runtime_name: z
    .string()
    .default("swamp-worker")
    .describe("AgentCore runtime name"),
  role_name: z
    .string()
    .default("SwampAgentCoreWorkerRole")
    .describe("IAM role name for the AgentCore worker"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  region: z.string(),
  bucketName: z.string(),
  bucketCreated: z.boolean(),
  ecrRepositoryUri: z.string(),
  ecrRepositoryArn: z.string(),
  roleArn: z.string(),
  runtimeArn: z.string(),
  imageTag: z.string(),
  provisionedAt: z.string(),
  durationMs: z.number(),
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
    throw new Error(`AWS CLI failed: ${stderr}`);
  }
  const stdout = new TextDecoder().decode(output.stdout);
  return stdout.trim() ? JSON.parse(stdout) : {};
}

/** Check if an S3 bucket exists. Only treats "not found" as false; rethrows other errors. */
async function bucketExists(name: string, region: string): Promise<boolean> {
  try {
    await awsCli(["s3api", "head-bucket", "--bucket", name], region);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("404") || msg.includes("NoSuchBucket") ||
      msg.includes("Not Found")
    ) {
      return false;
    }
    throw error;
  }
}

/** Check if an ECR repository exists. Only treats "not found" as null; rethrows other errors. */
async function ecrRepoExists(
  name: string,
  region: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await awsCli(
      ["ecr", "describe-repositories", "--repository-names", name],
      region,
    );
    const repos = result.repositories as Array<Record<string, unknown>>;
    return repos?.[0] ?? null;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("RepositoryNotFoundException") ||
      msg.includes("does not exist")
    ) {
      return null;
    }
    throw error;
  }
}

/** Model definition for the AgentCore bootstrap provisioner. */
export const model = {
  type: "@webframp/agentcore-bootstrap/provisioner",
  version: "2026.06.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    provision: {
      description: "AgentCore infrastructure provisioning result",
      schema: ProvisionResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    provision: {
      description:
        "Create S3 bucket, ECR repository, IAM role, build and push worker image, and deploy AgentCore runtime.",
      arguments: z.object({
        workerContextPath: z
          .string()
          .default("worker")
          .describe(
            "Path to worker Dockerfile context (relative to extension directory)",
          ),
        imageTag: z
          .string()
          .optional()
          .describe("Override image tag (default: latest)"),
        platform: z
          .string()
          .default("linux/arm64")
          .describe("Container build platform"),
      }),
      execute: async (
        args: {
          workerContextPath: string;
          imageTag?: string;
          platform: string;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, ...a: unknown[]) => void;
            warn: (msg: string, ...a: unknown[]) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          extensionFile: (path: string) => Promise<string>;
        },
      ) => {
        const start = performance.now();
        const { region, bucket_name, ecr_repo_name, runtime_name, role_name } =
          context.globalArgs;

        context.logger.info("Starting AgentCore bootstrap in {region}", {
          region,
        });

        // 1. Create S3 bucket if needed
        let bucketCreated = false;
        if (await bucketExists(bucket_name, region)) {
          context.logger.info("S3 bucket {bucket} already exists", {
            bucket: bucket_name,
          });
        } else {
          context.logger.info("Creating S3 bucket {bucket}", {
            bucket: bucket_name,
          });
          const bucketArgs = [
            "s3api",
            "create-bucket",
            "--bucket",
            bucket_name,
          ];
          if (region !== "us-east-1") {
            bucketArgs.push(
              "--create-bucket-configuration",
              `LocationConstraint=${region}`,
            );
          }
          await awsCli(bucketArgs, region);
          bucketCreated = true;
        }

        // Ensure bucket configuration regardless of whether it was just created
        await awsCli(
          [
            "s3api",
            "put-public-access-block",
            "--bucket",
            bucket_name,
            "--public-access-block-configuration",
            "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
          ],
          region,
        );
        await awsCli(
          [
            "s3api",
            "put-bucket-versioning",
            "--bucket",
            bucket_name,
            "--versioning-configuration",
            "Status=Enabled",
          ],
          region,
        );
        // Expire task artifacts after 7 days to prevent unbounded growth
        const lifecyclePolicy = JSON.stringify({
          Rules: [
            {
              ID: "ExpireTaskArtifacts",
              Status: "Enabled",
              Filter: { Prefix: "swamp-agentcore/tasks/" },
              Expiration: { Days: 7 },
            },
          ],
        });
        await awsCli(
          [
            "s3api",
            "put-bucket-lifecycle-configuration",
            "--bucket",
            bucket_name,
            "--lifecycle-configuration",
            lifecyclePolicy,
          ],
          region,
        );

        // 2. Create ECR repository if needed
        let ecrRepo = await ecrRepoExists(ecr_repo_name, region);
        if (ecrRepo) {
          context.logger.info("ECR repository {repo} already exists", {
            repo: ecr_repo_name,
          });
        } else {
          context.logger.info("Creating ECR repository {repo}", {
            repo: ecr_repo_name,
          });
          const result = await awsCli(
            [
              "ecr",
              "create-repository",
              "--repository-name",
              ecr_repo_name,
              "--image-scanning-configuration",
              "scanOnPush=true",
            ],
            region,
          );
          ecrRepo = (result.repository as Record<string, unknown>) ?? {};
        }

        const ecrUri = ecrRepo.repositoryUri as string | undefined;
        const ecrArn = ecrRepo.repositoryArn as string | undefined;
        if (!ecrUri || !ecrArn) {
          throw new Error(
            `ECR repository ${ecr_repo_name} exists but returned no URI or ARN`,
          );
        }
        const tag = args.imageTag ?? "latest";
        const fullImageTag = `${ecrUri}:${tag}`;

        // 3. Create IAM role for AgentCore worker
        context.logger.info("Ensuring IAM role {role}", { role: role_name });
        let roleArn: string;
        try {
          const roleResult = await awsCli(
            ["iam", "get-role", "--role-name", role_name],
            region,
          );
          const role = roleResult.Role as Record<string, unknown>;
          const arn = role?.Arn as string | undefined;
          if (!arn) {
            throw new Error(
              `IAM get-role returned no ARN for role ${role_name}`,
            );
          }
          roleArn = arn;
          context.logger.info("IAM role already exists: {arn}", {
            arn: roleArn,
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            !msg.includes("NoSuchEntity") && !msg.includes("does not exist")
          ) {
            throw error;
          }
          const trustPolicy = JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  Service: "bedrock-agentcore.amazonaws.com",
                },
                Action: "sts:AssumeRole",
              },
            ],
          });
          const createResult = await awsCli(
            [
              "iam",
              "create-role",
              "--role-name",
              role_name,
              "--assume-role-policy-document",
              trustPolicy,
            ],
            region,
          );
          const createdRole = createResult.Role as Record<string, unknown>;
          const createdArn = createdRole?.Arn as string | undefined;
          if (!createdArn) {
            throw new Error(
              `IAM create-role returned no ARN for role ${role_name}`,
            );
          }
          roleArn = createdArn;
        }

        // Ensure S3 access policy is attached (idempotent)
        const s3Policy = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject"],
              Resource: [`arn:aws:s3:::${bucket_name}/*`],
            },
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: [`arn:aws:s3:::${bucket_name}`],
            },
          ],
        });
        await awsCli(
          [
            "iam",
            "put-role-policy",
            "--role-name",
            role_name,
            "--policy-name",
            "SwampAgentCoreS3Access",
            "--policy-document",
            s3Policy,
          ],
          region,
        );

        // 4. Build and push worker image
        context.logger.info(
          "Building worker image from {path} for {platform}",
          { path: args.workerContextPath, platform: args.platform },
        );
        const workerDir = await context.extensionFile(args.workerContextPath);

        const buildCmd = new Deno.Command("docker", {
          args: [
            "buildx",
            "build",
            "--platform",
            args.platform,
            "-t",
            fullImageTag,
            "--load",
            workerDir,
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const buildOutput = await buildCmd.output();
        if (!buildOutput.success) {
          const stderr = new TextDecoder().decode(buildOutput.stderr);
          throw new Error(`Worker image build failed: ${stderr}`);
        }

        // ECR login — get password then pipe to docker login without shell interpolation
        context.logger.info("Authenticating to ECR");
        const registry = ecrUri.split("/")[0];
        const getPasswordCmd = new Deno.Command("aws", {
          args: ["ecr", "get-login-password", "--region", region],
          stdout: "piped",
          stderr: "piped",
        });
        const passwordOutput = await getPasswordCmd.output();
        if (!passwordOutput.success) {
          const stderr = new TextDecoder().decode(passwordOutput.stderr);
          throw new Error(`ECR get-login-password failed: ${stderr}`);
        }
        const password = new TextDecoder().decode(passwordOutput.stdout).trim();

        const dockerLoginCmd = new Deno.Command("docker", {
          args: ["login", "--username", "AWS", "--password-stdin", registry],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const loginProcess = dockerLoginCmd.spawn();
        const writer = loginProcess.stdin.getWriter();
        await writer.write(new TextEncoder().encode(password));
        await writer.close();
        const loginOutput = await loginProcess.output();
        if (!loginOutput.success) {
          const stderr = new TextDecoder().decode(loginOutput.stderr);
          throw new Error(`ECR login failed: ${stderr}`);
        }

        // Push
        context.logger.info("Pushing worker image to {tag}", {
          tag: fullImageTag,
        });
        const pushCmd = new Deno.Command("docker", {
          args: ["push", fullImageTag],
          stdout: "piped",
          stderr: "piped",
        });
        const pushOutput = await pushCmd.output();
        if (!pushOutput.success) {
          const stderr = new TextDecoder().decode(pushOutput.stderr);
          throw new Error(`Image push failed: ${stderr}`);
        }

        // 5. Create AgentCore runtime
        context.logger.info("Creating AgentCore runtime {name}", {
          name: runtime_name,
        });
        let runtimeArn: string;
        try {
          const runtimeResult = await awsCli(
            [
              "bedrock-agentcore",
              "create-agent-runtime",
              "--agent-runtime-name",
              runtime_name,
              "--agent-runtime-artifact",
              JSON.stringify({
                containerConfiguration: {
                  containerUri: fullImageTag,
                },
              }),
              "--role-arn",
              roleArn,
            ],
            region,
          );
          const createdRuntimeArn = runtimeResult.agentRuntimeArn as
            | string
            | undefined;
          if (!createdRuntimeArn) {
            throw new Error(
              `create-agent-runtime returned no ARN for ${runtime_name}`,
            );
          }
          runtimeArn = createdRuntimeArn;
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            msg.includes("ConflictException") || msg.includes("already exists")
          ) {
            context.logger.warn(
              "Runtime {name} already exists, retrieving ARN",
              { name: runtime_name },
            );
            const listResult = await awsCli(
              [
                "bedrock-agentcore",
                "get-agent-runtime",
                "--agent-runtime-name",
                runtime_name,
              ],
              region,
            );
            const existingArn = listResult.agentRuntimeArn as
              | string
              | undefined;
            if (!existingArn) {
              throw new Error(
                `get-agent-runtime returned no ARN for ${runtime_name}`,
              );
            }
            runtimeArn = existingArn;
          } else {
            throw error;
          }
        }

        const durationMs = Math.round(performance.now() - start);
        context.logger.info(
          "Bootstrap complete in {durationMs}ms. Runtime: {runtimeArn}",
          { durationMs, runtimeArn },
        );

        const handle = await context.writeResource("provision", "main", {
          region,
          bucketName: bucket_name,
          bucketCreated,
          ecrRepositoryUri: ecrUri,
          ecrRepositoryArn: ecrArn,
          roleArn,
          runtimeArn,
          imageTag: fullImageTag,
          provisionedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
