# @webframp/hermes-kanban-orchestrator

Creates kanban tasks via `hermes kanban create` and records each task as a swamp
data resource. This is the single entry point for creating kanban tasks from
swamp workflows, cron, and automation.

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

| Method        | Description                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `new_task`    | Create a kanban task with type, assignee, title, body, tags, and priority. Writes a `kanbanTask` resource to the swamp catalog. |
| `list_recent` | List recent kanban tasks and record them as swamp data.                                                                         |

## Task types

- `daily-journal` — Idempotent by date. Creates at most one task per day.
- `research-topic` — Open-ended deep-dive. No dedup.
- `weekly-review` — Periodic curation.

## Global arguments

| Arg         | Default               | Description                  |
| ----------- | --------------------- | ---------------------------- |
| `board`     | `research`            | Kanban board slug            |
| `hermesBin` | `~/.local/bin/hermes` | Path to hermes binary        |
| `repoDir`   | `/tmp/swamp-fresh`    | Swamp repo working directory |

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

## Troubleshooting

### `list_recent` returns empty results without error

If the `hermes kanban list` CLI command fails (binary not found, board doesn't
exist, permission error), the method logs a warning and returns zero data
handles. It does not throw. Check `swamp run history` for the warning message.
JSON parse failures on the list output also degrade to empty results with a log
message.

### `new_task` returns `kanbanId: "unresolved-..."`

If the `hermes kanban create --json` output cannot be parsed as JSON, the method
falls back to regex-based ID extraction from stdout/stderr. If that also fails,
a synthetic `unresolved-{timestamp}` ID is used. The task was created in the
kanban board, but the returned ID may not match the actual task. No warning is
logged for this fallback.

### Idempotency key collision

Tasks are de-duplicated by `idempotencyKey` (auto-generated from date + title
hash if not provided). If hermes reports "already exists," the method writes a
resource with `status: "exists"` and extracts the ID via regex. Multiple
collisions targeting `task-unknown` would overwrite each other's resource data.

### `hermesBin` default is `"hermes"` (not `~/.local/bin/hermes`)

The source default relies on PATH lookup. The README documents a different
default. Set `--global-arg hermesBin=/path/to/hermes` explicitly if hermes is
not in your PATH.

### 30-second timeout on CLI commands

All `hermes` CLI invocations time out after 30 seconds. If your kanban board is
large or the hermes binary is slow, the method throws a timeout error. This
timeout is not configurable.
