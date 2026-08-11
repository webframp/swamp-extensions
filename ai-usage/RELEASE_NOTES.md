## 2026.08.11.1

**Fixed:** `status` and `generate` always reported every provider as
unconfigured, even with valid scan data present. Both methods called
`context.dataRepository.findBySpec(modelName, specName)`, which does not
exist on the method-execution context — only `findAllForModel` (metadata)
and `getContent` (raw bytes) are available there. The call threw a
`TypeError` on every invocation, silently caught and logged as a warning,
so every provider always fell back to "unconfigured" regardless of actual
scan state.

**Fixed:** The replacement `findAllForModel`-based lookup sorted results by
calling `.localeCompare()` on `createdAt`, assuming it was a string — but
swamp's real `Data.createdAt` is a `Date` object, so this threw on every
invocation with scan data present. Sorting now uses `Date.getTime()`, and
`generate`'s error path now logs failures via `context.logger.warn` like
`status` already did. Added a runtime shape guard on `createdAt` so a
future mismatch between this extension's local type guess and swamp's
actual API surfaces as a clear error instead of a silent miscalculation.

**Upgrade note:** No schema or behavioral changes to the `status`/`report`
resource shapes — this is purely an internal data-access fix. Re-run
`swamp model method run ai-usage status` after upgrading to see accurate
coverage.

## 2026.08.05.1

**Changed:** Bump @webframp/aws/bedrock-usage 2026.08.01.1 → 2026.08.02.1

## 2026.08.02.1

**Changed:** Bump @webframp/aws/bedrock-usage 2026.07.29.1 → 2026.08.01.1

## 2026.07.31.2

**Changed:** Breaking schema change — the `hint` string field in status and
report coverage entries is replaced by a `setup` object containing `command`,
`permissions` (array of least-privilege IAM/RBAC permissions), and `authNotes`
(authentication mechanism description). Consumers parsing the status resource
must update to the new shape.

**Changed:** The `extensionType` field is now included in provider status
entries (e.g. `@webframp/aws/bedrock-usage`).

**Added:** Setup guidance now includes the full `model create` command with all
required arguments (including auth credentials for GCP and Azure that were
previously missing), the exact permissions needed, and a description of how
authentication works for each provider.

**Added:** Data-driven provider registry. Adding a new provider (Anthropic,
Moonshot, etc.) requires only appending a ProviderDefinition object — no new
code blocks in status, generate, or the report.

**Changed:** The report extension now imports provider definitions from the
model, eliminating duplicated per-provider rendering logic.

**Upgrade note:** This is a breaking change. If you parse the `status` resource
programmatically, update from `provider.hint` (string) to `provider.setup`
(object with `command`, `permissions`, `authNotes` fields). Configured providers
have these fields blanked (empty string / empty array).
