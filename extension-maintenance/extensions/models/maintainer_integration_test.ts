/**
 * Integration tests for apply-bump execute behavior.
 *
 * These tests create temporary extension fixtures and invoke the apply-bump
 * method directly to verify:
 * - Release notes are prepended (not overwritten)
 * - Lockfile is regenerated via deno cache (resolves direct specifiers)
 * - Test files are included in glob-pattern replacements
 * - NotFound on RELEASE_NOTES.md creates a new file
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { model } from "./maintainer.ts";

/** Create a minimal extension fixture in a temp directory. */
async function createFixture(opts: {
  releaseNotes?: string;
  sourceContent: string;
  testContent?: string;
  denoJson?: Record<string, unknown>;
}): Promise<{ root: string; extDir: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "ext-maint-test-" });
  const extDir = `${root}/test-ext`;
  const srcDir = `${extDir}/extensions/models`;

  await Deno.mkdir(srcDir, { recursive: true });

  // manifest.yaml
  await Deno.writeTextFile(
    `${extDir}/manifest.yaml`,
    `manifestVersion: 1\nname: "@test/ext"\nversion: "2026.01.01.1"\n`,
  );

  // deno.json (minimal)
  const denoJson = opts.denoJson ?? { imports: {} };
  await Deno.writeTextFile(
    `${extDir}/deno.json`,
    JSON.stringify(denoJson, null, 2),
  );

  // Source file
  await Deno.writeTextFile(`${srcDir}/mod.ts`, opts.sourceContent);

  // Test file (optional)
  if (opts.testContent) {
    await Deno.writeTextFile(`${srcDir}/mod_test.ts`, opts.testContent);
  }

  // RELEASE_NOTES.md (optional)
  if (opts.releaseNotes !== undefined) {
    await Deno.writeTextFile(
      `${extDir}/RELEASE_NOTES.md`,
      opts.releaseNotes,
    );
  }

  return {
    root,
    extDir,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
    },
  };
}

/** Build a mock context for apply-bump. */
function mockContext(repoRoot: string, planData: Record<string, unknown>) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];

  return {
    context: {
      globalArgs: { repo_root: repoRoot, registry_timeout: 30 },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec: specName, name, data });
        return Promise.resolve({ name });
      },
      readResource: (_name: string, _version?: number) => {
        return Promise.resolve(planData);
      },
      logger: {
        info: (msg: string) => logs.push(`[INFO] ${msg}`),
        warn: (msg: string) => logs.push(`[WARN] ${msg}`),
      },
    },
    written,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("apply-bump prepends release notes to existing file", async () => {
  const { root, cleanup } = await createFixture({
    releaseNotes:
      "## 2026.01.01.1\n\n**Added:** Initial release with great features.\n",
    sourceContent: `export const VERSION = "2026.01.01.1";\n`,
  });

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.1",
        nextVersion: "2026.07.27.1",
        changes: [
          {
            file: "manifest.yaml",
            find: 'version: "2026.01.01.1"',
            replace: 'version: "2026.07.27.1"',
            category: "manifest-version",
          },
        ],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** Bumped something.\n",
      },
    ],
    skipped: [],
  };

  const { context } = mockContext(root, plan);
  const execute = model.methods["apply-bump"].execute;
  await execute({}, context);

  const content = await Deno.readTextFile(`${root}/test-ext/RELEASE_NOTES.md`);
  // New entry is first
  assertStringIncludes(content, "## 2026.07.27.1");
  // Old entry is preserved
  assertStringIncludes(content, "## 2026.01.01.1");
  assertStringIncludes(content, "Initial release with great features.");
  // New entry comes before old
  const newIdx = content.indexOf("## 2026.07.27.1");
  const oldIdx = content.indexOf("## 2026.01.01.1");
  assertEquals(newIdx < oldIdx, true);

  await cleanup();
});

Deno.test("apply-bump creates RELEASE_NOTES.md when missing", async () => {
  const { root, cleanup } = await createFixture({
    // No releaseNotes — file doesn't exist
    sourceContent: `export const VERSION = "2026.01.01.1";\n`,
  });

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.1",
        nextVersion: "2026.07.27.1",
        changes: [],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** New thing.\n",
      },
    ],
    skipped: [],
  };

  const { context } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  const content = await Deno.readTextFile(`${root}/test-ext/RELEASE_NOTES.md`);
  assertEquals(content, "## 2026.07.27.1\n\n**Changed:** New thing.\n");

  await cleanup();
});

Deno.test("apply-bump includes test files in glob replacements", async () => {
  const { root, cleanup } = await createFixture({
    sourceContent: `import { foo } from "npm:some-pkg@1.0.0";\n`,
    testContent: `import { foo } from "npm:some-pkg@1.0.0";\n`,
  });

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.1",
        nextVersion: "2026.07.27.1",
        changes: [
          {
            file: "extensions/**/*.ts",
            find: "some-pkg@1.0.0",
            replace: "some-pkg@1.1.0",
            category: "npm",
          },
        ],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** bump some-pkg.\n",
      },
    ],
    skipped: [],
  };

  const { context, written } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  // Both source and test should be updated
  const src = await Deno.readTextFile(
    `${root}/test-ext/extensions/models/mod.ts`,
  );
  const test = await Deno.readTextFile(
    `${root}/test-ext/extensions/models/mod_test.ts`,
  );
  assertStringIncludes(src, "some-pkg@1.1.0");
  assertStringIncludes(test, "some-pkg@1.1.0");

  // Verify apply result reports correct counts
  const applyResult = written.find((w) => w.spec === "apply")
    ?.data as Record<string, unknown>;
  // 2 files matched from the glob + 1 RELEASE_NOTES
  assertEquals(applyResult.filesMatched, 3);

  await cleanup();
});

Deno.test("apply-bump reports an error and skips extensionsBumped when the written chain is broken", async () => {
  // Mirrors the real bug (#298, #322): a plan that bumps `version` but omits
  // the matching `toVersion` change, leaving the chain one step short.
  const { root, cleanup } = await createFixture({
    sourceContent: `export const model = {
  version: "2026.01.01.1",
  upgrades: [
    {
      toVersion: "2026.01.01.1",
      description: "initial",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
`,
  });

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.1",
        nextVersion: "2026.07.27.1",
        changes: [
          {
            file: "extensions/**/*.ts",
            find: 'version: "2026.01.01.1"',
            replace: 'version: "2026.07.27.1"',
            category: "source-version",
          },
          // Deliberately no matching `toVersion` change — this is the bug.
        ],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** Bumped something.\n",
      },
    ],
    skipped: [],
  };

  const { context, written } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  const applyResult = written.find((w) => w.spec === "apply")
    ?.data as Record<string, unknown>;
  const errors = applyResult.errors as Array<
    { extension: string; error: string }
  >;

  assertEquals(applyResult.extensionsBumped, 0);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].extension, "@test/ext");
  assertStringIncludes(errors[0].error, "upgrade chain broken");

  await cleanup();
});

Deno.test("apply-bump regenerates deno.lock with direct specifiers", async () => {
  // Use a real npm package that exists — zod is a safe bet
  const { root, cleanup } = await createFixture({
    sourceContent:
      `import { z } from "npm:zod@4.4.3";\nexport const s = z.string();\n`,
    denoJson: { imports: { zod: "npm:zod@3.23.0" } },
  });

  // Create an initial lockfile that does NOT contain zod@3.23.8
  await Deno.writeTextFile(
    `${root}/test-ext/deno.lock`,
    JSON.stringify({ version: "4", specifiers: {}, jsr: {}, npm: {} }),
  );

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.1",
        nextVersion: "2026.07.27.1",
        changes: [
          {
            file: "deno.json",
            find: "zod@3.23.0",
            replace: "zod@3.23.8",
            category: "npm",
          },
        ],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** bump zod.\n",
      },
    ],
    skipped: [],
  };

  const { context, logs } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  // Verify deno.json was updated
  const denoJsonContent = await Deno.readTextFile(
    `${root}/test-ext/deno.json`,
  );
  assertStringIncludes(denoJsonContent, "zod@3.23.8");

  // Verify deno.lock now contains the new version
  const lock = await Deno.readTextFile(`${root}/test-ext/deno.lock`);
  assertStringIncludes(lock, "3.23.8");

  // Verify the log says it was regenerated
  const regenLog = logs.find((l) => l.includes("deno.lock regenerated"));
  assertEquals(regenLog !== undefined, true);

  await cleanup();
});

Deno.test("apply-bump APPENDS an upgrade entry, preserving prior chain history", async () => {
  // A model with a two-step chain whose last entry already matches the current
  // version. Bumping must APPEND a third entry, not relabel the second.
  const { root, extDir, cleanup } = await createFixture({
    sourceContent: `export const model = {
  version: "2026.01.01.2",
  upgrades: [
    {
      toVersion: "2026.01.01.1",
      description: "initial",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.01.01.2",
      description: "add field foo",
      upgradeAttributes: (old: Record<string, unknown>) => ({ ...old, foo: 3 }),
    },
  ],
};
`,
  });

  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.01.01.2",
        nextVersion: "2026.07.27.1",
        changes: [
          {
            file: "extensions/**/*.ts",
            find: 'version: "2026.01.01.2"',
            replace: 'version: "2026.07.27.1"',
            category: "source-version",
          },
        ],
        upgradeInserts: [
          {
            file: "extensions/models/mod.ts",
            toVersion: "2026.07.27.1",
            description:
              "No schema changes — dependency/license maintenance bump",
          },
        ],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** Bumped something.\n",
      },
    ],
    skipped: [],
  };

  const { context, written } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  const applyResult = written.find((w) => w.spec === "apply")
    ?.data as Record<string, unknown>;
  assertEquals(applyResult.errors, []);
  assertEquals(applyResult.extensionsBumped, 1);

  const src = await Deno.readTextFile(`${extDir}/extensions/models/mod.ts`);
  // Prior entries preserved.
  assertStringIncludes(src, 'toVersion: "2026.01.01.1"');
  assertStringIncludes(src, 'toVersion: "2026.01.01.2"');
  assertStringIncludes(src, "add field foo");
  // New entry appended with identity migration.
  assertStringIncludes(src, 'toVersion: "2026.07.27.1"');
  assertStringIncludes(
    src,
    "No schema changes — dependency/license maintenance bump",
  );
  // The .01.01.2 step must still describe its own migration, not be relabelled.
  assertStringIncludes(
    src,
    'toVersion: "2026.01.01.2"',
  );

  await cleanup();
});

Deno.test("apply-bump detects the relabel anti-pattern (previous entry destroyed)", async () => {
  // Simulate the OLD broken behavior: the fixture's last toVersion was
  // relabelled from the previous version to the new one in place, so the
  // previous version's entry is gone. The version field is already bumped.
  // With currentVersion passed to checkUpgradeChain, this must be caught even
  // though the last toVersion equals the model version.
  const { root, cleanup } = await createFixture({
    sourceContent: `export const model = {
  version: "2026.07.27.1",
  upgrades: [
    {
      toVersion: "2026.01.01.1",
      description: "initial",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.27.1",
      description: "add field foo",
      upgradeAttributes: (old: Record<string, unknown>) => ({ ...old, foo: 3 }),
    },
  ],
};
`,
  });

  // Plan reports the bump came FROM 2026.01.02.1 — an intermediate shipped
  // version whose entry should exist but was destroyed by the relabel.
  const plan = {
    plannedAt: "2026-07-27T00:00:00Z",
    totalEntries: 1,
    entries: [
      {
        name: "@test/ext",
        dir: "test-ext",
        currentVersion: "2026.07.20.1",
        nextVersion: "2026.07.27.1",
        // No changes / inserts needed — the fixture is already at nextVersion,
        // simulating a chain that was relabelled rather than appended.
        changes: [],
        releaseNotes: "## 2026.07.27.1\n\n**Changed:** something\n",
      },
    ],
    skipped: [],
  };

  const { context, written } = mockContext(root, plan);
  await model.methods["apply-bump"].execute({}, context);

  const applyResult = written.find((w) => w.spec === "apply")
    ?.data as Record<string, unknown>;
  const errors = applyResult.errors as Array<
    { extension: string; error: string }
  >;
  assertEquals(applyResult.extensionsBumped, 0);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].error, "relabelled, not appended");

  await cleanup();
});

Deno.test("plan-bump emits upgradeInserts and a test-assertion change", async () => {
  // Fixture: a model with an upgrades: array (whose last toVersion matches the
  // current version) and a test asserting the exact model version literal.
  const { root, cleanup } = await createFixture({
    sourceContent: `export const model = {
  version: "2026.01.01.1",
  upgrades: [
    {
      toVersion: "2026.01.01.1",
      description: "initial",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
`,
    testContent:
      `import { assertEquals } from "@std/assert";\nimport { model } from "./mod.ts";\nDeno.test("v", () => {\n  assertEquals(model.version, "2026.01.01.1");\n});\n`,
  });

  // Audit input: one stale extension with a stale npm dep so plan-bump produces
  // a shipped change (and therefore a bump entry).
  const audit = {
    extensions: [
      {
        name: "@test/ext",
        dir: "test-ext",
        version: "2026.01.01.1",
        stale: true,
        npmDeps: [
          {
            name: "npm:zod",
            current: "4.4.2",
            latest: "4.4.3",
            stale: true,
          },
        ],
        testingDep: null,
        manifestDeps: [],
      },
    ],
  };

  const { context, written } = mockContext(root, audit);
  await model.methods["plan-bump"].execute({ skip_testing: false }, context);

  const plan = written.find((w) => w.spec === "plan")?.data as Record<
    string,
    unknown
  >;
  const entries = plan.entries as Array<Record<string, unknown>>;
  assertEquals(entries.length, 1);
  const entry = entries[0];

  // upgradeInserts targets the source file with the upgrades: array.
  const inserts = entry.upgradeInserts as Array<
    { file: string; toVersion: string; description: string }
  >;
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].file, "extensions/models/mod.ts");
  assertEquals(inserts[0].toVersion, entry.nextVersion);

  // A test-assertion change updates the exact literal, targeting *_test.ts.
  const changes = entry.changes as Array<
    { file: string; find: string; replace: string; category: string }
  >;
  const ta = changes.find((c) => c.category === "test-assertion");
  assertEquals(ta !== undefined, true);
  assertEquals(ta!.file, "extensions/**/*_test.ts");
  assertEquals(ta!.find, '.version, "2026.01.01.1"');
  assertEquals(ta!.replace, `.version, "${entry.nextVersion}"`);

  // No toVersion relabel change is emitted (the anti-pattern is gone).
  const relabel = changes.find((c) => c.find.startsWith("toVersion:"));
  assertEquals(relabel, undefined);

  await cleanup();
});
