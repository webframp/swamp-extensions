# @webframp/nix

A swamp execution driver that runs model methods inside a Nix shell with
declarative package dependencies. It provides reproducible execution
environments without containers by pulling packages from nixpkgs and
caching them in the Nix store.

## Features

- Declarative package dependencies via `nix shell`
- Pin to a specific nixpkgs revision for full reproducibility
- Two execution modes: command mode and bundle mode
- Configurable timeouts with graceful SIGTERM/SIGKILL shutdown
- Environment variable passthrough for AWS and SWAMP prefixes

## Execution Modes

**Command mode** runs a shell command string directly inside the Nix shell.
Standard output becomes the resource data, and standard error streams as logs.

**Bundle mode** writes a swamp bundle to a temporary file and executes it
with Deno inside the Nix shell, parsing structured JSON output.

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
    flakeRef: "nixpkgs"           # default
    nixpkgsRev: "abc123"          # optional: pin to a specific revision
    timeout: 300000               # default: 5 minutes (ms)
    impure: true                  # default: pass --impure to nix shell
    extraArgs: []                 # additional nix flags
```

## Usage Example

Reference the driver in a model definition to run commands in a reproducible
Nix environment:

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

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
