# @webframp/redmine

Redmine issue tracker integration for swamp. Manage issues, projects, and
workflows through the Redmine REST API. Provides model methods for CRUD
operations on Redmine issues (themes, stories, tasks), project queries,
status/tracker/user lookups, and custom field access. Includes reports for flow
metrics (cycle time, lead time, throughput, WIP age) and sprint summaries, plus
a scaffold-story workflow for creating stories with child tasks.

## Prerequisites

- A running [Redmine](https://www.redmine.org/) instance with the REST API
  enabled
- A Redmine API key (found under My Account in Redmine)
- [swamp](https://github.com/systeminit/swamp) CLI installed

## Installation

```bash
swamp extension pull @webframp/redmine
```

## Usage

### Create a model instance

```bash
swamp model create @webframp/redmine tracker \
  --global-arg host=https://redmine.example.org \
  --global-arg apiKey=YOUR_API_KEY \
  --global-arg project=my-project
```

### List issues

```bash
swamp model method run tracker list_issues \
  --arg statusId=open \
  --arg sort=updated_on:desc
```

### Get a single issue with journals and children

```bash
swamp model method run tracker get_issue --arg issueId=1234
```

### Create an issue

```bash
swamp model method run tracker create_issue \
  --arg subject="Fix login timeout" \
  --arg trackerId=1 \
  --arg priorityId=2 \
  --arg description="Users report session timeouts after 5 minutes"
```

### Update an issue

```bash
swamp model method run tracker update_issue \
  --arg issueId=1234 \
  --arg statusId=3 \
  --arg notes="Moved to In Progress"
```

### Lookup methods

```bash
swamp model method run tracker list_statuses
swamp model method run tracker list_trackers
swamp model method run tracker list_projects
swamp model method run tracker list_users
swamp model method run tracker list_custom_fields
```

### Scaffold a story with the workflow

```yaml
# Run the scaffold-story workflow
swamp workflow run scaffold-story \
--input subject="Platform | Auth Service | Improve session handling" \
--input description="Reduce timeout errors by extending token TTL" \
--input tracker=Story
```

### Reports

After running a workflow that collects issue data, generate reports:

```bash
# Flow metrics: cycle time, lead time, throughput, WIP age
swamp report run @webframp/flow-metrics-report --workflow-run <run-id>

# Sprint summary: status, tracker, and assignee breakdowns
swamp report run @webframp/sprint-summary-report --workflow-run <run-id>
```

## Extension Contents

| Type     | Path                       | Description                            |
| -------- | -------------------------- | -------------------------------------- |
| Model    | `redmine/redmine.ts`       | Redmine issue tracker model            |
| Report   | `flow_metrics_report.ts`   | Cycle time, lead time, throughput, WIP |
| Report   | `sprint_summary_report.ts` | Sprint status and assignee breakdowns  |
| Workflow | `scaffold-story.yaml`      | Create a story with structured fields  |

## Troubleshooting

### Pagination caps at 500 items with no `truncated` field

All paginated methods (list_issues, list_time_entries, list_projects, etc.) are
capped at 500 items maximum. The output's `totalCount` reflects fetched count,
not the API's total. There is no `truncated` field — you cannot distinguish
"exactly 500 items exist" from "more than 500 were truncated."

### All errors throw — no graceful degradation

Every API failure (network error, non-2xx response) throws immediately. There is
no retry logic, no backoff, and no partial-result path. Transient Redmine
outages or 429 responses crash the method execution.

### `project` global arg is optional but required by some methods

`list_users`, `create_issue`, `list_versions`, `create_version`, and
`list_issue_categories` require a project identifier. If `project` is not set in
global args, you must pass it per-method or the method throws.

### `update_issue` re-fetches after mutation

The method performs a PUT then re-fetches the issue via GET to return the
updated state. If the re-fetch fails after a successful update, the mutation
succeeded but the method throws (no resource written).

### `upload_file` reads the local file path

The `filePath` argument must be an absolute path readable by the swamp process.
If the file cannot be read, the method throws with the path in the error
message.

### Reports and workflows referenced in README do not exist here

The README documents reports (`flow_metrics_report`, `sprint_summary_report`)
and a workflow (`scaffold-story`) that live in the separate
`@webframp/redmine-kanban` extension, not this one.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
