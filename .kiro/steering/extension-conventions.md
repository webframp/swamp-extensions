---
inclusion: always
---
# Extension Repository Conventions

This repo publishes swamp extensions via CI. Every PR must satisfy these
requirements — they are not suggestions.

## Version & Release (blocking)

1. **Bump `manifest.yaml` version in the first commit of a PR.** CalVer
   `YYYY.MM.DD.N`. Use `swamp extension version --manifest manifest.yaml --json`
   to get the next version. The publish workflow keys off version changes — no
   bump means no publish after merge.

2. **Update `RELEASE_NOTES.md` in the same commit as the version bump.** CI
   passes this to `swamp extension push --release-notes` and to the GitHub
   release. Format:

   ```markdown
   ## <version>

   **Fixed:** What was broken.
   **Added:** New capabilities.
   **Changed:** Behavioral changes (breaking or not). Users depending on old
   behavior need to know.
   **Upgrade note:** Migration steps or co-upgrade requirements.
   ```

3. **Bump the `version` field inside the source file** (e.g.
   `version: "2026.07.03.1"` in the model export) to match `manifest.yaml`.

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/). Scope is the
extension name or directory:

- `fix(anthropic/compliance): correct org ID mapping`
- `feat(aws/pricing): add spot pricing method`
- `test(cloudflare): add rate limit edge case`

## Adversarial Review — Test Path Coverage

When reviewing the "Testing Completeness" dimension, do NOT just confirm tests
pass. For each code change, verify:

1. **The test exercises the primary new path, not a fallback.** If the fix adds
   `o.uuid ?? o.id`, ensure the mock fixture has a `uuid` field so the test
   hits the left side of `??`. A test that only exercises the fallback path
   proves the old behavior still works — it says nothing about the fix.

2. **Renamed outputs need assertion updates.** If an instance name changes
   (e.g. `"latest"` → `"recent"`), verify at least one test asserts the new
   name.

3. **Schema relaxation needs a fixture exercising the relaxed shape.** If a
   field goes from required to optional, add a fixture that omits it and verify
   the method still succeeds.

## Pre-Push Checklist

Before pushing any branch, run in the extension directory:

```bash
deno task check && deno task lint && deno task fmt:check && deno task test
swamp extension quality manifest.yaml --json
```

Then optionally: `./scripts/local-adversarial-review.sh`

## PR Workflow

1. Branch from main
2. Version bump + RELEASE_NOTES + code changes in first commit
3. Run local quality gates
4. Push, open PR
5. Address CI adversarial review findings (push new commits, do not force-push)
6. Comment `/lgtm` or `/shipit` to merge
