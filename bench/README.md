# Datastore Benchmark Harness

Shell-based benchmark for comparing swamp datastore performance across backends.

## Architecture

```
bench/              ← this directory (harness scripts)
  bench.sh          ← main runner: outputs JSONL per operation
  switch-datastore.sh ← switch the target repo between backends
  summarize.sh      ← aggregate and compare results
  results/          ← JSONL output files (gitignored)

/tmp/bench-target   ← isolated swamp repo under test
```

The harness exercises a target repo (`/tmp/bench-target`) while keeping its own
state separate. This prevents the benchmark's own datastore operations from
contaminating measurements.

## Quick Start

```bash
# Run filesystem baseline (5 iterations)
./bench.sh solo-sequential filesystem 5

# Run burst profile
./bench.sh solo-burst filesystem 10

# Switch to gitlab-datastore and benchmark
export GITLAB_HOST=gitlab.example.com
export GITLAB_PROJECT=devsecops/bench-state
export GITLAB_TOKEN="$(swamp vault get gitlab TOKEN)"
./switch-datastore.sh gitlab
./bench.sh solo-sequential gitlab 10
./bench.sh lock-contention gitlab 5

# Switch to S3 and benchmark
export S3_BUCKET=my-bench-bucket S3_REGION=us-east-1
./switch-datastore.sh s3
./bench.sh solo-sequential s3 10

# Compare results
./summarize.sh
```

## Workload Profiles

| Profile | Description | What it measures |
|---------|-------------|-----------------|
| `solo-sequential` | N method calls with sync between each | End-to-end per-op latency |
| `solo-burst` | N rapid-fire method calls, sync once at end | Lock acquisition under back-to-back pressure |
| `sync-only` | N push/pull cycles (no method calls) | Raw sync throughput |
| `lock-contention` | N parallel method call pairs | Serialization overhead under contention |

## Output Format

JSONL — one JSON object per operation:

```json
{"ts":"2026-06-10T17:14:41-04:00","datastore":"filesystem","profile":"solo-sequential","op":"method_run","duration_ms":1438,"exit_code":0,"iter":1}
```

Fields:
- `ts` — ISO timestamp
- `datastore` — label for the backend under test
- `profile` — workload profile name
- `op` — operation type (`method_run`, `sync_push`, `sync_pull`, `parallel_pair`)
- `duration_ms` — wall-clock milliseconds
- `exit_code` — 0 = success
- `iter` — iteration number
- `files_pushed` / `files_pulled` — sync metrics (when available)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCH_TARGET_DIR` | `/tmp/bench-target` | Path to the repo under test |
| `GITLAB_HOST` | — | GitLab hostname |
| `GITLAB_PROJECT` | — | GitLab project for state storage |
| `GITLAB_TOKEN` | — | GitLab personal access token |
| `S3_BUCKET` | — | S3 bucket name |
| `S3_PREFIX` | `bench` | S3 key prefix |
| `S3_REGION` | — | AWS region |
| `PG_CONN` | — | PostgreSQL connection string |
