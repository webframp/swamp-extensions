# @webframp/agentcore

Swamp execution driver that runs model methods in isolated AWS Bedrock AgentCore
microVM sessions. Any swamp model can execute remotely by adding a `driver`
field — no code changes to the model itself.

## Installation

```sh
swamp extension pull @webframp/agentcore
```

## How It Works

```
Local (swamp DAG) ──► S3 (stage bundle + request) ──► AgentCore (microVM boots)
                                                              │
                                                    pulls assets from S3
                                                    executes method (Deno)
                                                    writes output to S3
                                                              │
Local (poll S3) ◄── S3 (read status + outputs) ◄─────────────┘
```

The driver uses S3 as a coordination bus:

1. Swamp bundles the model TypeScript and stages it to S3 alongside the request
2. The driver invokes an AgentCore runtime via the AWS SDK
3. A Firecracker microVM boots, pulls assets from S3, executes the method
4. The worker writes outputs and status back to S3, then terminates
5. The driver polls S3 for the status, retrieves outputs, returns them to swamp

This approach is fault-tolerant (worker crash = no output = driver reports
error), has no duration limit beyond your configured timeout, and supports high
fan-out (hundreds of concurrent workers write independently).

## What Gets Installed vs What Gets Deployed

Installing this extension (`swamp extension pull`) gives you the **driver
client** — the code that stages assets to S3, invokes the runtime, and polls for
results. This runs locally wherever swamp runs.

Separately, you must **deploy the worker infrastructure** into your AWS account:

- An S3 bucket for task coordination
- An ECR repository with the worker container image
- An AgentCore runtime configured to use that image
- An IAM role granting the runtime S3 access

Use `@webframp/agentcore-bootstrap` to provision all infrastructure
automatically.

## Prerequisites

Deploy the worker infrastructure before using this driver. The
`@webframp/agentcore-bootstrap` extension handles this as a one-shot workflow:

```bash
swamp extension pull @webframp/agentcore-bootstrap
swamp model create @webframp/agentcore-bootstrap/provisioner agentcore-provisioner
swamp workflow run @webframp/bootstrap-agentcore \
  --input bucket_name=swamp-agentcore-coord-us-east-1 \
  --input region=us-east-1
```

This creates the S3 bucket, ECR repository, builds and pushes the worker image,
creates the IAM role, and deploys the AgentCore runtime. The output provides the
`runtimeArn` and `bucketName` for driver configuration.

### Manual Prerequisites

If provisioning manually, you need:

1. **S3 bucket** — coordination bus for task artifacts
2. **ECR repository + worker image** — ARM64 container image running the swamp
   worker (source in `@webframp/agentcore-bootstrap`)
3. **AgentCore runtime** — deployed via `aws bedrock-agentcore create-runtime`,
   referencing the ECR image and an IAM role trusting
   `bedrock-agentcore.amazonaws.com`
4. **IAM permissions** for the caller:
   - `s3:PutObject`, `s3:GetObject` on the coordination bucket
   - `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN
5. **IAM permissions** for the worker role:
   - `s3:GetObject`, `s3:PutObject` on the coordination bucket

## Configuration

```yaml
driver: "@webframp/agentcore"
driverConfig:
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent-runtime/swamp_worker"
  region: "us-east-1"
  s3Bucket: "my-swamp-coordination-bucket"
  s3Prefix: "swamp-agentcore/tasks" # optional, default shown
  timeout: 900000 # ms, default 15 min
  pollInterval: 5000 # ms, default 5s
  profile: "my-aws-profile" # optional, for local credential resolution
  env: # optional extra env vars for worker
    AWS_PROFILE: "target-account"
```

| Field          | Required | Default                 | Description                                |
| -------------- | -------- | ----------------------- | ------------------------------------------ |
| `runtimeArn`   | yes      | —                       | ARN of the deployed AgentCore runtime      |
| `region`       | no       | `us-east-1`             | AWS region for S3 and AgentCore calls      |
| `s3Bucket`     | yes      | —                       | S3 bucket for task coordination            |
| `s3Prefix`     | no       | `swamp-agentcore/tasks` | Key prefix for task artifacts              |
| `timeout`      | no       | `900000` (15m)          | Max wait time for worker completion        |
| `pollInterval` | no       | `5000` (5s)             | Interval between S3 status polls           |
| `profile`      | no       | —                       | AWS profile for credential resolution      |
| `env`          | no       | `{}`                    | Extra environment variables for the worker |

## Usage

### Workflow-level (all steps run on AgentCore)

```yaml
name: remote-sweep
driver: "@webframp/agentcore"
driverConfig:
  runtimeArn: arn:aws:bedrock-agentcore:us-east-1:123456789012:agent-runtime/swamp_worker
  region: us-east-1
  s3Bucket: swamp-agentcore-coord-us-east-1
jobs:
  - name: sweep
    steps:
      - name: run-sweep
        task:
          type: model_method
          modelType: "@webframp/aws/adopt"
          modelName: "adopt-prod"
          methodName: sweep
```

### Per-job override (selective remote execution)

```yaml
jobs:
  - name: heavy-sweep
    driver: "@webframp/agentcore"
    driverConfig:
      runtimeArn: arn:aws:bedrock-agentcore:us-east-1:123456789012:agent-runtime/swamp_worker
      region: us-east-1
      s3Bucket: swamp-agentcore-coord-us-east-1
    steps:
      - name: fan-out
        forEach: { item: account, in: "${{ inputs.accounts }}" }
        task:
          type: model_method
          modelType: "@webframp/aws/adopt"
          modelName: "adopt-${{ self.account }}"
          methodName: sweep
  - name: local-report
    dependsOn: [{ job: heavy-sweep, condition: { type: succeeded } }]
    steps:
      - name: summarize
        task:
          type: model_method
          modelType: "@webframp/aws/cost-report"
          modelName: sweep-report
          methodName: generate
```

### CLI one-shot override

Test any model method on AgentCore without modifying YAML:

```sh
swamp model method run my-model sweep \
  --driver @webframp/agentcore \
  --input filter='status == "running"'
```

## Driver Resolution Priority

```
step > job > workflow > model definition > default "raw"
```

The first non-undefined `driver` value wins. Config is not merged across levels.

## AgentCore Constraints

- **Architecture**: ARM64 only (Firecracker microVMs)
- **Resources**: 2 vCPU, 8 GB RAM per session
- **Duration**: 8 hour maximum per invocation
- **Ports**: 8080 (primary), 8000, 9000
- **Networking**: outbound internet access available

## Worker Runtime

The worker container runs inside AgentCore's Firecracker microVM. Each
invocation boots a fresh microVM — there is no state persistence between
invocations.

The worker:

1. Receives a task manifest on `POST /invocations`
2. Pulls the extension bundle from S3
3. Pulls the request envelope from S3
4. Generates a runner harness and executes the method via a Deno subprocess
5. Writes outputs and status back to S3
6. Returns 200, microVM terminates

The worker source and container image are maintained in the
`@webframp/agentcore-bootstrap` extension.

## S3 Object Lifecycle

Each task creates objects under `s3://<bucket>/<prefix>/<taskId>/`:

- `bundle.js` — the bundled model TypeScript
- `request.json` — the execution request envelope
- `status.json` — worker status (written by worker)
- `outputs/output-N.json` — method outputs (written by worker)

These objects are not automatically cleaned up after execution. Configure an S3
lifecycle rule to expire objects under the task prefix (e.g., 7-day expiration)
to avoid unbounded growth.

## When to Use AgentCore vs Other Drivers

| Scenario                                          | Driver                |
| ------------------------------------------------- | --------------------- |
| Quick local iteration, <30s methods               | `raw`                 |
| Network-sensitive AWS API calls in-region         | `@webframp/agentcore` |
| Large fan-out (100+ concurrent sweeps)            | `@webframp/agentcore` |
| Methods that need local filesystem (reports, git) | `raw`                 |
| CI/CD pipelines in GitHub Actions                 | `raw` or `docker`     |
| Methods needing x86_64 or GPU                     | `docker`              |

## Rollback

Remove the `driver:` / `driverConfig:` fields or set `driver: raw` to revert to
local in-process execution. No data migration needed — outputs are written to
the same datastore regardless of driver.

## License

MIT
