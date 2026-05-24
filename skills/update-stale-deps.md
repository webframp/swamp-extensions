---
name: update-stale-deps
description: Use when `swamp extension pull` fails with "not found in the registry" for a transitive dependency, or when proactively auditing manifest dependency freshness. Triggers on "stale dependency", "dependency not found", "pull failed", "update deps", "bump dependencies", "registry version missing".
---

# Update Stale Dependencies

Workflow extensions pin exact dependency versions in `manifest.yaml`. When
underlying extensions are republished and old versions are pruned from the
registry, pulls fail on transitive resolution.

## Diagnosis

The error looks like:

```
FTL error Error: "Extension @webframp/aws/cost-explorer@2026.03.30.1 not found in the registry."
```

This means a workflow extension's `dependencies:` list pins a version that no
longer exists.

## Workflow

### 1. Find affected manifests

```bash
grep -r "dependencies:" --include="manifest.yaml" -l
```

Then inspect each manifest's `dependencies:` list for old version pins.

### 2. Look up latest published versions

Use git tags as the source of truth for what's in the registry:

```bash
git tag --list '@webframp/aws/cost-explorer@*' | sort -V | tail -3
```

Repeat for each dependency that needs updating.

### 3. Update manifests

Edit `dependencies:` entries to reference the latest published version for each
dependency.

### 4. Bump the extension version

Each updated manifest needs a CalVer version bump (`YYYY.MM.DD.N`) so it can be
republished:

```yaml
version: "2026.05.24.1"  # today's date
```

### 5. Commit and PR

Follow the pr-workflow skill for branch/commit/push/merge.

## Proactive Audit

To check all workflow manifests for potentially stale deps before they break:

```bash
for manifest in $(grep -rl "dependencies:" --include="manifest.yaml"); do
  echo "=== $manifest ==="
  grep -A 20 "^dependencies:" "$manifest" | grep "^  - " | while read -r dep; do
    pkg=$(echo "$dep" | sed 's/.*"\(.*\)@.*/\1/')
    ver=$(echo "$dep" | sed 's/.*@\(.*\)"/\1/')
    latest=$(git tag --list "${pkg}@*" | sort -V | tail -1 | sed "s/.*@//")
    if [ "$ver" != "$latest" ] && [ -n "$latest" ]; then
      echo "  STALE: $pkg@$ver → latest: $latest"
    fi
  done
done
```

## Key Details

- Only workflow/composite extensions have `dependencies:` — model extensions
  don't pin transitive deps
- The registry prunes old versions after newer ones publish, so stale pins
  eventually break
- Always use `git tag --list` as source of truth — it reflects what's published
- Version bumps use CalVer: `YYYY.MM.DD.N` where N starts at 1
