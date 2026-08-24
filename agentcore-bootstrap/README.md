# @webframp/agentcore-bootstrap

One-shot provisioner for the `@webframp/agentcore` execution driver. Creates all
AWS infrastructure needed to run swamp model methods in Bedrock AgentCore
microVMs.

## What It Provisions

```
┌─────────────────────────────────────────────────────────────┐
│  1. S3 bucket (versioned, private, SSE-S3)                  │
│  2. ECR repository (scan-on-push enabled)                   │
│  3. Worker container image (ARM64, pushed to ECR)           │
│  4. IAM role (trusts bedrock-agentcore.amazonaws.com)       │
│  5. AgentCore runtime (references ECR image + role)         │
└─────────────────────────────────────────────────────────────┘
```

All resources are idempotent — running the provisioner again skips existing
resources and only creates what's missing.

## Prerequisites

- AWS credentials in the default credential chain with permissions:
  - `s3:CreateBucket`, `s3:PutBucketVersioning`, `s3:PutPublicAccessBlock`
  - `ecr:CreateRepository`, `ecr:GetAuthorizationToken`
  - `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`
  - `bedrock-agentcore:CreateAgentRuntime`, `bedrock-agentcore:GetAgentRuntime`
- Docker (or podman/buildah) available locally
- `@webframp/container-image` extension installed

## Installation

```bash
swamp extension pull @webframp/agentcore-bootstrap
```

## Usage

### Via workflow (recommended)

```bash
# Create required model instances
swamp model create @webframp/agentcore-bootstrap/provisioner agentcore-provisioner

# Edit to wire globalArguments
swamp model edit agentcore-provisioner
# Set: region, bucket_name, ecr_repo_name, runtime_name, role_name

# Run the bootstrap workflow
swamp workflow run @webframp/bootstrap-agentcore \
  --input bucket_name=swamp-agentcore-coord-us-east-1 \
  --input region=us-east-1
```

### Direct method invocation

```bash
swamp model method run agentcore-provisioner provision \
  --input workerContextPath=worker \
  --input platform=linux/arm64
```

## After Bootstrap

The provisioner writes a `provision` resource under the instance name `main`,
containing the `runtimeArn` and `bucketName`. Use these to configure the
`@webframp/agentcore` driver:

```yaml
driver: "@webframp/agentcore"
driverConfig:
  runtimeArn: ${{ data.latest("agentcore-provisioner", "main").attributes.runtimeArn }}
  region: ${{ data.latest("agentcore-provisioner", "main").attributes.region }}
  s3Bucket: ${{ data.latest("agentcore-provisioner", "main").attributes.bucketName }}
```

Or extract values directly:

```bash
swamp data get agentcore-provisioner --json | jq '.attributes.runtimeArn'
swamp data get agentcore-provisioner --json | jq '.attributes.bucketName'
```

## Configuration

| Global Argument | Required | Default                    | Description                     |
| --------------- | -------- | -------------------------- | ------------------------------- |
| `region`        | no       | `us-east-1`                | AWS region for all resources    |
| `bucket_name`   | yes      | —                          | S3 bucket for task coordination |
| `ecr_repo_name` | no       | `swamp-agentcore-worker`   | ECR repository name             |
| `runtime_name`  | no       | `swamp-worker`             | AgentCore runtime name          |
| `role_name`     | no       | `SwampAgentCoreWorkerRole` | IAM role name                   |

| Method Argument     | Required | Default       | Description                          |
| ------------------- | -------- | ------------- | ------------------------------------ |
| `workerContextPath` | no       | `worker`      | Path to Dockerfile context           |
| `imageTag`          | no       | `latest`      | Image tag to build and push          |
| `platform`          | no       | `linux/arm64` | Target platform (AgentCore is ARM64) |

## Worker Image

The `worker/` directory contains the container image source:

- `Dockerfile` — ARM64 Deno runtime image
- `worker.ts` — HTTP server implementing the AgentCore runtime contract
- `deno.json` / `deno.lock` — pinned dependencies

The worker boots inside a Firecracker microVM, receives a task manifest on
`POST /invocations`, pulls bundle + request from S3, executes the method via a
Deno subprocess, and writes outputs back to S3.

## Relationship to Other Extensions

| Extension                       | Role                                          |
| ------------------------------- | --------------------------------------------- |
| `@webframp/agentcore`           | Driver client (stages, invokes, polls)        |
| `@webframp/agentcore-bootstrap` | Infrastructure provisioner (this extension)   |
| `@webframp/container-image`     | OCI build/push (used by bootstrap internally) |

## Troubleshooting

### Workflow `--input` does not flow to model globalArgs

The workflow accepts inputs like `bucket_name` and `region`, but these are NOT
passed to the model's global arguments. Those must be set on the model instance
itself (via `swamp model edit` or at creation time with `--global-arg`). The
workflow only passes `workerContextPath` and `platform` to the method step.

### No `--profile` support

The extension has no AWS profile configuration. All `aws` CLI calls use whatever
credentials the default chain provides. Set `AWS_PROFILE` in the environment
before running if you need a specific profile.

### Idempotent provisioning — re-run is safe

Running `provision` multiple times is safe. Each resource (S3 bucket, ECR repo,
IAM role, AgentCore runtime) is checked before creation. If it already exists,
creation is skipped and the existing resource's ARN is used.

### Existing AgentCore runtime is not updated

If the runtime already exists (409/ConflictException), the extension falls back
to `get-agent-runtime` to retrieve its ARN but does NOT update it with the new
image. If you rebuilt the worker image, you must manually update or delete the
runtime before re-provisioning.

### S3 lifecycle expires task objects after 7 days

The provisioner applies a lifecycle rule that expires objects under
`swamp-agentcore/tasks/` after 7 days. This prevents unbounded storage growth
from completed task artifacts.

### Docker must be available for image build and push

The `provision` method runs `docker build` and `docker push`. If Docker is not
installed or the daemon is not running, the method fails with the Docker CLI's
error message.

## License

MIT
