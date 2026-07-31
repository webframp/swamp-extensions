## 2026.07.31.1

**Changed:** Bump @webframp/agentcore 2026.07.27.1 → 2026.07.27.2

## 2026.07.27.2

**Changed:** Bump @webframp/agentcore 2026.07.21.1 → 2026.07.27.1

## 2026.07.27.1

**Changed:** Reformatted files that had drifted from `deno fmt`. No code
behavior changes.

**Fixed:** `deno fmt` no longer inspects `CLAUDE.md` / `AGENTS.md`. Those files
are gitignored and never present in CI, but `deno fmt` does not read .gitignore,
so `deno task fmt:check` could fail locally on a file CI does not have.

**Upgrade note:** Tooling and formatting only. No model, method, schema, or
behavior change — nothing to do on upgrade.
