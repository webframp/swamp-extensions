## 2026.08.21.1

**Changed:** When a benchmark write iteration fails, the recorded `errorMessage`
now names the target model and payload size instead of surfacing the bare
`stderr` from the inner `swamp data write` command. A command that failed with
no stderr output previously produced an empty error message; it now says so
explicitly.

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
