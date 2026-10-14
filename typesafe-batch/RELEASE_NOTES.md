## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.26.1

**Added:** `triage_batch`, an extension method on `@swamp/typesafe-ai`, moved
here from `@webframp/operator-briefing` 2026.09.25.1 so packages other than the
briefing can depend on it. The method name, arguments, and the `triageBatch`
resource (`triage-batch-<name>`) are the same, so existing workflows and stored
batches keep working. The only behavior change is the request `User-Agent`, now
`webframp-typesafe-batch/1`.
