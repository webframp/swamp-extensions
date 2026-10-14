## 2026.10.14.1

**Fixed:** `compute_drift` and `get_drift_velocity` failed on current swamp with
`Data name 'latest' is reserved for internal use`. The two results also shared
one data name; they no longer do.

**Changed:** Stored results are now written as `drift-result-current` (spec
`driftResult`) and `velocity-current` (spec `velocity`) instead of `latest`.
`get_drifted` and `get_drift_velocity` read `drift-result-current`. Anything
that read `data.latest("<model>", "latest")` or queried `name == "latest"` must
use the new names.

**Upgrade note:** Data stored under `latest` is not migrated. Run
`compute_drift` (or `refresh`) once after upgrading; until then `get_drifted`
and `get_drift_velocity` return empty results. Baselines and timelines keep
their names and are unaffected. No attribute schemas changed.

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.
