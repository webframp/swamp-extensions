/**
 * CI check: verifies that every model's upgrade chain terminates at the
 * current version declared in the model export.
 *
 * Swamp's catalog validator requires the last entry in the `upgrades` array
 * to have `toVersion` matching the model's `version` field. Without this,
 * `swamp extension pull` fails with:
 *
 *   "Last upgrade toVersion does not match model version. The upgrade chain
 *    must terminate at the current version."
 *
 * Usage:
 *   deno run --allow-read main.ts [extension-dir ...]
 *
 * When no arguments are given, scans all extensions in the repo root.
 * Exit code 1 if any model has a broken upgrade chain.
 */

import { walk } from "jsr:@std/fs@1/walk";
import { join, relative } from "jsr:@std/path@1";

interface ModelExport {
  version?: string;
  upgrades?: Array<{ toVersion?: string }>;
}

interface Violation {
  file: string;
  modelVersion: string;
  lastUpgradeToVersion: string | undefined;
}

async function findModelFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(root, { exts: [".ts"], skip: [/node_modules/, /_test\.ts$/, /test\.ts$/] })) {
    if (entry.isFile && !entry.name.endsWith("_test.ts") && !entry.name.endsWith("test.ts")) {
      files.push(entry.path);
    }
  }
  return files;
}

async function checkFile(filePath: string): Promise<Violation | null> {
  const content = await Deno.readTextFile(filePath);

  // Quick filter: only check files that export a model with both version and upgrades
  if (!content.includes("upgrades") || !content.includes("version")) return null;
  if (!content.includes("toVersion")) return null;

  // Extract version from the model export
  const versionMatch = content.match(/version:\s*["']([^"']+)["']/);
  if (!versionMatch) return null;
  const modelVersion = versionMatch[1];

  // Extract all toVersion values from upgrades array
  const toVersionMatches = [...content.matchAll(/toVersion:\s*["']([^"']+)["']/g)];
  if (toVersionMatches.length === 0) return null;

  // The last toVersion in the upgrades array must match the model version
  const lastToVersion = toVersionMatches[toVersionMatches.length - 1][1];

  if (lastToVersion !== modelVersion) {
    return {
      file: filePath,
      modelVersion,
      lastUpgradeToVersion: lastToVersion,
    };
  }

  return null;
}

async function main(): Promise<void> {
  const args = Deno.args;
  let roots: string[];

  if (args.length > 0) {
    roots = args;
  } else {
    // Default: scan all extension directories from the repo root
    const repoRoot = join(Deno.cwd(), "../..");
    const entries: string[] = [];
    for await (const entry of Deno.readDir(repoRoot)) {
      if (entry.isDirectory && !entry.name.startsWith(".") && entry.name !== "scripts" && entry.name !== "docs") {
        // Each top-level dir may contain extension subdirs
        const topDir = join(repoRoot, entry.name);
        for await (const sub of Deno.readDir(topDir)) {
          if (sub.isDirectory) {
            const extDir = join(topDir, sub.name, "extensions");
            try {
              await Deno.stat(extDir);
              entries.push(extDir);
            } catch {
              // No extensions/ subdir — try models/ directly
              const modelsDir = join(topDir, sub.name, "extensions", "models");
              try {
                await Deno.stat(modelsDir);
                entries.push(modelsDir);
              } catch { /* skip */ }
            }
          }
        }
      }
    }
    roots = entries;
  }

  const violations: Violation[] = [];

  for (const root of roots) {
    let modelFiles: string[];
    try {
      modelFiles = await findModelFiles(root);
    } catch {
      continue;
    }

    for (const file of modelFiles) {
      const violation = await checkFile(file);
      if (violation) {
        violations.push(violation);
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ ${violations.length} model(s) have broken upgrade chains:\n`);
    for (const v of violations) {
      const rel = relative(Deno.cwd(), v.file);
      console.error(`  ${rel}`);
      console.error(`    model version: ${v.modelVersion}`);
      console.error(`    last toVersion: ${v.lastUpgradeToVersion}`);
      console.error(`    → upgrade chain must terminate at "${v.modelVersion}"\n`);
    }
    Deno.exit(1);
  }

  console.log(`✅ All models have valid upgrade chains.`);
}

main();
