# @webframp/redmine-kanban

Kanban workflow reports and automation for Redmine, built on top of
[@webframp/redmine](../redmine/). Provides opinionated flow metrics, sprint
summaries, and story scaffolding workflows designed for teams using Kanban-style
pull-based workflows with Redmine issue tracking.

## What's Included

- **flow_metrics_report** -- Cycle time, lead time, throughput, and WIP age
  analysis computed from Redmine issue journals. Produces both Markdown and
  structured JSON output with percentile statistics (average, median, P90).
- **sprint_summary_report** -- Sprint-based issue summaries with breakdowns by
  status, tracker, and assignee. Identifies blocked and completed items.
- **scaffold-story workflow** -- Creates a story issue in Redmine using the
  `Technology | Service | Objective` subject convention, linking it under an
  optional parent theme.

## Prerequisites

This extension depends on `@webframp/redmine`. Install both and create a model
instance before running workflows or reports:

```bash
swamp extension pull @webframp/redmine-kanban

swamp model create @webframp/redmine tracker \
  --global-arg host=https://your-redmine.example.org \
  --global-arg apiKey=YOUR_API_KEY \
  --global-arg project=your-project
```

## Usage

### Scaffold a Story

Create a new story issue using the structured subject line format:

```bash
swamp workflow run @webframp/scaffold-story \
  --input subject="ADDS | LDAP | Implement Geographic Redundancy"
```

The workflow accepts optional inputs for `description`, `tracker` (defaults to
"Story"), `parentId`, `assigneeId`, and `priorityId`.

### Flow Metrics Report

The flow metrics report runs as a workflow-scoped report. It analyzes issues
collected during a workflow run and computes:

- **Lead time** -- days from issue creation to closure
- **Cycle time** -- days from first in-progress transition to closure
- **Throughput** -- count of closed issues in the dataset
- **WIP age** -- how long open in-progress items have been sitting

In-progress detection uses pattern matching against common status names
(`In Progress`, `Doing`, `Active`, `Started`, etc.).

### Sprint Summary Report

The sprint summary report produces an overview of current sprint status:

- Total, completed, in-progress, and blocked issue counts
- Breakdown by status and tracker type
- Assignee workload table (total / in-progress / completed per person)
- Blocked items list (detected via `[blocked]` subject prefix)
- Recently completed items list

## Included Skills

This extension ships four agent skills for guided issue creation:

| Skill                      | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `create-story`             | Guides story creation with subject convention and template |
| `create-task`              | Guides procedural task creation with action plan steps     |
| `hypothesis-task`          | Guides hypothesis-driven tasks for uncertain work          |
| `design-session-checklist` | Facilitates design sessions and produces task issues       |

## Report Output Format

Both reports produce dual output (Markdown for humans, JSON for automation):

```json
{
  "workflowName": "my-workflow",
  "timestamp": "2026-05-21T12:00:00.000Z",
  "leadTime": { "average": 5.2, "median": 4.0, "p90": 9.1, "sampleSize": 12 },
  "cycleTime": { "average": 3.1, "median": 2.5, "p90": 6.0, "sampleSize": 12 },
  "throughput": 12,
  "wipItems": [{ "id": 42, "subject": "Configure HA proxy", "ageDays": 3 }]
}
```

## Troubleshooting

### Report shows "No issue data available"

The reports read pre-collected data from workflow steps (specifically
`list_issues` and `get_issue` steps targeting the `tracker` model instance). If
the workflow steps failed or the data files are missing/corrupt, the report
returns a stub with this message. Check `swamp workflow history search --json`
to confirm the upstream steps completed.

### Model instance must be named "tracker"

The `scaffold-story.yaml` workflow hardcodes `modelIdOrName: tracker`. The model
instance created from `@webframp/redmine` must use this exact name:
`swamp model create @webframp/redmine tracker --global-arg host=... ...`

### Cycle time computation fallback

The flow metrics report computes cycle time from Redmine journal entries. It
first tries to match status names in journal details
(`findFirstInProgressDate-
ByName`). If that fails (journal stores integer IDs,
not names), it falls back to treating the first status transition as "work
started." This heuristic may overcount cycle time if early transitions represent
triage rather than implementation.

### Reports run automatically in workflow context

Both reports have `scope: "workflow"` — they execute as part of a workflow run,
not via standalone `swamp report run`. View output after a workflow completes
using `swamp report get`.

### `@webframp/redmine` is a separate extension

This extension provides only reports and a workflow. The actual Redmine API
interaction lives in `@webframp/redmine`. Both must be pulled:
`swamp extension pull @webframp/redmine-kanban` and
`swamp extension pull @webframp/redmine`.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
