## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in `BuildResultSchema`, `PushResultSchema`, and `InspectResultSchema`. No
behavioral changes.

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to
`2026.07.27.1`) updated `version` but left the `upgrades` array terminating one
step short, which blocks `swamp extension push` ("model upgrade chain errors").
That version never actually published — the registry was still serving
`2026.07.18.1`. This release closes the chain with a no-op upgrade entry and
republishes everything that had accumulated since `2026.07.18.1`.

## 2026.07.27.1

**Fixed:** `deno fmt` no longer inspects `CLAUDE.md` / `AGENTS.md`. Those files
are gitignored and never present in CI, but `deno fmt` does not read .gitignore,
so `deno task fmt:check` could fail locally on a file CI does not have.

**Upgrade note:** Tooling and formatting only. No model, method, schema, or
behavior change — nothing to do on upgrade.
