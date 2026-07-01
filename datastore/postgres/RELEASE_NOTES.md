# 2026.06.30.1

## Two-Phase Datastore Sync

Adds `preparePush`/`commitPush` two-phase sync protocol alongside the existing
`fullWalkPush` and `pushOneRel` single-shot paths.

### Added

- `TwoPhaseSyncService` interface with `preparePush()` and `commitPush()` methods
- `PushManifest` opaque branded type for safe manifest passing between phases
- `preparePush()` captures sidecar snapshot and collects diff without transaction
- `commitPush()` executes batched inserts in a transaction, clears sidecar
- `capabilities()` now reports `twoPhaseSync: true`

### Changed

- Extracted `collectFullWalkDiff()` and `collectOneRelDiff()` helper functions
- Refactored `fullWalkPush`/`pushOneRel` to use extracted helpers (behavior preserved)
- No breaking changes to existing sync behavior
