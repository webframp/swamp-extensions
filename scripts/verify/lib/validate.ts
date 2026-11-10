/**
 * Judges an attestation. Pure: every fact about the pull request (its head
 * tree, the extensions its diff touches, the trust-root files it changes) is
 * passed in, so the verdict can be tested without a repository.
 *
 * The attestation is a claim. Nothing in it is trusted where CI can compute
 * the same fact itself:
 * - coverage is recomputed from the diff, so an attestation that examined
 *   fewer extensions than the PR touches fails;
 * - the required steps are derived from that recomputed set;
 * - the attested gate summary is ignored and recomputed from the steps.
 *
 * @module
 */

import {
  type Attestation,
  ATTESTATION_VERSION,
  requiredStepNames,
} from "./types.ts";

/** Older than this earns a warning. */
export const WARN_AGE_MS = 24 * 60 * 60 * 1000;
/** Older than this fails: registry rules and advisories drift with time. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ValidationInput {
  attestation: Attestation;
  headCommit: string;
  headTree: string;
  /** Extensions the pull request's diff selects, from CI's own discovery. */
  expectedExtensions: readonly string[];
  /** Trust-root files that differ between base and head. */
  trustRootChanges: readonly string[];
  now: Date;
  /** Deno version CI pins; a mismatch is a warning. */
  expectDeno?: string;
  /** Treat trust-root changes as errors rather than warnings. */
  strict?: boolean;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  /** Derived from the steps, never read from the attestation. */
  gate: { allPassed: boolean; passed: number; failed: number; skipped: number };
}

export function validateAttestation(input: ValidationInput): ValidationResult {
  const { attestation: a } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (a.version !== ATTESTATION_VERSION) {
    errors.push(`unknown attestation version: ${String(a.version)}`);
  }

  if (a.subject?.tree !== input.headTree) {
    errors.push(
      `attestation is for tree ${a.subject?.tree}, the PR head has tree ${input.headTree}`,
    );
  }
  if (a.subject?.commit !== input.headCommit) {
    warnings.push(
      `attested commit ${a.subject?.commit?.slice(0, 8)} differs from PR head ${
        input.headCommit.slice(0, 8)
      } (same tree, so the content is what was verified)`,
    );
  }

  // Coverage: everything the PR touches must have been examined.
  const attested = new Set(a.discovery?.extensions ?? []);
  const uncovered = input.expectedExtensions.filter((e) => !attested.has(e));
  if (uncovered.length > 0) {
    errors.push(
      `attestation did not cover ${uncovered.length} extension(s) the PR touches: ${
        uncovered.slice(0, 10).join(", ")
      }${uncovered.length > 10 ? ", ..." : ""}`,
    );
  }

  // Required steps, derived from what CI computes, not from the attestation.
  const byName = new Map((a.steps ?? []).map((s) => [s.name, s]));
  const missing: string[] = [];
  const notPassed: string[] = [];
  for (const name of requiredStepNames(input.expectedExtensions)) {
    const step = byName.get(name);
    if (!step) missing.push(name);
    else if (step.status !== "passed") {
      notPassed.push(`${name} (${step.status})`);
    }
  }
  if (missing.length > 0) {
    errors.push(
      `${missing.length} required step(s) missing: ${
        missing.slice(0, 8).join(", ")
      }${missing.length > 8 ? ", ..." : ""}`,
    );
  }
  if (notPassed.length > 0) {
    errors.push(
      `${notPassed.length} required step(s) did not pass: ${
        notPassed.slice(0, 8).join(", ")
      }${notPassed.length > 8 ? ", ..." : ""}`,
    );
  }

  const steps = a.steps ?? [];
  const gate = {
    passed: steps.filter((s) => s.status === "passed").length,
    failed: steps.filter((s) => s.status === "failed").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
    allPassed: false,
  };
  gate.allPassed = gate.failed === 0 && gate.skipped === 0 && steps.length > 0;
  if (gate.failed > 0) {
    errors.push(`${gate.failed} step(s) failed in the attested run`);
  }
  if (a.gate?.allPassed !== gate.allPassed) {
    warnings.push(
      `attested gate.allPassed=${a.gate?.allPassed} disagrees with the steps (recomputed ${gate.allPassed})`,
    );
  }

  // Reviews: a recorded non-pass blocks; none recorded is only noted, since
  // reviews are not required yet.
  const reviews = a.reviews ?? [];
  const badReviews = reviews.filter((r) => r.verdict !== "pass");
  if (badReviews.length > 0) {
    errors.push(
      `review(s) did not pass: ${
        badReviews.map((r) => `${r.name} (${r.verdict})`).join(", ")
      }`,
    );
  }
  if (reviews.length === 0) {
    warnings.push("no review verdict is recorded in the attestation");
  }

  // Freshness.
  const completed = Date.parse(a.timing?.completedAt ?? "");
  if (Number.isNaN(completed)) {
    errors.push("attestation has no valid completion time");
  } else {
    const age = input.now.getTime() - completed;
    if (age > MAX_AGE_MS) {
      errors.push(
        `attestation is ${Math.floor(age / 86_400_000)} day(s) old (limit ${
          MAX_AGE_MS / 86_400_000
        })`,
      );
    } else if (age > WARN_AGE_MS) {
      warnings.push(
        `attestation is ${Math.floor(age / 3_600_000)}h old (warns past 24h)`,
      );
    }
  }

  if (input.expectDeno && a.environment?.deno !== input.expectDeno) {
    warnings.push(
      `verified with Deno ${a.environment?.deno}, CI pins ${input.expectDeno}`,
    );
  }

  // The attestation is produced by the tooling in the tree it vouches for.
  // A PR that edits that tooling can make it report anything.
  if (input.trustRootChanges.length > 0) {
    const msg = `PR changes the verification tooling (${
      input.trustRootChanges.slice(0, 6).join(", ")
    }${
      input.trustRootChanges.length > 6 ? ", ..." : ""
    }); an attestation produced by that tooling needs a maintainer's review`;
    (input.strict ? errors : warnings).push(msg);
  }

  return { errors, warnings, gate };
}

/** Markdown for a PR comment or job summary. Inputs are rendered as code. */
export function renderSummary(
  commit: string,
  tree: string,
  ref: string | null,
  result: ValidationResult,
): string {
  const code = (s: string) =>
    `\`${s.replace(/[`\r\n]+/g, " ").slice(0, 300)}\``;
  const lines = [
    "## Attestation Validation",
    "",
    `Commit ${code(commit.slice(0, 12))}, tree ${code(tree.slice(0, 12))}${
      ref ? `, ref ${code(ref)}` : ""
    }`,
    "",
  ];
  for (const e of result.errors) lines.push(`- ❌ ${code(e)}`);
  for (const w of result.warnings) lines.push(`- ⚠ ${code(w)}`);
  lines.push(
    "",
    result.errors.length > 0
      ? `### ❌ Failed: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
      : result.warnings.length > 0
      ? `### ⚠ Passed with ${result.warnings.length} warning(s)`
      : "### ✅ Passed",
  );
  return lines.join("\n") + "\n";
}
