## 2026.08.20.1

**Changed:** Bump @aws-sdk/* 3.1111.0 → 3.1114.0 (3 packages)

## 2026.08.15.1

**Changed:** Bump @aws-sdk/* 3.1104.0 → 3.1111.0 (3 packages)

## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (3 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (3 packages)

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (3 packages)

## 2026.07.27.2

**Changed:** Bump @aws-sdk/* 3.1094.0 → 3.1096.0 (3 packages)

## 2026.07.27.1

**Fixed:** `deno fmt` no longer inspects `CLAUDE.md` / `AGENTS.md`. Those files
are gitignored and never present in CI, but `deno fmt` does not read .gitignore,
so `deno task fmt:check` could fail locally on a file CI does not have.

**Upgrade note:** Tooling and formatting only. No model, method, schema, or
behavior change — nothing to do on upgrade.
