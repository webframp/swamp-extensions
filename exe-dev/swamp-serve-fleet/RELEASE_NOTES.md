# Release Notes

## 2026.11.05.1

Initial release.

### Added

- `@webframp/exe-dev/swamp-serve-fleet` provisioner behavior with six methods:
  `provision_orchestrator`, `enroll_worker`, `verify`, `promote`, `cutover`, and
  `teardown`.
- `@webframp/bootstrap-swamp-serve-fleet` workflow chaining the phases with a
  single operator approval gate before the irreversible `cutover`
  (`autoResume: true`).
- Composes `@webframp/exe-dev/vm` (declared dependency) for VM lifecycle and
  drives swamp, tailscale, and exe.dev CLIs over SSH for serve/worker/token and
  promotion wiring.
- Production serve flag set (plain HTTP on loopback, `--trusted-hosts` covering
  every presented name, no middle reverse proxy) assembled generically from
  operator inputs.
- Secret discipline: tokens minted during provisioning, copied into the
  operator-named `tokenVault` via a reveal→`vault put` pipeline, and delivered
  to workers over SSH stdin (never argv, never worker→orchestrator SSH);
  resources store token names and vault keys only, never values; captured
  SSH/CLI output is secret-redacted before persistence.
- Serve and worker daemons are enabled as systemd **user** services
  (`daemon enable --user`), matching the reference deployment's lingered
  user-service model.
- `verify` reads the server token from its vault key, asserts it is non-empty,
  and treats an unparseable `swamp worker list` as unhealthy rather than
  silently reporting zero workers.
- `provision_orchestrator` keeps the exe.dev HTTPS proxy private
  (`share set-private`) so the dashboard is never left publicly reachable.
- `provision_orchestrator` and `enroll_worker` are idempotent: VM creation is
  skipped when a VM of that name already exists (the fleet is synced and checked
  first), token provisioning rotates/recreates an existing token with a fresh
  secret instead of failing on a duplicate name, and the remaining steps
  (tailscale join, installs, daemon enable, proxy wiring) are self-asserting. A
  re-run after a partial failure converges rather than erroring.

### Security

- `adminPrincipal`, `tokenVault`, `datastoreType`, `magicDnsName`, and
  `clubApiKeyPath` are format-constrained to reject shell metacharacters before
  they are interpolated into remote SSH (or local `promote`) commands; a
  runtime-resolved `magicDnsName` is validated before use.
- `tailnetAuthKey` is format-validated (`tskey-…`) and delivered to
  `tailscale up` over SSH stdin into `TS_AUTHKEY` (`sudo --preserve-env`), so it
  never appears in argv or the remote `/proc` table.
- `promote` and `cutover` build their `swamp datastore`/`vault` commands as
  explicit argv (no `sh -c`), so config blobs, vault names, and backend types
  are passed as individual arguments and cannot inject a command.
- `cutover` tolerates an already-claimed datastore on a re-run and always
  records its result: if `datastore claim` succeeds but the serve restart fails,
  the resource is still written with `serveRestarted: false` and a
  `restartError`, so a partial cutover is recoverable rather than leaving the
  store claimed, serve down, and no record.
- `promote` accepts `migrateVaults` as an array or a JSON-array string (the
  shape a workflow string input passes), parsing and re-validating each element
  against the vault-name constraint.
- The token reveal→`vault put` pipelines run under `set -o pipefail`, so a `jq`
  parse failure fails the step instead of silently piping an empty token into
  `vault put` (which would surface later as a misleading "empty value" error in
  `enroll_worker`).
- `datastoreConfig` is validated as a JSON object at the schema level, so a
  malformed blob is rejected early with a clear error rather than reaching
  `swamp datastore setup`.
- The `swamp install` steps cap their remote output (`pipefail` + `tail -c`) so
  a verbose installer cannot grow the provisioner's capture buffer without
  bound.
- `provision_orchestrator` and `enroll_worker` pin swamp's bundled Deno to
  `denoVersion` (`deno upgrade --version`) after install, so the configured
  version is actually honored on the fleet rather than being metadata only.
- The secret-stdin SSH helpers arm their SIGTERM/SIGKILL timeouts before writing
  stdin, so a remote process that exits without reading stdin cannot hang the
  call on a full pipe buffer.
