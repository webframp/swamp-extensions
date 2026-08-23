# @webframp/gitlab-datastore-bootstrap

One-shot bootstrap for `@webframp/gitlab-datastore`. Validates access to a
GitLab project, optionally creates a scoped project access token, and configures
the current swamp repository to use GitLab's Terraform state API as the
datastore backend.

Zero infrastructure required — if you already have a GitLab project, this gives
you a shared datastore with distributed locking in under a minute.

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

| Input                  | Default              | Required | Description                          |
| ---------------------- | -------------------- | -------- | ------------------------------------ |
| `project_id`           | —                    | **yes**  | Numeric ID or path (`group/project`) |
| `token`                | —                    | **yes**  | PAT with `api` scope                 |
| `base_url`             | `https://gitlab.com` | no       | GitLab instance URL                  |
| `username`             | (token owner)        | no       | GitLab username                      |
| `state_prefix`         | `swamp`              | no       | Namespace prefix for state objects   |
| `create_project_token` | `false`              | no       | Create a dedicated project token     |
| `project_token_name`   | `swamp-datastore`    | no       | Token name if creating               |

## What happens

1. **Validates** the project exists and your token has API access
2. **Verifies** the Terraform state API is reachable for the project
3. **Optionally creates** a project access token (Developer role, 1-year expiry)
   scoped to `api` — isolates the datastore credential from your personal token
4. **Configures** the repo datastore pointing at the project

## How it stores data

`@webframp/gitlab-datastore` wraps each piece of swamp data in a Terraform state
envelope. GitLab's native state locking provides distributed lock semantics. No
extra storage or services needed — it piggybacks on GitLab's existing
infrastructure.

## Limitations

- **Rate limits**: GitLab.com enforces API rate limits. High-throughput
  workloads (many concurrent writes) may hit 429s. Best suited for
  low-to-moderate write volumes.
- **State size**: Each Terraform state object is limited to ~10MB on GitLab.com.
  Large binary artifacts may need chunking.
- **Not for production at scale**: This is a convenience/PoC datastore for teams
  already on GitLab. For production workloads, prefer
  `@webframp/postgres-datastore` or `@webframp/dynamodb-datastore`.

## Troubleshooting

**`GitLab token is invalid or expired`**
`validateProject` raises this directly whenever the initial project lookup
returns HTTP 401. Since the same `token` is reused to validate the project,
verify state access, and (optionally) create a project token, an expired PAT
fails at the very first API call — regenerate the token and confirm it still
carries the `api` scope.

**`GitLab project '<id>' not found or token lacks access`**
Raised on HTTP 404 from `validateProject`. GitLab's API returns 404 both for
projects that don't exist and for projects your token can't see — a private
project your PAT's owner isn't a member of looks identical to a typo in
`project_id`. Double-check the numeric ID or `group/project` path against
what you see in the GitLab UI while logged in as the token's owner.

**`Token lacks access to Terraform state API — needs api scope and at least
Developer role`**
`verifyStateAccess` probes
`/projects/:id/terraform/state/<state_prefix>-healthcheck` and treats a 403
specifically as this error; a 200 or 404 both count as success (no state
object existing yet is expected on first run). If your PAT has `api` scope
but you're only a Reporter/Guest on the project, this is the failure you'll
hit even though `validateProject` already passed.

**Bootstrap fails with a JSON-parse error instead of a GitLab error message**
`gitlabApi` tries to `JSON.parse` every response body and raises a parse
error (including the first 300 characters of the raw response) if it isn't
valid JSON. This shows up on self-hosted GitLab instances when `base_url` is
wrong or missing `/`-prefixed paths, or when the instance is behind a login
redirect that returns an HTML page instead of a JSON API response — check
the raw-response snippet in the error message for `<html>` before assuming
it's a GitLab-side outage.

**`Cannot create project access token — requires Maintainer role on the
project`**
Only raised when `create_project_token=true`. `createProjectToken` always
requests `access_level: 30` (Developer) for the new token regardless of the
caller's own role, but GitLab still requires the *calling* token's owner to
be a Maintainer (or higher) to create any project access token — Developer
role is enough to pass `validateProject` and `verifyStateAccess`, but not
this step.

## Development

```bash
cd gitlab-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
