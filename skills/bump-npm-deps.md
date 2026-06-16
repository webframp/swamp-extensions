---
name: bump-npm-deps
description: Audit and upgrade npm dependencies (AWS SDK, zod, postgres, etc.) across all extensions in the monorepo. Triggers on "bump deps", "update npm", "upgrade sdk", "dependency audit", "npm versions", "sdk upgrade", "bump aws sdk", "bump zod", "latest dependencies", "dep check".
---

# Bump npm Dependencies

Swamp extensions inline npm packages via `npm:package@version` import specifiers
in TypeScript source files. There is no lockfile coverage for these — versions
are pinned directly in source. This skill handles auditing and upgrading them
across the monorepo.

## Audit (check what's stale)

### 1. Extract current versions

```bash
find . -name '*.ts' -not -path './.worktrees/*' -not -path '*/.swamp/*' \
  -exec grep -oh 'npm:[^"'"'"']*' {} \; | sort -u
```

### 2. Check latest from npm registry

For each unique package:

```bash
curl -s https://registry.npmjs.org/<package>/latest | grep -o '"version":"[^"]*"'
```

### 3. Check version consistency

All references to the same package should use the same version. Flag splits:

```bash
find . -name '*.ts' -not -path './.worktrees/*' -not -path '*/.swamp/*' \
  -exec grep -oh 'npm:[^"'"'"']*' {} \; | sort | uniq -c | sort -rn
```

Bare version ranges like `npm:zod@4` (without patch) are bugs — always pin
exact versions.

## Upgrade

### 1. Apply version replacements

For each package being upgraded, sed across all source files:

```bash
find . -name '*.ts' -not -path './.worktrees/*' -not -path '*/.swamp/*' \
  -exec sed -i 's/npm:@aws-sdk\/\([^@]*\)@OLD/npm:@aws-sdk\/\1@NEW/g' {} \;
```

Repeat for each old version → new version mapping. AWS SDK versions should all
converge to a single version.

### 2. Verify type checking

Run `deno task check` in every extension that has changed source files:

```bash
git diff --name-only | grep '\.ts$' | sed 's|/extensions/.*||' | sort -u
```

Then for each:

```bash
cd <extension> && deno task check
```

All must pass. If any fail, the SDK introduced a breaking change — investigate
the specific type error before proceeding.

### 3. Bump manifest versions

Every extension with changed source files needs a CalVer version bump in
`manifest.yaml`:

```bash
sed -i 's/^version: ".*"/version: "YYYY.MM.DD.1"/' <ext>/manifest.yaml
```

Watch for manifests using single quotes — handle both:

```bash
sed -i "s/^version: '.*'/version: 'YYYY.MM.DD.1'/" <ext>/manifest.yaml
```

### 4. Commit and push

Single commit covering all changes:

```
chore: bump all npm dependencies to latest versions

- AWS SDK: X.Y.Z → A.B.C
- zod: X.Y.Z → A.B.C
- postgres: X.Y.Z → A.B.C

All N affected extensions pass deno task check.
Manifest versions bumped to YYYY.MM.DD.1.
```

## What does NOT need bumping

- **Workflow-only extensions** (aws/cost-audit, aws/ops, sre, etc.) — they have
  no TypeScript source, only YAML workflows. Their `dependencies:` in
  `manifest.yaml` pin swamp extension versions, not npm versions.
- **`.swamp/` cached bundles** — these are local runtime artifacts, not source.
- **`deno.lock` files** — swamp's bundler does not use these for npm deps. They
  may update automatically from `deno task check` but don't affect publishing.

## Frequency

AWS SDK ships new versions multiple times per week. Reasonable cadence:
- Monthly for routine bumps
- Immediately when a new SDK client is needed (e.g. new AWS service)
- Immediately when a security advisory affects a pinned version

## Cross-references

| Need | Skill |
|------|-------|
| Stale swamp extension dependency pins in workflows | `update-stale-deps` |
| PR workflow for landing changes | `pr-workflow` |
