/**
 * Fails when a tracked, non-test TypeScript file writes a data name that swamp
 * reserves (see lib/scan.ts). Run from the repository root:
 *
 *   deno run --allow-read scripts/check-reserved-names/main.ts
 *
 * @module
 */

import { walk } from "@std/fs/walk";
import { relative, resolve } from "@std/path";
import { scanSource } from "./lib/scan.ts";

/**
 * Directories to skip, matched against the path *below the scan root* so a dot
 * directory above the root (`~/.cache/...`, a self-hosted runner path) cannot
 * make the scan skip everything.
 */
function skipPatterns(root: string): RegExp[] {
  const prefix = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // .git, .swamp, .worktrees, .claude, .cache, ...
    new RegExp(`^${prefix}/(.*/)?(\\.[^/]+|node_modules)(/|$)`),
  ];
}

async function main(): Promise<number> {
  const root = resolve(Deno.args[0] ?? Deno.cwd());
  let scanned = 0;
  const findings = [];
  for await (
    const entry of walk(root, {
      exts: [".ts"],
      includeDirs: false,
      skip: skipPatterns(root),
    })
  ) {
    const file = relative(root, entry.path);
    if (file.endsWith("_test.ts")) continue;
    // The scanner's own reserved-name list is the one legitimate literal.
    if (file.startsWith("scripts/check-reserved-names/")) continue;
    scanned++;
    findings.push(
      ...scanSource(file, await Deno.readTextFile(entry.path)),
    );
  }
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.reason}\n    ${f.text}`);
  }
  console.log(
    `check-reserved-names: scanned ${scanned} files, ${findings.length} finding(s)`,
  );
  if (scanned === 0) {
    // A scan that read nothing proves nothing; never let it pass.
    console.error(`check-reserved-names: no .ts files found under ${root}`);
    return 2;
  }
  return findings.length === 0 ? 0 : 1;
}

Deno.exit(await main());
