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

## Testing

- Use `@systeminit/swamp-testing` for test utilities
- Mock external APIs with `Deno.serve({ port: 0, onListen() {} }, handler)`
- Run tests: `deno test --allow-net extensions/`

## Versioning

- CalVer format: `YYYY.MM.DD.N` (e.g., `2026.03.31.1`)
- Bump version in `manifest.yaml` for each release
