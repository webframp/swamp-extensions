/**
 * Decides what a review agent's output means. A review passes only when it
 * states an explicit `VERDICT: pass` on a line of its own. Nothing is
 * inferred: output that is empty, too short to be a review, or lacks the
 * marker is `missing`, and a human looks. This keeps a stub body such as
 * "FINDINGS - SEE BELOW" from counting as either a pass or a real failure.
 *
 * @module
 */

import type { ReviewKind } from "./types.ts";

export type Verdict =
  | { kind: "pass" }
  | { kind: "fail" }
  | { kind: "missing"; reason: "empty-output" | "no-marker" }
  | { kind: "provider-error" };

/** Output below this size cannot be a review. */
export const MIN_REVIEW_BYTES = 50;

const PROVIDER_ERROR =
  /hit your (weekly|daily|monthly) limit|rate_limit_error|overloaded_error|authentication_error|invalid_api_key|credit balance is too low|exceeded your .*quota/i;

const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * A reviewer quoting an error code or the marker format inside code is
 * describing, not answering. Code is blanked before either is searched for.
 */
function withoutCode(text: string): string {
  return text.replace(FENCED_BLOCK, " ").replace(INLINE_CODE, " ");
}

/** Line-initial marker; emphasis characters may surround its parts. */
const MARKER = /^[ \t>*_]*VERDICT[ \t*_]*:[ \t*_]*(pass|fail)\b/im;

export function determineVerdict(output: string): Verdict {
  const prose = withoutCode(output);
  if (PROVIDER_ERROR.test(prose)) return { kind: "provider-error" };

  const marker = prose.match(MARKER);
  if (marker) {
    return marker[1].toLowerCase() === "pass"
      ? { kind: "pass" }
      : { kind: "fail" };
  }

  const bytes = new TextEncoder().encode(output).length;
  return {
    kind: "missing",
    reason: bytes < MIN_REVIEW_BYTES ? "empty-output" : "no-marker",
  };
}

export function toReviewKind(v: Verdict): ReviewKind {
  return v.kind;
}
