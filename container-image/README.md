# @webframp/container-image

Build, push, and inspect OCI container images. Registry-agnostic — works with
ECR, GHCR, DockerHub, or any OCI-compliant registry.

## Methods

- **login** — Authenticate to a private registry (password via stdin)
- **build** — Build an image from a Dockerfile via `buildx` (supports
  multi-platform)
- **push** — Push a built image, captures remote digest
- **inspect** — Read local image metadata (architecture, size, creation time)

## Usage

```bash
# Create the model
swamp model create @webframp/container-image my-image

# Build (ARM64 for AgentCore, local context)
swamp model method run my-image build \
  --input contextPath=./worker \
  --input tag=123456789012.dkr.ecr.us-east-1.amazonaws.com/swamp-worker:latest \
  --input platform=linux/arm64

# Login to ECR
TOKEN=$(aws ecr get-login-password --region us-east-1)
swamp model method run my-image login \
  --input registry=123456789012.dkr.ecr.us-east-1.amazonaws.com \
  --input password="$TOKEN"

# Push
swamp model method run my-image push \
  --input tag=123456789012.dkr.ecr.us-east-1.amazonaws.com/swamp-worker:latest

# Inspect
swamp model method run my-image inspect \
  --input tag=123456789012.dkr.ecr.us-east-1.amazonaws.com/swamp-worker:latest
```

## Data Outputs

| Spec      | Fields                                                                    | Lifetime |
| --------- | ------------------------------------------------------------------------- | -------- |
| `build`   | tag, imageId, platform, contextPath, dockerfile, buildDurationMs, builtAt | 30d      |
| `push`    | tag, digest, size, pushedAt, pushDurationMs                               | 30d      |
| `inspect` | tag, id, digest, architecture, os, size, created, inspectedAt             | 7d       |

## CEL References

```yaml
# Get the digest from the last push
digest: ${{ data.latest("my-image", "push").attributes.digest }}

# Get the image ID from the last build
imageId: ${{ data.latest("my-image", "build").attributes.imageId }}
```

## Install

```bash
swamp extension pull @webframp/container-image
```
