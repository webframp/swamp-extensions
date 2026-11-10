/**
 * Shapes shared by the verification tool: step records written while a
 * verification runs, and the attestation assembled from them.
 *
 * @module
 */

export const ATTESTATION_VERSION = 1;

export type StepStatus = "passed" | "failed" | "skipped";

export interface StepRecord {
  /** Unique within a verification, e.g. "aws/inventory:lint". */
  name: string;
  /** The extension directory the step ran for, when it is per-extension. */
  extension?: string;
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  /** Why a step was skipped or could not run. */
  reason?: string;
}

export interface DiscoveryRecord {
  scope: "full" | "scoped";
  reason: string;
  extensions: string[];
  /** The commit the discovery diff was taken against. */
  base: string;
}

export type ReviewKind = "pass" | "fail" | "missing" | "provider-error";

export interface ReviewRecord {
  name: string;
  verdict: ReviewKind;
}

export interface Attestation {
  version: typeof ATTESTATION_VERSION;
  subject: {
    commit: string;
    /** The key: a squash merge into an up-to-date base keeps this value. */
    tree: string;
    base: string;
    branch: string;
  };
  discovery: DiscoveryRecord;
  steps: StepRecord[];
  reviews: ReviewRecord[];
  environment: { deno: string; swamp: string; os: string };
  timing: { startedAt: string; completedAt: string };
  /** Informational: the validator recomputes this and never trusts it. */
  gate: {
    allPassed: boolean;
    stepsTotal: number;
    stepsPassed: number;
    stepsSkipped: number;
  };
}

/** The per-extension tasks every extension must pass. */
export const EXTENSION_TASKS = ["check", "lint", "fmt:check", "test"] as const;

/**
 * Every step name a verification of `extensions` must contain, passed. The
 * validator derives this from its own discovery, never from the attestation.
 */
export function requiredStepNames(extensions: readonly string[]): string[] {
  const names: string[] = ["reserved-data-names"];
  for (const ext of extensions) {
    for (const task of EXTENSION_TASKS) names.push(`${ext}:${task}`);
    names.push(`${ext}:manifest-fmt`, `${ext}:quality`);
  }
  return names;
}
