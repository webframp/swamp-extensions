# Design: `@webframp/exe-dev/swamp-serve-fleet`

**Status:** DESIGN — for design-review gate. No code written yet. **Date:**
2026-11-05 **Published from:** `~/src/webframp/swamp-extensions`

## Goal

A fat provisioner model plus one bootstrap workflow that stands up a complete,
migrated, working `swamp serve` orchestrator + remote worker fleet on exe.dev
from an operator's local workstation — matching the reference deployment
documented in `devsecops/docs/exe-dev-serve-fleet.md`, but parameterized so any
exe.dev user supplies their own names, datastore, vaults, and admin principal.
No confidential values from the reference deployment are baked in.

Secondary goal: read as a reference others can port to AWS/Azure/GCP. The only
provider-specific surface is "get a VM and reach it over SSH"
(`@webframp/exe-dev/vm` + `@swamp/ssh`); the serve/worker/token/promotion logic
is provider-agnostic.

## Prior art (grounded in real data, not guesses)

- **`@webframp/exe-dev/vm`** (published): VM lifecycle. Composed for VM create.
- **`devsecops` `provision-worker` workflow** (`95302d11-…`): the proven worker
  skeleton — mint worker-token + mint server-token + grant + `exe-dev create` +
  install tailscale/swamp + enroll. Token handoff is via a vault, minted during
  the run, read back with `vault.get`. This design ports that skeleton, evolved
  to the runbook's production shape (`worker daemon enable` systemd service, not
  `worker connect`; `tailscale serve` + exe.dev `share port`, not an SSH reverse
  tunnel).
- **`exe-dev-serve-fleet.md` runbook:** authoritative for the orchestrator side,
  which has **no captured automation** — it was hand-run over SSH on the VM.
  `provision_orchestrator` is therefore genuinely new code derived from the
  runbook (raising adversarial-review stakes on it specifically).
- **Team mode** (`serve/team-mode.md`): the local→fleet promotion is the
  documented `managedConfig` + `datastore claim` flow, not ad-hoc migration.

## Execution model

The workflow runs **on the operator's workstation** (local SQLite datastore,
`local_encryption` vaults during bootstrap). Its whole job is to create serve +
workers where none exist, then migrate the operator's local data into the new
system. No step is placed on a worker (none exist yet); no step runs through
serve (it does not exist yet) until after cutover. No chicken-and-egg.

## Phases (one linear workflow, one approval gate)

```
provision_orchestrator → enroll_worker → verify → promote
  → [approval gate: operator confirms ready to cut over]
  → cutover (datastore claim + restart serve)
```

- **bootstrap** (`provision_orchestrator` → `enroll_worker` → `verify`):
  unattended. End state = a running serve+worker fleet.
- **promote**: unattended. Moves the operator's existing local swamp data into
  the new shared datastore (S3/GCS/…) and migrates vaults to a backend the
  orchestrator can read. The local data becomes the fleet's data.
- **approval gate**: the only human step. `autoResume: true` so serve resumes
  the run when approved. Everything before this point is reversible; `claim` is
  not.
- **cutover**: `datastore config migrate` (managedConfig) +
  `datastore claim
  --address <serveURL>` + restart serve. Serve becomes
  datastore owner; team mode.

## Type: `@webframp/exe-dev/swamp-serve-fleet`

### Global arguments (generic defaults; nothing confidential)

| Arg                | Default                       | Reference deployment value (stripped) |
| ------------------ | ----------------------------- | ------------------------------------- |
| `orchestratorName` | `swamp-serve`                 | `devsecops-serve`                     |
| `workerNamePrefix` | `swamp-worker`                | `devsecops-workers`                   |
| `workerCount`      | `2`                           | 5                                     |
| `placementLabel`   | `role=swamp-fleet`            | `role=devsecops-experiment`           |
| `adminPrincipal`   | _(required)_                  | `user:sean`                           |
| `datastoreType`    | `@swamp/s3-datastore`         | S3                                    |
| `datastoreConfig`  | _(required JSON)_             | bucket/region/namespace               |
| `loopbackPort`     | `8000`                        | 8000                                  |
| `workerPort`       | `4000`                        | 4000                                  |
| `denoVersion`      | _(pinned current)_            | 2.9.8                                 |
| `exeToken`         | vault ref, sensitive          | —                                     |
| `tailnetAuthKey`   | vault ref, sensitive          | —                                     |
| `tokenVault`       | _(required)_                  | where minted tokens land              |
| `serveUrl`         | derived from orchestratorName | the serve address for `claim`         |

### Methods

| Method                   | Does                                                                                                                                                                                                                                                                                                                            | Records resource                                        | dryRun default                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| `provision_orchestrator` | create orchestrator VM; tailnet join (inline authkey, `--accept-dns=false`); install pinned Deno + swamp; mint server/worker-enrollment/dashboard tokens into `tokenVault`; write datastore config; `serve daemon enable` (full flag set from runbook); `tailscale serve --https=<workerPort>`; `exe share port <loopbackPort>` | `orchestrator` (URLs, MagicDNS, token **names**, flags) | n/a                             |
| `enroll_worker`          | fan-out `workerCount` (each own `modelName` — S3-lock gotcha); create worker VMs; tailnet join `--accept-dns=true`; sandbox dir; drop enrollment+server tokens from `tokenVault`; `worker daemon enable` with `placementLabel`                                                                                                  | one `worker` per VM                                     | n/a                             |
| `verify`                 | `swamp worker list` + `/ready` probes                                                                                                                                                                                                                                                                                           | `fleetStatus`                                           | n/a                             |
| `promote`                | `datastore setup extension <datastoreType> --config … --namespace …`; `vault migrate` per vault to orchestrator-readable backend                                                                                                                                                                                                | `promotion`                                             | n/a (safe/reversible)           |
| `cutover`                | `datastore config migrate`; `datastore claim --address <serveUrl>`; restart serve                                                                                                                                                                                                                                               | `cutover`                                               | **true** (irreversible; opt-in) |
| `teardown`               | stop daemons; optional `exe-dev destroy`                                                                                                                                                                                                                                                                                        | —                                                       | **true**                        |

### State discipline (no secret leakage)

Resources store token **names**, principals, URLs, MagicDNS names, flag sets —
never token values, never the reference deployment's KV names. Vault and key
names are operator inputs.

## Workflow: `@webframp/bootstrap-swamp-serve-fleet`

Linear DAG, phases as above, `approval` step before `cutover`,
`autoResume:
true`. Inputs mirror global args with generic defaults; secrets as
`vault.get` refs. Mirrors `aurora-datastore-bootstrap`'s provisioner+workflow
shape.

## What stays a documented prerequisite

- exe.dev account + API token in a vault (`exe-dev/vm setup` mints it).
- A tailnet with the exe.dev catalog integration configured (brief one-time
  manual step) + an auth key in a vault. The model _uses_ it; it does not create
  the integration.
- AWS/GCS creds in the default chain for the chosen datastore.

## Design-review findings (self-run, all resolved)

- **DR-1 [token handoff]** — RESOLVED. Tokens minted during
  `provision_orchestrator` into `tokenVault`, read back by `enroll_worker` via
  `vault.get`. Matches `provision-worker` prior art. Only names stored.
- **DR-2 [execution locus]** — RESOLVED. Bootstrap runs locally; no worker
  placement, no serve dependency pre-cutover. No chicken-and-egg.
- **DR-3 [local→fleet promotion]** — RESOLVED. Promotion is team mode
  (`datastore setup` + `vault migrate` + `datastore config migrate` +
  `datastore claim`), all first-class commands, not reinvented migration.
- **DR-4 [cutover safety]** — RESOLVED. Single approval gate before the one
  irreversible step (`claim`); `cutover` method also `dryRun`-defaults true as a
  second guard.
