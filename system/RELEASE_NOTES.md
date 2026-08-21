## 2026.08.21.1

**Changed:** Tightened `get_processes`'s `count` argument to require a
positive integer. The method already used it as a slice length starting
from the top of the sorted process list, so a zero, negative, or fractional
value never produced anything meaningful — this catches that at validation
time instead of silently returning zero or misshapen results.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `diagnostics.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
