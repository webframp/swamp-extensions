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
# Environment variables for config (no secrets — secrets stay in a swamp vault
# in the target repo and are referenced with vault.get expressions):
#   BENCH_TARGET_DIR   — target repo path (default: /tmp/bench-target)
#   GITLAB_HOST        — GitLab host for gitlab-datastore
#   GITLAB_PROJECT     — GitLab project ID or path for state storage
#   GITLAB_TOKEN_VAULT — vault holding the GitLab token (default: gitlab)
#   GITLAB_TOKEN_KEY   — key of the GitLab token in that vault (default: TOKEN)
#   S3_BUCKET          — S3 bucket name
#   S3_PREFIX          — S3 prefix
#   S3_REGION          — AWS region
#   PG_CONN_VAULT      — vault holding the PostgreSQL URI (default: postgres)
#   PG_CONN_KEY        — key of the URI in that vault (default: CONNECTION_STRING)
#
# The gitlab and postgres labels write the datastore block into the target
# repo's .swamp.yaml with a "${{ vault.get(<vault>, <key>) }}" expression,
# which swamp resolves at startup. They do not use `swamp datastore setup
# --config`, because setup validates the literal config without resolving
# vault expressions, so it would need the secret itself on argv. Requires yq
# (mikefarah/yq v4). Existing local data in the target repo is not migrated.
set -euo pipefail

TARGET_DIR="${BENCH_TARGET_DIR:-/tmp/bench-target}"
LABEL="${1:?Usage: $0 <filesystem|gitlab|s3|postgres>}"

echo "Switching $TARGET_DIR to datastore: $LABEL" >&2

# Vault and key names are interpolated into an expression; allow only safe
# identifier characters.
require_name() {
  if [[ ! "$2" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "Invalid $1: '$2' (letters, digits, '_', '.', '-' only)" >&2
    exit 1
  fi
}

# write_datastore <type> <config-json> — replace the datastore block in the
# target repo's .swamp.yaml. The config JSON carries vault.get expressions,
# never secret values.
write_datastore() {
  DS_TYPE="$1" DS_CONFIG="$2" yq -i \
    '.datastore = {"type": strenv(DS_TYPE), "config": (strenv(DS_CONFIG) | from_json)}' \
    "${TARGET_DIR}/.swamp.yaml"
}

case "$LABEL" in
  filesystem)
    swamp datastore setup filesystem \
      --path "${TARGET_DIR}/.swamp" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  gitlab)
    : "${GITLAB_HOST:?Set GITLAB_HOST}"
    : "${GITLAB_PROJECT:?Set GITLAB_PROJECT}"
    vault="${GITLAB_TOKEN_VAULT:-gitlab}"
    key="${GITLAB_TOKEN_KEY:-TOKEN}"
    require_name GITLAB_TOKEN_VAULT "$vault"
    require_name GITLAB_TOKEN_KEY "$key"
    write_datastore @webframp/gitlab-datastore "$(jq -nc \
      --arg base "https://${GITLAB_HOST}" --arg project "$GITLAB_PROJECT" \
      --arg vault "$vault" --arg key "$key" \
      '{baseUrl: $base, projectId: $project,
        token: ("${{ vault.get(" + $vault + ", " + $key + ") }}")}')"
    ;;
  s3)
    : "${S3_BUCKET:?Set S3_BUCKET}"
    : "${S3_REGION:?Set S3_REGION}"
    swamp datastore setup extension @swamp/s3-datastore \
      --config "{\"bucket\":\"${S3_BUCKET}\",\"prefix\":\"${S3_PREFIX:-bench}\",\"region\":\"${S3_REGION}\"}" \
      --repo-dir "$TARGET_DIR" --json
    ;;
  postgres)
    vault="${PG_CONN_VAULT:-postgres}"
    key="${PG_CONN_KEY:-CONNECTION_STRING}"
    require_name PG_CONN_VAULT "$vault"
    require_name PG_CONN_KEY "$key"
    write_datastore @webframp/postgres-datastore "$(jq -nc \
      --arg vault "$vault" --arg key "$key" \
      '{connectionString: ("${{ vault.get(" + $vault + ", " + $key + ") }}")}')"
    ;;
  *)
    echo "Unknown datastore label: $LABEL" >&2
    echo "Available: filesystem, gitlab, s3, postgres" >&2
    exit 1
    ;;
esac

echo "Verifying health..." >&2
swamp datastore status --json --repo-dir "$TARGET_DIR" | jq '{type, healthy}'
