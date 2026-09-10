/**
 * Bump script — re-fetches the fal.ai OpenAPI spec, detects changes, and
 * regenerates affected extensions with bumped versions.
 *
 * Usage (from the falai-codegen directory):
 *   deno task bump                  # Detect changes and bump affected services
 *   deno task bump -- --all         # Force regenerate all services
 *   deno task bump -- --dry-run     # Show what would change
 *
 * @module
 */

import { OUTPUT_BASE, SERVICES } from "../config.ts";
import { fetchSchemaFresh } from "./schema_fetcher.ts";
import { groupOperations } from "./service_grouper.ts";
import { classifyServiceMethods } from "./method_classifier.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";

interface BumpOptions {
  dryRun: boolean;
  all: boolean;
  version?: string;
}

function parseArgs(): BumpOptions {
  const args = Deno.args;
  const opts: BumpOptions = { dryRun: false, all: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--version":
        opts.version = args[++i];
        break;
    }
  }

  return opts;
}

/** Get the next CalVer version, incrementing N if today already has a version */
async function getNextVersion(outputBase: string): Promise<string> {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${y}.${m}.${d}`;

  let maxN = 0;
  for (const service of SERVICES) {
    const manifestPath = join(outputBase, service.name, "manifest.yaml");
    try {
      const content = await Deno.readTextFile(manifestPath);
      const match = content.match(/version:\s*"(\d{4}\.\d{2}\.\d{2}\.\d+)"/);
      if (match) {
        const existingVersion = match[1];
        if (existingVersion.startsWith(datePrefix)) {
          const n = parseInt(existingVersion.split(".")[3], 10);
          if (Number.isFinite(n) && n >= maxN) maxN = n;
        }
      }
    } catch {
      // File doesn't exist yet
    }
  }

  return `${datePrefix}.${maxN + 1}`;
}

interface ServiceDiff {
  name: string;
  oldMethods: number;
  newMethods: number;
  isNew: boolean;
  hasChanges: boolean;
}

async function detectChanges(
  outputBase: string,
  groups: ReturnType<typeof groupOperations>,
): Promise<ServiceDiff[]> {
  const diffs: ServiceDiff[] = [];

  for (const group of groups) {
    const methods = classifyServiceMethods(group);
    const modelPath = join(
      outputBase,
      group.config.name,
      "extensions",
      "models",
      "falai",
      `${group.config.name.replace(/-/g, "_")}.ts`,
    );

    let isNew = false;
    let oldMethods = 0;

    if (await exists(modelPath)) {
      const content = await Deno.readTextFile(modelPath);
      const methodMatches = content.match(/^\s{4}\w+:\s*{$/gm);
      oldMethods = methodMatches?.length ?? 0;
    } else {
      isNew = true;
    }

    diffs.push({
      name: group.config.name,
      oldMethods,
      newMethods: methods.length,
      isNew,
      hasChanges: isNew || methods.length !== oldMethods,
    });
  }

  return diffs;
}

async function main() {
  const opts = parseArgs();

  console.log(`\n🔄 fal.ai Extension Bump Tool`);
  console.log(`   Mode: ${opts.dryRun ? "DRY RUN" : "BUMP"}`);
  console.log(
    `   Scope: ${opts.all ? "ALL services" : "Changed services only"}`,
  );
  console.log(``);

  console.log(`📥 Fetching fresh fal.ai OpenAPI spec...`);
  const spec = await fetchSchemaFresh(join(OUTPUT_BASE, ".cache"));
  console.log(
    `   ✓ Loaded: ${Object.keys(spec.paths).length} paths`,
  );
  console.log(``);

  const groups = groupOperations(spec, SERVICES);

  const diffs = await detectChanges(OUTPUT_BASE, groups);
  const changed = opts.all ? diffs : diffs.filter((d) => d.hasChanges);

  if (changed.length === 0) {
    console.log(`✅ No changes detected. All extensions are up to date.`);
    Deno.exit(0);
  }

  console.log(`📊 Changes detected:`);
  for (const diff of changed) {
    if (diff.isNew) {
      console.log(`   🆕 ${diff.name}: NEW (${diff.newMethods} methods)`);
    } else if (diff.newMethods > diff.oldMethods) {
      console.log(
        `   ➕ ${diff.name}: ${diff.oldMethods} → ${diff.newMethods} methods`,
      );
    } else if (diff.newMethods < diff.oldMethods) {
      console.log(
        `   ➖ ${diff.name}: ${diff.oldMethods} → ${diff.newMethods} methods`,
      );
    } else {
      console.log(`   🔄 ${diff.name}: ${diff.newMethods} methods (forced)`);
    }
  }
  console.log(``);

  if (opts.dryRun) {
    console.log(`Would regenerate ${changed.length} extensions.`);
    Deno.exit(0);
  }

  const version = opts.version ?? await getNextVersion(OUTPUT_BASE);
  console.log(`📌 Version: ${version}`);
  console.log(``);

  const serviceNames = changed.map((d) => d.name).join(",");
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "main.ts",
      "--services",
      serviceNames,
      "--version",
      version,
    ],
    cwd: import.meta.dirname ? join(import.meta.dirname, "..") : ".",
    stdout: "inherit",
    stderr: "inherit",
  });

  const result = await cmd.output();
  if (!result.success) {
    console.error(`\n❌ Generation failed`);
    Deno.exit(1);
  }

  console.log(`\n✅ Bump complete. Review changes and open a PR.`);
}

main().catch((err) => {
  console.error(`\n❌ Fatal error:`, err.message);
  Deno.exit(1);
});
