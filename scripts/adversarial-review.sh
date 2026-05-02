#!/usr/bin/env bash
# Run adversarial code review locally against the current branch's diff vs main.
# Usage: ./scripts/adversarial-review.sh [PR_NUMBER]
set -euo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  DIFF=$(git diff origin/main...HEAD)
else
  DIFF=$(gh pr diff "$PR")
fi

if [ -z "$DIFF" ]; then
  echo "No diff found." >&2
  exit 1
fi

# Read CLAUDE.md if it exists
CONVENTIONS=""
if [ -f CLAUDE.md ]; then
  CONVENTIONS=$(cat CLAUDE.md)
fi

PROMPT="You are an ADVERSARIAL code reviewer. Your job is to find problems the author would miss.

PROJECT CONVENTIONS:
${CONVENTIONS}

DIFF:
${DIFF}

Review the diff systematically across these dimensions:
1. Logic & Correctness — trace code paths, edge cases (empty, zero, null, undefined)
2. Error Handling — what happens when external calls fail?
3. Security — injection, path traversal, sensitive data exposure
4. Data Integrity — silent truncation, cache staleness, incorrect truncated flags
5. API Contract — breaking changes, inconsistencies with existing patterns

Rules:
- Be SPECIFIC with file:line references and concrete breaking examples
- Classify as CRITICAL/HIGH (blocks merge), MEDIUM (warning), LOW (theoretical)
- Do NOT flag style issues or documentation gaps
- If the code is solid, say so

Format:
## Adversarial Review
### Critical / High
### Medium
### Low
### Verdict: PASS or FAIL with reason"

echo "$PROMPT" | kiro-cli chat --no-interactive --trust-all-tools -
