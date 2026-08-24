# @webframp/sre

Unified SRE health check extension for swamp. Runs network probes (HTTP status,
TLS certificate expiry, DNS resolution, TCP port connectivity) and collects
local system health metrics (disk usage, memory, load averages), then generates
a consolidated health report with severity-rated findings and actionable
recommendations.

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) CLI installed
- The `@webframp/network` and `@webframp/system` extensions (installed
  automatically as dependencies)
- Standard CLI tools on the target host: `curl`, `openssl`, `dig`, `df`, `free`

## Installation

```bash
swamp extension pull @webframp/sre
```

This installs the SRE extension along with its dependencies (`@webframp/network`
and `@webframp/system`).

## Usage

### 1. Create model instances

The workflow expects two model instances named `net-probe` and `sys-diag`:

```bash
swamp model create @webframp/network net-probe
swamp model create @webframp/system sys-diag
```

### 2. Run the health check workflow

```bash
swamp workflow run @webframp/sre-health-check --input target=https://example.com
```

The workflow executes the following checks in parallel:

- **HTTP check** -- verifies endpoint availability and response time
- **TLS certificate check** -- inspects certificate expiry (warns at 30 days,
  critical at 7)
- **DNS lookup** -- resolves the target hostname and reports records
- **Port check** -- tests TCP connectivity on standard ports
- **Disk usage** -- flags filesystems above 80% (warn) or 90% (critical)
- **Memory** -- reports RAM and swap utilization against configurable thresholds
- **Load averages** -- surfaces high system load

### 3. View the report

After the workflow completes, the SRE health report is generated automatically.
It includes:

- Overall health status: `HEALTHY`, `WARNING`, `CRITICAL`, or `DEGRADED`
- A severity-rated findings table
- Numbered recommendations for any issues found

```yaml
# Example report output summary
Status: "[HEALTHY] HEALTHY"
Checks: "7 total | 0 critical | 0 warning | 5 ok"
```

## Components

| Type     | Name                          | Description                              |
| -------- | ----------------------------- | ---------------------------------------- |
| Workflow | `@webframp/sre-health-check`  | Orchestrates all probes and diagnostics  |
| Report   | `@webframp/sre-health-report` | Aggregates findings into a health report |

## Troubleshooting

### Report shows "DEGRADED" status

The `DEGRADED` status means one or more probe steps could not collect data.
Common causes: `dig`, `openssl`, or system utilities not installed on the
runner, or the target URL/host is unreachable. Check `swamp run history` for
per-step failure details.

### All steps use `allowFailure: true`

The workflow is designed to always produce a report even when probes fail.
Individual probe failures appear as `severity: "error"` findings (HTTP, TLS,
DNS) or as absent findings (disk, memory, load). The report always runs via the
`completed` dependency condition.

### Passing both `target` and `targetHost` inputs

The `target` input (full URL) is used for HTTP checks. The `targetHost` input
(bare hostname) is used for cert, DNS, and port checks. Changing `target` does
not automatically update `targetHost`. Pass both when targeting a non-default
host.

### Thresholds are hardcoded

Certificate expiry (30/7 days), disk usage (80/90%), memory (80/95%), swap
(50%), and load (4.0) thresholds are compile-time constants. They cannot be
overridden at runtime.

### Asymmetric "no data" handling

HTTP, TLS, and DNS push explicit error findings when their step data is missing.
Disk, memory, and load produce no finding at all when their step data is absent
— they are invisible in the report rather than flagged.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
