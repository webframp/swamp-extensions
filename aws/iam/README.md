# @webframp/aws/iam

Cross-account IAM observation model for role, user, and policy inventory.

## Usage

```bash
# Create a model instance
swamp model create @webframp/aws/iam iam-fleet \
  --set profiles='["prod-readonly","staging-readonly","dev-readonly"]'

# Discover all IAM state
swamp model method run iam-fleet discover_all

# Or discover incrementally (discover_trust_map requires discover_roles to
# have run first — it reads the roles-<profile> resources, it does not
# call the IAM API itself)
swamp model method run iam-fleet discover_roles
swamp model method run iam-fleet discover_users
swamp model method run iam-fleet discover_policies
swamp model method run iam-fleet discover_trust_map
```

## Query Examples

```bash
# Find roles with external trusts (unknown accounts)
swamp data query iam-fleet 'specName == "trustMap" && size(attributes.externalTrusts) > 0'

# Find users without MFA
swamp data query iam-fleet 'specName == "users" && attributes.users.exists(u, !u.mfaEnabled)'

# Find access keys older than 90 days
swamp data query iam-fleet 'specName == "users" && attributes.users.exists(u, u.accessKeys.exists(k, k.ageDays > 90 && k.status == "Active"))'
```

## Resources

| Resource | Description |
|----------|-------------|
| `roles` | Per-account role inventory with trust policies |
| `users` | Per-account user inventory with credential metadata |
| `policies` | Per-account customer-managed policy metadata |
| `trustMap` | Cross-account trust graph (edges, external, service) |

## Methods

| Method | Description |
|--------|-------------|
| `discover_roles` | Fan-out role discovery across profiles |
| `discover_users` | Fan-out user discovery with MFA and key status |
| `discover_policies` | Customer-managed policy metadata |
| `discover_trust_map` | Build trust graph from discovered roles (reads previously written `roles-<profile>` resources; does not call IAM itself — run `discover_roles` first) |
| `discover_all` | Orchestrate all discovery methods |

## Required Permissions

All methods are read-only. The configured profiles need:

- `iam:ListRoles`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`
- `iam:ListUsers`, `iam:ListMFADevices`, `iam:ListAccessKeys`, `iam:GetAccessKeyLastUsed`
- `iam:ListAttachedUserPolicies`, `iam:ListUserPolicies`
- `iam:ListPolicies`
- `sts:GetCallerIdentity`

## Troubleshooting

**A profile silently produces no `roles`/`users`/`policies` resource.**
`discover_roles`, `discover_users`, and `discover_policies` each wrap their
per-profile work in a `try/catch` that logs a `warn`-level message
(`"IAM role discovery failed for profile {profile}: {err}"`, and the
equivalent for users/policies) and moves on to the next profile — it does
not throw. A bad or expired credential, a profile missing from
`~/.aws/config`, or an `AccessDenied` on one of the required IAM/STS calls
all degrade the same way: `discover_all` still returns success with fewer
`dataHandles` than expected. Check the model's warn-level logs (not just
whether the method run "succeeded") when a profile's resource is missing.

**`discover_trust_map` fails with "No role data found. Run discover_roles
first."** This method never calls the IAM API — it reads the
`roles-<profile>` resources written by `discover_roles` for the profiles in
scope and derives the trust graph from their `trustPolicy` fields. If no
`discover_roles` run has completed for any configured profile (or all of
them failed per the point above), `discover_trust_map` throws this exact
error instead of writing an empty `trustMap`.

**`pathPrefix` filters can produce an empty inventory with no error.** All
three discovery methods pass `pathPrefix` (default `/`) as the `PathPrefix`
filter to `ListRoles`/`ListUsers`/`ListPolicies`. A prefix that doesn't
match any role/user/policy path returns a clean empty page from AWS —
there's no distinction in the output between "nothing exists" and "your
prefix excluded everything." If a discovery resource comes back empty,
re-check `pathPrefix` before assuming the account has no IAM principals.

**Large accounts can hit the `truncated: true` pagination cap.** Each
discovery method paginates up to `MAX_PAGES = 200` pages at 100 items per
page (20,000 roles/users/policies) before stopping and setting
`truncated: true` on the resource, even though more pages remain. This is
a hardcoded, unconfigurable cap — there's no `--input` to raise it. It's
unlikely to matter for a single account's roles or users, but a large org
with many customer-managed policies (or a very deep discovery across many
accounts) can hit it; check `truncated` on the resource before treating a
`policies`/`roles`/`users` list as complete.

**Malformed trust policy documents silently disappear.** `parseTrustPolicy`
wraps its JSON decode/parse in a `try/catch` that returns `[]` on any
failure, with no log line. A role whose `AssumeRolePolicyDocument` fails to
decode ends up with an empty `trustPolicy`, which means it contributes zero
edges to `discover_trust_map`'s output — it isn't flagged as external,
wildcard, or unparseable, it just doesn't appear in the trust graph at
all. If a role you expect to see cross-account trust for is missing from
`trustMap`, check the raw `AssumeRolePolicyDocument` on that role directly
rather than trusting an absence of edges to mean "no external trust."
