## 2026.08.21.2

**Changed:** `evaluate` and `mitigate` now validate that the threat IDs they
reference actually exist in the current assessment before applying any
change. Previously, calling `evaluate` with an adjustment for a typo'd or
stale `threatId`, or calling `mitigate` with a control's `mitigates` list, an
acceptance's `threatId`, or a `deferred` entry pointing at a threat ID that
was never identified, silently did nothing — the assessment was written back
unchanged with no indication that the reference didn't resolve. Both methods
now throw a descriptive error listing the unknown ID(s) and the known IDs on
the assessment, so a typo surfaces immediately instead of producing a
posture snapshot that quietly omits the intended change.
