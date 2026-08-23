# @webframp/aws/drift-state

Unified drift detection model that composes observations from existing
models (adopt, inventory, terraform, config, dns, event_topology) into
queryable versioned state.

This is a higher-order model: it makes **zero AWS API calls**. It reads
already-collected data from upstream model instances via the swamp data
repository, diffs the current snapshot against a stored baseline, and
writes typed drift results, timelines, and velocity metrics. Because of
that, drift-state is only ever as fresh as its upstream sources — see
[Upstream Sources](#upstream-sources) and
[Troubleshooting](#troubleshooting) below.

## Methods

- **compute_drift** — Compare latest upstream snapshots against baselines
- **set_baseline** — Mark current upstream state as expected
- **get_drifted** — Query resources currently in drifted state
- **get_drift_timeline** — History of drift events for a resource
- **get_drift_velocity** — Aggregate drift rate metrics
- **refresh** — Recompute drift from current upstream data

## Upstream Sources

- `@webframp/aws/adopt` (required) — VPCs, subnets, gateways, route
  tables, security groups, RDS
- `@webframp/aws/inventory` (required) — EC2, RDS, DynamoDB, Lambda, S3,
  EBS
- `@webframp/terraform` (optional) — Terraform-managed resources. If not
  installed, reported in `unavailableSources` and skipped gracefully.
- `@webframp/aws/config-compliance` (optional) — AWS Config
  non-compliant resources. If not installed, reported in
  `unavailableSources`.
- `@webframp/aws/dns-observation` (optional) — Orphaned DNS records
  pointing at decommissioned infrastructure. If not installed, reported
  in `unavailableSources`.
- `@webframp/aws/event-topology` (optional) — Event graph topology
  (EventBridge, SNS, SQS, Lambda ESM). If not installed, reported in
  `unavailableSources`.

Each method takes a `*ModelName` argument per source (e.g.
`adoptModelName`, `inventoryModelName`) defaulting to the source's
conventional instance name (`aws-adopt`, `aws-inventory`, `terraform`,
`aws-config-compliance`, `aws-dns-observation`, `aws-event-topology`).
If your upstream model instances use different names, pass the matching
argument explicitly or the source will be treated as unavailable.

## Usage

```bash
swamp extension pull @webframp/aws/drift-state
swamp model create @webframp/aws/drift-state drift-state

# One-time: baseline current upstream state as "expected"
swamp model method run drift-state set_baseline

# Detect drift against that baseline
swamp model method run drift-state compute_drift

# Query results
swamp model method run drift-state get_drifted
swamp model method run drift-state get_drift_velocity

# History for one resource (ARN or composite canonical ID)
swamp model method run drift-state get_drift_timeline \
  --input '{"canonicalId": "arn:aws:ec2:us-east-1:123456:vpc/vpc-abc"}'

# Limit compute_drift/set_baseline to specific sources, or point at
# non-default upstream instance names
swamp model method run drift-state compute_drift \
  --input '{"sources": ["adopt", "inventory"], "adoptModelName": "aws-adopt-prod"}'
```

## Workflow

`compute_drift` and `set_baseline` only read data that already exists in
the upstream models — they don't trigger a fresh scan. Use the bundled
workflow to refresh upstream data first, then recompute drift in one
step:

```bash
swamp workflow run @webframp/drift-state-refresh
```

## Troubleshooting

**`get_drifted` / `get_drift_velocity` return empty results.**
These methods read the last stored `compute_drift` output — they don't
compute anything themselves. Run `compute_drift` at least once first.

**Every resource shows `driftStatus: "unknown"`.**
No baseline has been set for that source yet, so there's nothing to
diff against. Run `set_baseline` before the first `compute_drift`.

**A source appears in `unavailableSources`.**
Either the extension for that source isn't installed (expected and
harmless for optional sources — terraform, config, dns,
event_topology), or the upstream model instance name doesn't match
what drift-state is looking for. Check the `*ModelName` argument for
that source against `swamp model list`, and confirm the upstream model
has run its collection method (`discovery`, `scan`, `read_state`, etc.)
at least once — `dataRepository.findBySpec` returns nothing for a model
that has never produced that spec.

**A source appears in `staleSources`.**
The most recent upstream data for that source is older than
`staleThresholdMinutes` (default: 1440, i.e. 24h). This doesn't block
drift computation — stale sources are still diffed — but the result is
flagged so you know it. Re-run the upstream model's collection method,
or run the `drift-state-refresh` workflow, and increase
`staleThresholdMinutes` if 24h is too aggressive for your refresh
cadence.

**Baseline seems to "reset" `firstDriftDetected` unexpectedly.**
`firstDriftDetected` is read from the per-resource timeline
(`timeline-<hash of canonicalId>`), not the baseline. If a resource's
canonical ID changes — e.g. it previously had no ARN and used a
composite `source:type:id` key, then later gained an ARN — drift-state
treats it as a new resource with no prior timeline.

**Drift shows up for a resource whose only real change was tag
ordering or list ordering.**
Shouldn't happen: `compute_drift` normalizes both baseline and current
snapshots with a canonical JSON serializer that sorts object keys and
array elements before comparing. If you see spurious drift from
ordering alone, it's a bug — file an issue.
