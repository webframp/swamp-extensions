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
