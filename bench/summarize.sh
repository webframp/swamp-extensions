#!/usr/bin/env bash
# summarize.sh — Summarize benchmark JSONL results
# Usage: ./summarize.sh [results-dir]
set -euo pipefail

RESULTS_DIR="${1:-$(dirname "$0")/results}"

if [ ! -d "$RESULTS_DIR" ] || [ -z "$(ls "$RESULTS_DIR"/*.jsonl 2>/dev/null)" ]; then
  echo "No results found in $RESULTS_DIR" >&2
  exit 1
fi

echo "=== Benchmark Summary ==="
echo ""

for f in "$RESULTS_DIR"/*.jsonl; do
  label=$(basename "$f" .jsonl)
  echo "--- $label ---"

  # Per-operation stats
  jq -rs '
    group_by(.op) | map({
      op: .[0].op,
      count: length,
      min_ms: (map(.duration_ms) | min),
      max_ms: (map(.duration_ms) | max),
      avg_ms: ((map(.duration_ms) | add) / length | floor),
      p50_ms: (sort_by(.duration_ms) | .[length/2 | floor].duration_ms),
      errors: (map(select(.exit_code != 0)) | length)
    }) | .[] | "\(.op)\t n=\(.count)\t min=\(.min_ms)ms\t avg=\(.avg_ms)ms\t p50=\(.p50_ms)ms\t max=\(.max_ms)ms\t errors=\(.errors)"
  ' "$f"
  echo ""
done

# Cross-datastore comparison if multiple results exist
count=$(ls "$RESULTS_DIR"/*.jsonl 2>/dev/null | wc -l)
if [ "$count" -gt 1 ]; then
  echo "=== Cross-Datastore Comparison (avg method_run ms) ==="
  for f in "$RESULTS_DIR"/*.jsonl; do
    label=$(basename "$f" .jsonl | cut -d- -f1)
    avg=$(jq -rs '[.[] | select(.op == "method_run")] | if length > 0 then ((map(.duration_ms) | add) / length | floor) else 0 end' "$f")
    printf "  %-20s %d ms\n" "$label" "$avg"
  done
fi
