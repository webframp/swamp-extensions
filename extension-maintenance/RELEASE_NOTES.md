## 2026.07.26.3

**Fixed:** Every method failed immediately on 2026.07.26.2. Three independent
mismatches against the model execution context, each of which aborted the run
before it produced data:

1. **`context.log` does not exist.** The runtime supplies `logger`, a LogTape
   logger with `info`/`warn` methods — not a `log(level, message)` function.
   Every method called `context.log(...)` and died with
   `context.log is not a function`. All 14 call sites now use
   `context.logger.info(...)` / `context.logger.warn(...)`, matching the
   convention already used across the other `@webframp` extensions.

2. **`latest` is a reserved data name.** All four resource writes used it, so
   even after logging was fixed the audit failed with
   `Data name 'latest' is reserved for internal use`. Resources are now written
   as `current-audit`, `current-plan`, `current-apply`, and `current-quality`.

3. **`readResource` was called with the wrong arity.** The runtime signatures
   differ: `writeResource(specName, name, data)` takes both a spec and a data
   name, while `readResource(instanceName, version?)` takes only the data name.
   Passing `(specName, name)` meant the spec name was used as the instance name
   and the data name landed in the `version` slot, so the lookup missed and
   `plan-bump` reported `No audit data found` immediately after a successful
   audit. `apply-bump` failed the same way reading the plan.

4. **A dry-run apply was indistinguishable from a real one.** `filesModified`
   incremented on every planned change regardless of `dry_run`, and
   `ApplyResultSchema` had no field recording which mode produced the record. A
   dry run across 35 stale extensions wrote `extensionsBumped: 35` and a nonzero
   `filesModified` — the same shape a real apply writes — so nothing reading
   `current-apply` could tell whether the files existed on disk. `dryRun` is now
   a required field on the resource, populated from the argument.

**Changed:** Resource data names. Anything referencing this model's output must
be updated:

| Spec      | Was      | Now               |
| --------- | -------- | ----------------- |
| `audit`   | `latest` | `current-audit`   |
| `plan`    | `latest` | `current-plan`    |
| `apply`   | `latest` | `current-apply`   |
| `quality` | `latest` | `current-quality` |

Retrieval becomes `swamp data get ext-maint current-audit`. CEL references
become `data.latest("ext-maint", "current-audit")`. Distinct names also make the
four resources addressable — under the old scheme all four shared one data name
and could not be told apart by a workflow expression.

**Added:** A `@webframp/extension-maintenance-sweep` workflow shipping with the
extension. It chains the full maintenance loop as one command:

```bash
swamp workflow run @webframp/extension-maintenance-sweep
```

Five sequential steps — `audit`, `plan`, `approve`, `apply`, `verify` — with a
`manual_approval` gate between the plan and any file write. Inspect the plan
while the run is suspended, then approve and resume:

```bash
swamp data get ext-maint current-plan --json
swamp workflow approve @webframp/extension-maintenance-sweep approve
swamp workflow resume @webframp/extension-maintenance-sweep
```

Every step targets one model instance and therefore runs strictly sequentially —
parallelising them would contend on the per-model lock. The workflow expects an
instance named `ext-maint`.

**Changed:** `ApplyResultSchema` gains a required `dryRun` field. Consumers
parsing `current-apply` with a strict schema must add it.

**Upgrade note:** Requires an `@webframp/extension-maintenance/maintainer`
instance named `ext-maint` for the bundled workflow to resolve. Existing
`latest` data from prior runs is not migrated; the first `audit` after upgrading
writes `current-audit` and any older `latest` data can be deleted.

**Known limitation:** `audit` is documented as pure observation but is not.
`getQualityScore()` invokes `swamp extension quality` with `cwd` set to each
extension directory, and each of those invocations writes to that directory's
`.swamp.yaml` repo marker and can create a missing `deno.lock`. Running the
audit against a repo of N extensions therefore touches N repo markers. Not
addressed in this release.
