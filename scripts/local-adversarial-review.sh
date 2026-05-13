#!/usr/bin/env bash
# Run an adversarial code review locally against the current branch diff vs main.
# Works with both `claude` (Claude Code CLI) and `kiro-cli`.
#
# Usage:
#   ./scripts/local-adversarial-review.sh           # auto-detect tool
#   ./scripts/local-adversarial-review.sh --claude  # force claude
#   ./scripts/local-adversarial-review.sh --kiro    # force kiro-cli
#   REVIEW_TOOL=claude ./scripts/local-adversarial-review.sh
#
# Exit codes:
#   0 - review passed or no diff
#   1 - review found blocking issues or script error
set -euo pipefail

# ---------------------------------------------------------------------------
# Args & tool selection
# ---------------------------------------------------------------------------

TOOL="${REVIEW_TOOL:-auto}"
for arg in "$@"; do
  case "$arg" in
    --claude) TOOL="claude" ;;
    --kiro)   TOOL="kiro" ;;
    --help|-h)
      echo "Usage: $0 [--claude|--kiro]"
      echo "  Auto-detects available tool, or set REVIEW_TOOL env var."
      exit 0
      ;;
  esac
done

if [ "$TOOL" = "auto" ]; then
  if command -v claude &>/dev/null; then
    TOOL="claude"
  elif command -v kiro-cli &>/dev/null; then
    TOOL="kiro"
  else
    echo "ERROR: Neither 'claude' nor 'kiro-cli' found in PATH." >&2
    exit 1
  fi
fi

echo "Using: $TOOL"

# ---------------------------------------------------------------------------
# Gather diff
# ---------------------------------------------------------------------------

DIFF=$(git diff origin/main...HEAD)
if [ -z "$DIFF" ]; then
  echo "No diff vs origin/main. Nothing to review."
  exit 0
fi

DIFF_FILE=$(mktemp)
echo "$DIFF" > "$DIFF_FILE"
trap 'rm -f "$DIFF_FILE"' EXIT

echo "Diff size: $(wc -l < "$DIFF_FILE") lines"

# ---------------------------------------------------------------------------
# Pattern symmetry pre-check (fast, grep-based)
# ---------------------------------------------------------------------------

echo ""
echo "=== Pattern Symmetry Check ==="
SYMMETRY_WARNINGS=0

while IFS= read -r file; do
  if [[ "$file" == *.ts ]] && [ -f "$file" ]; then
    methods=$(grep -c "execute:" "$file" 2>/dev/null || echo 0)
    catches=$(grep -c "\.catch(" "$file" 2>/dev/null || echo 0)
    if [ "$methods" -gt 1 ] && [ "$catches" -gt 0 ] && [ "$catches" -lt "$methods" ]; then
      echo "  WARN: $file — $catches .catch() but $methods execute methods (pattern may be inconsistent)"
      SYMMETRY_WARNINGS=$((SYMMETRY_WARNINGS + 1))
    fi

    # Check truncated flag usage consistency
    truncated_writes=$(grep -c "truncated:" "$file" 2>/dev/null || echo 0)
    truncated_vars=$(grep -c "anyTruncated\|Truncated" "$file" 2>/dev/null || echo 0)
    if [ "$truncated_writes" -gt 1 ] && [ "$truncated_vars" -eq 0 ]; then
      echo "  WARN: $file — multiple 'truncated:' fields but no tracking variable"
      SYMMETRY_WARNINGS=$((SYMMETRY_WARNINGS + 1))
    fi
  fi
done < <(echo "$DIFF" | grep "^+++ b/" | sed 's|^+++ b/||')

if [ "$SYMMETRY_WARNINGS" -eq 0 ]; then
  echo "  OK — no obvious pattern asymmetries detected"
else
  echo ""
  echo "  Found $SYMMETRY_WARNINGS potential asymmetries. Review will check in detail."
fi

# ---------------------------------------------------------------------------
# Conventions
# ---------------------------------------------------------------------------

CONVENTIONS=""
if [ -f CLAUDE.md ]; then
  CONVENTIONS=$(cat CLAUDE.md)
fi

# ---------------------------------------------------------------------------
# Prompt (mirrors CI adversarial review)
# ---------------------------------------------------------------------------

PROMPT="You are an ADVERSARIAL code reviewer. Your job is to be the skeptic — assume
the code is broken until proven otherwise. You are here to find problems that the
author and a standard reviewer would miss.

PROJECT CONVENTIONS:
${CONVENTIONS}

DIFF:
$(cat "$DIFF_FILE")

Your review MUST systematically attempt to break the code across these dimensions:

## 1. Logic & Correctness
- Trace every code path mentally. Are there unreachable branches? Wrong operators?
  Off-by-one errors? Short-circuit evaluation that skips important side effects?
- What happens with empty arrays, empty strings, zero, negative numbers, NaN, undefined, null?
- Are there implicit type coercions that could produce surprising results?

## 2. Error Handling & Failure Modes
- What happens when every external call fails? Network timeout? Permission denied?
- Are errors caught and swallowed silently? Are error messages useful?
- Can a thrown error leave the system in an inconsistent state?
- Are Promise.all calls missing .catch() on individual promises?

## 3. Security
- Command injection via string interpolation in shell commands or subprocess calls
- Path traversal — can user input escape intended directories?
- Sensitive data exposure in logs, error messages, or stack traces
- Are secrets, tokens, or credentials ever hardcoded or logged?

## 4. Concurrency & State
- Can concurrent operations corrupt shared state?
- Are there race conditions in async code? (await ordering, Promise.all error handling)

## 5. Data Integrity
- Can data be silently truncated, rounded, or lost during transformation?
- Are truncated flags honestly reflecting whether more data exists?
- Could cache staleness cause incorrect behavior?

## 6. API Contract & Pattern Consistency
- Does the PR change any function signatures or return types that callers depend on?
- Do new functions follow the existing patterns in the codebase?

## CRITICAL RULE: PATTERN CONSISTENCY
When you find a pattern (like .catch() on batch queries, sanitizeInstanceName(),
truncated tracking, .max() on arguments), you MUST verify it is applied CONSISTENTLY
across ALL methods in the same file that use the same pattern. Inconsistency between
sibling methods is a HIGH finding. Check every execute() method, not just the first one.

## Review Rules
- Be SPECIFIC. Include file:line, what's wrong, a concrete breaking example, and fix.
- Classify as CRITICAL/HIGH (blocks merge), MEDIUM (warning), LOW (theoretical).
- Do NOT flag style issues, naming preferences, or documentation gaps.
- Focus on what a normal review would miss — logic errors, edge cases, failure modes.
- If the code is genuinely solid, say so. Do not invent problems.

Format:
## Adversarial Review

### Critical / High (if any)
[numbered list with file:line, description, breaking example, suggested fix]

### Medium (if any)
[numbered list]

### Low (if any)
[numbered list]

### Verdict
PASS or FAIL with one-line summary"

# ---------------------------------------------------------------------------
# Run review
# ---------------------------------------------------------------------------

echo ""
echo "=== Running Adversarial Review ==="
echo ""

run_review() {
  case "$TOOL" in
    claude)
      echo "$PROMPT" | claude --print --model claude-sonnet-4-6 --allowedTools Read,Glob,Grep -p -
      ;;
    kiro)
      echo "$PROMPT" | kiro-cli chat --no-interactive --trust-all-tools -
      ;;
    *)
      echo "ERROR: Unknown tool '$TOOL'" >&2
      return 1
      ;;
  esac
}

if ! run_review; then
  echo ""
  echo "Review tool exited non-zero"
  exit 1
fi
