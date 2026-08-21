## 2026.08.21.1

**Changed:** Added `.describe()` documentation to the previously undocumented `KanbanTaskSchema`
fields (`kanbanId`, `type`, `title`, `assignee`, `status`, `priority`, `tags`, `bodyPreview`,
`createdAt`). No behavioral change — a no-op `upgrades` entry was added to keep the model's
`typeVersion` tracking in sync with the version bump.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `hermes_kanban_orch.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
