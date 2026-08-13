# Project: swamp-extensions

Community extensions for swamp - models, vaults, datastores, drivers, reports, and workflows.

## Code Style

- TypeScript strict mode, Deno runtime
- Use named exports: `export const model = { ... }`, `export const vault = { ... }`, `export const report = { ... }`, etc.
- All code must pass `deno check`, `deno lint`, and `deno fmt`
- Shell scripts must pass `shellcheck` with no warnings before committing
- Include test coverage for all extensions (`*_test.ts` files)

## Extension Structure

Each extension lives in its own directory with:
- `.swamp.yaml` - Repo marker (run `swamp repo init` in the directory to create)
- `manifest.yaml` - Extension metadata and entry points
- `extensions/models/`, `extensions/vaults/`, `extensions/datastores/`, `extensions/reports/` - Implementation files
- `deno.json` - Dependencies (import `@systeminit/swamp-testing` for tests, optional for model-only extensions)

**Do not commit per-extension `CLAUDE.md` or `AGENTS.md` files.** Running `swamp repo init` generates a managed `CLAUDE.md` in each extension directory — these are local development aids, not project artifacts. To support multiple AI tools, use `swamp repo init --tool claude --tool opencode` (or `swamp repo upgrade --tool opencode` to add a tool later). Both files are excluded by the root `.gitignore`. The root `CLAUDE.md` (symlinked as `AGENTS.md`) is the single source of project guidance.

## Manifest Format

```yaml
manifestVersion: 1
name: "@webframp/extension-name"
version: "2026.04.13.1"          # CalVer: YYYY.MM.DD.N

# At least one extension type required:
models:
  - path/to/model.ts
vaults:
  - path/to/vault.ts
datastores:
  - path/to/datastore.ts
drivers:
  - path/to/driver.ts
reports:
  - path/to/report.ts
workflows:
  - path/to/workflow.yaml

# Optional metadata:
labels: [aws, cost, finops]
platforms: [linux-x86_64, linux-aarch64, darwin-x86_64, darwin-aarch64]
dependencies:
  - "@webframp/other-ext@2026.04.12.1"
include: []                      # Additional files to bundle
```

All paths must be relative, no `..` segments, no absolute paths.

## Extension Types

- **Models** - Typed representations of external systems. Export `model` with `type`, `version`, `methods`, `resources`.
- **Vaults** - Secret storage providers. Implement `VaultProvider`: `get()`, `put()`, `list()`, `getName()`.
- **Datastores** - Storage backends for runtime data. Implement `DatastoreProvider`: `createLock()`, `createVerifier()`, `resolveDatastorePath()`.
- **Drivers** - Custom execution engines. Implement `ExecutionDriver`: `execute(request, callbacks)`.
- **Reports** - Analysis generators scoped to method, model, or workflow. Export `report` with `scope`, `description`, `execute()`.
- **Workflows** - YAML orchestration of model methods across parallel jobs/steps.

## Naming Conventions

- Extension names: `@webframp/<name>` (e.g., `@webframp/cloudflare`) or `@webframp/<category>/<name>` for grouped extensions (e.g., `@webframp/aws/pricing`)
- File names: `snake_case.ts`
- Test files: `<name>_test.ts` next to implementation

## Testing Rules

- Never rely on live cloud services in tests
- Use local HTTP servers (`Deno.serve({ port: 0, onListen() {} }, handler)`) or Deno.Command mocking
- Restore all env vars in a `finally` block
- Tests that create SDK clients with connection pooling need `sanitizeResources: false` with a comment explaining why
- Use `@systeminit/swamp-testing` conformance helpers and test factories

### Test Factories

```typescript
import { createModelTestContext } from "@systeminit/swamp-testing";
import { createReportTestContext } from "@systeminit/swamp-testing";
```

- `createModelTestContext({ globalArgs, storedResources })` - Test model methods, inspect via `getWrittenResources()`, `getLogsByLevel()`
- `createVaultTestContext()` - Test vault operations with mock secrets
- `createDatastoreTestContext()` - Test locking, health checks, sync
- `createDriverTestContext()` - Test execution drivers with captured logs
- `createReportTestContext()` - Test report generation with mock repositories

### Conformance Helpers

- `assertVaultExportConformance(module)` - Validate vault provider exports
- `assertDatastoreExportConformance(module)` - Validate datastore provider exports

### Mocking Utilities

- `withMockedFetch(handler)` - Mock HTTP requests (for API-based extensions)
- `withMockedCommand(handler)` - Mock `Deno.Command` executions (for CLI-based extensions)

### Canonical Test Examples

- Vault (CLI mock): `vault/gopass/extensions/vaults/gopass_test.ts`
- Model (HTTP mock): `cloudflare/extensions/models/cloudflare/zone_test.ts`
- Datastore: `datastore/gitlab-datastore/extensions/datastores/gitlab_datastore/mod_test.ts`

## API Integration Patterns

When building models that wrap external APIs:

- **Client-side filtering changes pagination semantics.** If you move a filter from server-side (API criterion) to client-side (post-fetch), the pagination loop must over-fetch to compensate. A `limit` applied before client-side filtering produces fewer results than requested. Either keep filtering server-side, or paginate until `filtered.length >= limit`.
- **Zod schemas are the contract.** Add `.min()`, `.max()`, and other constraints that match the API's actual limits. Don't rely on runtime slicing to enforce bounds — fail fast at validation.
- **Null safety on SDK responses.** AWS SDK types are often `T | undefined`. Use `?? defaultValue` (not `|| defaultValue`) to handle both `null` and `undefined` without masking falsy values like `0` or `""`.
- **Deterministic resource instance names.** Use filter parameters or entity IDs, not timestamps. `Date.now()` in instance names causes unbounded data accumulation.
- **Run `swamp extension quality manifest.yaml` before pushing.** Extensions must score 14/14 (100%) on the quality rubric. Anything less blocks the PR.
- **Bounded pagination is mandatory.** Never use `Infinity` or unbounded loops for API pagination. Cap fetch limits to a practical multiple (e.g., `limit * 20`) and set a `truncated: boolean` field in the output when results may be incomplete. Unbounded pagination can trigger API throttling and OOM on large accounts.
- **`truncated` must be honest.** If results are sliced, capped, or filtered after fetching, the `truncated` field must reflect whether more data exists. Hardcoding `false` is a data integrity bug.
- **SDK timestamp fields may be `Date` or `string`.** Use `String(field)` or `field?.toISOString?.() ?? String(field)` to normalize. Don't assume the SDK returns strings — some versions return `Date` objects.
- **Instance names must be collision-resistant.** For variable-length ID lists, hash the sorted IDs (e.g., SHA-1 prefix) rather than joining/truncating. Truncated joins produce collisions.
- **Version strings need a single source of truth.** If an external tool or package version appears in both a constant (for provenance metadata) and a call site (CLI arg, import specifier, URL template), derive the call site from the constant — never hardcode the same version in two places. A version bump that updates the constant but misses the invocation is a silent correctness bug that passes all type checks.
- **Schema changes must be additive.** Adding new optional or nullable fields to resource schemas is safe. Adding new required fields, removing fields, or changing field types are breaking changes that require a coordinated version bump, explicit `RELEASE_NOTES.md` **Upgrade note**, and consideration of whether existing stored resources will fail validation on read. When in doubt, make new fields nullable with a sensible default.
- **Every version bump requires `RELEASE_NOTES.md`.** This is not optional. CI passes it to the registry and GitHub release. Without it, users pulling your extension have no idea what changed. See the Release Notes section for format.

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
- **ALWAYS bump `manifest.yaml` version in the first commit of a PR.** Do not defer to a follow-up. The publish workflow keys off version changes — forgetting the bump means the extension won't publish after merge.
- **Exception — test-only changes do not require a version bump or `RELEASE_NOTES.md`.** Test files (`*_test.ts`) are not bundled into the published extension; only the paths in `models`/`vaults`/`datastores`/`drivers`/`reports`/`workflows` and `additionalFiles` are shipped. A PR that changes only test files produces a byte-identical published artifact, so bumping would republish identical bytes with empty release notes. CI still runs the tests on every PR. If a PR changes both a shipped file and its test, the normal bump rule applies.
- **`deno.json` changes DO require a bump and release notes, even tooling-only ones.** Adding a task, correcting `fmt` semantics, or adjusting a `fmt`/`lint` exclude is not a test-only change. The published version stream is how consumers see that an extension is actively maintained and its infrastructure is being kept current — that signal is the point, so tooling changes ride the same rule as code. Say plainly in the release notes that nothing behavioral changed.
- **`fmt` formats, `fmt:check` verifies.** Every extension defines both. A single `fmt` task running `deno fmt --check` is a bug: it makes `deno task fmt` unable to format anything, and leaves CI with no check task to call. If an extension's `fmt` task is unscoped (`deno fmt` with no path), add `fmt.exclude` for `CLAUDE.md` and `AGENTS.md` — they are gitignored and absent in CI, but `deno fmt` does not read `.gitignore`, so without the exclude `fmt:check` fails locally on files CI never sees.
- Pin all npm dependencies to exact versions in `deno.json` (no ranges)
- Swamp's bundler inlines npm packages at bundle time; `deno.lock` does NOT cover extension deps

## Repository Maintenance Sweep

Dependency refresh across the whole repo runs as a swamp workflow rather than a
manual loop of four commands. It ships with `@webframp/extension-maintenance`.

### One-time setup

```bash
swamp extension pull @webframp/extension-maintenance
swamp model create @webframp/extension-maintenance/maintainer ext-maint \
  --global-arg repo_root=/path/to/swamp-extensions
```

The instance must be named `ext-maint` — the shipped workflow references it by
name.

### Running the sweep

```bash
swamp workflow run @webframp/extension-maintenance-sweep
```

Five steps, strictly sequential: `audit` observes staleness across every
extension, `plan` produces a CalVer bump plan, `approve` pauses for human
review, `apply` writes the files, `verify` runs the quality gate.

Inspect the plan while the run is suspended, then approve or reject:

```bash
swamp data get ext-maint current-plan --json
swamp workflow approve @webframp/extension-maintenance-sweep approve
swamp workflow resume @webframp/extension-maintenance-sweep
```

Rejecting marks the run failed and leaves `apply` and `verify` unscheduled.
Nothing is modified, and the audit and plan data remain queryable.

### Rules

1. **The steps cannot be parallelised.** All five target the single `ext-maint`
   model and contend on its per-model lock. The dependency chain is load-bearing,
   not stylistic.
2. **Never auto-approve.** The gate exists because `apply-bump` rewrites
   `manifest.yaml`, `deno.json`, and `RELEASE_NOTES.md` across every stale
   extension in one shot. Read the plan first.
3. **The sweep does not replace the PR flow.** It writes files in your working
   tree. Branch, commit, and open a PR as usual — CI still publishes only what
   lands on main with a bumped version.
4. **Expect a slow audit.** Roughly five minutes across 137 extensions, because
   it queries npm once per deduplicated package. Do not shorten it by fanning
   `audit` out per extension with `forEach` — that defeats the deduplication and
   multiplies registry calls for identical information.
5. **Query the results, don't re-run.** Four resources are written per sweep:
   `current-audit`, `current-plan`, `current-apply`, `current-quality`. Reference
   them with `swamp data get ext-maint <name>` or CEL rather than re-running a
   method.
6. **Run the quality gate standalone when that is all you need.**
   `swamp model method run ext-maint quality-gate` skips the audit entirely, and
   accepts a `filter` glob to scope it to one extension directory.

## Development Workflow

All changes go through pull requests — no direct pushes to main.

1. **Branch** — Create a branch from main. Name it however you like; `feat/`, `fix/`, `docs/` prefixes are conventional but not required.
2. **Develop** — Make changes, run `deno task check && deno task lint && deno task fmt && deno task test` locally in the extension directory.
3. **Commit** — Use [Conventional Commits](https://www.conventionalcommits.org/). Scope is the extension name or directory.
   - `feat(aws/terraform-drift): add VPC drift detection`
   - `fix(cloudflare): handle rate limit on zone list`
   - `docs: update README with new extension`
   - `ci: add redmine to test matrix`
   - `chore(terraform): bump AWS SDK to 3.1020.0`
   - `test(vault/gopass): add edge case for empty store`
4. **Run local adversarial review** — Before pushing, review the branch diff (`git diff origin/main...HEAD`) adversarially yourself, matching the CI adversarial prompt: assume the code is broken and probe for logic errors, edge cases, failure modes, pattern inconsistencies across sibling methods, and unhandled partial failures. Fix findings before pushing to avoid slow review cycles.
5. **Push and open PR** — Push the branch and open a PR against main. CI runs check/lint/fmt/test. The adversarial code review runs automatically on PRs.
6. **Address review** — Fix any issues raised by CI or the adversarial review. Push additional commits (do not force-push over review comments).
7. **Merge** — Comment `/lgtm`, `/approve`, or `/shipit` on the PR. The merge workflow squash-merges after verifying CI passed, then deletes the branch.
8. **Publish** — After merge to main, CI runs again. Only after CI passes does the publish workflow run, auto-publishing any extensions with bumped `manifest.yaml` versions.

**Version bumps**: Bump `version` in `manifest.yaml` (CalVer `YYYY.MM.DD.N`) in the same PR as the code change. Do not bump versions in separate commits or PRs.

**New extensions**: When adding a new extension, update the root `README.md` — add it to the appropriate table, the install commands section, and any relevant usage examples.

## Publishing

CI auto-publishes when `manifest.yaml` changes land on main and CI passes. The publish workflow triggers only after a successful CI run — it will not publish broken code. Do not push extensions locally — always open a PR and let CI handle publishing via `swamp extension push manifest.yaml --yes`.

## Release Notes

Every version bump **must** include a `RELEASE_NOTES.md` in the extension directory. CI passes this to `swamp extension push --release-notes` and to `gh release create --notes`. Without it, the registry and GitHub release get generic placeholder text that tells users nothing.

### Format

```markdown
## <version>

**Fixed:** One-line per fix. Lead with what was broken, not how you fixed it.

**Added:** New methods, resources, or capabilities.

**Changed:** Behavioral changes, even if they're improvements. Users who depend on
the old behavior need to know.

**Upgrade note:** Dependency changes, required co-upgrades, or migration steps.
```

### Rules

1. **Write for the user who runs `swamp extension pull`.** They care about what changed in behavior, not about internal refactoring.
2. **Call out behavioral changes explicitly.** If a method that previously failed silently now returns data, say so. If log output changes, say so.
3. **Include co-upgrade requirements.** If extension A depends on extension B at a specific version, state that both must be pulled together.
4. **Keep it under 5000 characters** (the `--release-notes` flag limit).
5. **Do not include the file in `additionalFiles` in the manifest.** It is consumed by CI only, not bundled into the published extension.
6. **Overwrite per version.** The file always describes the current version being published. Previous notes live in git history and GitHub releases.

## Swamp Skills

Two skills are available for guidance when working on extensions:

- `swamp` — Unified skill covering the full CLI: models, workflows, data, vaults, extensions, publishing, repos, reports, issues, and troubleshooting. Contains a routing table that dispatches to sub-guides by topic (e.g., `references/model/guide.md`, `references/extension/guide.md`, `references/workflow/guide.md`). Load the skill, then follow the routing table to the relevant guide.
- `swamp-getting-started` — Interactive onboarding walkthrough for new swamp users (state-machine checklist with verification at each step).

## Project Skills

Project-level skills in `skills/` at the repo root:

- `skills/pr-workflow.md` - End-to-end PR workflow: branch, develop, push, respond to adversarial review, iterate until CI passes, merge
- `skills/update-stale-deps.md` - Fix stale swamp extension dependency pins in workflow manifests
- `skills/bump-npm-deps.md` - Audit and upgrade npm dependencies (AWS SDK, zod, postgres) across all extensions
