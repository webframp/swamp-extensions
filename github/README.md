# @webframp/github

A swamp model extension for querying GitHub repository data using the `gh` CLI.
This extension provides methods to list repositories, inspect repository
details, enumerate pull requests, issues, releases, and recent workflow runs --
all without leaving the swamp workflow.

## Prerequisites

- [gh CLI](https://cli.github.com/) installed and available on your `PATH`
- Authenticated via `gh auth login` (token or browser-based flow)

## Installation

```bash
swamp extension pull @webframp/github
```

## Model Creation

Create a GitHub model instance to start querying data:

```bash
swamp model create @webframp/github github
```

## Method Execution Examples

List your repositories (up to 30):

```bash
swamp model method run github list_repos
```

Get detailed information about a specific repository:

```bash
swamp model method run github get_repo_info --input repo=octocat/Hello-World
```

List open pull requests for a repository:

```bash
swamp model method run github list_prs --input repo=octocat/Hello-World
```

List closed issues:

```bash
swamp model method run github list_issues --input repo=octocat/Hello-World --input state=closed
```

List releases:

```bash
swamp model method run github list_releases --input repo=octocat/Hello-World
```

List recent workflow runs:

```bash
swamp model method run github list_workflows --input repo=octocat/Hello-World
```

## Available Methods

| Method           | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `list_repos`     | List repositories for the authenticated user with basic metadata |
| `get_repo_info`  | Get detailed information about a specific repository             |
| `list_prs`       | List pull requests for a repository with optional state filter   |
| `list_issues`    | List issues for a repository with optional state filter          |
| `list_releases`  | List releases for a repository                                   |
| `list_workflows` | List recent workflow runs for a repository                       |
| `list_code_scanning_alerts` | Snapshot code-scanning alerts as one resource per alert plus a summary |
| `get_code_scanning_alert` | Retrieve one code-scanning alert with full rule detail |
| `dismiss_code_scanning_alert` | Dismiss one alert with a reason and comment (idempotent) |
| `dismiss_code_scanning_alerts` | Dismiss up to 200 alerts with one reason and comment; rerun to retry only failures |
| `reopen_code_scanning_alert` | Reopen one dismissed alert (idempotent) |

## Code-scanning triage

Token scope: `gh` needs the `security_events` scope (or `repo` on a private
repository) to read alerts, and write access to dismiss or reopen them.

```bash
# Snapshot open alerts (omit state for every state)
swamp model method run github list_code_scanning_alerts \
  --input repo=owner/name --input state=open --input severity=high

# One alert's full rule text and help
swamp model method run github get_code_scanning_alert \
  --input repo=owner/name --input number=42

# Dismiss: reason is false_positive, wont_fix, used_in_tests, or mitigated;
# the comment is at most 280 characters
swamp model method run github dismiss_code_scanning_alert \
  --input repo=owner/name --input number=42 --input reason=used_in_tests \
  --input comment="Test fixture, not shipped" --input idempotencyKey=dismiss-42

# Dismiss many alerts with one reason and comment (one call, one lock)
swamp model method run github dismiss_code_scanning_alerts \
  --input repo=owner/name --input 'numbers=[41,42,43]' \
  --input reason=used_in_tests --input comment="Test fixtures, not shipped" \
  --input idempotencyKey=dismiss-batch-1
```

`dismiss_code_scanning_alerts` attempts every alert even when one fails, keeps
the marker of each success, and then fails the step listing the problems. Run
the identical call again to retry only the rest: alerts already dismissed under
the same key are skipped without calling GitHub. It stops at once, listing the
alerts it never attempted, when GitHub reports rate limiting or rejects the
credentials or permissions, since every further alert would fail the same way.
It waits `pauseMs` (default 1000) after each real dismissal, because GitHub asks
for about a second between mutating requests; skipped alerts cost no pause. It
shares markers with `dismiss_code_scanning_alert`, so the two can be mixed.

A key names one operation. Reusing a key for the same alert with a different
`reason` or `comment` fails instead of silently returning the earlier result;
use a new key for a new decision.

`list_code_scanning_alerts` is a fan-out method: it writes one
`codeScanningAlert` instance per alert and one `codeScanningSummary`. Read the
summary before trusting a count: `truncated: true` means more than `maxAlerts`
alerts matched, or the 11-page read limit ended the read on a full page. GitHub
pages this list by offset with no snapshot isolation, so an alert changing state
mid-read can shift rows and hide a still-open alert. The method therefore reads
the list until two consecutive passes agree (so each list costs at least two
reads), and fails without writing anything if three passes never settle. An
alert that appears on two pages is counted once.

Each new snapshot replaces every earlier one for the repo: it lists what is
stored and deletes each alert the new snapshot does not contain (fixed, or
outside the new filter), including leftovers from a run that died partway. If a
delete fails, the snapshot is kept, the method reports the failure, and the next
list retries. Every remaining alert's `snapshotId` equals the summary's.

`get_code_scanning_alert` stores its result as `codeScanningAlertDetail` under a
separate `alert-detail` instance name, so it never overwrites the list snapshot.
Instance names are `<owner%2Frepo>~<kind>~<number>[~<key>]`; `~` cannot appear
in a repo slug or an idempotency key, so names from different repos or kinds
cannot collide. Names use the lowercase repo slug, since GitHub treats
`owner/name` case-insensitively. Idempotency keys may contain letters, digits,
`.`, `_`, and `-` (no `:`, no trailing `.`) and are at most 64 characters.

`dismiss_code_scanning_alert` and `reopen_code_scanning_alert` write their
idempotency marker only after GitHub confirms the new state, so a failed or
unconfirmed call can be retried with the same key. The marker is scoped to the
alert number plus the key, so one key reused across several alerts dismisses
each of them once.

## Troubleshooting

### Results are silently capped (no `truncated` field)

All list methods have hardcoded limits: repos (30), PRs (20), issues (20),
releases (10), workflows (10). There is no `truncated` indicator and no
user-configurable `limit` parameter. If you have more items than the cap, the
output silently omits them.

### `gh` CLI must be installed and authenticated

The extension delegates entirely to the `gh` CLI. If `gh` is not in PATH or not
authenticated (`gh auth login`), every method throws with the `gh` stderr
output. No in-extension token configuration exists.

### No retry logic or rate-limit handling

If GitHub returns a rate-limit response, `gh` exits non-zero and the method
fails immediately. There is no backoff or retry. For bulk operations, add delays
between invocations.

### JSON shape trust-cast (no runtime validation)

The extension casts `gh` output directly to the expected schema type without Zod
parsing. If a future `gh` version changes its JSON output shape, the error
surfaces at resource-write time (schema validation) rather than at parse time.

### No GitHub Enterprise support configuration

The extension uses whatever host `gh` is configured for. To target GitHub
Enterprise, configure `gh` externally
(`gh auth login --hostname ghe.example.com`).

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
