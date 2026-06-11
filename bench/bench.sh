#!/usr/bin/env bash
# bench.sh — Datastore benchmark harness
# Outputs JSONL: one line per operation with timing and metadata
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${BENCH_TARGET_DIR:-/tmp/bench-target}"
RESULTS_DIR="${SCRIPT_DIR}/results"
PROFILE="${1:-solo-sequential}"
DATASTORE_LABEL="${2:-filesystem}"
ITERATIONS="${3:-10}"

mkdir -p "$RESULTS_DIR"
OUTFILE="${RESULTS_DIR}/${DATASTORE_LABEL}-${PROFILE}-$(date +%Y%m%dT%H%M%S).jsonl"

# --- Helpers ---

ts_ms() {
  date +%s%3N
}

emit() {
  local op="$1" duration_ms="$2" exit_code="$3" extra="${4:-}"
  local base
  base=$(jq -nc \
    --arg ts "$(date -Iseconds)" \
    --arg ds "$DATASTORE_LABEL" \
    --arg prof "$PROFILE" \
    --arg op "$op" \
    --argjson dur "$duration_ms" \
    --argjson rc "$exit_code" \
    '{ts:$ts, datastore:$ds, profile:$prof, op:$op, duration_ms:$dur, exit_code:$rc}')
  if [[ -n "$extra" ]]; then
    echo "$base" | jq -c ". + $extra" >> "$OUTFILE"
  else
    echo "$base" >> "$OUTFILE"
  fi
}

run_timed() {
  local op="$1"; shift
  local start end duration rc output
  start=$(ts_ms)
  set +e
  output=$("$@" 2>&1)
  rc=$?
  set -e
  end=$(ts_ms)
  duration=$((end - start))

  # Extract sync metrics if present
  local pushed pulled
  pushed=$(echo "$output" | jq -r '.filesPushed // empty' 2>/dev/null || echo "")
  pulled=$(echo "$output" | jq -r '.filesPulled // empty' 2>/dev/null || echo "")

  local extra="{\"iter\":${CURRENT_ITER:-0}}"
  [[ -n "$pushed" ]] && extra=$(echo "$extra" | jq -c ". + {files_pushed: $pushed}")
  [[ -n "$pulled" ]] && extra=$(echo "$extra" | jq -c ". + {files_pulled: $pulled}")

  emit "$op" "$duration" "$rc" "$extra"
  return $rc
}

# --- Workload Profiles ---

workload_solo_sequential() {
  echo "Running solo-sequential: $ITERATIONS iterations" >&2
  for i in $(seq 1 "$ITERATIONS"); do
    export CURRENT_ITER="$i"

    # Write operation (model method run)
    run_timed "method_run" \
      swamp model method run bench-load execute \
        --input "run=echo iteration-${i}" --json \
        --repo-dir "$TARGET_DIR"

    # Sync push (skip if datastore doesn't support it)
    if [[ "$DATASTORE_LABEL" != "filesystem" ]]; then
      run_timed "sync_push" \
        swamp datastore sync --push --json --repo-dir "$TARGET_DIR" || true

      run_timed "sync_pull" \
        swamp datastore sync --pull --json --repo-dir "$TARGET_DIR" || true
    fi
  done
}

workload_solo_burst() {
  echo "Running solo-burst: $ITERATIONS rapid method calls" >&2
  for i in $(seq 1 "$ITERATIONS"); do
    export CURRENT_ITER="$i"
    run_timed "method_run" \
      swamp model method run bench-load execute \
        --input "run=echo burst-${i}" --json \
        --repo-dir "$TARGET_DIR"
  done
  # Single sync after burst (if supported)
  if [[ "$DATASTORE_LABEL" != "filesystem" ]]; then
    export CURRENT_ITER="final"
    run_timed "sync_push" \
      swamp datastore sync --push --json --repo-dir "$TARGET_DIR" || true
  fi
}

workload_sync_only() {
  if [[ "$DATASTORE_LABEL" == "filesystem" ]]; then
    echo "Skipping sync-only profile: filesystem doesn't support sync" >&2
    return 0
  fi
  echo "Running sync-only: $ITERATIONS push/pull cycles" >&2
  for i in $(seq 1 "$ITERATIONS"); do
    export CURRENT_ITER="$i"
    run_timed "sync_push" \
      swamp datastore sync --push --json --repo-dir "$TARGET_DIR" || true
    run_timed "sync_pull" \
      swamp datastore sync --pull --json --repo-dir "$TARGET_DIR" || true
  done
}

workload_lock_contention() {
  echo "Running lock-contention: $ITERATIONS parallel pairs" >&2
  for i in $(seq 1 "$ITERATIONS"); do
    export CURRENT_ITER="$i"
    # Launch two method runs simultaneously
    local start end
    start=$(ts_ms)
    swamp model method run bench-load execute \
      --input "run=echo a-${i}" --json --repo-dir "$TARGET_DIR" &>/dev/null &
    local pid1=$!
    swamp model method run bench-load execute \
      --input "run=echo b-${i}" --json --repo-dir "$TARGET_DIR" &>/dev/null &
    local pid2=$!

    local rc1=0 rc2=0
    wait $pid1 || rc1=$?
    wait $pid2 || rc2=$?
    end=$(ts_ms)

    emit "parallel_pair" "$((end - start))" "$((rc1 + rc2))" "{\"iter\":${i},\"rc1\":${rc1},\"rc2\":${rc2}}"
  done
}

# --- Main ---

echo "=== Datastore Benchmark ===" >&2
echo "Target:    $TARGET_DIR" >&2
echo "Datastore: $DATASTORE_LABEL" >&2
echo "Profile:   $PROFILE" >&2
echo "Iters:     $ITERATIONS" >&2
echo "Output:    $OUTFILE" >&2
echo "" >&2

case "$PROFILE" in
  solo-sequential) workload_solo_sequential ;;
  solo-burst)      workload_solo_burst ;;
  sync-only)       workload_sync_only ;;
  lock-contention) workload_lock_contention ;;
  *)
    echo "Unknown profile: $PROFILE" >&2
    echo "Available: solo-sequential, solo-burst, sync-only, lock-contention" >&2
    exit 1
    ;;
esac

echo "" >&2
echo "Done. Results: $OUTFILE" >&2
echo "Lines: $(wc -l < "$OUTFILE")" >&2
