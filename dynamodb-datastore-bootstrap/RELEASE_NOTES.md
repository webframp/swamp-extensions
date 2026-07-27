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
