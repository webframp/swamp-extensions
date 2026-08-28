/**
 * Cloudflare OpenAPI → swamp extension code generator.
 *
 * Usage:
 *   deno task generate              # Generate all configured services
 *   deno task generate -- --dry-run # Show what would be generated
 *   deno task generate -- --service r2,kv  # Generate specific services
 *
 * @module
 */

import { OUTPUT_BASE, SERVICES } from "./config.ts";
import { fetchSchema } from "./lib/schema_fetcher.ts";
import { groupOperations } from "./lib/service_grouper.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./lib/method_classifier.ts";
import { generateTestSource } from "./lib/test_generator.ts";
import { computeModelVersion, computeUpgradesBlock } from "./lib/upgrades.ts";
import {
  generateApiLib,
  generateDenoJson,
  generateGitignore,
  generateLicense,
  generateManifest,
  generateReadme,
  generateReleaseNotes,
  generateSwampYaml,
} from "./lib/extension_generator.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

interface GenerateOptions {
  dryRun: boolean;
  services?: string[];
  outputBase?: string;
  version?: string;
  /**
   * Release-notes body for this run. Required when regenerating an extension
   * that already has RELEASE_NOTES.md: the default text claims an initial
   * release, which is false for every version after the first, and the notes
   * are what consumers read to decide whether to upgrade.
   */
  notes?: string;
}

function parseArgs(): GenerateOptions {
  const args = Deno.args;
  const opts: GenerateOptions = { dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--service":
      case "--services":
        opts.services = args[++i]?.split(",");
        break;
      case "--output":
        opts.outputBase = args[++i];
        break;
      case "--version":
        opts.version = args[++i];
        break;
      case "--notes":
        opts.notes = args[++i];
        break;
      case "--notes-file":
        opts.notes = Deno.readTextFileSync(args[++i]);
        break;
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();
  const outputBase = opts.outputBase ?? OUTPUT_BASE;

  // Date prefix for CalVer. Per-model versions are computed from a content
  // diff (see computeModelVersion); `--version` forces a specific version.
  const now = new Date();
  const datePrefix = `${now.getFullYear()}.${
    String(now.getMonth() + 1).padStart(2, "0")
  }.${String(now.getDate()).padStart(2, "0")}`;

  console.log(`\n🔧 Cloudflare Extension Code Generator`);
  console.log(
    `   Version: ${
      opts.version ?? `${datePrefix}.* (per-model, content-based)`
    }`,
  );
  console.log(`   Output:  ${outputBase}/`);
  console.log(`   Mode:    ${opts.dryRun ? "DRY RUN" : "GENERATE"}`);
  console.log(``);

  // Filter services if specified
  const servicesToGenerate = opts.services
    ? SERVICES.filter((s) => opts.services!.includes(s.name))
    : SERVICES;

  if (servicesToGenerate.length === 0) {
    console.error(
      `❌ No matching services found. Available: ${
        SERVICES.map((s) => s.name).join(", ")
      }`,
    );
    Deno.exit(1);
  }

  console.log(
    `📋 Services to generate: ${
      servicesToGenerate.map((s) => s.name).join(", ")
    }`,
  );
  console.log(``);

  // Fetch schema
  console.log(`📥 Fetching Cloudflare OpenAPI spec...`);
  const spec = await fetchSchema(join(outputBase, ".cache"));
  console.log(
    `   ✓ Loaded spec: ${Object.keys(spec.paths).length} paths, ${
      Object.keys(spec.components.schemas).length
    } schemas`,
  );
  console.log(``);

  // Group operations by service
  const groups = groupOperations(spec, servicesToGenerate);
  console.log(`📂 Grouped operations into ${groups.length} services:`);
  for (const group of groups) {
    console.log(
      `   • ${group.config.name}: ${group.operations.length} operations`,
    );
  }
  console.log(``);

  if (groups.length === 0) {
    console.log(`⚠️  No operations matched the configured service prefixes.`);
    console.log(
      `   Check your pathPrefixes in config.ts against the actual spec paths.`,
    );
    Deno.exit(0);
  }

  // Generate each service
  let totalMethods = 0;
  let totalExtensions = 0;

  for (const group of groups) {
    const { config } = group;
    const methods = classifyServiceMethods(group);

    if (methods.length === 0) {
      console.log(`   ⚠️  ${config.name}: no methods classified, skipping`);
      continue;
    }

    totalMethods += methods.length;
    totalExtensions++;

    const modelFileName = `${config.name.replace(/-/g, "_")}.ts`;
    const testFileName = `${config.name.replace(/-/g, "_")}_test.ts`;
    const extDir = join(outputBase, config.name);
    const modelDir = join(extDir, "extensions", "models", "cloudflare");
    const libDir = join(modelDir, "_lib");

    console.log(`   🔨 ${config.name}: ${methods.length} methods`);

    const modelPath = join(modelDir, modelFileName);

    // Content-based version: generate a candidate with a placeholder version
    // and empty upgrades, compare against the on-disk file, and keep the
    // existing version when nothing changed. This makes regeneration idempotent
    // (no date reset on no-op runs) and preserves the hand-written upgrade
    // ledger instead of erasing it.
    const PLACEHOLDER = "0.0.0.0";
    const candidateSource = generateModelSource(
      group,
      methods,
      PLACEHOLDER,
      "  upgrades: [],",
    );
    const versionResult = await computeModelVersion(
      modelPath,
      datePrefix,
      candidateSource,
      PLACEHOLDER,
    );
    // `--version` forces a specific version. When forced, unchanged models are
    // NOT skipped below (see the skip condition) — they are rewritten and get a
    // catch-up upgrade entry, which appendGuarded rejects if the forced version
    // is not strictly greater than the chain's tail.
    const version = opts.version ?? versionResult.version;
    const upgradesBlock = computeUpgradesBlock(
      versionResult.status,
      version,
      versionResult.existingContent,
    );

    if (versionResult.status === "unchanged" && !opts.version) {
      console.log(`      ↳ unchanged (${version}) — no write needed`);
      continue;
    }
    console.log(`      ↳ ${versionResult.status} → ${version}`);

    if (opts.dryRun) {
      console.log(`      [DRY RUN] would write ${extDir}/ (${version})`);
      continue;
    }

    // Create directories
    await ensureDir(libDir);

    // Generate all files
    const modelSource = generateModelSource(
      group,
      methods,
      version,
      upgradesBlock,
    );
    const testSource = generateTestSource(
      config,
      methods,
      modelFileName.replace(".ts", ""),
    );
    const manifest = generateManifest(config, version, modelFileName);
    const denoJson = generateDenoJson();
    const readme = generateReadme(config, methods);
    // Regenerating an existing extension with the default "initial release"
    // text would publish a false claim to the registry, where per-version notes
    // are immutable. Require an explicit body instead of writing a wrong one.
    const notesPath = join(extDir, "RELEASE_NOTES.md");
    const hasExistingNotes = await Deno.stat(notesPath).then(
      () => true,
      () => false,
    );
    if (hasExistingNotes && !opts.notes) {
      console.error(
        `\n❌ ${config.name} already has RELEASE_NOTES.md, so this is not an ` +
          `initial release.\n   Pass --notes "<body>" or --notes-file <path> ` +
          `describing what changed in ${version}.`,
      );
      Deno.exit(1);
    }
    const releaseNotes = generateReleaseNotes(
      config,
      version,
      methods.length,
      opts.notes,
    );
    const swampYaml = generateSwampYaml(
      await Deno.readTextFile(join(extDir, ".swamp.yaml")).catch(() =>
        undefined
      ),
    );
    const gitignore = generateGitignore();
    const apiLib = generateApiLib();
    const license = generateLicense();

    // Write all files
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), manifest);
    await Deno.writeTextFile(join(extDir, "deno.json"), denoJson);
    await Deno.writeTextFile(join(extDir, "README.md"), readme);
    await Deno.writeTextFile(join(extDir, "LICENSE.md"), license);
    await Deno.writeTextFile(join(extDir, "RELEASE_NOTES.md"), releaseNotes);
    await Deno.writeTextFile(join(extDir, ".swamp.yaml"), swampYaml);
    await Deno.writeTextFile(join(extDir, ".gitignore"), gitignore);
    await Deno.writeTextFile(join(modelDir, modelFileName), modelSource);
    await Deno.writeTextFile(join(modelDir, testFileName), testSource);
    await Deno.writeTextFile(join(libDir, "api.ts"), apiLib);
  }

  console.log(``);
  console.log(
    `✅ Generated ${totalExtensions} extensions with ${totalMethods} total methods`,
  );
  if (!opts.dryRun) {
    console.log(`   Output directory: ${outputBase}/`);

    // Post-process: run deno fmt on all generated TypeScript files
    console.log(`\n🎨 Running deno fmt on generated output...`);
    const fmtCmd = new Deno.Command(Deno.execPath(), {
      args: ["fmt", outputBase],
      stdout: "piped",
      stderr: "piped",
    });
    const fmtResult = await fmtCmd.output();
    if (fmtResult.success) {
      console.log(`   ✓ Formatted generated files`);
    } else {
      const stderr = new TextDecoder().decode(fmtResult.stderr);
      console.log(`   ⚠️  deno fmt had issues: ${stderr.slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error:`, err.message);
  Deno.exit(1);
});
