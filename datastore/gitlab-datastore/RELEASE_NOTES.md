# 2026.06.30.1

## Two-Phase Datastore Sync

Adds `preparePush`/`commitPush` two-phase sync protocol alongside the existing
`pushChanged` single-shot path.

### Added

- `TwoPhaseSyncService` interface with `preparePush()` and `commitPush()` methods
- `PushManifest` opaque branded type for safe manifest passing between phases
- `preparePush()` collects diff outside the lock (no remote writes)
- `commitPush()` re-reads fresh state under lock, uploads entries, merges hashes
- `capabilities()` now reports `twoPhaseSync: true`

### Changed

- Extracted `EXCLUDED_DIRS` and `isExcludedFile` to module-level constants (deduplication)
- No breaking changes to existing `pushChanged` behavior
