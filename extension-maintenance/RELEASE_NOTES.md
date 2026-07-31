## 2026.07.31.1

**Changed:** Bump @opentelemetry/api 1.9.1`) that bypass → 1.9.1

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
