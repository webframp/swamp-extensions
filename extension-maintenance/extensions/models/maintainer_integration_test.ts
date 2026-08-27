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
