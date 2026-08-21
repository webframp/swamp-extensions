## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in the resource-only schemas `ContextMapSchema`, `DomainGlossarySchema`,
and `BoundariesSchema` (and their nested `ContextRelationshipSchema`,
`BoundedContextSchema`, `GlossaryEntrySchema`, `InvariantSchema`, and
`AggregateDesignSchema`). The corresponding method argument schemas already
had descriptions; this brings the resource schemas up to the same standard.
No behavioral changes.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `mod.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
