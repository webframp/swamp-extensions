import { assertEquals, assertMatch } from "@std/assert";
import {
  compareVersions,
  model,
  parseQualityResult,
  pickEligibleVersion,
  publishedNpmVersions,
} from "./maintainer.ts";

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/extension-maintenance/maintainer");
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
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
          specifier: "jsr:@swamp-club/swamp-testing@0.20260604.20",
          jsonVersion: "0.20260604.20",
          lockVersion: null,
        },
      ],
    },
    directSpecifiers: [
      {
        file: "extensions/models/mod_test.ts",
        specifier: "jsr:@swamp-club/swamp-testing@0.20260504.10",
        alias: "@swamp-club/swamp-testing",
      },
    ],
    pinDrift: [
      { name: "npm:zod", pinned: "4.3.6", modal: "4.4.3" },
    ],
    metadataCoverage: {
      isModel: true,
      missing: ["fetchedAt"],
    },
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
      pinDrift: 1,
      metadataGaps: 1,
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

Deno.test("AuditSummarySchema requires pinDrift and metadataGaps counts", () => {
  const auditSchema = model.resources.audit.schema;
  // Has the older counts but omits the two new ones.
  const result = auditSchema.safeParse({
    scannedAt: "2026-07-26T00:00:00Z",
    repoRoot: "/tmp",
    totalExtensions: 0,
    staleCount: 0,
    categories: {
      npm: 0,
      testing: 0,
      manifest: 0,
      lockDrifted: 0,
      directSpecifiers: 0,
    },
    extensions: [],
  });
  assertEquals(result.success, false);
});

Deno.test("ExtensionStatusSchema requires pinDrift and metadataCoverage", () => {
  const auditSchema = model.resources.audit.schema;
  const ext = {
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
      inSync: true,
      staleEntries: [],
    },
    directSpecifiers: [],
    // pinDrift and metadataCoverage deliberately omitted
    stale: false,
    lockDrifted: false,
  };
  const result = auditSchema.safeParse({
    scannedAt: "2026-07-26T00:00:00Z",
    repoRoot: "/tmp",
    totalExtensions: 1,
    staleCount: 0,
    categories: {
      npm: 0,
      testing: 0,
      manifest: 0,
      lockDrifted: 0,
      directSpecifiers: 0,
      pinDrift: 0,
      metadataGaps: 0,
    },
    extensions: [ext],
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

Deno.test("globalArguments defaults min_dependency_age_hours to Deno's 24h", () => {
  assertEquals(model.globalArguments.parse({}).min_dependency_age_hours, 24);
  assertEquals(
    model.globalArguments.safeParse({ min_dependency_age_hours: -1 }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ min_dependency_age_hours: 0 }).success,
    true,
  );
});

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("3.1140.0", "3.999.0") > 0, true);
  assertEquals(compareVersions("3.1139.0", "3.1140.0") < 0, true);
  assertEquals(compareVersions("0.20260923.37", "0.20260917.35") > 0, true);
  assertEquals(compareVersions("4.6.5", "4.6.5"), 0);
});

Deno.test("pickEligibleVersion skips releases newer than the cutoff", () => {
  const published = {
    created: "2020-01-01T00:00:00Z",
    modified: "2026-09-24T19:03:21Z",
    "3.1138.0": "2026-09-22T20:00:00Z",
    "3.1139.0": "2026-09-23T23:26:28Z",
    "3.1140.0": "2026-09-24T19:03:21Z",
  };
  // The 2026-09-24 sweep ran at 20:07Z; a 24h window cuts off at 09-23 20:07Z.
  const auditAt = Date.parse("2026-09-24T20:07:00Z");
  assertEquals(
    pickEligibleVersion(published, "3.1140.0", new Date(auditAt - 86_400_000)),
    "3.1138.0",
  );
  // min_dependency_age_hours: 0 — cutoff is the audit time itself.
  assertEquals(
    pickEligibleVersion(published, "3.1140.0", new Date(auditAt)),
    "3.1140.0",
  );
});

Deno.test("pickEligibleVersion ignores prereleases and versions above latest", () => {
  const published = {
    "2.0.0": "2026-01-01T00:00:00Z",
    "3.0.0-beta.1": "2026-01-02T00:00:00Z",
    "3.0.0": "2026-01-03T00:00:00Z",
  };
  const cutoff = new Date("2026-06-01T00:00:00Z");
  assertEquals(pickEligibleVersion(published, "2.0.0", cutoff), "2.0.0");
  assertEquals(pickEligibleVersion(published, null, cutoff), "3.0.0");
  assertEquals(
    pickEligibleVersion(published, "3.0.0", new Date("2025-01-01T00:00:00Z")),
    null,
  );
});

Deno.test("parseQualityResult applies CI's pass condition", () => {
  const ok = (stdout: string, stderr = "", success = true) =>
    parseQualityResult({ stdout, stderr, success });

  const pass = ok(
    JSON.stringify({ status: "passed", percentage: 100, allPassed: true }),
  );
  assertEquals(pass.passed, true);
  assertEquals(pass.detail, null);

  const partial = ok(JSON.stringify({ status: "passed", percentage: 95 }));
  assertEquals(partial.passed, false);
  assertEquals(partial.percentage, 95);

  const notAll = ok(
    JSON.stringify({ status: "passed", percentage: 100, allPassed: false }),
  );
  assertEquals(notAll.passed, false);

  // The #450 failure: JSON error on stderr, nothing on stdout, non-zero exit.
  const denoDoc = ok(
    "",
    JSON.stringify({
      error: "deno doc --json failed: minimum dependency date",
    }),
    false,
  );
  assertEquals(denoDoc.passed, false);
  assertMatch(denoDoc.detail ?? "", /deno doc --json failed/);

  const garbage = ok("", "panic: something", false);
  assertEquals(garbage.passed, false);
  assertMatch(garbage.detail ?? "", /panic/);
});

Deno.test("compareVersions ranks a release above its prereleases and ignores build metadata", () => {
  assertEquals(compareVersions("2.0.0", "2.0.0-rc.1") > 0, true);
  assertEquals(compareVersions("2.0.0-rc.1", "2.0.0") < 0, true);
  assertEquals(compareVersions("2.0.0-rc.2", "2.0.0-rc.1") > 0, true);
  assertEquals(compareVersions("1.0.0+abc", "1.0.0"), 0);
  // CalVer manifest pins.
  assertEquals(compareVersions("2026.09.23.1", "2026.09.24.1") < 0, true);
  assertEquals(compareVersions("2026.09.24.10", "2026.09.24.9") > 0, true);
});

Deno.test("publishedNpmVersions drops unpublished and deprecated versions", () => {
  const published = publishedNpmVersions({
    time: {
      created: "2020-01-01T00:00:00Z",
      "3.9.8": "2026-01-01T00:00:00Z",
      "3.9.9": "2026-01-02T00:00:00Z", // unpublished: absent from versions
      "3.9.10": "2026-01-03T00:00:00Z", // deprecated
      "4.0.0": "2026-09-24T00:00:00Z",
    },
    versions: {
      "3.9.8": {},
      "3.9.10": { deprecated: "broken build" },
      "4.0.0": {},
    },
  });
  assertEquals(Object.keys(published).sort(), ["3.9.8", "4.0.0"]);
  // 4.0.0 is too fresh, 3.9.9 and 3.9.10 cannot be pinned: 3.9.8 wins.
  assertEquals(
    pickEligibleVersion(published, "4.0.0", new Date("2026-06-01T00:00:00Z")),
    "3.9.8",
  );
});

Deno.test("parseQualityResult never crashes and never passes on stderr alone", () => {
  const nullOut = parseQualityResult({
    stdout: "null",
    stderr: "",
    success: true,
  });
  assertEquals(nullOut.passed, false);

  // CI reads stdout only: a verdict printed solely to stderr is not a pass.
  const stderrVerdict = parseQualityResult({
    stdout: "",
    stderr: JSON.stringify({ status: "passed", percentage: 100 }),
    success: false,
  });
  assertEquals(stderrVerdict.passed, false);

  const floatPct = parseQualityResult({
    stdout: JSON.stringify({ status: "passed", percentage: 100.0 }),
    stderr: "",
    success: true,
  });
  assertEquals(floatPct.passed, true);
});
