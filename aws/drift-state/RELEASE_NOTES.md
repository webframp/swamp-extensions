## 2026.08.21.1

**Changed:** Previously-silent catch blocks around stored baseline, drift
result, and timeline reads (in `compute_drift`, `get_drifted`,
`get_drift_timeline`, and `get_drift_velocity`) now log a warning naming the
resource being read and the underlying error before falling back to the
same graceful "not available yet" behavior. Before, an unexpected read
failure (as opposed to a simple "not found") was swallowed with no
diagnostic at all.

**Changed:** `compute_drift`'s `sources` argument, if provided, must now be a
non-empty array instead of silently accepting `[]` and producing an empty
drift result. `get_drift_timeline`'s `canonicalId` must be a non-empty
string.
