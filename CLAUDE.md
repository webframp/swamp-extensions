# Project: swamp-extensions

Community extensions for swamp - models, vaults, datastores, and reports.

## Code Style

- TypeScript strict mode, Deno runtime
- Use named exports: `export const model = { ... }` or `export const vault = { ... }`
- All code must pass `deno check`, `deno lint`, and `deno fmt`
- Include test coverage for all extensions (`*_test.ts` files)

## Extension Structure

Each extension lives in its own directory with:
- `manifest.yaml` - Extension metadata and entry points
- `extensions/models/`, `extensions/vaults/`, etc. - Implementation files
- `deno.json` - Dependencies (import `@systeminit/swamp-testing` for tests)

## Naming Conventions

- Extension types: `@webframp/<name>` (e.g., `@webframp/cloudflare`)
- File names: `snake_case.ts`
- Test files: `<name>_test.ts` next to implementation

## Testing Rules

- Never rely on live cloud services in tests
- Use local HTTP servers (`Deno.serve({ port: 0, onListen() {} }, handler)`) or Deno.Command mocking
- Restore all env vars in a `finally` block
- Tests that create SDK clients with connection pooling need `sanitizeResources: false` with a comment explaining why
- Use `@systeminit/swamp-testing` conformance helpers (`assertVaultExportConformance`, `assertDatastoreExportConformance`, etc.)
- Canonical test example: `vault/gopass/extensions/vaults/gopass_test.ts`

## Commands

Run from extension directory (e.g., `cd vault/macos-keychain`):

```bash
deno task check    # Type check
deno task lint     # Lint
deno task fmt      # Format
deno task test     # Run tests
```

## Versioning

- CalVer format: `YYYY.MM.DD.N` (e.g., `2026.03.31.1`)
- Bump version in `manifest.yaml` for each release
- Pin all npm dependencies to exact versions in `deno.json` (no ranges)

## Publishing

CI auto-publishes when `manifest.yaml` changes on main and the version is newer than the registry. Manual: `swamp extension push manifest.yaml`
