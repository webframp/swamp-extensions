// SPDX-License-Identifier: Apache-2.0
/**
 * CI's pass condition for `swamp extension quality --json`, from ci.yml's
 * quality-gate job.
 *
 * @module
 */

export interface QualityJudgement {
  passed: boolean;
  /** Why it did not pass; absent on a pass. */
  reason?: string;
  percentage?: number;
  provisionalPercentage?: number;
  allPassed?: boolean;
}

/**
 * Passes when status is "passed", allPassed is not false, and percentage or
 * ifProvisionalEarned.percentage is 100. Empty output, output that is not JSON
 * (a 503 page, an auth error, a stack trace) and a non-zero exit with nothing
 * parseable all fail, never skip.
 */
export function judgeQuality(
  stdout: string,
  exitCode: number | null,
): QualityJudgement {
  if (exitCode === null) {
    return { passed: false, reason: "swamp extension quality did not start" };
  }
  const text = stdout.trim();
  if (!text) {
    return {
      passed: false,
      reason: `swamp extension quality printed nothing (exit ${exitCode})`,
    };
  }
  let r: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    r = parsed as Record<string, unknown>;
  } catch {
    return {
      passed: false,
      reason: `swamp extension quality did not return JSON (exit ${exitCode})`,
    };
  }
  const provisional = r.ifProvisionalEarned as
    | { percentage?: unknown }
    | undefined;
  const percentage = typeof r.percentage === "number"
    ? r.percentage
    : undefined;
  const provisionalPercentage = typeof provisional?.percentage === "number"
    ? provisional.percentage
    : undefined;
  const allPassed = typeof r.allPassed === "boolean" ? r.allPassed : undefined;
  const base = { percentage, provisionalPercentage, allPassed };
  if (r.status !== "passed") {
    return { ...base, passed: false, reason: `status is ${String(r.status)}` };
  }
  if (percentage !== 100 && provisionalPercentage !== 100) {
    return {
      ...base,
      passed: false,
      reason: `score is ${percentage ?? "unknown"}%, ${
        provisionalPercentage ?? "unknown"
      }% once provisional factors are earned; 100 is required`,
    };
  }
  if (allPassed === false) {
    return { ...base, passed: false, reason: "allPassed is false" };
  }
  return { ...base, passed: true };
}
