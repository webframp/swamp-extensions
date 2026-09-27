## 2026.09.26.1

**Added:** `triage_batch`, an extension method on `@swamp/typesafe-ai`, moved
here from `@webframp/operator-briefing` 2026.09.25.1 so packages other than the
briefing can depend on it. The method name, arguments, and the `triageBatch`
resource (`triage-batch-<name>`) are the same, so existing workflows and stored
batches keep working. The only behavior change is the request `User-Agent`, now
`webframp-typesafe-batch/1`.
