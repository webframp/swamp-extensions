/**
 * Change classification: decide what a diff means for the matrix.
 *
 * Fails safe in every ambiguous case. Over-selecting costs runner time;
 * under-selecting ships untested code, so any uncertainty resolves to the full
 * matrix.
 *
 * @module
 */

import type { Extension } from "./discover.ts";

export type Scope = "full" | "scoped";

export interface Classification {
  scope: Scope;
  /** Extension directories to build. Every extension when scope is "full". */
  extensions: string[];
  /** Human-readable explanation, surfaced in the workflow log. */
  reason: string;
  /**
   * True when the selection exceeds MATRIX_LIMIT and cannot be expressed as a
   * single GitHub matrix.
   *
   * Deliberately NOT resolved by truncating. Silently dropping entries would
   * mean silently not testing them, which is the failure mode every other
   * decision here is designed to avoid. The caller must fail instead, and the
   * repo needs chunked or nested matrices at that point.
   */
  overflow: boolean;
}

/**
 * GitHub caps a matrix at 256 jobs per workflow run. 137 extensions as one job
 * each fits; 137 x 4 tasks as a matrix axis would not, which is why tasks are
 * steps rather than a dimension.
 */
export const MATRIX_LIMIT = 256;

/**
 * Classify a set of changed paths.
 *
 * `changed` is repo-root-relative paths. A null or empty list means the diff
 * could not be computed, which selects the full matrix rather than guessing that
 * nothing changed.
 */
export function classify(
  changed: string[] | null,
  exts: Extension[],
  expand: (seed: Iterable<string>) => string[],
): Classification {
  const allDirs = exts.map((e) => e.dir);

  const full = (reason: string): Classification => ({
    scope: "full",
    extensions: allDirs,
    reason,
    overflow: allDirs.length > MATRIX_LIMIT,
  });

  if (changed === null) return full("diff could not be computed");
  if (changed.length === 0) return full("empty diff");

  // Longest-prefix match, so `cloudflare/kv/...` attributes to `cloudflare/kv`
  // rather than to the shorter `cloudflare` that also prefixes it.
  const dirsByLength = [...allDirs].sort((a, b) => b.length - a.length);

  const touched = new Set<string>();
  const global: string[] = [];

  for (const path of changed) {
    const owner = dirsByLength.find((d) =>
      path === d || path.startsWith(d + "/")
    );
    if (owner) touched.add(owner);
    else global.push(path);
  }

  if (global.length > 0) {
    const sample = global.slice(0, 3).join(", ");
    return full(
      `shared file changed outside every extension: ${sample}` +
        (global.length > 3 ? ` (+${global.length - 3} more)` : ""),
    );
  }

  const expanded = expand(touched);
  const added = expanded.filter((d) => !touched.has(d));
  const reason = added.length > 0
    ? `${touched.size} extension(s) changed, +${added.length} dependent(s): ${
      added.join(", ")
    }`
    : `${touched.size} extension(s) changed, no dependents`;

  return {
    scope: "scoped",
    extensions: expanded,
    reason,
    overflow: expanded.length > MATRIX_LIMIT,
  };
}
