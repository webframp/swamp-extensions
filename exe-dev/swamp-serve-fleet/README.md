# @webframp/exe-dev/swamp-serve-fleet

Bootstrap a `swamp serve` orchestrator and a remote worker fleet on
[exe.dev](https://exe.dev), from your local workstation, in one workflow — then
promote your local swamp data into the new system and hand datastore ownership
to serve (team mode).

This is a generalized, reusable form of the reference deployment documented in
the webframp `devsecops` repo. Every site-specific value is an input with a
generic default; no confidential values are baked in. It is also a reference
others can port to AWS, Azure, or GCP: the only provider-specific surface is
"get a VM and reach it over SSH", which `@webframp/exe-dev/vm` handles.

## Architecture

```
Workers ──tailnet──▶ tailscale serve (HTTPS :workerPort) ─┐
                                                          ├─▶ swamp serve
Browser ──▶ exe.dev HTTP proxy (public TLS + auth) ───────┘   (plain HTTP
                                                               127.0.0.1:loopbackPort)
```

Serve binds plain HTTP on loopback. Two native proxies terminate TLS on their
own side: the exe.dev HTTPS proxy fronts the browser dashboard;
`tailscale
serve` fronts the workers. A reverse proxy in the middle would force
Host rewriting, Origin spoofing, CORS for the dashboard's crossorigin assets,
and hand-wired WebSocket upgrades. Binding plain and letting each platform's
proxy do TLS avoids all of it.

## Prerequisites

- An exe.dev account and an API token in a vault. The `@webframp/exe-dev/vm`
  `setup` method mints one:
  `swamp behavior run exe-dev setup --input vaultName=exe-dev --input secretKey=API_TOKEN`.
- A tailnet with the exe.dev catalog integration configured, and a tailnet auth
  key in a vault.
- Credentials in the default chain for the shared datastore you promote to
  (S3/GCS/…).

## Quick start

```bash
swamp extension pull @webframp/exe-dev/swamp-serve-fleet

swamp behavior create @webframp/exe-dev/swamp-serve-fleet swamp-serve-fleet
swamp behavior edit swamp-serve-fleet
# wire global arguments:
#   adminPrincipal:  user:you
#   datastoreConfig: '{"bucket":"my-swamp-data","region":"us-east-1"}'
#   namespace:       myteam                 # optional, for shared datastores
#   tokenVault:      exe-dev
#   exeToken:        ${{ vault.get("exe-dev", "API_TOKEN") }}
#   tailnetAuthKey:  ${{ vault.get("tailscale", "AUTH_KEY") }}
#   workerCount:     2

swamp workflow run @webframp/bootstrap-swamp-serve-fleet \
  --input migrate_vaults='["gitlab"]' \
  --input vault_type=@zts/aws-ssm

# the run suspends at the approval gate once the fleet is up and data promoted:
swamp workflow approve @webframp/bootstrap-swamp-serve-fleet --run <id>
```

## Phases

| Phase | Method                   | What it does                                                                                                                                                                                                                                                        |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `provision_orchestrator` | Create the orchestrator VM, join the tailnet (MagicDNS off), install pinned Deno + swamp, mint server/worker/dashboard tokens into `tokenVault`, enable the serve daemon with the production flag set, expose it via `tailscale serve` and the exe.dev HTTPS proxy. |
| 2     | `enroll_worker`          | Create `workerCount` worker VMs, join the tailnet (MagicDNS on), drop token files from the vault, enable the worker daemon with the placement label.                                                                                                                |
| 3     | `verify`                 | Probe `/ready` and `swamp worker list`.                                                                                                                                                                                                                             |
| 4     | `promote`                | `swamp datastore setup extension <datastoreType>` + `swamp vault migrate` for the named vaults. Safe and reversible.                                                                                                                                                |
| —     | approval gate            | Operator confirms the running, data-promoted fleet before the irreversible step.                                                                                                                                                                                    |
| 5     | `cutover`                | `swamp datastore config migrate` + `swamp datastore claim --address <serveUrl>` + restart serve (team mode). `dryRun` defaults true; the workflow passes false after approval.                                                                                      |

`teardown` (dryRun default true) stops the daemons and optionally destroys the
VMs.

## Global arguments

| Arg                | Default                        | Notes                                         |
| ------------------ | ------------------------------ | --------------------------------------------- |
| `orchestratorName` | `swamp-serve`                  | exe.dev VM name.                              |
| `workerNamePrefix` | `swamp-worker`                 | Workers are `<prefix>-01`, `-02`, …           |
| `workerCount`      | `2`                            | 1–20.                                         |
| `placementLabel`   | `role=swamp-fleet`             | Advertised by every worker.                   |
| `adminPrincipal`   | _(required)_                   | `user:<id>` or `group:<name>`.                |
| `datastoreType`    | `@swamp/s3-datastore`          | Shared datastore extension.                   |
| `datastoreConfig`  | _(required)_                   | JSON for `datastore setup`.                   |
| `namespace`        | _(none)_                       | Datastore namespace slug.                     |
| `loopbackPort`     | `8000`                         | Plain-HTTP port serve binds.                  |
| `workerPort`       | `4000`                         | Tailnet HTTPS port `tailscale serve` exposes. |
| `denoVersion`      | `2.9.8`                        | Pinned on orchestrator and workers.           |
| `tokenVault`       | _(required)_                   | Where minted tokens land.                     |
| `exeToken`         | _(vault ref)_                  | exe.dev API token; sensitive.                 |
| `tailnetAuthKey`   | _(vault ref)_                  | Tailnet auth key; sensitive.                  |
| `magicDnsName`     | _(auto)_                       | Read from the VM if omitted.                  |
| `clubApiKeyPath`   | `~/.config/swamp/club-api-key` | Passed to `serve daemon enable`.              |

## Gotchas (inherited from the reference deployment)

- **Workers need MagicDNS on; the orchestrator keeps it off.** Workers must
  resolve the orchestrator's `*.ts.net` name; the orchestrator reaches serve via
  loopback.
- **`--trusted-hosts` must list every name a client presents**, with and without
  port, or serve's DNS-rebinding defense rejects the request. `buildServeFlags`
  assembles this list.
- **Re-enabling the serve daemon rewrites the unit**, so the full flag set is
  passed every time.
- **Serve caches its vault registry at startup.** `cutover` restarts serve so it
  reloads the migrated vault set.
- **A cold serve start re-hydrates from the datastore**; a large namespace takes
  ~30s. `verify` polls `/ready`.
- **Secrets never land in resources.** Tokens are minted into the vault and read
  back for enrollment; resources record token names only; captured output is
  redacted.

## Security

- `exeToken` and `tailnetAuthKey` are sensitive global arguments — pass vault
  references, never literals.
- The provisioner stores token names, principals, and URLs. It never stores
  token values, and redacts token-shaped and `tskey-` strings from captured
  output.
- `cutover` and `teardown` default to `dryRun: true`.
