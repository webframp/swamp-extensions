## 2026.08.21.2

**Changed:** `quality-gate` failures now include the actual command output.
Previously a failing `deno task check`/`lint`/`fmt`/`test` or
`swamp extension fmt --check` only recorded a bare "check failed" / "lint
failed" style message with no indication of what broke; the `errors` array now
embeds a truncated snippet of the command's stderr (or stdout when stderr is
empty) so you can diagnose a failure from the quality report alone.
`apply-bump`'s `deno cache` regeneration failure message now includes the
`deno cache` stderr output instead of a generic "may be out of sync" note.

## 2026.08.21.1

**Changed:** Added `.describe()` documentation to previously undocumented schema
fields: the `extensions` array in `AuditSummarySchema`, the `changes[].category`
enum and `entries` array in the bump-plan schemas, and the error/result fields
in `ApplyResultSchema` and `QualityResultSchema`. No behavioral change.

## 2026.08.15.1

**Fixed:** Restore comment line in `maintainer.ts` truncated by apply-bump's
over-broad version regex (matched `@opentelemetry/api@1.9.1` inside a code
comment and stripped trailing text).

## 2026.08.06.1

**Fixed:** `plan-bump` no longer assumes that source file version strings match
`manifest.yaml`. It now reads the actual `version:` fields from `.ts` source
files via a new `readSourceVersions` helper and emits find/replace patterns for
each distinct version found. This fixes silent no-ops during `apply-bump` when a
prior partial bump left source and manifest versions out of sync (as happened
with `agentcore-bootstrap/provisioner.ts` in the 2026.08.05 sweep).

**Fixed:** `checkUpgradeChain` now cross-validates that each source file's model
version matches the manifest version. Previously it only checked internal
consistency (last `toVersion` == `version:` within the same file), so a file
whose version drifted from the manifest passed silently. Both `apply-bump` and
`quality-gate` now pass the expected manifest version to catch this class of
mismatch.

## 2026.08.01.1

**Fixed:** `apply-bump` now self-verifies the upgrade chain it just wrote before
counting an extension as bumped. The `plan-bump` fix from `2026.07.29` (it adds
the matching `toVersion` alongside a `version` bump) only helps when
`apply-bump` runs through the full `extension-maintenance-sweep` workflow, whose
`verify` step calls `quality-gate`. Two sweeps since then were run as ad-hoc
`audit` → `plan-bump` → `apply-bump` invocations that skipped `verify` entirely,
so a broken chain shipped undetected both times — 19 extensions after the
`2026.07.27.1` sweep, then 21 more after the AWS SDK bump on `2026.07.31`.
`apply-bump` now runs the same `checkUpgradeChain` check `quality-gate` uses
immediately after writing each extension's files, so a broken chain is caught
and reported in `current-apply` even when `verify` never runs.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/credential-providers 3.1096.0 → 3.1100.0

## 2026.07.27.4

**Fixed:** `apply-bump` lockfile regeneration now uses `deno cache` on all
source files instead of `deno install`. The previous approach only resolved
specifiers declared in the `deno.json` import map, leaving direct specifiers
(like `npm:@opentelemetry/api@1.9.1`) unresolved in the lockfile. CI would then
fail on lock-check because the lockfile still referenced the old version.

## 2026.07.27.3

**Fixed:** `apply-bump` now prepends the new release notes entry to
`RELEASE_NOTES.md` instead of overwriting it. Previous versions discarded the
entire changelog history, replacing it with only the current bump's entry.

## 2026.07.27.2

**Fixed:** `apply-bump` now includes `*_test.ts` files when expanding glob
patterns for find-and-replace. Previously the glob expansion excluded test
files, so a dependency bump in production source would leave the same import at
the old version in tests — causing duplicate-singleton bugs (e.g.
OpenTelemetry's global registry keyed per module instance).

The `audit` method's `extractNpmImports` still excludes test files when
determining _which_ deps are stale (test-only deps don't drive bumps), but once
a bump plan exists, `apply-bump` replaces all occurrences of the stale version
string regardless of whether the file is a test.

## 2026.07.27.1

**Fixed:** The `fmt` task ran `deno fmt --check`, so `deno task fmt` verified
formatting instead of applying it and there was no way to format the extension
through its own task. `fmt` now formats and a new `fmt:check` verifies, matching
every other extension in the repository.

**Fixed:** `deno fmt` no longer inspects `CLAUDE.md` / `AGENTS.md`. Those files
are gitignored and never present in CI, but `deno fmt` does not read .gitignore,
so `deno task fmt:check` could fail locally on a file CI does not have.

**Upgrade note:** Tooling and formatting only. No model, method, schema, or
behavior change — nothing to do on upgrade.
