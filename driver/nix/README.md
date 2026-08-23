# @webframp/nix

A swamp execution driver that runs model methods inside a Nix shell with
declarative package dependencies. It provides reproducible execution
environments without containers by pulling packages from nixpkgs and caching
them in the Nix store.

## Features

- Declarative package dependencies via `nix shell`
- Pin to a specific nixpkgs revision for full reproducibility
- Two execution modes: command mode and bundle mode
- Configurable timeouts with graceful SIGTERM/SIGKILL shutdown
- Environment variable passthrough for AWS and SWAMP prefixes (bundle mode
  only — command mode inherits the full parent environment unmodified)

## Execution Modes

**Command mode** runs a shell command string directly inside the Nix shell.
Standard output becomes the resource data, and standard error streams as logs.

**Bundle mode** writes a swamp bundle to a temporary file and executes it with
Deno inside the Nix shell, parsing structured JSON output.

## Configuration

The driver accepts the following configuration keys:

```yaml
driver:
  type: "@webframp/nix"
  config:
    packages:
      - dig
      - whois
      - openssl
    flakeRef: "nixpkgs" # default
    nixpkgsRev: "abc123" # optional: pin to a specific revision
    timeout: 300000 # default: 5 minutes (ms)
    impure: true # default: pass --impure to nix shell
    extraArgs: [] # additional nix flags
```

## Usage Example

Reference the driver in a model definition to run commands in a reproducible Nix
environment:

```yaml
models:
  - type: network/dns
    driver:
      type: "@webframp/nix"
      config:
        packages: [dig, whois]
        nixpkgsRev: "e89cf1c932006531f454de7d652163a9a5c86668"
    methods:
      lookup:
        run: "dig +short example.com"
```

## Troubleshooting

- **`Could not run "nix" — is it installed and on PATH?`** — `nix_driver.ts`
  catches `Deno.errors.NotFound` from `Deno.Command("nix", ...).spawn()`
  specifically to add this hint, because the raw error is just "No such
  file or directory" with no mention of which binary is missing. Install
  Nix on the host running swamp (or add it to `PATH`) — the driver never
  falls back to a container or bundled Nix.

- **Command fails with `Nix shell command timed out after <N>ms` (or
  `Nix bundle execution timed out after <N>ms`)** — the driver's default
  timeout is 300000ms (5 minutes) if `config.timeout` isn't set. On
  timeout it sends `SIGTERM`, waits 5000ms (`SIGKILL_GRACE_MS`), then
  sends `SIGKILL` if the process is still alive. Slow-building Nix
  environments (large or uncached package sets, no binary cache reachable)
  can eat this budget before your command even starts running — raise
  `timeout` in the driver config rather than assuming the command itself
  is hanging.

- **Failure message is just `Nix shell exited with code <N>`** — this is
  the fallback used when the process exits non-zero but writes nothing to
  stderr (`error: stderrResult || `Nix shell exited with code ${status.code}``).
  A bare exit code with no stderr usually means the package name passed
  in `packages` doesn't resolve on the pinned (or unpinned) `nixpkgsRev` —
  try `nix shell nixpkgs#<package>` locally to confirm the flake ref
  resolves before assuming the wrapped command itself failed.

- **Bundle mode can't see an env var that command mode can** — only
  bundle-mode execution restricts the child's environment: `nix_driver.ts`
  builds an explicit allowlist of `AWS_*`, `SWAMP_*`, `HOME`, `PATH`,
  `USER`, and `DENO_DIR` for the `deno run` process inside the nix shell.
  Command mode (`run: "..."`) does not set an `env` override at all and
  inherits the full parent process environment. If a bundle-mode model
  needs a custom API key or other env var, it will silently not see it —
  there's no config knob to extend the allowlist, so pass such values
  through `globalArgs`/`methodArgs` instead.

- **Config rejected at driver creation with `Nix driver requires 'packages'
  array...` or `'timeout' must be a positive number...`** — `parseConfig`
  validates eagerly: `packages` must be a non-empty array of non-empty
  strings, and `timeout` (if set) must be `> 0`. These are validation
  errors at driver instantiation, not execution failures — fix the
  `driver.config` block in the model definition.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
