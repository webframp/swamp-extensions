/**
 * Extension maintenance model.
 *
 * Observes a multi-extension repository, audits dependency freshness,
 * plans version bumps, applies changes, and runs quality gates.
 *
 * **Methods:**
 * - `audit` — Pure observation. Scans all extensions, queries registry.
 * - `plan-bump` — Reads audit output, produces a structured change plan.
 * - `apply-bump` — Executes the plan (writes files). Human-approved.
 * - `quality-gate` — Runs check/lint/fmt/test/quality across extensions.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

/** Global arguments schema for the maintainer model. */
const GlobalArgsSchema = z.object({
  repo_root: z
    .string()
    .default(".")
    .describe("Path to the extension repository root"),
  registry_timeout: z
    .number()
    .int()
    .min(5)
    .max(120)
    .default(30)
    .describe("Seconds to wait for registry queries"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Schema for a single dependency's version status (current vs latest). */
const DepStatusSchema = z.object({
  name: z.string().describe("Dependency package name"),
  current: z.string().describe("Currently pinned version"),
  latest: z.string().describe("Latest available version"),
  stale: z.boolean().describe("Whether current < latest"),
});

/** Schema for a single extension's full dependency and quality status. */
const ExtensionStatusSchema = z.object({
  name: z.string().describe("Extension manifest name"),
  dir: z.string().describe("Directory relative to repo root"),
  version: z.string().describe("Current manifest version"),
  qualityScore: z.number().describe("Quality rubric percentage (0-100)"),
  npmDeps: z.array(DepStatusSchema).describe("npm dependency status"),
  testingDep: DepStatusSchema.nullable().describe("swamp-testing status"),
  manifestDeps: z.array(DepStatusSchema).describe("Manifest pin status"),
  lockfileSync: z.object({
    hasDeno: z.boolean().describe("Extension has a deno.json"),
    hasLock: z.boolean().describe("Extension has a deno.lock"),
    inSync: z.boolean().describe("Lock resolves every pin in deno.json"),
    staleEntries: z.array(z.object({
      specifier: z.string().describe("The import specifier from deno.json"),
      jsonVersion: z.string().describe("Version declared in deno.json"),
      lockVersion: z.string().nullable().describe(
        "Version resolved in deno.lock, null if missing",
      ),
    })).describe("Specifiers where the lock disagrees with deno.json"),
  }).describe("Whether deno.lock agrees with deno.json"),
  directSpecifiers: z.array(z.object({
    file: z.string().describe("File path relative to extension dir"),
    specifier: z.string().describe("The fully-qualified import specifier"),
    alias: z.string().nullable().describe(
      "Import map alias that should have been used, or null if unmapped",
    ),
  })).describe(
    "Imports that bypass the deno.json import map by naming a version directly",
  ),
  stale: z.boolean().describe("Any dependency is stale"),
  lockDrifted: z.boolean().describe("Lock does not match deno.json"),
});

/** Schema for the complete audit summary resource. */
const AuditSummarySchema = z.object({
  scannedAt: z.string().describe("ISO 8601 audit timestamp"),
  repoRoot: z.string().describe("Repository root path"),
  totalExtensions: z.number().describe("Total extensions scanned"),
  staleCount: z.number().describe("Extensions with stale deps"),
  categories: z.object({
    npm: z.number().describe("Extensions with stale npm deps"),
    testing: z.number().describe("Extensions with stale test framework"),
    manifest: z.number().describe("Extensions with stale manifest pins"),
    lockDrifted: z.number().describe("Extensions with deno.lock out of sync"),
    directSpecifiers: z.number().describe(
      "Extensions with imports bypassing the import map",
    ),
  }),
  extensions: z.array(ExtensionStatusSchema).describe(
    "Per-extension dependency and quality status",
  ),
});

/** Schema for a single extension's planned bump entry. */
const BumpPlanEntrySchema = z.object({
  name: z.string().describe("Extension manifest name"),
  dir: z.string().describe("Directory relative to repo root"),
  currentVersion: z.string().describe("Current manifest version"),
  nextVersion: z.string().describe("Planned next CalVer version"),
  changes: z.array(z.object({
    file: z.string().describe("File path relative to extension dir"),
    find: z.string().describe("Version string to replace"),
    replace: z.string().describe("Replacement version string"),
    category: z.enum([
      "npm",
      "testing",
      "manifest-pin",
      "manifest-version",
      "source-version",
    ]).describe("Which kind of version reference this change targets"),
  })).describe("Find/replace edits needed to apply this extension's bump"),
  releaseNotes: z.string().describe("Generated RELEASE_NOTES.md content"),
});

/** Schema for the complete bump plan resource. */
const BumpPlanSchema = z.object({
  plannedAt: z.string().describe("ISO 8601 plan timestamp"),
  totalEntries: z.number().describe("Extensions to bump"),
  entries: z.array(BumpPlanEntrySchema).describe(
    "Planned bump entries, one per extension to be bumped",
  ),
  skipped: z.array(z.object({
    name: z.string().describe("Extension manifest name"),
    dir: z.string().describe("Directory relative to repo root"),
    reason: z.string().describe("Why the extension was not planned for a bump"),
  })).describe(
    "Extensions that are stale but excluded from the plan (e.g. test-only changes)",
  ),
});

/** Schema for the apply-bump result resource. */
const ApplyResultSchema = z.object({
  appliedAt: z.string().describe("ISO 8601 apply timestamp"),
  dryRun: z
    .boolean()
    .describe(
      "True when the run reported changes without writing them. On a dry run extensionsBumped and filesModified are both 0; filesMatched carries the scope.",
    ),
  extensionsBumped: z
    .number()
    .describe(
      "Extensions whose file writes completed with a valid upgrade chain. 0 on a dry run. Excludes entries that threw mid-write and entries where the written upgrade chain fails checkUpgradeChain (see errors); a deno.lock regeneration failure still counts as bumped because the files were written.",
    ),
  filesModified: z
    .number()
    .describe("Files actually written to disk. 0 on a dry run."),
  filesMatched: z
    .number()
    .describe(
      "Files where the target string was present, so a real run would rewrite them. Populated on dry runs and real runs alike. On a real run with errors this can exceed filesModified: matches are counted before the write is attempted, so files belonging to an entry that threw are matched but not modified. Cross-reference the errors array to attribute the difference.",
    ),
  errors: z.array(z.object({
    extension: z.string().describe(
      "Extension manifest name the error belongs to",
    ),
    error: z.string().describe("Error message describing the failure"),
  })).describe("Per-extension errors encountered while applying the plan"),
});

/** Schema for the quality-gate result resource. */
const QualityResultSchema = z.object({
  ranAt: z.string().describe("ISO 8601 timestamp"),
  totalExtensions: z.number().describe(
    "Number of extensions the gate ran against",
  ),
  passed: z.number().describe("Number of extensions that passed all checks"),
  failed: z.number().describe(
    "Number of extensions with at least one failing check",
  ),
  results: z.array(z.object({
    name: z.string().describe("Extension manifest name"),
    dir: z.string().describe("Directory relative to repo root"),
    check: z.boolean().describe("Whether `deno task check` passed"),
    lint: z.boolean().describe("Whether `deno task lint` passed"),
    fmt: z.boolean().describe("Whether `deno task fmt` passed"),
    test: z.boolean().describe("Whether `deno task test` passed"),
    quality: z.number().describe("Quality score 0-100"),
    extensionFmt: z.boolean().describe(
      "Whether `swamp extension fmt --check` passed",
    ),
    errors: z.array(z.string()).describe(
      "Human-readable descriptions of every failing check",
    ),
  })).describe("Per-extension quality gate results"),
});

// =============================================================================
// Helpers
// =============================================================================

/** Run a command and return stdout, or null on failure. */
async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ stdout: string; success: boolean }> {
  const proc = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    success: output.success,
  };
}

/** Query npm registry for latest version of a package. */
async function npmLatest(
  pkg: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://registry.npmjs.org/${pkg}/latest`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Query JSR for latest version of a scoped package. */
async function jsrLatest(
  scope: string,
  name: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://jsr.io/@${scope}/${name}/meta.json`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.latest ?? null;
  } catch {
    return null;
  }
}

/** Discover all extensions (directories containing manifest.yaml). */
async function discoverExtensions(repoRoot: string): Promise<string[]> {
  const dirs: string[] = [];
  const findCmd = await run([
    "find",
    repoRoot,
    "-name",
    "manifest.yaml",
    "-not",
    "-path",
    "*/.worktrees/*",
    "-not",
    "-path",
    "*/.swamp/*",
    "-maxdepth",
    "3",
  ]);
  if (!findCmd.success) return dirs;
  for (const line of findCmd.stdout.trim().split("\n")) {
    if (!line) continue;
    const dir = line.replace(/\/manifest\.yaml$/, "");
    dirs.push(dir);
  }
  return dirs.sort();
}

/** Extract npm import versions from .ts source files in an extension. */
async function extractNpmImports(
  extDir: string,
  warnings?: string[],
): Promise<Map<string, string>> {
  const imports = new Map<string, string>();
  const findCmd = await run([
    "find",
    `${extDir}/extensions`,
    "-name",
    "*.ts",
    "-not",
    "-name",
    "*_test.ts",
  ]);
  if (!findCmd.success) return imports;

  for (const file of findCmd.stdout.trim().split("\n")) {
    if (!file) continue;
    // Read the file and extract npm: specifiers from non-comment lines.
    // This avoids false positives from code examples in documentation comments.
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const npmSpecRe = /npm:([^"'`\s)]+)/g;
    let inBlockComment = false;
    for (const line of content.split("\n")) {
      // Track block comment state
      const trimmed = line.trimStart();
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        continue;
      }
      // Skip single-line comment lines
      if (trimmed.startsWith("//")) continue;
      for (const m of line.matchAll(npmSpecRe)) {
        const spec = m[1]!; // e.g. @aws-sdk/client-s3@3.1094.0
        const atIdx = spec.lastIndexOf("@");
        if (atIdx <= 0) {
          // Unversioned import (e.g. just "zod") — flag it
          if (warnings) {
            warnings.push(`Unversioned npm import: npm:${spec} in ${file}`);
          }
          continue;
        }
        const pkg = spec.slice(0, atIdx);
        const ver = spec.slice(atIdx + 1);
        // Validate version looks like semver — reject garbage
        if (!/^\d+\.\d+\.\d+/.test(ver)) {
          if (warnings) {
            warnings.push(
              `Skipping non-semver version "${ver}" for ${pkg} in ${file}`,
            );
          }
          continue;
        }
        imports.set(pkg, ver);
      }
    }
  }
  return imports;
}

/** Read swamp-testing version from deno.json. */
async function readTestingVersion(extDir: string): Promise<string | null> {
  try {
    const content = await Deno.readTextFile(`${extDir}/deno.json`);
    const deno = JSON.parse(content);
    const imports = deno.imports ?? {};
    const testing: string | undefined = imports["@systeminit/swamp-testing"];
    if (!testing) return null;
    // jsr:@systeminit/swamp-testing@0.20260604.20
    const match = testing.match(/@([\d.]+)$/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Check whether deno.lock agrees with deno.json.
 *
 * For each specifier in deno.json's `imports`, verifies that deno.lock has a
 * matching resolution at the same version. A missing entry or a version
 * mismatch means the lock will rewrite itself the moment anyone runs a deno
 * command.
 */
async function checkLockfileSync(extDir: string): Promise<{
  hasDeno: boolean;
  hasLock: boolean;
  inSync: boolean;
  staleEntries: Array<{
    specifier: string;
    jsonVersion: string;
    lockVersion: string | null;
  }>;
}> {
  let denoJson: { imports?: Record<string, string> };
  try {
    denoJson = JSON.parse(await Deno.readTextFile(`${extDir}/deno.json`));
  } catch {
    return { hasDeno: false, hasLock: false, inSync: true, staleEntries: [] };
  }

  let lockContent: string;
  try {
    lockContent = await Deno.readTextFile(`${extDir}/deno.lock`);
  } catch {
    return { hasDeno: true, hasLock: false, inSync: true, staleEntries: [] };
  }

  const imports = denoJson.imports ?? {};
  const staleEntries: Array<{
    specifier: string;
    jsonVersion: string;
    lockVersion: string | null;
  }> = [];

  for (const [_alias, specifier] of Object.entries(imports)) {
    if (!specifier) continue;
    // Extract the version from specifiers like "npm:zod@4.4.3" or
    // "jsr:@systeminit/swamp-testing@0.20260604.20"
    const versionMatch = specifier.match(/@([\d][^"]*)$/);
    if (!versionMatch) continue;
    const jsonVersion = versionMatch[1]!;

    // Look for this specifier in the lock's specifiers section.
    // The lock records lines like: "npm:zod@4.4.3": "4.4.3" or
    // "jsr:@systeminit/swamp-testing@0.20260604.20": "0.20260604.20"
    // Also check workspace.dependencies for the bare specifier.
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const specRegex = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`);
    const specMatch = lockContent.match(specRegex);

    if (specMatch) {
      // Found, check version matches
      if (specMatch[1] !== jsonVersion) {
        staleEntries.push({
          specifier,
          jsonVersion,
          lockVersion: specMatch[1]!,
        });
      }
    } else {
      // Not found in specifiers at all — check workspace.dependencies
      if (!lockContent.includes(`"${specifier}"`)) {
        staleEntries.push({ specifier, jsonVersion, lockVersion: null });
      }
    }
  }

  return {
    hasDeno: true,
    hasLock: true,
    inSync: staleEntries.length === 0,
    staleEntries,
  };
}

/**
 * Find source files that import versioned specifiers directly instead of using
 * the deno.json import map alias.
 *
 * A direct `jsr:@systeminit/swamp-testing@0.20260504.10` import bypasses the
 * alias, so a pin change in deno.json does not reach it. This also catches
 * config files that *generate* a specifier string, since the grep pattern
 * matches any occurrence of a versioned jsr:/npm: specifier.
 */
async function findDirectSpecifiers(
  extDir: string,
): Promise<
  Array<{ file: string; specifier: string; alias: string | null }>
> {
  // Read deno.json import map to know which specifiers have aliases
  let imports: Record<string, string> = {};
  try {
    const dj = JSON.parse(await Deno.readTextFile(`${extDir}/deno.json`));
    imports = dj.imports ?? {};
  } catch {
    // No deno.json — no aliases to compare against
  }

  // Build a reverse map: specifier-prefix → alias name
  const aliasFor = new Map<string, string>();
  for (const [alias, spec] of Object.entries(imports)) {
    if (!spec) continue;
    // Strip the version to match against the prefix:
    // "jsr:@systeminit/swamp-testing@0.20260604.20" → "jsr:@systeminit/swamp-testing@"
    const atIdx = spec.lastIndexOf("@");
    if (atIdx > 4) {
      aliasFor.set(spec.slice(0, atIdx + 1), alias);
    }
  }

  const results: Array<
    { file: string; specifier: string; alias: string | null }
  > = [];
  const seen = new Set<string>();

  // Scan all .ts files (including tests, configs, and codegen)
  const findCmd = await run([
    "find",
    extDir,
    "-name",
    "*.ts",
    "-not",
    "-path",
    "*/.swamp/*",
  ]);
  if (!findCmd.success) return results;

  for (const file of findCmd.stdout.trim().split("\n")) {
    if (!file) continue;
    const relFile = file.slice(extDir.length + 1);
    // Skip deno.json itself (imports there are declarations, not bypasses)
    if (relFile === "deno.json") continue;

    const grepCmd = await run([
      "grep",
      "-ohE",
      '(jsr:|npm:)(@[^"@/]+/)?[^"@]+@[0-9][^"\'` ]*',
      file,
    ]);
    if (!grepCmd.success) continue;

    for (const match of grepCmd.stdout.trim().split("\n")) {
      if (!match) continue;
      // Find the alias this should have used
      const atIdx = match.lastIndexOf("@");
      if (atIdx <= 4) continue;
      const prefix = match.slice(0, atIdx + 1);
      const alias = aliasFor.get(prefix) ?? null;

      // Deduplicate: the same specifier appearing multiple times in one file is
      // one bypass site, not many.
      const key = `${relFile}|${match}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ file: relFile, specifier: match, alias });
    }
  }

  return results;
}

/** Read manifest dependency pins. */
async function readManifestDeps(
  extDir: string,
): Promise<Array<{ name: string; version: string }>> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const deps: Array<{ name: string; version: string }> = [];
    const lines = content.split("\n");
    let inDeps = false;
    for (const line of lines) {
      if (line.match(/^dependencies:\s*$/)) {
        inDeps = true;
        continue;
      }
      if (inDeps && line.match(/^\s+-\s+"/)) {
        // Extract full "name@version" then split on last @
        const fullMatch = line.match(/"([^"]+)"/);
        if (fullMatch) {
          const full = fullMatch[1]!;
          const lastAt = full.lastIndexOf("@");
          if (lastAt > 0) {
            deps.push({
              name: full.slice(0, lastAt),
              version: full.slice(lastAt + 1),
            });
          }
        }
      } else if (inDeps && !line.match(/^\s+-/) && !line.match(/^\s*$/)) {
        inDeps = false;
      }
    }
    return deps;
  } catch {
    return [];
  }
}

/** Get extension quality score via swamp extension quality. */
async function getQualityScore(extDir: string): Promise<number> {
  const result = await run(
    ["swamp", "extension", "quality", "manifest.yaml", "--json"],
    extDir,
  );
  if (!result.success) return 0;
  try {
    const data = JSON.parse(result.stdout);
    return data.percentage ?? 0;
  } catch {
    return 0;
  }
}

/** Query registry for latest version of a swamp extension. */
async function registryLatest(extName: string): Promise<string | null> {
  const result = await run([
    "swamp",
    "extension",
    "info",
    extName,
    "--json",
  ]);
  if (!result.success) return null;
  try {
    const data = JSON.parse(result.stdout);
    return data.latestVersion ?? null;
  } catch {
    return null;
  }
}

/** Compute next CalVer version, incrementing the sequence if already bumped today. */
function nextCalVer(currentVersion: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const todayPrefix = `${y}.${m}.${d}.`;

  if (currentVersion.startsWith(todayPrefix)) {
    const seq = parseInt(currentVersion.slice(todayPrefix.length), 10);
    return `${todayPrefix}${(isNaN(seq) ? 0 : seq) + 1}`;
  }
  return `${todayPrefix}1`;
}

/** Read the version field from manifest.yaml. */
async function readManifestVersion(extDir: string): Promise<string> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const match = content.match(/^version:\s*"([^"]+)"/m);
    return match ? match[1]! : "unknown";
  } catch {
    return "unknown";
  }
}

/** Read the extension name from manifest.yaml. */
async function readManifestName(extDir: string): Promise<string> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const match = content.match(/^name:\s*"([^"]+)"/m);
    return match ? match[1]! : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the model version string(s) from non-test .ts source files in an
 * extension directory. Returns a map of file path → version string for every
 * file that exports a model/driver/vault with a CalVer `version:` field.
 *
 * This reads the *actual* source content rather than trusting the manifest,
 * which may have drifted if a prior bump partially applied.
 */
async function readSourceVersions(
  extDir: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const findResult = await run([
    "find",
    `${extDir}/extensions`,
    "-name",
    "*.ts",
    "-not",
    "-name",
    "*_test.ts",
  ]);
  if (!findResult.success) return versions;

  for (const file of findResult.stdout.trim().split("\n")) {
    if (!file) continue;
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    // Match the version field in a model/driver/vault export.
    // The pattern targets `version: "YYYY.MM.DD.N"` inside an export object.
    const match = content.match(
      /version:\s*["'](\d{4}\.\d{2}\.\d{2}\.\d+)["']/,
    );
    if (match) {
      versions.set(file, match[1]!);
    }
  }
  return versions;
}

// =============================================================================
// Validation Checks
// =============================================================================

/** Checks that the last upgrade chain entry's toVersion matches the model version,
 * AND that the model version matches the manifest version (if provided).
 * Returns an error message if broken, null if valid or no upgrades present. */
async function checkUpgradeChain(
  extDir: string,
  manifestVersion?: string,
): Promise<string | null> {
  const tsFiles: string[] = [];
  try {
    const findResult = await run(
      [
        "find",
        `${extDir}/extensions`,
        "-name",
        "*.ts",
        "-not",
        "-name",
        "*_test.ts",
      ],
      extDir,
    );
    if (findResult.success) {
      tsFiles.push(
        ...findResult.stdout.trim().split("\n").filter(Boolean),
      );
    }
  } catch {
    return null;
  }

  for (const file of tsFiles) {
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    if (!content.includes("upgrades") || !content.includes("toVersion")) {
      continue;
    }
    const versionMatch = content.match(
      /version:\s*["'](\d{4}\.\d{2}\.\d{2}\.\d+)["']/,
    );
    if (!versionMatch) continue;
    const modelVersion = versionMatch[1];

    const toVersionMatches = [
      ...content.matchAll(/toVersion:\s*["']([^"']+)["']/g),
    ];
    if (toVersionMatches.length === 0) continue;

    const lastToVersion = toVersionMatches[toVersionMatches.length - 1][1];
    if (lastToVersion !== modelVersion) {
      return `upgrade chain broken: last toVersion "${lastToVersion}" != model version "${modelVersion}"`;
    }

    // Cross-check: source model version must match manifest version.
    // A mismatch means apply-bump failed to update the source file (e.g.
    // because the find pattern was built from the manifest, which had already
    // drifted from the source).
    if (manifestVersion && modelVersion !== manifestVersion) {
      const relFile = file.slice(extDir.length + 1);
      return `source/manifest version mismatch: ${relFile} has version "${modelVersion}" but manifest.yaml has "${manifestVersion}"`;
    }
  }
  return null;
}

/** Checks that RELEASE_NOTES.md contains an entry for the current manifest version.
 * Returns an error message if missing, null if valid. */
async function checkReleaseNotes(extDir: string): Promise<string | null> {
  const manifestVersion = await readManifestVersion(extDir);
  if (manifestVersion === "unknown") return null; // No manifest — skip

  const rnPath = `${extDir}/RELEASE_NOTES.md`;
  let content: string;
  try {
    content = await Deno.readTextFile(rnPath);
  } catch {
    return `RELEASE_NOTES.md missing (version ${manifestVersion} has no release notes)`;
  }

  if (!content.includes(`## ${manifestVersion}`)) {
    return `RELEASE_NOTES.md missing entry for current version ${manifestVersion}`;
  }
  return null;
}

/** Checks that all direct npm/jsr specifiers in source files are resolved in
 * deno.lock. A stale lockfile means CI will fail with frozen lockfile checks.
 * Returns an error message listing missing specifiers, or null if all present. */
async function checkLockfileCompleteness(
  extDir: string,
): Promise<string | null> {
  let lockContent: string;
  try {
    lockContent = await Deno.readTextFile(`${extDir}/deno.lock`);
  } catch {
    return null; // No lockfile — nothing to check
  }

  const specifiers = await findDirectSpecifiers(extDir);
  const missing: string[] = [];

  for (const { specifier } of specifiers) {
    // Check if this exact specifier appears in the lockfile
    if (!lockContent.includes(`"${specifier}"`)) {
      // Also check without quotes (some lock formats vary)
      if (!lockContent.includes(specifier)) {
        missing.push(specifier);
      }
    }
  }

  if (missing.length > 0) {
    return `deno.lock missing ${missing.length} specifier(s): ${
      missing.slice(0, 3).join(", ")
    }${missing.length > 3 ? "..." : ""}`;
  }
  return null;
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * Extension maintenance model definition.
 *
 * Provides four methods for managing a multi-extension repository:
 * - `audit` — Observe dependency freshness across all extensions.
 * - `plan-bump` — Compute a structured change plan from audit data.
 * - `apply-bump` — Execute the plan (human-approved write step).
 * - `quality-gate` — Run deno check/lint/fmt/test and quality scoring.
 *
 * Each method produces a typed resource stored as versioned swamp data,
 * enabling queries over maintenance history via CEL.
 */
export const model = {
  type: "@webframp/extension-maintenance/maintainer",
  version: "2026.08.15.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    audit: {
      description: "Full dependency audit report across all extensions.",
      schema: AuditSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    plan: {
      description: "Structured bump plan for human review.",
      schema: BumpPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    apply: {
      description: "Result of applying a bump plan.",
      schema: ApplyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    quality: {
      description: "Quality gate results for all extensions.",
      schema: QualityResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    audit: {
      description:
        "Scan all extensions, query registries, produce a staleness report. Pure observation, zero side effects.",
      arguments: z.object({
        filter: z
          .string()
          .optional()
          .describe("Glob pattern to filter extensions by directory name"),
      }),
      execute: async (
        args: { filter?: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, ...a: unknown[]) => void;
            warn: (msg: string, ...a: unknown[]) => void;
          };
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        context.logger.info(`Scanning extensions in ${resolvedRoot}`);
        const extDirs = await discoverExtensions(resolvedRoot);
        context.logger.info(`Found ${extDirs.length} extensions`);

        // Deduplicate npm packages to minimize registry queries
        const allNpmPkgs = new Set<string>();
        const extNpmMaps: Map<string, Map<string, string>> = new Map();

        const unpinnedWarnings: string[] = [];

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;
          const npmImports = await extractNpmImports(dir, unpinnedWarnings);
          extNpmMaps.set(dir, npmImports);
          for (const pkg of npmImports.keys()) {
            allNpmPkgs.add(pkg);
          }
        }

        for (const w of unpinnedWarnings) {
          context.logger.warn(w);
        }

        // Batch-query npm registry
        const timeoutMs = context.globalArgs.registry_timeout * 1000;
        context.logger.info(
          `Querying npm registry for ${allNpmPkgs.size} packages`,
        );
        const npmLatestVersions = new Map<string, string>();
        for (const pkg of allNpmPkgs) {
          const latest = await npmLatest(pkg, timeoutMs);
          if (latest) npmLatestVersions.set(pkg, latest);
        }

        // Query swamp-testing latest
        const testingLatest = await jsrLatest(
          "systeminit",
          "swamp-testing",
          timeoutMs,
        );
        context.logger.info(`swamp-testing latest: ${testingLatest}`);

        // Build per-extension status
        const extensions: z.infer<typeof ExtensionStatusSchema>[] = [];
        let staleNpm = 0;
        let staleTesting = 0;
        let staleManifest = 0;

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;

          const name = await readManifestName(dir);
          const version = await readManifestVersion(dir);
          const relDir = dir.slice(resolvedRoot.length + 1) || ".";

          // npm deps
          const npmImports = extNpmMaps.get(dir) ?? new Map();
          const npmDeps: z.infer<typeof DepStatusSchema>[] = [];
          let hasStaleNpm = false;
          for (const [pkg, ver] of npmImports) {
            const latest = npmLatestVersions.get(pkg) ?? ver;
            const stale = ver !== latest;
            if (stale) hasStaleNpm = true;
            npmDeps.push({ name: pkg, current: ver, latest, stale });
          }
          if (hasStaleNpm) staleNpm++;

          // testing dep
          const testVer = await readTestingVersion(dir);
          let testingDep: z.infer<typeof DepStatusSchema> | null = null;
          let hasStaleTesting = false;
          if (testVer && testingLatest) {
            const stale = testVer !== testingLatest;
            if (stale) hasStaleTesting = true;
            testingDep = {
              name: "@systeminit/swamp-testing",
              current: testVer,
              latest: testingLatest,
              stale,
            };
          }
          if (hasStaleTesting) staleTesting++;

          // manifest deps
          const mDeps = await readManifestDeps(dir);
          const manifestDeps: z.infer<typeof DepStatusSchema>[] = [];
          let hasStaleManifest = false;
          for (const dep of mDeps) {
            const latest = await registryLatest(dep.name);
            const stale = latest !== null && dep.version !== latest;
            if (stale) hasStaleManifest = true;
            manifestDeps.push({
              name: dep.name,
              current: dep.version,
              latest: latest ?? dep.version,
              stale,
            });
          }
          if (hasStaleManifest) staleManifest++;

          // quality
          const qualityScore = await getQualityScore(dir);

          // lockfile sync
          const lockfileSync = await checkLockfileSync(dir);
          const lockDrifted = !lockfileSync.inSync;

          // direct specifiers (bypass the import map)
          const directSpecifiers = await findDirectSpecifiers(dir);

          const isStale = hasStaleNpm || hasStaleTesting || hasStaleManifest;
          extensions.push({
            name,
            dir: relDir,
            version,
            qualityScore,
            npmDeps,
            testingDep,
            manifestDeps,
            lockfileSync,
            directSpecifiers,
            stale: isStale,
            lockDrifted,
          });
        }

        const staleCount = extensions.filter((e) => e.stale).length;
        const lockDriftedCount = extensions.filter((e) => e.lockDrifted).length;
        const directSpecCount =
          extensions.filter((e) => e.directSpecifiers.length > 0).length;
        context.logger.info(
          `Audit complete: ${staleCount}/${extensions.length} stale, ${lockDriftedCount} lock-drifted, ${directSpecCount} with direct specifiers`,
        );

        const handle = await context.writeResource("audit", "current-audit", {
          scannedAt: new Date().toISOString(),
          repoRoot: resolvedRoot,
          totalExtensions: extensions.length,
          staleCount,
          categories: {
            npm: staleNpm,
            testing: staleTesting,
            manifest: staleManifest,
            lockDrifted: lockDriftedCount,
            directSpecifiers: directSpecCount,
          },
          extensions,
        });
        return { dataHandles: [handle] };
      },
    },

    "plan-bump": {
      description:
        "Read the latest audit, produce a structured plan of changes. No side effects.",
      arguments: z.object({
        skip_testing: z
          .boolean()
          .default(false)
          .describe(
            "Skip deno.json swamp-testing bump for extensions that also have shipped-file changes. Test-only extensions are always excluded from the plan.",
          ),
      }),
      execute: async (
        args: { skip_testing?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          logger: {
            info: (msg: string, ...a: unknown[]) => void;
            warn: (msg: string, ...a: unknown[]) => void;
          };
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const audit = await context.readResource("current-audit");
        if (!audit) {
          throw new Error(
            "No audit data found. Run the audit method first.",
          );
        }

        const extensions = (audit as {
          extensions: Array<{
            name: string;
            dir: string;
            version: string;
            stale: boolean;
            npmDeps: Array<
              { name: string; current: string; latest: string; stale: boolean }
            >;
            testingDep:
              | { current: string; latest: string; stale: boolean }
              | null;
            manifestDeps: Array<
              { name: string; current: string; latest: string; stale: boolean }
            >;
          }>;
        }).extensions;

        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        const entries: z.infer<typeof BumpPlanEntrySchema>[] = [];
        const skipped: Array<{ name: string; dir: string; reason: string }> =
          [];

        for (const ext of extensions) {
          if (!ext.stale) continue;

          // Verify the extension's version against the actual manifest on disk.
          // The audit snapshot may be stale if the extension was bumped between
          // audit and plan-bump (e.g. a hotfix). Use the on-disk version as the
          // source of truth for find-and-replace targets.
          let currentVersion = ext.version;
          const onDiskVersion = await readManifestVersion(
            `${resolvedRoot}/${ext.dir}`,
          );
          if (
            onDiskVersion !== "unknown" && onDiskVersion !== ext.version
          ) {
            context.logger.warn(
              `${ext.name}: audit recorded version ${ext.version} but manifest has ${onDiskVersion} — using on-disk version`,
            );
            currentVersion = onDiskVersion;
          }

          const nextVer = nextCalVer(currentVersion);
          const changes: z.infer<typeof BumpPlanEntrySchema>["changes"] = [];
          const noteLines: string[] = [];

          // npm dep changes (these modify shipped source files → version bump)
          const staleNpm = ext.npmDeps.filter((d) => d.stale);
          for (const dep of staleNpm) {
            changes.push({
              file: "extensions/**/*.ts",
              find: `${dep.name}@${dep.current}`,
              replace: `${dep.name}@${dep.latest}`,
              category: "npm",
            });
          }
          if (staleNpm.length > 0) {
            const grouped = new Map<string, string[]>();
            for (const dep of staleNpm) {
              const base = dep.name.split("/").slice(0, -1).join("/") ||
                dep.name;
              if (!grouped.has(base)) grouped.set(base, []);
              grouped.get(base)!.push(dep.name.split("/").pop()!);
            }
            for (const [base, pkgs] of grouped) {
              // Use the version from the first package (all under same
              // namespace typically share a version)
              const first = staleNpm.find((d) =>
                d.name === base || d.name.startsWith(base + "/")
              )!;
              if (pkgs.length === 1) {
                noteLines.push(
                  `**Changed:** Bump ${first.name} ${first.current} → ${first.latest}`,
                );
              } else {
                noteLines.push(
                  `**Changed:** Bump ${base}/* ${first.current} → ${first.latest} (${pkgs.length} packages)`,
                );
              }
            }
          }

          // testing dep (test-only → no version bump unless skip_testing=false)
          if (!args.skip_testing && ext.testingDep?.stale) {
            changes.push({
              file: "deno.json",
              find: ext.testingDep.current,
              replace: ext.testingDep.latest,
              category: "testing",
            });
          }

          // manifest dep pins (modifies manifest.yaml → version bump)
          const staleManifest = ext.manifestDeps.filter((d) => d.stale);
          for (const dep of staleManifest) {
            changes.push({
              file: "manifest.yaml",
              find: `${dep.name}@${dep.current}`,
              replace: `${dep.name}@${dep.latest}`,
              category: "manifest-pin",
            });
            noteLines.push(
              `**Changed:** Bump ${dep.name} ${dep.current} → ${dep.latest}`,
            );
          }

          // Only produce an entry if there are shipped-file changes.
          // Test-only changes (swamp-testing bump) do not require a version
          // bump or RELEASE_NOTES per repo conventions.
          const hasShippedChanges = changes.some(
            (c) => c.category !== "testing",
          );
          if (!hasShippedChanges) {
            skipped.push({
              name: ext.name,
              dir: ext.dir,
              reason:
                "stale dependency is test-only (swamp-testing); no published output changes",
            });
            continue;
          }

          // manifest version bump
          changes.push({
            file: "manifest.yaml",
            find: `version: "${currentVersion}"`,
            replace: `version: "${nextVer}"`,
            category: "manifest-version",
          });

          // Source version bump: read the actual version strings from .ts files
          // rather than assuming they match the manifest. A prior partial bump
          // may have left the source at a different version than the manifest.
          const sourceVersions = await readSourceVersions(
            `${resolvedRoot}/${ext.dir}`,
          );
          const uniqueSourceVersions = new Set(sourceVersions.values());

          if (uniqueSourceVersions.size === 0) {
            // No CalVer version fields found in source — fall back to manifest
            // version for the find pattern (extension may not have a version
            // field, e.g. workflow-only extensions).
            changes.push({
              file: "extensions/**/*.ts",
              find: `version: "${currentVersion}"`,
              replace: `version: "${nextVer}"`,
              category: "source-version",
            });
            changes.push({
              file: "extensions/**/*.ts",
              find: `toVersion: "${currentVersion}"`,
              replace: `toVersion: "${nextVer}"`,
              category: "source-version",
            });
          } else {
            // Emit a find/replace for each distinct source version found.
            // This handles the case where the source drifted from the manifest.
            for (const srcVer of uniqueSourceVersions) {
              if (srcVer === nextVer) continue; // Already at target — skip
              changes.push({
                file: "extensions/**/*.ts",
                find: `version: "${srcVer}"`,
                replace: `version: "${nextVer}"`,
                category: "source-version",
              });
              changes.push({
                file: "extensions/**/*.ts",
                find: `toVersion: "${srcVer}"`,
                replace: `toVersion: "${nextVer}"`,
                category: "source-version",
              });
            }
            // If the manifest version differs from all source versions, also
            // emit a pattern for it — covers files that DO match the manifest.
            if (!uniqueSourceVersions.has(currentVersion)) {
              changes.push({
                file: "extensions/**/*.ts",
                find: `version: "${currentVersion}"`,
                replace: `version: "${nextVer}"`,
                category: "source-version",
              });
              changes.push({
                file: "extensions/**/*.ts",
                find: `toVersion: "${currentVersion}"`,
                replace: `toVersion: "${nextVer}"`,
                category: "source-version",
              });
            }
            // Warn if source versions are inconsistent across files
            if (uniqueSourceVersions.size > 1) {
              context.logger.warn(
                `${ext.name}: found multiple source versions (${
                  [...uniqueSourceVersions].join(", ")
                }); emitting find patterns for all`,
              );
            }
          }

          const releaseNotes = `## ${nextVer}\n\n${noteLines.join("\n\n")}\n`;

          entries.push({
            name: ext.name,
            dir: ext.dir,
            currentVersion,
            nextVersion: nextVer,
            changes,
            releaseNotes,
          });
        }

        context.logger.info(
          `Plan: ${entries.length} extensions to bump, ${skipped.length} skipped (test-only)`,
        );

        const handle = await context.writeResource("plan", "current-plan", {
          plannedAt: new Date().toISOString(),
          totalEntries: entries.length,
          entries,
          skipped,
        });
        return { dataHandles: [handle] };
      },
    },

    "apply-bump": {
      description:
        "Execute the latest plan. Writes files. Requires human approval.",
      arguments: z.object({
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, report what would change without writing"),
      }),
      execute: async (
        args: { dry_run?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          logger: {
            info: (msg: string, ...a: unknown[]) => void;
            warn: (msg: string, ...a: unknown[]) => void;
          };
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        const plan = await context.readResource("current-plan");
        if (!plan) {
          throw new Error("No plan found. Run plan-bump first.");
        }

        const entries = (plan as {
          entries: Array<{
            name: string;
            dir: string;
            changes: Array<
              { file: string; find: string; replace: string; category: string }
            >;
            releaseNotes: string;
            nextVersion: string;
            currentVersion: string;
          }>;
        }).entries;

        let filesModified = 0;
        let filesMatched = 0;
        let extensionsBumped = 0;
        const errors: Array<{ extension: string; error: string }> = [];

        for (const entry of entries) {
          const extDir = `${resolvedRoot}/${entry.dir}`;
          context.logger.info(
            `${args.dry_run ? "[DRY RUN] " : ""}Applying: ${entry.name}`,
          );

          try {
            for (const change of entry.changes) {
              if (change.file.includes("*")) {
                // Glob pattern — find matching files. Include test files: when
                // a dependency version changes, test imports must stay in sync
                // to avoid duplicate-singleton bugs (e.g. OTel registries).
                const findResult = await run([
                  "find",
                  `${extDir}/extensions`,
                  "-name",
                  "*.ts",
                ]);
                if (!findResult.success) continue;
                for (const file of findResult.stdout.trim().split("\n")) {
                  if (!file) continue;
                  const content = await Deno.readTextFile(file);
                  if (content.includes(change.find)) {
                    filesMatched++;
                    if (!args.dry_run) {
                      const updated = content.replaceAll(
                        change.find,
                        change.replace,
                      );
                      await Deno.writeTextFile(file, updated);
                      filesModified++;
                    }
                  }
                }
              } else {
                // Specific file
                const filePath = `${extDir}/${change.file}`;
                try {
                  const content = await Deno.readTextFile(filePath);
                  if (content.includes(change.find)) {
                    filesMatched++;
                    if (!args.dry_run) {
                      const updated = content.replaceAll(
                        change.find,
                        change.replace,
                      );
                      await Deno.writeTextFile(filePath, updated);
                      filesModified++;
                    }
                  }
                } catch {
                  // File may not exist for this extension
                }
              }
            }

            // Write RELEASE_NOTES.md — prepend the new entry, preserving
            // existing changelog history.
            filesMatched++;
            if (!args.dry_run) {
              const rnPath = `${extDir}/RELEASE_NOTES.md`;
              let existing = "";
              try {
                existing = await Deno.readTextFile(rnPath);
              } catch (err) {
                if (!(err instanceof Deno.errors.NotFound)) throw err;
                // File doesn't exist yet — start fresh.
              }
              const updated = existing
                ? `${entry.releaseNotes}\n${existing}`
                : entry.releaseNotes;
              await Deno.writeTextFile(rnPath, updated);
              filesModified++;
            }

            // Regenerate deno.lock after pin changes. Two steps are needed:
            // 1. `deno install` resolves specifiers declared in deno.json's
            //    import map.
            // 2. `deno cache` on all .ts source files resolves direct
            //    specifiers (e.g. `npm:@opentelemetry/api@1.9.1`) that bypass
            //    the import map. Without this, the lock retains the old version
            //    and CI fails on lock-check.
            if (!args.dry_run) {
              // Find all .ts files to cache (includes tests — they have deps too)
              const tsFiles = await run([
                "find",
                `${extDir}/extensions`,
                "-name",
                "*.ts",
              ]);
              const fileList = tsFiles.success
                ? tsFiles.stdout.trim().split("\n").filter(Boolean)
                : [];

              // Run deno cache with all source files — this resolves both
              // import-map and direct specifiers into the lockfile.
              const cacheCmd = ["deno", "cache", ...fileList];
              const lockResult = await run(cacheCmd, extDir);
              if (lockResult.success) {
                context.logger.info(
                  `  ↳ deno.lock regenerated for ${entry.name}`,
                );
              } else {
                context.logger.warn(
                  `  ↳ deno cache failed for ${entry.name}`,
                );
                errors.push({
                  extension: entry.name,
                  error:
                    "deno cache failed after writing pin changes; deno.lock may be out of sync",
                });
              }
            }

            // Self-verify the upgrade chain this apply just wrote. quality-gate
            // checks this too, but only if the sweep workflow's verify step
            // actually runs — an ad-hoc audit→plan-bump→apply-bump invocation
            // that skips the workflow (as happened in #298 and again in #322,
            // breaking 19 and then 21 more extensions) would otherwise ship a
            // broken chain undetected. Catch it here, at the point of writing,
            // regardless of what runs after.
            const chainError = !args.dry_run
              ? await checkUpgradeChain(extDir, entry.nextVersion)
              : null;
            if (chainError) {
              errors.push({ extension: entry.name, error: chainError });
            } else if (!args.dry_run) {
              // Reaching here means every write for this entry completed and
              // the chain it wrote is valid. A deno.lock regeneration failure
              // above does not unset this: the files were written, only the
              // lock is stale.
              extensionsBumped++;
            }
          } catch (err: unknown) {
            errors.push({
              extension: entry.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        context.logger.info(
          `Apply complete: ${extensionsBumped}/${entries.length} extensions bumped, ${filesModified} files written, ${filesMatched} matched${
            args.dry_run ? " (dry run — nothing written)" : ""
          }`,
        );

        const handle = await context.writeResource("apply", "current-apply", {
          appliedAt: new Date().toISOString(),
          dryRun: args.dry_run ?? false,
          extensionsBumped,
          filesModified,
          filesMatched,
          errors,
        });
        return { dataHandles: [handle] };
      },
    },

    "quality-gate": {
      description:
        "Run check/lint/fmt/test and quality scoring across all (or filtered) extensions.",
      arguments: z.object({
        filter: z
          .string()
          .optional()
          .describe("Glob pattern to filter extensions by directory name"),
        stop_on_failure: z
          .boolean()
          .default(false)
          .describe("Stop at first failing extension"),
      }),
      execute: async (
        args: { filter?: string; stop_on_failure?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, ...a: unknown[]) => void;
            warn: (msg: string, ...a: unknown[]) => void;
          };
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        const extDirs = await discoverExtensions(resolvedRoot);
        const results: z.infer<typeof QualityResultSchema>["results"] = [];
        let passed = 0;
        let failed = 0;

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;

          // Skip extensions without deno.json (workflow-only, etc.)
          try {
            await Deno.stat(`${dir}/deno.json`);
          } catch {
            continue;
          }

          const name = await readManifestName(dir);
          const relDir = dir.slice(resolvedRoot.length + 1) || ".";
          const errors: string[] = [];

          context.logger.info(`Quality gate: ${name}`);

          const checkResult = await run(["deno", "task", "check"], dir);
          const lintResult = await run(["deno", "task", "lint"], dir);
          const fmtResult = await run(["deno", "task", "fmt"], dir);
          const testResult = await run(["deno", "task", "test"], dir);

          if (!checkResult.success) errors.push("check failed");
          if (!lintResult.success) errors.push("lint failed");
          if (!fmtResult.success) errors.push("fmt failed");
          if (!testResult.success) errors.push("test failed");

          const quality = await getQualityScore(dir);

          // Extension fmt
          const extFmtResult = await run(
            ["swamp", "extension", "fmt", "manifest.yaml", "--check", "--json"],
            dir,
          );
          if (!extFmtResult.success) errors.push("extension fmt failed");

          // Upgrade chain: last toVersion must match model version
          const manifestVer = await readManifestVersion(dir);
          const upgradeChainResult = await checkUpgradeChain(
            dir,
            manifestVer !== "unknown" ? manifestVer : undefined,
          );
          if (upgradeChainResult) errors.push(upgradeChainResult);

          // Release notes: current version must have an entry
          const releaseNotesResult = await checkReleaseNotes(dir);
          if (releaseNotesResult) errors.push(releaseNotesResult);

          // Lockfile completeness: all source specifiers must be in deno.lock
          const lockCompleteResult = await checkLockfileCompleteness(dir);
          if (lockCompleteResult) errors.push(lockCompleteResult);

          const allPassed = errors.length === 0;
          if (allPassed) passed++;
          else failed++;

          results.push({
            name,
            dir: relDir,
            check: checkResult.success,
            lint: lintResult.success,
            fmt: fmtResult.success,
            test: testResult.success,
            quality,
            extensionFmt: extFmtResult.success,
            errors,
          });

          if (!allPassed && args.stop_on_failure) {
            context.logger.warn(`Stopping on failure: ${name}`);
            break;
          }
        }

        context.logger.info(
          `Quality gate complete: ${passed} passed, ${failed} failed`,
        );

        const handle = await context.writeResource(
          "quality",
          "current-quality",
          {
            ranAt: new Date().toISOString(),
            totalExtensions: results.length,
            passed,
            failed,
            results,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
