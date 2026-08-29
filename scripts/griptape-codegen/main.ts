/**
 * Griptape Cloud OpenAPI → swamp extension code generator.
 *
 * Usage:
 *   deno task generate                       # Generate all configured services
 *   deno task generate:dry-run               # Show what would be generated
 *   deno task generate -- --service threads,tools
 *   deno task generate -- --notes "..."      # Release notes for a regeneration
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
   * release, which is false for every version after the first.
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

  const now = new Date();
  const datePrefix = `${now.getFullYear()}.${
    String(now.getMonth() + 1).padStart(2, "0")
  }.${String(now.getDate()).padStart(2, "0")}`;

  console.log(`\n🔧 Griptape Cloud Extension Code Generator`);
  console.log(
    `   Version: ${
      opts.version ?? `${datePrefix}.* (per-model, content-based)`
    }`,
  );
  console.log(`   Output:  ${outputBase}/`);
  console.log(`   Mode:    ${opts.dryRun ? "DRY RUN" : "GENERATE"}`);
  console.log(``);

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

  console.log(`📥 Fetching Griptape Cloud OpenAPI spec...`);
  // Cache under the codegen dir (fetchSchema's default), NOT under outputBase —
  // the output tree is the published extension set and must stay clean.
  const spec = await fetchSchema();
  console.log(
    `   ✓ Loaded spec: ${Object.keys(spec.paths).length} paths, ${
      Object.keys(spec.components.schemas).length
    } schemas`,
  );
  console.log(``);

  const groups = groupOperations(spec, servicesToGenerate);
  console.log(`📂 Grouped operations into ${groups.length} services:`);
  for (const group of groups) {
    console.log(
      `   • ${group.config.name}: ${group.operations.length} operations`,
    );
  }
  console.log(``);

  if (groups.length === 0) {
    console.log(`⚠️  No operations matched the configured path prefixes.`);
    Deno.exit(0);
  }

  const PLACEHOLDER = "0.0.0.0";

  interface PlannedExtension {
    // deno-lint-ignore no-explicit-any
    group: any;
    // deno-lint-ignore no-explicit-any
    methods: any[];
    version: string;
    status: "new" | "changed" | "unchanged";
    upgradesBlock: string;
    existingContent?: string;
  }

  const plan: PlannedExtension[] = [];
  const rejections: string[] = [];
  let totalMethods = 0;

  // Pass 1 (plan): classify + compute version/upgrades without writing.
  for (const group of groups) {
    const { config } = group;
    const methods = classifyServiceMethods(group);

    if (methods.length === 0) {
      console.log(`   ⚠️  ${config.name}: no methods classified, skipping`);
      continue;
    }

    const modelFileName = `${config.name.replace(/-/g, "_")}.ts`;
    const modelDir = join(
      outputBase,
      config.name,
      "extensions",
      "models",
      "griptape",
    );
    const modelPath = join(modelDir, modelFileName);

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
    const version = opts.version ?? versionResult.version;

    let upgradesBlock: string;
    try {
      upgradesBlock = computeUpgradesBlock(
        versionResult.status,
        version,
        versionResult.existingContent,
      );
    } catch (err) {
      rejections.push(`   • ${config.name}: ${(err as Error).message}`);
      continue;
    }

    plan.push({
      group,
      methods,
      version,
      status: versionResult.status,
      upgradesBlock,
      existingContent: versionResult.existingContent,
    });
  }

  if (rejections.length > 0) {
    console.error(
      `\n❌ --version ${opts.version} was rejected by ${rejections.length} ` +
        `service(s); no files were written:\n${rejections.join("\n")}`,
    );
    Deno.exit(1);
  }

  // Pass 2 (write): iterate the validated plan.
  let totalExtensions = 0;

  for (const planned of plan) {
    const { group, methods, version, status, upgradesBlock } = planned;
    const { config } = group;

    totalMethods += methods.length;
    totalExtensions++;

    const modelFileName = `${config.name.replace(/-/g, "_")}.ts`;
    const testFileName = `${config.name.replace(/-/g, "_")}_test.ts`;
    const extDir = join(outputBase, config.name);
    const modelDir = join(extDir, "extensions", "models", "griptape");
    const libDir = join(modelDir, "_lib");

    console.log(`   🔨 ${config.name}: ${methods.length} methods`);

    if (status === "unchanged" && !opts.version) {
      console.log(`      ↳ unchanged (${version}) — no write needed`);
      continue;
    }
    console.log(`      ↳ ${status} → ${version}`);

    if (opts.dryRun) {
      console.log(`      [DRY RUN] would write ${extDir}/ (${version})`);
      continue;
    }

    await ensureDir(libDir);

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
