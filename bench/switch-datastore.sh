#!/usr/bin/env bash
# switch-datastore.sh — Switch the bench target repo to a different datastore
# Usage: ./switch-datastore.sh <label> [extra-args...]
#
# Labels map to datastore setup commands:
#   filesystem    — local filesystem (baseline)
#   gitlab        — @webframp/gitlab-datastore
#   s3            — @swamp/s3-datastore
#   postgres      — @webframp/postgres-datastore
#
# Environment variables for config:
#   BENCH_TARGET_DIR   — target repo path (default: /tmp/bench-target)
#   GITLAB_HOST        — GitLab host for gitlab-datastore
#   GITLAB_PROJECT     — GitLab project path for state storage
#   GITLAB_TOKEN       — GitLab token (or vault ref)
#   S3_BUCKET          — S3 bucket name
#   S3_PREFIX          — S3 prefix
#   S3_REGION          — AWS region
#   PG_CONN            — PostgreSQL connection string
set -euo pipefail

TARGET_DIR="${BENCH_TARGET_DIR:-/tmp/bench-target}"
LABEL="${1:?Usage: $0 <filesystem|gitlab|s3|postgres>}"

echo "Switching $TARGET_DIR to datastore: $LABEL" >&2

case "$LABEL" in
  filesystem)
    swamp datastore setup filesystem \
      --path "${TARGET_DIR}/.swamp" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  gitlab)
    : "${GITLAB_HOST:?Set GITLAB_HOST}"
    : "${GITLAB_PROJECT:?Set GITLAB_PROJECT}"
    : "${GITLAB_TOKEN:?Set GITLAB_TOKEN}"
    swamp datastore setup extension @webframp/gitlab-datastore \
      --config "{\"host\":\"${GITLAB_HOST}\",\"project\":\"${GITLAB_PROJECT}\",\"token\":\"${GITLAB_TOKEN}\"}" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  s3)
    : "${S3_BUCKET:?Set S3_BUCKET}"
    : "${S3_REGION:?Set S3_REGION}"
    swamp datastore setup extension @swamp/s3-datastore \
      --config "{\"bucket\":\"${S3_BUCKET}\",\"prefix\":\"${S3_PREFIX:-bench}\",\"region\":\"${S3_REGION}\"}" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  postgres)
    : "${PG_CONN:?Set PG_CONN}"
    swamp datastore setup extension @webframp/postgres-datastore \
      --config "{\"connectionString\":\"${PG_CONN}\"}" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  *)
    echo "Unknown datastore label: $LABEL" >&2
    echo "Available: filesystem, gitlab, s3, postgres" >&2
    exit 1
    ;;
esac

echo "Verifying health..." >&2
swamp datastore status --json --repo-dir "$TARGET_DIR" | jq '{type, healthy}'
