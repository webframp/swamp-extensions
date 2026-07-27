import { assertEquals } from "@std/assert";
import { model } from "./maintainer.ts";

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/extension-maintenance/maintainer");
  assertEquals(model.version, "2026.07.27.1");
});

Deno.test("model has all four methods", () => {
  assertEquals(typeof model.methods.audit.execute, "function");
  assertEquals(typeof model.methods["plan-bump"].execute, "function");
  assertEquals(typeof model.methods["apply-bump"].execute, "function");
  assertEquals(typeof model.methods["quality-gate"].execute, "function");
});

Deno.test("model has all four resources", () => {
  assertEquals(model.resources.audit.lifetime, "infinite");
  assertEquals(model.resources.plan.lifetime, "infinite");
  assertEquals(model.resources.apply.lifetime, "infinite");
  assertEquals(model.resources.quality.lifetime, "infinite");
});

Deno.test("globalArguments validates defaults", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.repo_root, ".");
  assertEquals(parsed.registry_timeout, 30);
});

Deno.test("globalArguments validates registry_timeout range", () => {
  const tooLow = model.globalArguments.safeParse({ registry_timeout: 2 });
  assertEquals(tooLow.success, false);

  const tooHigh = model.globalArguments.safeParse({ registry_timeout: 200 });
  assertEquals(tooHigh.success, false);

  const valid = model.globalArguments.safeParse({ registry_timeout: 60 });
  assertEquals(valid.success, true);
});

Deno.test("audit arguments accepts optional filter", () => {
  const valid = model.methods.audit.arguments.safeParse({});
  assertEquals(valid.success, true);

  const withFilter = model.methods.audit.arguments.safeParse({
    filter: "aws/",
  });
  assertEquals(withFilter.success, true);
});

Deno.test("plan-bump arguments defaults skip_testing to false", () => {
  const parsed = model.methods["plan-bump"].arguments.parse({});
  assertEquals(parsed.skip_testing, false);
});

Deno.test("apply-bump arguments defaults dry_run to false", () => {
  const parsed = model.methods["apply-bump"].arguments.parse({});
  assertEquals(parsed.dry_run, false);
});

Deno.test("quality-gate arguments accepts optional filter and stop_on_failure", () => {
  const valid = model.methods["quality-gate"].arguments.safeParse({
    filter: "cloudflare",
    stop_on_failure: true,
  });
  assertEquals(valid.success, true);
});

// ---------------------------------------------------------------------------
// Schema validation for new audit fields
// ---------------------------------------------------------------------------

Deno.test("ExtensionStatusSchema accepts lockfileSync and directSpecifiers", () => {
  const input = {
    name: "@webframp/test",
    dir: "test",
    version: "2026.01.01.1",
    qualityScore: 100,
    npmDeps: [],
    testingDep: null,
    manifestDeps: [],
    lockfileSync: {
      hasDeno: true,
      hasLock: true,
      inSync: false,
      staleEntries: [
        {
          specifier: "jsr:@systeminit/swamp-testing@0.20260604.20",
          jsonVersion: "0.20260604.20",
          lockVersion: null,
        },
      ],
    },
    directSpecifiers: [
      {
        file: "extensions/models/mod_test.ts",
        specifier: "jsr:@systeminit/swamp-testing@0.20260504.10",
        alias: "@systeminit/swamp-testing",
      },
    ],
    stale: false,
    lockDrifted: true,
  };

  // The schema is internal, so we validate through the model's resource schema.
  const auditSchema = model.resources.audit.schema;
  const result = auditSchema.safeParse({
    scannedAt: "2026-07-26T00:00:00Z",
    repoRoot: "/tmp",
    totalExtensions: 1,
    staleCount: 0,
    categories: {
      npm: 0,
      testing: 0,
      manifest: 0,
      lockDrifted: 1,
      directSpecifiers: 1,
    },
    extensions: [input],
  });
  assertEquals(result.success, true);
});

Deno.test("BumpPlanSchema accepts a skipped array", () => {
  const planSchema = model.resources.plan.schema;
  const result = planSchema.safeParse({
    plannedAt: "2026-07-26T00:00:00Z",
    totalEntries: 0,
    entries: [],
    skipped: [
      {
        name: "@webframp/test",
        dir: "test",
        reason: "stale dependency is test-only",
      },
    ],
  });
  assertEquals(result.success, true);
});

Deno.test("BumpPlanSchema rejects missing skipped field", () => {
  const planSchema = model.resources.plan.schema;
  const result = planSchema.safeParse({
    plannedAt: "2026-07-26T00:00:00Z",
    totalEntries: 0,
    entries: [],
    // skipped is now required by the schema
  });
  assertEquals(result.success, false);
});

Deno.test("AuditSummarySchema requires new category counts", () => {
  const auditSchema = model.resources.audit.schema;
  // Missing the new lockDrifted and directSpecifiers counts
  const result = auditSchema.safeParse({
    scannedAt: "2026-07-26T00:00:00Z",
    repoRoot: "/tmp",
    totalExtensions: 0,
    staleCount: 0,
    categories: { npm: 0, testing: 0, manifest: 0 },
    extensions: [],
  });
  assertEquals(result.success, false);
});

Deno.test("ApplyResultSchema requires dryRun", () => {
  const applySchema = model.resources.apply.schema;
  // Without dryRun a stored result cannot be distinguished from a real apply
  const result = applySchema.safeParse({
    appliedAt: "2026-07-26T00:00:00Z",
    extensionsBumped: 35,
    filesModified: 70,
    filesMatched: 70,
    errors: [],
  });
  assertEquals(result.success, false);
});

Deno.test("ApplyResultSchema requires filesMatched", () => {
  const applySchema = model.resources.apply.schema;
  // filesMatched is the only scope signal a dry run produces
  const result = applySchema.safeParse({
    appliedAt: "2026-07-26T00:00:00Z",
    dryRun: true,
    extensionsBumped: 0,
    filesModified: 0,
    errors: [],
  });
  assertEquals(result.success, false);
});

Deno.test("ApplyResultSchema accepts a dry-run result writing nothing", () => {
  const applySchema = model.resources.apply.schema;
  // A dry run over 35 stale extensions: nothing bumped, nothing written,
  // but 70 files matched and would be rewritten by a real run.
  const result = applySchema.safeParse({
    appliedAt: "2026-07-26T00:00:00Z",
    dryRun: true,
    extensionsBumped: 0,
    filesModified: 0,
    filesMatched: 70,
    errors: [],
  });
  assertEquals(result.success, true);
});

Deno.test("ApplyResultSchema accepts a real apply", () => {
  const applySchema = model.resources.apply.schema;
  const result = applySchema.safeParse({
    appliedAt: "2026-07-26T00:00:00Z",
    dryRun: false,
    extensionsBumped: 35,
    filesModified: 70,
    filesMatched: 70,
    errors: [],
  });
  assertEquals(result.success, true);
});
