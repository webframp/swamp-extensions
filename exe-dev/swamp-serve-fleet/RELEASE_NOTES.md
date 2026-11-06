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
