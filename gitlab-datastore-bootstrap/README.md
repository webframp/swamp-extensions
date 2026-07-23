# @webframp/gitlab-datastore-bootstrap

One-shot bootstrap for `@webframp/gitlab-datastore`. Validates access to a
GitLab project, optionally creates a scoped project access token, and
configures the current swamp repository to use GitLab's Terraform state API
as the datastore backend.

Zero infrastructure required — if you already have a GitLab project, this
gives you a shared datastore with distributed locking in under a minute.

## Prerequisites

- A GitLab project (GitLab.com or self-hosted)
- A personal access token with the `api` scope
- Developer role or higher on the project (Maintainer to create project tokens)

## Usage

```bash
swamp extension pull @webframp/gitlab-datastore-bootstrap

swamp model create @webframp/gitlab-datastore-bootstrap/provisioner \
  swamp-gitlab-provisioner
swamp model create command/shell swamp-gitlab-setup

# Basic: use your existing PAT
swamp workflow run @webframp/bootstrap-gitlab-datastore \
  --input project_id=12345 \
  --input token=glpat-xxxxxxxxxxxxxxxxxxxx

# With dedicated project token (recommended for shared use)
swamp workflow run @webframp/bootstrap-gitlab-datastore \
  --input project_id=mygroup/myproject \
  --input token=glpat-xxxxxxxxxxxxxxxxxxxx \
  --input create_project_token=true

swamp datastore status
```

## Inputs

| Input | Default | Required | Description |
|-------|---------|----------|-------------|
| `project_id` | — | **yes** | Numeric ID or path (`group/project`) |
| `token` | — | **yes** | PAT with `api` scope |
| `base_url` | `https://gitlab.com` | no | GitLab instance URL |
| `username` | (token owner) | no | GitLab username |
| `state_prefix` | `swamp` | no | Namespace prefix for state objects |
| `create_project_token` | `false` | no | Create a dedicated project token |
| `project_token_name` | `swamp-datastore` | no | Token name if creating |

## What happens

1. **Validates** the project exists and your token has API access
2. **Verifies** the Terraform state API is reachable for the project
3. **Optionally creates** a project access token (Developer role, 1-year expiry)
   scoped to `api` — isolates the datastore credential from your personal token
4. **Configures** the repo datastore pointing at the project

## How it stores data

`@webframp/gitlab-datastore` wraps each piece of swamp data in a Terraform
state envelope. GitLab's native state locking provides distributed lock
semantics. No extra storage or services needed — it piggybacks on GitLab's
existing infrastructure.

## Limitations

- **Rate limits**: GitLab.com enforces API rate limits. High-throughput
  workloads (many concurrent writes) may hit 429s. Best suited for
  low-to-moderate write volumes.
- **State size**: Each Terraform state object is limited to ~10MB on
  GitLab.com. Large binary artifacts may need chunking.
- **Not for production at scale**: This is a convenience/PoC datastore for
  teams already on GitLab. For production workloads, prefer
  `@webframp/postgres-datastore` or `@webframp/dynamodb-datastore`.

## Development

```bash
cd gitlab-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
