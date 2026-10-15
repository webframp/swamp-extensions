## 2026.10.14.2

**Added:** `list_schedule_overrides`, `create_schedule_overrides` and
`delete_schedule_override` for on-call schedule overrides.
`create_schedule_overrides` takes an `entries` array of override items (1 to 25)
and sends them as the `data` payload; `include` is sent as a query parameter.
Its result is stored per schedule ID.

**Upgrade note:** Additive only. Existing methods, schemas and stored resources
are unchanged.
