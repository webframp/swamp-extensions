## 2026.08.24.5

**Added:** `describe_endpoint` method — aggregated health check that runs DNS
resolution, HTTP reachability, and TLS certificate inspection for a single host
in one call. Returns a unified `endpoint_summary` resource with per-check
results and an overall `healthy` boolean.

**Added:** `endpoint_summary` resource spec storing the aggregated check output.
