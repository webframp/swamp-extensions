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

## Troubleshooting

- **`Failed to run "docker ...": ...` (or a similar error naming the wrong
  CLI)** — the `command` global argument defaults to `docker`. If the host
  only has `podman`, `nerdctl`, or `buildah` installed (or `docker` isn't on
  `PATH`), every method fails at the `Deno.Command` spawn step. Set the
  binary explicitly: `swamp model create @webframp/container-image my-image
  --global-arg command=podman`.

- **Multi-platform `build` fails with something like "docker exporter does
  not support exporting manifest lists"** — for any CLI other than
  `buildah`, `build` always appends `--load` to `buildx build`
  (`container_image.ts`, `build` method). `--load` only supports a single
  platform; it cannot import a multi-arch manifest list into the local
  image store. Passing a comma-separated `platform` (e.g.
  `linux/amd64,linux/arm64`) with `docker`/`nerdctl` will fail at this step.
  Build one platform at a time, or use `buildah` (which builds without
  `--load`).

- **`push` succeeds but then throws "Pushed <tag> but failed to inspect its
  digest"** — after a successful push, `push` re-runs `image inspect
  --format {{index .RepoDigests 0}}` to read the registry digest back. If
  the local image store hasn't synced `RepoDigests` yet (common right after
  a push from a `buildx --load`'ed image), that index lookup fails against
  an empty list and the whole method errors even though the push itself
  succeeded. Re-running `inspect` a few seconds later, or running `push`
  again, usually picks up the synced digest.

- **`push` result has `size: null` even though the image clearly isn't
  empty** — `size` is parsed with `parseInt(sizeResult.stdout.trim(), 10) ||
  null`. Any non-numeric output from `image inspect --format {{.Size}}`
  (or, in the edge case of a genuinely 0-byte report) collapses to `null`
  rather than surfacing the parse failure. Treat a `null` size as "unknown,"
  not "zero."

- **`inspect` returns `architecture: "unknown"`, `os: "unknown"`, or
  `digest: null`** — these are the schema's explicit fallbacks
  (`raw.Architecture ?? "unknown"`, `raw.RepoDigests?.[0] ?? null`, etc.)
  for whatever the CLI's JSON output didn't populate. `digest: null` in
  particular is expected for an image that was only built locally and never
  pushed — `RepoDigests` is empty until a push completes.
