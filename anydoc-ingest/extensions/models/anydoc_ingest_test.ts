/**
 * Unit tests for the anydoc-ingest model.
 *
 * Uses createModelTestContext and injectable command runner to avoid
 * any real file system or CLI dependency.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { type CommandRunner, model } from "./anydoc_ingest.ts";

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

/** Mock command runner that simulates successful anydoc conversion. */
const successRunner: CommandRunner = (
  _cmd: string,
  args: string[],
): Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
> => {
  const filePath = args[args.length - 1];
  const fileName = filePath.split("/").pop() ?? "unknown";
  return Promise.resolve({
    success: true,
    stdout: `# ${fileName}\n\nConverted markdown content from ${fileName}.`,
    stderr: "",
    code: 0,
  });
};

/** Mock command runner that simulates conversion failure. */
const failureRunner: CommandRunner = (
  _cmd: string,
  _args: string[],
): Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
> => {
  return Promise.resolve({
    success: false,
    stdout: "",
    stderr: "Error: encrypted document",
    code: 1,
  });
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
      { force: false, _runner: successRunner },
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
      { force: false, _runner: failureRunner },
      context as unknown as IngestContext,
    );

    const resources = getWrittenResources();
    const docs = resources.filter((r) => r.specName === "document");
    assertEquals(docs.length, 1);
    const docData = docs[0].data as Record<string, unknown>;
    assertEquals(docData.error, "Error: encrypted document");
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
        },
      },
    });

    await model.methods.ingest.execute(
      { force: false, _runner: successRunner },
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
        },
      },
    });

    await model.methods.ingest.execute(
      { force: true, _runner: successRunner },
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
