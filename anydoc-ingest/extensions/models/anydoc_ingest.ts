/**
 * Document-to-knowledge ingestion model powered by Firecrawl's anydoc.
 *
 * Converts office documents (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB,
 * CSV, PDF) into structured markdown and writes provenance-aware resource
 * entries compatible with {@link https://github.com/stateless/swamp-extensions/tree/main/sourced-kb | @stateless/sourced-kb}.
 *
 * Three methods:
 * - `scan` — discover documents without converting
 * - `ingest` — convert and write KB entries with provenance
 * - `status` — summarise ingestion state
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments configuring the documents directory and behavior. */
const GlobalArgsSchema = z.object({
  documentsDir: z.string().min(1)
    .refine((p) => p.startsWith("/"), {
      message: "documentsDir must be an absolute path (starting with /)",
    })
    .describe("Absolute path to the directory containing documents to ingest"),
  recursive: z.boolean().default(true)
    .describe("Whether to scan subdirectories recursively"),
  maxFileSizeMb: z.number().min(1).max(500).default(50)
    .describe("Maximum file size in MB to attempt conversion"),
  includePatterns: z.array(z.string()).default([])
    .describe(
      "Glob patterns to include (empty = all supported formats)",
    ),
  excludePatterns: z.array(z.string()).default([])
    .describe("Glob patterns to exclude"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Schema for the scan result resource. */
const ScanResultSchema = z.object({
  scannedAt: z.string().describe("ISO 8601 timestamp when the scan ran"),
  documentsDir: z.string().describe("Directory that was scanned"),
  recursive: z.boolean().describe("Whether subdirectories were scanned"),
  totalFiles: z.number().int().min(0).describe(
    "Number of supported documents found",
  ),
  totalSizeBytes: z.number().int().min(0).describe(
    "Combined size in bytes of all discovered documents",
  ),
  byFormat: z.record(z.string(), z.number().int()).describe(
    "Document count broken down by format",
  ),
  files: z.array(z.object({
    relativePath: z.string().describe(
      "Path relative to documentsDir",
    ),
    format: z.string().describe("Detected document format"),
    sizeBytes: z.number().int().describe("File size in bytes"),
  })).describe("Discovered documents, up to the scan cap"),
  truncated: z.boolean().describe(
    "Whether the scan cap was reached before all documents were listed",
  ),
});

/** Schema for a single ingested document resource. */
const DocumentSchema = z.object({
  id: z.string().describe("Stable content-derived document identifier"),
  kind: z.string().describe("Resource kind discriminator"),
  sourcePath: z.string().describe("Absolute path to the source file"),
  relativePath: z.string().describe("Path relative to documentsDir"),
  format: z.string().describe("Detected document format"),
  sizeBytes: z.number().int().describe("Source file size in bytes"),
  contentHash: z.string().describe(
    "SHA-256 hex hash of the source file content, used for idempotency",
  ),
  markdown: z.string().describe(
    "Converted markdown content (empty if conversion failed)",
  ),
  markdownLength: z.number().int().describe(
    "Length of the converted markdown in characters",
  ),
  convertedAt: z.string().describe(
    "ISO 8601 timestamp when this document was converted",
  ),
  provenance: z.object({
    asOf: z.string().describe("ISO 8601 timestamp the provenance was recorded"),
    source: z.string().describe("Absolute path to the source file"),
    tool: z.string().describe("Conversion tool identifier"),
    toolVersion: z.string().describe("Conversion tool version"),
  }),
  error: z.string().nullable().describe(
    "Conversion error message, or null if conversion succeeded",
  ),
});

/** Schema for the ingestion status resource. */
const StatusSchema = z.object({
  lastRunAt: z.string().nullable().describe(
    "ISO 8601 timestamp of the last ingest run, or null if none has run",
  ),
  documentsDir: z.string().describe("Directory that was ingested"),
  totalIngested: z.number().int().min(0)
    .describe(
      "Documents for which a `document` resource was written this run — includes both successful conversions and conversion failures (empty markdown + error field). Use `totalConverted` for the successful-only count.",
    ),
  totalConverted: z.number().int().min(0).default(0)
    .describe(
      "Documents that produced non-empty markdown (conversion succeeded).",
    ),
  totalErrors: z.number().int().min(0)
    .describe(
      "Total errors encountered (conversion failures + unreadable files). May exceed totalIngested - totalConverted when files fail before resource write.",
    ),
  totalSkipped: z.number().int().min(0).describe(
    "Documents skipped because content hash was unchanged since the last run",
  ),
  truncated: z.boolean().describe(
    "Whether the ingest cap was reached before all documents were processed",
  ),
  byFormat: z.record(z.string(), z.number().int()).describe(
    "Ingested document count broken down by format",
  ),
  errors: z.array(z.object({
    path: z.string().describe("Relative path of the file that errored"),
    error: z.string().describe("Error message"),
  })).describe("Per-file errors encountered during the run"),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported file extensions mapped to anydoc format names. */
const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".doc": "doc",
  ".docx": "docx",
  ".docm": "docm",
  ".ppt": "ppt",
  ".pps": "ppt",
  ".pot": "ppt",
  ".pptx": "pptx",
  ".pptm": "pptx",
  ".ppsx": "pptx",
  ".ppsm": "pptx",
  ".xls": "xls",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".xlsb": "xlsx",
  ".odt": "odt",
  ".ods": "ods",
  ".odp": "odp",
  ".rtf": "rtf",
  ".epub": "epub",
  ".csv": "csv",
  ".pdf": "pdf",
};

const ANYDOC_VERSION = "0.1.8";
const MAX_SCAN_FILES = 5000;
const MAX_INGEST_FILES = 10000;
const CONVERT_TIMEOUT_MS = 120_000; // 2 minutes per document

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex hash of file content. */
async function hashFile(path: string): Promise<string> {
  const content = await Deno.readFile(path);
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Get file extension in lowercase. */
function getExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "";
  return path.slice(lastDot).toLowerCase();
}

/** Sanitise a file path into a collision-resistant instance name using hash. */
async function toInstanceName(relativePath: string): Promise<string> {
  // Use SHA-1 prefix of the full relative path for collision resistance
  const encoded = new TextEncoder().encode(relativePath);
  const hashBuffer = await crypto.subtle.digest("SHA-1", encoded);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Keep a readable prefix + hash suffix for debuggability
  const readable = relativePath
    .replace(/[^a-zA-Z0-9_\-.]/g, "_")
    .slice(0, 80);
  return `${readable}-${hashHex.slice(0, 12)}`;
}

/** Escape a string for use in a regex, preserving no special meaning. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a path matches any of the given glob patterns.
 *
 * Glob semantics:
 * - `*` matches any characters except `/` (single path segment)
 * - `**` matches any characters including `/` (cross-segment)
 * - `?` matches exactly one character except `/`
 */
function matchesPattern(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    // Convert glob to regex: handle ** before * to avoid double-conversion
    let regexStr = "";
    let i = 0;
    while (i < pattern.length) {
      if (pattern[i] === "*" && pattern[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
        // Skip trailing / after ** (e.g., **/ matches zero or more dirs)
        if (pattern[i] === "/") i++;
      } else if (pattern[i] === "*") {
        regexStr += "[^/]*";
        i++;
      } else if (pattern[i] === "?") {
        regexStr += "[^/]";
        i++;
      } else {
        regexStr += escapeRegex(pattern[i]);
        i++;
      }
    }
    return new RegExp("^" + regexStr + "$").test(path);
  });
}

/**
 * Walk a directory and yield file entries matching supported formats.
 *
 * Respects maxFileSizeMb, includePatterns, and excludePatterns.
 */
async function* discoverDocuments(
  dir: string,
  args: GlobalArgs,
): AsyncGenerator<
  { path: string; relativePath: string; format: string; sizeBytes: number }
> {
  // Validate directory exists before walking
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) {
      throw new Error(
        `documentsDir is not a directory: ${dir}`,
      );
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`documentsDir does not exist: ${dir}`);
    }
    if (err instanceof Error && err.message.startsWith("documentsDir")) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stat documentsDir ${dir}: ${message}`);
  }

  const maxBytes = args.maxFileSizeMb * 1024 * 1024;

  for await (const entry of walkDir(dir, args.recursive)) {
    const ext = getExtension(entry.path);
    const format = SUPPORTED_EXTENSIONS[ext];
    if (!format) continue;

    const relativePath = entry.path.slice(dir.length).replace(/^\//, "");

    // Apply include patterns
    if (
      args.includePatterns.length > 0 &&
      !matchesPattern(relativePath, args.includePatterns)
    ) {
      continue;
    }

    // Apply exclude patterns
    if (matchesPattern(relativePath, args.excludePatterns)) {
      continue;
    }

    // Check size
    if (entry.sizeBytes > maxBytes) continue;

    yield {
      path: entry.path,
      relativePath,
      format,
      sizeBytes: entry.sizeBytes,
    };
  }
}

/**
 * Recursively walk a directory, yielding file entries with size. Skips symlinks.
 *
 * `Deno.stat` on an entry can race with concurrent deletion (temp cleaners,
 * user tools) and throw `NotFound`. A permission change can throw
 * `PermissionDenied`. Since this is an async generator, a throw here bypasses
 * the per-document try/catch inside `ingest` and aborts the entire run,
 * dropping the status writeResource. Skip such entries instead — they'll show
 * up as missing on the next run, which is the correct semantic.
 */
async function* walkDir(
  dir: string,
  recursive: boolean,
): AsyncGenerator<{ path: string; sizeBytes: number }> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isSymlink) continue; // Avoid symlink loops
    if (entry.isFile) {
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(fullPath);
      } catch (err) {
        if (
          err instanceof Deno.errors.NotFound ||
          err instanceof Deno.errors.PermissionDenied
        ) {
          continue;
        }
        throw err;
      }
      yield { path: fullPath, sizeBytes: stat.size };
    } else if (entry.isDirectory && recursive) {
      try {
        yield* walkDir(fullPath, recursive);
      } catch (err) {
        if (
          err instanceof Deno.errors.NotFound ||
          err instanceof Deno.errors.PermissionDenied
        ) {
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Convert a document to markdown.
 *
 * Default implementation invokes the anydoc CLI (a native Rust binary
 * distributed via npm). The CLI approach is required because the npm package
 * ships platform-specific NAPI addons that can't be bundled by swamp's
 * JS bundler or loaded directly in Deno without special configuration.
 *
 * Accepts an optional converter function for testability.
 */
async function convertDocument(
  filePath: string,
  converter?: DocumentConverter,
): Promise<{ markdown: string; error: string | null }> {
  const convert = converter ?? defaultConverter;
  try {
    const markdown = await convert(filePath);
    return { markdown, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { markdown: "", error: message };
  }
}

/** Converter function signature for dependency injection in tests. */
export type DocumentConverter = (filePath: string) => Promise<string>;

/**
 * Default converter using the anydoc CLI with a timeout.
 *
 * Spawns `npx @firecrawl/anydoc@<version>` which auto-downloads the
 * platform-native binary on first run.
 */
const defaultConverter: DocumentConverter = async (
  filePath: string,
): Promise<string> => {
  const command = new Deno.Command("npx", {
    args: ["--yes", `@firecrawl/anydoc@${ANYDOC_VERSION}`, filePath],
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      try {
        child.kill();
      } catch { /* already exited */ }
      reject(new Error(`Conversion timed out after ${CONVERT_TIMEOUT_MS}ms`));
    }, CONVERT_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([child.output(), timeout]);
    if (result.success) {
      return new TextDecoder().decode(result.stdout);
    }
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(stderr || `anydoc exited with code ${result.code}`);
  } finally {
    clearTimeout(timerId);
  }
};

// ---------------------------------------------------------------------------
// Method context type
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
    debug: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Document ingestion model powered by anydoc. */
export const model = {
  type: "@webframp/anydoc-ingest",
  version: "2026.08.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "scan": {
      description:
        "Result of scanning the documents directory — file inventory without conversion.",
      schema: ScanResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "document": {
      description:
        "A single ingested document — markdown content with provenance metadata, one per source file.",
      schema: DocumentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "status": {
      description:
        "Ingestion summary — counts, formats, errors from the last ingest run.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description:
        "Discover supported documents in the configured directory. Reports file count, formats, and total size without performing any conversion.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        context.logger.info("Scanning {dir}", { dir: globalArgs.documentsDir });

        const files: Array<{
          format: string;
          sizeBytes: number;
          relativePath: string;
        }> = [];
        const byFormat: Record<string, number> = {};
        let totalSizeBytes = 0;
        let truncated = false;

        for await (
          const doc of discoverDocuments(globalArgs.documentsDir, globalArgs)
        ) {
          if (files.length >= MAX_SCAN_FILES) {
            truncated = true;
            break;
          }
          files.push({
            relativePath: doc.relativePath,
            format: doc.format,
            sizeBytes: doc.sizeBytes,
          });
          byFormat[doc.format] = (byFormat[doc.format] ?? 0) + 1;
          totalSizeBytes += doc.sizeBytes;
        }

        context.logger.info("Found {count} documents", {
          count: files.length,
        });

        const handle = await context.writeResource("scan", "scan-latest", {
          scannedAt: new Date().toISOString(),
          documentsDir: globalArgs.documentsDir,
          recursive: globalArgs.recursive,
          totalFiles: files.length,
          totalSizeBytes,
          byFormat,
          files,
          truncated,
        });

        return { dataHandles: [handle] };
      },
    },

    ingest: {
      description:
        "Convert each document to markdown via anydoc and write a provenance-aware `document` resource per file. Idempotent: re-running skips files whose content hash hasn't changed.",
      arguments: z.object({
        force: z.boolean().default(false)
          .describe("Force re-conversion even if content hash matches"),
      }),
      execute: async (
        args: { force?: boolean; _converter?: DocumentConverter },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        const converter = args._converter;
        const handles: Array<{ name: string }> = [];
        const errors: Array<{ path: string; error: string }> = [];
        let ingested = 0;
        let converted = 0;
        let skipped = 0;
        let truncated = false;
        const byFormat: Record<string, number> = {};

        context.logger.info("Starting ingestion from {dir}", {
          dir: globalArgs.documentsDir,
        });

        for await (
          const doc of discoverDocuments(globalArgs.documentsDir, globalArgs)
        ) {
          // Bounded pagination: cap total documents processed. Include
          // `errors.length` so files that fail in the outer catch (hashFile
          // PermissionDenied, writeResource failures) still count against the
          // cap. Otherwise a directory of unreadable files could iterate
          // without bound while every doc lands only in `errors`.
          if (ingested + skipped + errors.length >= MAX_INGEST_FILES) {
            truncated = true;
            context.logger.warn(
              "Reached ingestion cap ({cap} files). Remaining documents skipped.",
              { cap: MAX_INGEST_FILES },
            );
            break;
          }

          try {
            const instanceName = `document-${await toInstanceName(
              doc.relativePath,
            )}`;

            // Compute content hash for idempotency
            const contentHash = await hashFile(doc.path);

            // Check if already ingested with same hash (unless forced)
            // Skip only if the previous run succeeded (no error)
            if (!args.force && context.readResource) {
              const existing = await context.readResource(instanceName);
              if (
                existing && typeof existing === "object" &&
                existing.contentHash === contentHash &&
                !existing.error
              ) {
                skipped++;
                context.logger.debug("Skipping unchanged {path}", {
                  path: doc.relativePath,
                });
                continue;
              }
            }

            // Convert
            context.logger.info("Converting {path} ({format})", {
              path: doc.relativePath,
              format: doc.format,
            });

            const { markdown, error } = await convertDocument(
              doc.path,
              converter,
            );

            if (error) {
              context.logger.warn("Conversion failed for {path}: {error}", {
                path: doc.relativePath,
                error,
              });
              errors.push({ path: doc.relativePath, error });
            }

            const now = new Date().toISOString();
            const id = `anydoc:${contentHash.slice(0, 16)}`;

            const handle = await context.writeResource(
              "document",
              instanceName,
              {
                id,
                kind: "document",
                sourcePath: doc.path,
                relativePath: doc.relativePath,
                format: doc.format,
                sizeBytes: doc.sizeBytes,
                contentHash,
                markdown,
                markdownLength: markdown.length,
                convertedAt: now,
                provenance: {
                  asOf: now,
                  source: doc.path,
                  tool: "@firecrawl/anydoc",
                  toolVersion: ANYDOC_VERSION,
                },
                error,
              },
            );

            handles.push(handle);
            ingested++;
            if (error === null) converted++;
            byFormat[doc.format] = (byFormat[doc.format] ?? 0) + 1;
          } catch (err) {
            // Per-document failure: log, record error, continue processing
            const message = err instanceof Error ? err.message : String(err);
            context.logger.warn(
              "Failed to process {path}: {error}",
              { path: doc.relativePath, error: message },
            );
            errors.push({ path: doc.relativePath, error: message });
          }
        }

        // Write status
        const statusHandle = await context.writeResource("status", "status", {
          lastRunAt: new Date().toISOString(),
          documentsDir: globalArgs.documentsDir,
          totalIngested: ingested,
          totalConverted: converted,
          totalErrors: errors.length,
          totalSkipped: skipped,
          truncated,
          byFormat,
          errors,
        });
        handles.push(statusHandle);

        context.logger.info(
          "Ingestion complete: {ingested} written ({converted} converted, {failed} with errors), {skipped} skipped",
          {
            ingested,
            converted,
            failed: ingested - converted,
            skipped,
          },
        );

        return { dataHandles: handles };
      },
    },

    status: {
      description:
        "Summarise ingestion state: total documents processed, last run timestamp, formats, and errors encountered.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const existing = context.readResource
          ? await context.readResource("status")
          : null;

        if (!existing) {
          context.logger.info("No previous ingestion found");
          const handle = await context.writeResource("status", "status", {
            lastRunAt: null,
            documentsDir: context.globalArgs.documentsDir,
            totalIngested: 0,
            totalConverted: 0,
            totalErrors: 0,
            totalSkipped: 0,
            truncated: false,
            byFormat: {},
            errors: [],
          });
          return { dataHandles: [handle] };
        }

        context.logger.info("Last ingestion: {lastRunAt}, {total} documents", {
          lastRunAt: existing.lastRunAt,
          total: existing.totalIngested,
        });

        // Re-write to keep resource versioned for trend tracking.
        // `totalConverted` was added in 2026.08.12.2; fall back to
        // `totalIngested` for status resources written by earlier versions
        // so existing timelines don't show a synthetic drop to zero.
        const handle = await context.writeResource("status", "status", {
          lastRunAt: existing.lastRunAt,
          documentsDir: existing.documentsDir ??
            context.globalArgs.documentsDir,
          totalIngested: existing.totalIngested ?? 0,
          totalConverted: existing.totalConverted ??
            existing.totalIngested ?? 0,
          totalErrors: existing.totalErrors ?? 0,
          totalSkipped: existing.totalSkipped ?? 0,
          truncated: existing.truncated ?? false,
          byFormat: existing.byFormat ?? {},
          errors: existing.errors ?? [],
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
