// SPDX-License-Identifier: Apache-2.0
/**
 * The repo-wide greps CI's "Validate manifests" job runs, reproduced exactly.
 *
 * CI's zod-pin grep scans every .ts file in the repository, this one included,
 * and counts each distinct match as a pin. So no line here may contain the
 * text the greps match: the patterns are assembled from parts, and
 * ci_patterns_test.ts runs both greps over this extension to prove it.
 *
 * @module
 */

const FROM = "fr" + "om";

/** CI's bare-specifier pattern, as written in ci.yml. */
export const BARE_SPECIFIER_PATTERN = FROM + ' "(zod|postgres|ioredis)"';

/** CI's zod-pin pattern, as written in ci.yml. */
export const ZOD_PIN_PATTERN = FROM + ' "npm:' + "zod@" + '[^"]*"';

/** Flags and arguments of the two greps, each as it appears in ci.yml. */
export const GREP_FLAGS = [
  '--include="*.ts"',
  '--exclude="*_test.ts"',
  "--exclude-dir=.swamp",
  "--exclude-dir=.worktrees",
  "--exclude-dir=scripts",
  'find . -type d -name extensions -not -path "*/.swamp/*"',
] as const;

/**
 * Bare specifiers in shipped extension source. Prints every match; empty
 * output is a pass.
 */
export const BARE_SPECIFIER_COMMAND = [
  `grep -rnE '${BARE_SPECIFIER_PATTERN}'`,
  '--include="*.ts"',
  '--exclude="*_test.ts"',
  "--exclude-dir=.swamp",
  "--exclude-dir=.worktrees",
  '$(find . -type d -name extensions -not -path "*/.swamp/*")',
  "2>/dev/null || true",
].join(" ");

/**
 * Distinct zod pins outside scripts/ (codegen templates interpolate the
 * version). One line or none is a pass.
 */
export const ZOD_PIN_COMMAND = [
  `grep -rhoE '${ZOD_PIN_PATTERN}'`,
  '--include="*.ts"',
  "--exclude-dir=.swamp",
  "--exclude-dir=.worktrees",
  "--exclude-dir=scripts",
  ". 2>/dev/null | sort -u",
].join(" ");

/** Judges the bare-specifier grep's output. */
export function judgeBareSpecifiers(output: string): string | null {
  const lines = output.split("\n").filter((l) => l.trim());
  return lines.length === 0
    ? null
    : `bare import specifier(s) in shipped source: ${
      lines.slice(0, 5).join("; ")
    }`;
}

/** Judges the zod-pin grep's output. */
export function judgeZodPins(output: string): string | null {
  const pins = output.split("\n").filter((l) => l.trim());
  return pins.length <= 1 ? null : `inconsistent zod pins: ${pins.join(", ")}`;
}
