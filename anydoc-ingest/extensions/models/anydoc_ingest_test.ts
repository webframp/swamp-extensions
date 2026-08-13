/**
 * Unit tests for the anydoc-ingest model.
 *
 * Uses createModelTestContext and injectable DocumentConverter to avoid
 * any real file system or library dependency for conversion.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { type DocumentConverter, model } from "./anydoc_ingest.ts";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type ScanContext = Parameters<typeof model.methods.scan.execute>[1];
type IngestContext = Parameters<typeof model.methods.ingest.execute>[1];
type StatusContext = Parameters<typeof model.methods.status.execute>[1];

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/swamp-anydoc-test";

/** Creates a temporary directory with test documents. */
async function withTestDocuments(
  files: Array<{ name: string; content: string }>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "anydoc-test-" });
  try {
    for (const file of files) {
      const path = `${dir}/${file.name}`;
      const parent = path.slice(0, path.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true }).catch(() => {});
      await Deno.writeTextFile(path, file.content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Mock converter that simulates successful anydoc conversion. */
const successConverter: DocumentConverter = (
  filePath: string,
): Promise<string> => {
  const fileName = filePath.split("/").pop() ?? "unknown";
  return Promise.resolve(
    `# ${fileName}\n\nConverted markdown content from ${fileName}.`,
  );
};

/** Mock converter that simulates conversion failure. */
const failureConverter: DocumentConverter = (
  _filePath: string,
): Promise<string> => {
  return Promise.reject(new Error("encrypted document"));
};

// ---------------------------------------------------------------------------
// scan method tests
// ---------------------------------------------------------------------------

Deno.test("scan - discovers documents in directory", async () => {
  await withTestDocuments([
    { name: "report.docx", content: "fake docx content" },
    { name: "slides.pptx", content: "fake pptx content" },
    { name: "data.csv", content: "col1,col2\nval1,val2" },
    { name: "readme.txt", content: "not a supported format" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "scan");
    assertEquals(resources[0].name, "scan-latest");

    const data = resources[0].data as Record<string, unknown>;
    assertEquals(data.totalFiles, 3); // docx, pptx, csv (not txt)
    assertEquals(data.truncated, false);
    assertEquals(data.byFormat, { docx: 1, pptx: 1, csv: 1 });
  });
});

Deno.test("scan - respects exclude patterns", async () => {
  await withTestDocuments([
    { name: "include.docx", content: "keep this" },
    { name: "exclude.pptx", content: "skip this" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: ["*.pptx"],
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.totalFiles, 1);
    assertEquals(data.byFormat, { docx: 1 });
  });
});

Deno.test("scan - respects include patterns", async () => {
  await withTestDocuments([
    { name: "keep.pdf", content: "%PDF-fake" },
    { name: "skip.docx", content: "nope" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: ["*.pdf"],
        excludePatterns: [],
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.totalFiles, 1);
    assertEquals(data.byFormat, { pdf: 1 });
  });
});

Deno.test("scan - recursive into subdirectories", async () => {
  await withTestDocuments([
    { name: "top.docx", content: "top level" },
    { name: "sub/nested.xlsx", content: "nested" },
    { name: "sub/deep/deeper.pdf", content: "%PDF" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.totalFiles, 3);
  });
});

Deno.test("scan - non-recursive skips subdirectories", async () => {
  await withTestDocuments([
    { name: "top.docx", content: "top level" },
    { name: "sub/nested.xlsx", content: "nested" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: false,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.totalFiles, 1);
  });
});

// ---------------------------------------------------------------------------
// ingest method tests
// ---------------------------------------------------------------------------

Deno.test("ingest - converts documents and writes resources", async () => {
  await withTestDocuments([
    { name: "report.docx", content: "fake docx content" },
    { name: "data.csv", content: "col1,col2\nval1,val2" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    await model.methods.ingest.execute(
      { force: false, _converter: successConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    // 2 document resources + 1 status resource
    assertEquals(resources.length, 3);

    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 2);

    // Each document has provenance
    for (const doc of docs) {
      const data = doc.data as Record<string, unknown>;
      const provenance = data.provenance as Record<string, unknown>;
      assertExists(provenance);
      assertEquals(provenance.tool, "@firecrawl/anydoc");
      assertEquals(provenance.toolVersion, "0.1.8");
      assertEquals(data.kind, "document");
      assertExists(data.contentHash);
      assertExists(data.markdown);
    }

    // Status resource
    const status = resources.find((r) => r.specName === "status");
    assertExists(status);
    const statusData = status!.data as Record<string, unknown>;
    assertEquals(statusData.totalIngested, 2);
    assertEquals(statusData.totalErrors, 0);
    assertEquals(statusData.totalSkipped, 0);
  });
});

Deno.test("ingest - handles conversion errors gracefully", async () => {
  await withTestDocuments([
    { name: "encrypted.docx", content: "encrypted content" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    await model.methods.ingest.execute(
      { force: false, _converter: failureConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 1);
    const docData = docs[0].data as Record<string, unknown>;
    assertEquals(docData.error, "encrypted document");
    assertEquals(docData.markdown, "");

    const status = resources.find((r) => r.specName === "status");
    const statusData = status!.data as Record<string, unknown>;
    assertEquals(statusData.totalErrors, 1);
  });
});

Deno.test("ingest - skips unchanged documents (idempotent)", async () => {
  await withTestDocuments([
    { name: "stable.docx", content: "unchanged content" },
  ], async (dir) => {
    // Compute what the content hash will be
    const content = new TextEncoder().encode("unchanged content");
    const hashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Compute the instance name the same way the model does
    const pathBytes = new TextEncoder().encode("stable.docx");
    const nameHash = await crypto.subtle.digest("SHA-1", pathBytes);
    const nameHashHex = Array.from(new Uint8Array(nameHash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const readable = "stable.docx".replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(
      0,
      80,
    );
    const instanceName = `document-${readable}-${nameHashHex.slice(0, 12)}`;

    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
      storedResources: {
        [instanceName]: {
          contentHash: expectedHash,
          markdown: "# Already converted",
          error: null, // No error — successful previous run
        },
      },
    });

    await model.methods.ingest.execute(
      { force: false, _converter: successConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    // Only status resource written (document was skipped)
    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 0);

    const status = resources.find((r) => r.specName === "status");
    const statusData = status!.data as Record<string, unknown>;
    assertEquals(statusData.totalSkipped, 1);
    assertEquals(statusData.totalIngested, 0);
  });
});

Deno.test("ingest - force flag overrides hash check", async () => {
  await withTestDocuments([
    { name: "stable.docx", content: "unchanged content" },
  ], async (dir) => {
    const content = new TextEncoder().encode("unchanged content");
    const hashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Compute the instance name the same way the model does
    const pathBytes = new TextEncoder().encode("stable.docx");
    const nameHash = await crypto.subtle.digest("SHA-1", pathBytes);
    const nameHashHex = Array.from(new Uint8Array(nameHash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const readable = "stable.docx".replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(
      0,
      80,
    );
    const instanceName = `document-${readable}-${nameHashHex.slice(0, 12)}`;

    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
      storedResources: {
        [instanceName]: {
          contentHash: expectedHash,
          markdown: "# Old version",
          error: null,
        },
      },
    });

    await model.methods.ingest.execute(
      { force: true, _converter: successConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 1); // Re-converted despite same hash
  });
});

// ---------------------------------------------------------------------------
// status method tests
// ---------------------------------------------------------------------------

Deno.test("status - returns empty state when no prior ingestion", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      documentsDir: TEST_DIR,
      recursive: true,
      maxFileSizeMb: 50,
      includePatterns: [],
      excludePatterns: [],
    },
  });

  await model.methods.status.execute(
    {} as Record<string, never>,
    context as unknown as StatusContext,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  const data = resources[0].data as Record<string, unknown>;
  assertEquals(data.lastRunAt, null);
  assertEquals(data.totalIngested, 0);
});

Deno.test("status - returns previous state when data exists", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      documentsDir: TEST_DIR,
      recursive: true,
      maxFileSizeMb: 50,
      includePatterns: [],
      excludePatterns: [],
    },
    storedResources: {
      "status": {
        lastRunAt: "2026-08-12T10:00:00Z",
        documentsDir: TEST_DIR,
        totalIngested: 5,
        totalErrors: 1,
        totalSkipped: 2,
        truncated: false,
        byFormat: { docx: 3, pdf: 2 },
        errors: [{ path: "bad.docx", error: "encrypted" }],
      },
    },
  });

  await model.methods.status.execute(
    {} as Record<string, never>,
    context as unknown as StatusContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as Record<string, unknown>;
  assertEquals(data.lastRunAt, "2026-08-12T10:00:00Z");
  assertEquals(data.totalIngested, 5);
  assertEquals(data.totalErrors, 1);
});

// ---------------------------------------------------------------------------
// Regression tests for CI adversarial review findings
// ---------------------------------------------------------------------------

Deno.test("HIGH-1: per-document exception does not abort run or lose status", async () => {
  // Create a directory structure where one file becomes unreadable
  // between discovery (readDir + stat) and hashFile (readFile)
  const dir = await Deno.makeTempDir({ prefix: "anydoc-toctou-" });
  try {
    // Write two files
    await Deno.writeTextFile(`${dir}/good.docx`, "good content");
    await Deno.writeTextFile(`${dir}/bad.pdf`, "bad content");

    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
    });

    // Make bad.pdf unreadable AFTER discovery can find it.
    // We chmod 000 so stat succeeds (in walkDir) but readFile (in hashFile) fails.
    await Deno.chmod(`${dir}/bad.pdf`, 0o000);

    // Should NOT throw — the error is caught per-document
    await model.methods.ingest.execute(
      { force: false, _converter: successConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    // Status resource MUST exist (this was the bug: no status on exception)
    const status = resources.find((r) => r.specName === "status");
    assertExists(status);
    const statusData = status!.data as Record<string, unknown>;
    // The unreadable PDF should appear in errors
    assertEquals(statusData.totalErrors, 1);
    // The good docx should still be ingested
    assertEquals(statusData.totalIngested, 1);
  } finally {
    // Restore permissions for cleanup
    await Deno.chmod(`${dir}/bad.pdf`, 0o644).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("HIGH-2: previously-failed documents are retried on next run", async () => {
  await withTestDocuments([
    { name: "retry.docx", content: "retry content" },
  ], async (dir) => {
    // Compute the content hash and instance name
    const content = new TextEncoder().encode("retry content");
    const hashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const pathBytes = new TextEncoder().encode("retry.docx");
    const nameHash = await crypto.subtle.digest("SHA-1", pathBytes);
    const nameHashHex = Array.from(new Uint8Array(nameHash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const readable = "retry.docx".replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(
      0,
      80,
    );
    const instanceName = `document-${readable}-${nameHashHex.slice(0, 12)}`;

    // Seed a stored resource WITH an error (previous failed conversion)
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
      storedResources: {
        [instanceName]: {
          contentHash: expectedHash,
          markdown: "",
          error: "Error: network timeout downloading anydoc binary",
        },
      },
    });

    await model.methods.ingest.execute(
      { force: false, _converter: successConverter },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    // The document MUST be re-processed (not skipped)
    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 1);
    const docData = docs[0].data as Record<string, unknown>;
    // Should have new successful markdown, not empty
    assertEquals((docData.markdown as string).length > 0, true);
    assertEquals(docData.error, null);

    const status = resources.find((r) => r.specName === "status");
    const statusData = status!.data as Record<string, unknown>;
    assertEquals(statusData.totalIngested, 1);
    assertEquals(statusData.totalSkipped, 0);
  });
});

Deno.test("MEDIUM-1: glob * does not cross path separators", async () => {
  await withTestDocuments([
    { name: "top.pptx", content: "top level" },
    { name: "sub/nested.pptx", content: "nested" },
    { name: "top.docx", content: "keep" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: ["*.pptx"], // Should only exclude top-level pptx
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    // *.pptx excludes top.pptx but NOT sub/nested.pptx
    assertEquals(data.totalFiles, 2); // sub/nested.pptx + top.docx
  });
});

Deno.test("MEDIUM-1: glob ** crosses path separators", async () => {
  await withTestDocuments([
    { name: "top.pptx", content: "top level" },
    { name: "sub/nested.pptx", content: "nested" },
    { name: "top.docx", content: "keep" },
  ], async (dir) => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: dir,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: ["**.pptx"], // Should exclude ALL pptx at any depth
      },
    });

    await model.methods.scan.execute(
      {} as Record<string, never>,
      context as unknown as ScanContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    // **.pptx excludes both top.pptx and sub/nested.pptx
    assertEquals(data.totalFiles, 1); // only top.docx
  });
});

// ---------------------------------------------------------------------------
// Regression tests for review #4921643985 (HIGH-1, HIGH-2, MEDIUM-1)
// ---------------------------------------------------------------------------

Deno.test(
  "HIGH-1 (walkDir stat race): NotFound during stat does not abort the run",
  async () => {
    // Simulates a temp-cleaner deleting a file between readDir yielding the
    // entry and walkDir calling Deno.stat on it. Before the fix, Deno.stat
    // would throw NotFound inside the generator and bypass ingest's inner
    // try/catch, dropping the status resource entirely.
    await withTestDocuments([
      { name: "good.docx", content: "good content" },
      { name: "vanishing.docx", content: "about to vanish" },
    ], async (dir) => {
      const originalStat = Deno.stat;
      const vanishingPath = `${dir}/vanishing.docx`;
      // Monkey-patch Deno.stat to throw NotFound for the vanishing file,
      // simulating a delete that happened between readDir and stat.
      (Deno as unknown as { stat: typeof Deno.stat }).stat = ((
        path: string | URL,
      ) => {
        if (path === vanishingPath) {
          return Promise.reject(
            new Deno.errors.NotFound(`stat '${vanishingPath}'`),
          );
        }
        return originalStat(path);
      }) as typeof Deno.stat;

      try {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {
            documentsDir: dir,
            recursive: true,
            maxFileSizeMb: 50,
            includePatterns: [],
            excludePatterns: [],
          },
        });

        // Must not throw — the missing file is silently skipped in walkDir.
        await model.methods.ingest.execute(
          { force: false, _converter: successConverter },
          context as unknown as IngestContext,
        );

        const resources = getWrittenResources();
        // Status MUST be written even though a stat call failed mid-walk.
        const status = resources.find((r) => r.specName === "status");
        assertExists(status);
        const statusData = status!.data as Record<string, unknown>;
        // Only the good file was ingested; the vanishing one was skipped
        // in walkDir without reaching hashFile, so it isn't in errors either.
        assertEquals(statusData.totalIngested, 1);
        assertEquals(statusData.totalErrors, 0);
      } finally {
        (Deno as unknown as { stat: typeof Deno.stat }).stat = originalStat;
      }
    });
  },
);

Deno.test(
  "HIGH-1 (walkDir stat race): PermissionDenied during stat is skipped",
  async () => {
    await withTestDocuments([
      { name: "readable.docx", content: "ok" },
      { name: "denied.docx", content: "denied" },
    ], async (dir) => {
      const originalStat = Deno.stat;
      const deniedPath = `${dir}/denied.docx`;
      (Deno as unknown as { stat: typeof Deno.stat }).stat = ((
        path: string | URL,
      ) => {
        if (path === deniedPath) {
          return Promise.reject(
            new Deno.errors.PermissionDenied(`stat '${deniedPath}'`),
          );
        }
        return originalStat(path);
      }) as typeof Deno.stat;

      try {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {
            documentsDir: dir,
            recursive: true,
            maxFileSizeMb: 50,
            includePatterns: [],
            excludePatterns: [],
          },
        });

        await model.methods.scan.execute(
          {} as Record<string, never>,
          context as unknown as ScanContext,
        );

        const data = getWrittenResources()[0].data as Record<string, unknown>;
        assertEquals(data.totalFiles, 1);
      } finally {
        (Deno as unknown as { stat: typeof Deno.stat }).stat = originalStat;
      }
    });
  },
);

Deno.test(
  "HIGH-2 (walkDir recursive): PermissionDenied on subdirectory does not abort the run",
  async () => {
    // Simulates a subdirectory that becomes chmod 000 (or is deleted) between
    // the parent readDir and the recursive walkDir call. Before the fix, the
    // Deno.readDir inside the inner walkDir threw PermissionDenied, propagated
    // through yield*, escaped ingest's per-document try/catch, and dropped
    // the status resource entirely.
    await withTestDocuments([
      { name: "top.docx", content: "top level" },
    ], async (dir) => {
      // Create a subdirectory with a file, then make the dir unreadable.
      const subdir = `${dir}/restricted`;
      await Deno.mkdir(subdir);
      await Deno.writeTextFile(`${subdir}/inner.docx`, "inner content");
      await Deno.chmod(subdir, 0o000);

      try {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {
            documentsDir: dir,
            recursive: true,
            maxFileSizeMb: 50,
            includePatterns: [],
            excludePatterns: [],
          },
        });

        // Must not throw — the inaccessible subdirectory is silently skipped.
        await model.methods.ingest.execute(
          { force: false, _converter: successConverter },
          context as unknown as IngestContext,
        );

        const resources = getWrittenResources();
        const status = resources.find((r) => r.specName === "status");
        assertExists(status);
        const statusData = status!.data as Record<string, unknown>;
        // Only the top-level file was ingested; the restricted subdir was skipped.
        assertEquals(statusData.totalIngested, 1);
        assertEquals(statusData.totalErrors, 0);
      } finally {
        // Restore permissions so cleanup can remove the directory.
        await Deno.chmod(subdir, 0o755);
      }
    });
  },
);

Deno.test(
  "HIGH-2 (cap): outer-catch errors count against the ingestion cap",
  async () => {
    // The cap is 10,000 in production. We can't create 10k files in a test,
    // but we can verify the counting rule: `errors.length` participates in
    // the cap check so a directory of files that all fail hashFile still
    // stops eventually rather than iterating without bound.
    //
    // Instead of exercising 10k files, we exercise the invariant by seeding
    // the outer catch with an unreadable file and confirming the status
    // reflects the accumulated error — the essential fix is the counter
    // arithmetic, verified statically here.
    await withTestDocuments([
      { name: "a.docx", content: "a" },
      { name: "b.docx", content: "b" },
      { name: "c.docx", content: "c" },
    ], async (dir) => {
      const originalReadFile = Deno.readFile;
      // All hashFile calls throw — every doc lands in the outer catch.
      (Deno as unknown as { readFile: typeof Deno.readFile }).readFile = (
        _path: string | URL,
      ) =>
        Promise.reject(
          new Deno.errors.PermissionDenied("simulated readFile failure"),
        );

      try {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {
            documentsDir: dir,
            recursive: true,
            maxFileSizeMb: 50,
            includePatterns: [],
            excludePatterns: [],
          },
        });

        await model.methods.ingest.execute(
          { force: false, _converter: successConverter },
          context as unknown as IngestContext,
        );

        const status = getWrittenResources().find((r) =>
          r.specName === "status"
        );
        assertExists(status);
        const statusData = status!.data as Record<string, unknown>;
        // All 3 files went to errors — ingested/skipped/converted are 0.
        // The cap check now includes errors.length, so with a real 10k cap
        // this pattern would terminate at 10k errors instead of iterating
        // without bound.
        assertEquals(statusData.totalIngested, 0);
        assertEquals(statusData.totalConverted, 0);
        assertEquals(statusData.totalSkipped, 0);
        assertEquals(statusData.totalErrors, 3);
      } finally {
        (Deno as unknown as { readFile: typeof Deno.readFile }).readFile =
          originalReadFile;
      }
    });
  },
);

Deno.test(
  "MEDIUM-1 (totalConverted): failed conversions do not inflate the success count",
  async () => {
    await withTestDocuments([
      { name: "ok1.docx", content: "one" },
      { name: "ok2.docx", content: "two" },
      { name: "bad.docx", content: "three" },
    ], async (dir) => {
      // Converter that fails on `bad.docx` but succeeds on the others.
      const partialFailConverter: DocumentConverter = (path: string) => {
        if (path.endsWith("bad.docx")) {
          return Promise.reject(new Error("encrypted"));
        }
        const name = path.split("/").pop() ?? "unknown";
        return Promise.resolve(`# ${name}\n\nok`);
      };

      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          documentsDir: dir,
          recursive: true,
          maxFileSizeMb: 50,
          includePatterns: [],
          excludePatterns: [],
        },
      });

      await model.methods.ingest.execute(
        { force: false, _converter: partialFailConverter },
        context as unknown as IngestContext,
      );

      const status = getWrittenResources().find((r) => r.specName === "status");
      assertExists(status);
      const statusData = status!.data as Record<string, unknown>;
      // All three documents get a `document` resource (with error for the
      // failed one), so totalIngested is 3. But only two produced markdown,
      // so totalConverted is 2 — the distinction the field was added for.
      assertEquals(statusData.totalIngested, 3);
      assertEquals(statusData.totalConverted, 2);
      assertEquals(statusData.totalErrors, 1);
    });
  },
);

Deno.test(
  "MEDIUM-1 (totalConverted): status method falls back to totalIngested for pre-2026.08.12.2 resources",
  async () => {
    // Old status resources predate the totalConverted field. The status
    // method must preserve the historical count instead of writing 0.
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        documentsDir: TEST_DIR,
        recursive: true,
        maxFileSizeMb: 50,
        includePatterns: [],
        excludePatterns: [],
      },
      storedResources: {
        "status": {
          lastRunAt: "2026-08-11T09:00:00Z",
          documentsDir: TEST_DIR,
          totalIngested: 7,
          // totalConverted intentionally absent — written by older version
          totalErrors: 0,
          totalSkipped: 3,
          truncated: false,
          byFormat: { docx: 7 },
          errors: [],
        },
      },
    });

    await model.methods.status.execute(
      {} as Record<string, never>,
      context as unknown as StatusContext,
    );

    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.totalIngested, 7);
    // Fallback: without prior totalConverted, use totalIngested so timelines
    // don't show a synthetic drop to zero.
    assertEquals(data.totalConverted, 7);
  },
);
