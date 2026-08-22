## 2026.08.21.2

**Changed:**

- `new_task` now rejects an empty `title` with a clear validation error
  before calling `hermes kanban create`, instead of letting hermes reject
  it (or silently accept it) deep inside the CLI call.
- Failures from `hermes kanban create` and `hermes kanban list` now name the
  operation, board, and (for `new_task`) the task type/title in the error or
  log message, instead of surfacing only the raw CLI output.
- If the `hermes` binary itself fails to spawn or run (e.g. not found on
  `PATH`, permission denied), the error now names the binary, board, and
  arguments involved instead of an unqualified low-level exception.
