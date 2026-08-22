## 2026.08.21.1

**Changed:** `provision` now gives a clear error when the AWS CLI itself can't
be run (not installed / not on PATH) instead of a bare "No such file or
directory" that doesn't name what's missing. It also now catches the case where
the AWS CLI exits successfully but prints something that isn't valid JSON (e.g.
a CLI deprecation warning ahead of the payload) — previously this crashed with a
raw `JSON.parse` error giving no indication of which `aws` subcommand or what
output caused it; it now names the command and includes a preview of the
unexpected output.

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
