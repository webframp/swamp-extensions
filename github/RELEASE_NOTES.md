## 2026.11.06.1

**Added:** Code-scanning alert triage. `list_code_scanning_alerts` snapshots alerts as one `codeScanningAlert` resource per alert plus a `codeScanningSummary` (totals, filters, exact `truncated` flag). Each snapshot replaces the previous one and deletes alerts it no longer lists. `get_code_scanning_alert` stores one alert with its full rule text as `codeScanningAlertDetail`. `dismiss_code_scanning_alert` and `reopen_code_scanning_alert` change one alert per call and record an idempotency marker, scoped to the alert number and key, only after GitHub confirms the new state. `dismiss_code_scanning_alerts` dismisses up to 200 alerts in one call with the same markers: a failure on one alert does not stop the rest, and rerunning the same call retries only the failures. Dismissal reasons are `false_positive`, `wont_fix`, `used_in_tests`, and `mitigated`; the extension sends the spaced strings the API requires.

**Upgrade note:** Additive. Existing methods and resources are unchanged. `gh` needs the `security_events` scope (or `repo` on a private repository) to read alerts, and write access to change them.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.12.1

**Fixed:** Repeating an `idempotencyKey` on `create_issue`, `add_issue_comment`,
`close_issue`, `retry_workflow_run`, or a finished `merge_pull_request` no
longer fails the workflow step. These methods returned a handle with only a
name when the key had been seen before. The runtime rejected it
(`expected string, received undefined (path: dataId)`), so a scheduled workflow
whose detection persisted reported failure on every run. Dedup itself was
unaffected: no duplicate issue, comment, close, retry, or merge comment was
ever sent.

**Changed:** A repeated key now re-writes the existing `triageAction` record
unchanged and returns its full handle. Each repeat adds a version of that
record (retention is still 20 versions) whose 30-day lifetime starts from the
repeat, so a marker that a workflow keeps hitting stays current instead of
aging out from its first write. No `gh` command runs on a repeat.
