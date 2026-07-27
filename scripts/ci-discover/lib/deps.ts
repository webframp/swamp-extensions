/**
 * Reverse-dependency expansion.
 *
 * Nine extensions declare dependencies on fifteen others, and `aws/inventory`
 * alone has four dependents. Diff-scoping without expansion would test a change
 * to it in isolation and report green while its dependents were never built.
 *
 * @module
 */

import { type Extension, nameToDir, stripVersion } from "./discover.ts";

/**
 * Build dependents edges: directory -> directories that depend on it.
 *
 * Dependency specifiers naming an extension outside this repo are ignored — they
 * cannot be built here, so they cannot be affected by a local change.
 */
export function buildDependents(exts: Extension[]): Map<string, Set<string>> {
  const byName = nameToDir(exts);
  const dependents = new Map<string, Set<string>>();

  for (const ext of exts) {
    for (const spec of ext.dependencies) {
      const depDir = byName.get(stripVersion(spec));
      if (!depDir) continue; // external or unresolvable
      if (depDir === ext.dir) continue; // self-reference, ignore
      let set = dependents.get(depDir);
      if (!set) {
        set = new Set();
        dependents.set(depDir, set);
      }
      set.add(ext.dir);
    }
  }

  return dependents;
}

/**
 * Expand a seed set to include everything that transitively depends on it.
 *
 * Breadth-first with a visited set, so a dependency cycle terminates instead of
 * looping. Cycles are not currently present but nothing prevents one being
 * introduced, and a CI script that hangs is worse than one that over-selects.
 */
export function expandDependents(
  seed: Iterable<string>,
  dependents: Map<string, Set<string>>,
): string[] {
  const selected = new Set<string>(seed);
  const queue = [...selected];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    for (const dep of dependents.get(dir) ?? []) {
      if (selected.has(dep)) continue;
      selected.add(dep);
      queue.push(dep);
    }
  }

  return [...selected].sort((a, b) => a.localeCompare(b));
}
