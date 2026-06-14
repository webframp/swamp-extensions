# @webframp/hermes-kanban-orchestrator

Creates kanban tasks via `hermes kanban create` and records each task as a
swamp data resource. This is the single entry point for creating kanban tasks
from swamp workflows, cron, and automation.

## Usage

```bash
# Create the orchestrator model instance
swamp model create @webframp/hermes-kanban-orchestrator kanban-orch \
  --global-arg board=research

# Create a daily journal task (idempotent — deduped by date)
swamp model method run kanban-orch new_task \
  --input type=daily-journal \
  --input assignee=researcher \
  --input title="Daily research journal"

# Queue a research deep-dive topic
swamp model method run kanban-orch new_task \
  --input type=research-topic \
  --input assignee=researcher \
  --input 'title=Supply chain attacks on npm' \
  --input 'body=Focus on IFIN and SRE Weekly sources'

# List recent tasks
swamp model method run kanban-orch list_recent --input limit=5
```

## Methods

| Method | Description |
|--------|-------------|
| `new_task` | Create a kanban task with type, assignee, title, body, tags, and priority. Writes a `kanbanTask` resource to the swamp catalog. |
| `list_recent` | List recent kanban tasks and record them as swamp data. |

## Task types

- `daily-journal` — Idempotent by date. Creates at most one task per day.
- `research-topic` — Open-ended deep-dive. No dedup.
- `weekly-review` — Periodic curation.

## Global arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `board` | `research` | Kanban board slug |
| `hermesBin` | `~/.local/bin/hermes` | Path to hermes binary |
| `repoDir` | `/tmp/swamp-fresh` | Swamp repo working directory |

## TypeScript model export

```typescript
export const model = {
  type: "@webframp/hermes-kanban-orchestrator",
  version: "2026.06.14.1",
  globalArguments: GlobalArgsSchema,
  resources: { kanbanTask: { ... } },
  methods: { new_task: { ... }, list_recent: { ... } },
};
```
