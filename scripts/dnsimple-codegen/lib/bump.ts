/**
 * Bump script — re-fetches the DNSimple OpenAPI spec, detects changes, and
 * regenerates affected extensions with bumped versions.
 *
 * Usage (from the dnsimple-codegen directory):
 *   deno task bump                  # Detect changes and bump affected services
 *   deno task bump -- --all         # Force regenerate all services
 *   deno task bump -- --dry-run     # Show what would change
 *
 * @module
 */

import { OUTPUT_BASE, SERVICES } from "../config.ts";
import { applySpecCorrections, fetchSchemaFresh } from "./schema_fetcher.ts";
import { groupOperations } from "./service_grouper.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import { computeModelVersion } from "./upgrades.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";

interface BumpOptions {
  dryRun: boolean;
  all: boolean;
  version?: string;
  /** Release notes forwarded to main.ts, which requires them for a bump. */
  notes?: string;
  notesFile?: string;
}

function parseArgs(): BumpOptions {
  const args = Deno.args;
  const opts: BumpOptions = { dryRun: false, all: false };
  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`\n❌ ${flag} needs a value`);
      Deno.exit(1);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--version":
        opts.version = value(++i, flag);
        break;
      case "--notes":
        opts.notes = value(++i, flag);
        break;
      case "--notes-file":
        opts.notesFile = value(++i, flag);
        break;
      default:
        console.error(`\n❌ unknown argument ${flag}`);
        Deno.exit(1);
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

/** Stand-in version, so the candidate source compares equal to what is on disk. */
const PLACEHOLDER = "0.0.0.0";

/**
 * Compare each service's freshly generated model source with the file on
 * disk. A new response field or enum value changes the source without
 * changing the method count, so the comparison is on content.
 */
async function detectChanges(
  outputBase: string,
  groups: ReturnType<typeof groupOperations>,
): Promise<ServiceDiff[]> {
  const diffs: ServiceDiff[] = [];
  const now = new Date();
  const datePrefix = `${now.getFullYear()}.${
    String(now.getMonth() + 1).padStart(2, "0")
  }.${String(now.getDate()).padStart(2, "0")}`;

  for (const group of groups) {
    const methods = classifyServiceMethods(group);
    const modelPath = join(
      outputBase,
      group.config.name,
      "extensions",
      "models",
      "dnsimple",
      `${group.config.name.replace(/-/g, "_")}.ts`,
    );

    let isNew = false;
    let oldMethods = 0;
    let contentChanged = false;

    if (await exists(modelPath)) {
      const content = await Deno.readTextFile(modelPath);
      const methodMatches = content.match(/^\s{4}\w+:\s*{$/gm);
      oldMethods = methodMatches?.length ?? 0;
      const candidate = generateModelSource(
        group,
        methods,
        PLACEHOLDER,
        "  upgrades: [],",
      );
      const result = await computeModelVersion(
        modelPath,
        datePrefix,
        candidate,
        PLACEHOLDER,
      );
      contentChanged = result.status !== "unchanged";
    } else {
      isNew = true;
    }

    diffs.push({
      name: group.config.name,
      oldMethods,
      newMethods: methods.length,
      isNew,
      hasChanges: isNew || contentChanged,
    });
  }

  return diffs;
}

async function main() {
  const opts = parseArgs();

  console.log(`\n🔄 DNSimple Extension Bump Tool`);
  console.log(`   Mode: ${opts.dryRun ? "DRY RUN" : "BUMP"}`);
  console.log(
    `   Scope: ${opts.all ? "ALL services" : "Changed services only"}`,
  );
  console.log(``);

  console.log(`📥 Fetching fresh DNSimple OpenAPI spec...`);
  const spec = await fetchSchemaFresh(join(OUTPUT_BASE, ".cache"));
  applySpecCorrections(spec);
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

  if (!opts.notes && !opts.notesFile) {
    console.error(
      `❌ A bump rewrites RELEASE_NOTES.md. Pass --notes "<body>" or ` +
        `--notes-file <path> describing what changed.`,
    );
    Deno.exit(1);
  }

  const version = opts.version ?? await getNextVersion(OUTPUT_BASE);
  console.log(`📌 Version: ${version}`);
  console.log(``);

  const serviceNames = changed.map((d) => d.name).join(",");
  const notesArgs = opts.notes
    ? ["--notes", opts.notes]
    : ["--notes-file", opts.notesFile!];
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
      ...notesArgs,
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
