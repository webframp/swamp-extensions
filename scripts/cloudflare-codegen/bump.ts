/**
 * Bump script — re-fetches the Cloudflare OpenAPI spec, detects changes,
 * and regenerates affected extensions with bumped versions.
 *
 * Usage:
 *   deno task bump                  # Detect changes and bump affected services
 *   deno task bump -- --all         # Force regenerate all services
 *   deno task bump -- --dry-run     # Show what would change
 *
 * @module
 */

import { OUTPUT_BASE, SERVICES } from "./config.ts";
import { fetchSchemaFresh } from "./lib/schema_fetcher.ts";
import { groupOperations } from "./lib/service_grouper.ts";
import { classifyServiceMethods } from "./lib/method_classifier.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";

interface BumpOptions {
  dryRun: boolean;
  all: boolean;
  version?: string;
  updateSha: boolean;
}

function parseArgs(): BumpOptions {
  const args = Deno.args;
  const opts: BumpOptions = { dryRun: false, all: false, updateSha: false };

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
      case "--update-sha":
        opts.updateSha = true;
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

  // Check existing versions across all generated manifests
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

/** Detect changes between old and new operation counts per service */
interface ServiceDiff {
  name: string;
  oldMethods: number;
  newMethods: number;
  isNew: boolean;
  hasChanges: boolean;
}

async function detectChanges(
  outputBase: string,
  services: typeof SERVICES,
  groups: ReturnType<typeof groupOperations>,
): Promise<ServiceDiff[]> {
  const diffs: ServiceDiff[] = [];

  for (const group of groups) {
    const methods = classifyServiceMethods(group);
    const manifestPath = join(outputBase, group.config.name, "manifest.yaml");
    const modelPath = join(
      outputBase,
      group.config.name,
      "extensions",
      "models",
      "cloudflare",
      `${group.config.name.replace(/-/g, "_")}.ts`,
    );

    let isNew = false;
    let oldMethods = 0;

    if (await exists(modelPath)) {
      // Count methods in existing file
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

/** Fetch the latest commit SHA from cloudflare/api-schemas and update config.ts */
async function updatePinnedSha(dryRun: boolean): Promise<void> {
  console.log(`📌 Fetching latest SHA from cloudflare/api-schemas...`);

  const response = await fetch(
    "https://api.github.com/repos/cloudflare/api-schemas/commits/main",
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json() as { sha: string };
  const newSha = data.sha;
  console.log(`   Latest SHA: ${newSha}`);

  // Read current config.ts and replace the SHA
  const configPath = new URL("./config.ts", import.meta.url).pathname;
  const content = await Deno.readTextFile(configPath);
  const shaPattern = /export const SCHEMA_SHA = "[a-f0-9]+";/;
  const match = content.match(shaPattern);

  if (!match) {
    throw new Error("Could not find SCHEMA_SHA in config.ts");
  }

  const currentSha = match[0].match(/"([a-f0-9]+)"/)?.[1];
  if (currentSha === newSha) {
    console.log(`   ✓ Already at latest SHA, no update needed.`);
    console.log(``);
    return;
  }

  console.log(`   Current: ${currentSha}`);
  console.log(`   New:     ${newSha}`);

  if (dryRun) {
    console.log(`   Would update config.ts (dry run)`);
    console.log(``);
    return;
  }

  const updated = content.replace(
    shaPattern,
    `export const SCHEMA_SHA = "${newSha}";`,
  );
  await Deno.writeTextFile(configPath, updated);
  console.log(`   ✓ Updated config.ts`);
  console.log(``);
}

async function main() {
  const opts = parseArgs();

  console.log(`\n🔄 Cloudflare Extension Bump Tool`);
  console.log(`   Mode: ${opts.dryRun ? "DRY RUN" : "BUMP"}`);
  console.log(
    `   Scope: ${opts.all ? "ALL services" : "Changed services only"}`,
  );
  console.log(``);

  // Update pinned SHA if requested
  if (opts.updateSha) {
    await updatePinnedSha(opts.dryRun);
  }

  // Fresh fetch (bypass cache)
  console.log(`📥 Fetching fresh Cloudflare OpenAPI spec...`);
  const spec = await fetchSchemaFresh(join(OUTPUT_BASE, ".cache"));
  console.log(
    `   ✓ Loaded: ${Object.keys(spec.paths).length} paths`,
  );
  console.log(``);

  // Group and classify
  const groups = groupOperations(spec, SERVICES);

  // Detect changes
  const diffs = await detectChanges(OUTPUT_BASE, SERVICES, groups);
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

  // Get next version
  const version = opts.version ?? await getNextVersion(OUTPUT_BASE);
  console.log(`📌 Version: ${version}`);
  console.log(``);

  // Regenerate changed services by invoking main.ts
  const serviceNames = changed.map((d) => d.name).join(",");
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "main.ts",
      "--services",
      serviceNames,
      "--version",
      version,
    ],
    cwd: import.meta.dirname ?? ".",
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
