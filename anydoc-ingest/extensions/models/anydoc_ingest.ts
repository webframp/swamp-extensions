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
  scannedAt: z.string(),
  documentsDir: z.string(),
  recursive: z.boolean(),
  totalFiles: z.number().int().min(0),
  totalSizeBytes: z.number().int().min(0),
  byFormat: z.record(z.string(), z.number().int()),
  files: z.array(z.object({
    relativePath: z.string(),
    format: z.string(),
    sizeBytes: z.number().int(),
  })),
  truncated: z.boolean(),
});

/** Schema for a single ingested document resource. */
const DocumentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  sourcePath: z.string(),
  relativePath: z.string(),
  format: z.string(),
  sizeBytes: z.number().int(),
  contentHash: z.string(),
  markdown: z.string(),
  markdownLength: z.number().int(),
  convertedAt: z.string(),
  provenance: z.object({
    asOf: z.string(),
    source: z.string(),
    tool: z.string(),
    toolVersion: z.string(),
  }),
  error: z.string().nullable(),
});

/** Schema for the ingestion status resource. */
const StatusSchema = z.object({
  lastRunAt: z.string().nullable(),
  documentsDir: z.string(),
  totalIngested: z.number().int().min(0),
  totalErrors: z.number().int().min(0),
  totalSkipped: z.number().int().min(0),
  truncated: z.boolean(),
  byFormat: z.record(z.string(), z.number().int()),
  errors: z.array(z.object({
    path: z.string(),
    error: z.string(),
  })),
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

/** Escape regex special characters except glob wildcards. */
function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Check if a path matches any of the given glob patterns (simple matching). */
function matchesPattern(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    // Escape regex-special chars, then convert glob wildcards
    const escaped = pattern.split("").map((c) => {
      if (c === "*") return ".*";
      if (c === "?") return ".";
      return escapeRegexChar(c);
    }).join("");
    const regex = new RegExp("^" + escaped + "$");
    return regex.test(path);
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
    throw err;
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

/** Recursively walk a directory, yielding file entries with size. Skips symlinks. */
async function* walkDir(
  dir: string,
  recursive: boolean,
): AsyncGenerator<{ path: string; sizeBytes: number }> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isSymlink) continue; // Avoid symlink loops
    if (entry.isFile) {
      const stat = await Deno.stat(fullPath);
      yield { path: fullPath, sizeBytes: stat.size };
    } else if (entry.isDirectory && recursive) {
      yield* walkDir(fullPath, recursive);
    }
  }
}

/**
 * Convert a document to markdown using the anydoc CLI.
 *
 * Uses `npx @firecrawl/anydoc` which downloads the native binary on first run.
 * Accepts an optional command runner for testability.
 */
async function convertDocument(
  filePath: string,
  options?: { runner?: CommandRunner },
): Promise<{ markdown: string; error: string | null }> {
  const runner = options?.runner ?? defaultCommandRunner;
  try {
    const result = await runner(
      "npx",
      ["--yes", "@firecrawl/anydoc@0.1.8", filePath],
    );
    if (result.success) {
      return { markdown: result.stdout, error: null };
    }
    return {
      markdown: "",
      error: result.stderr || `Exit code: ${result.code}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { markdown: "", error: message };
  }
}

/** Command runner signature for dependency injection in tests. */
export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
>;

/** Default command runner using Deno.Command with timeout. */
const defaultCommandRunner: CommandRunner = async (
  cmd: string,
  args: string[],
): Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
> => {
  const command = new Deno.Command(cmd, {
    args,
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
      reject(new Error(`Command timed out after ${CONVERT_TIMEOUT_MS}ms`));
    }, CONVERT_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([child.output(), timeout]);
    return {
      success: result.success,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      code: result.code,
    };
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
  version: "2026.08.12.1",
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
        _runner: z.any().optional()
          .describe("Injectable command runner for testing"),
      }),
      execute: async (
        args: { force?: boolean; _runner?: CommandRunner },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        const runner = args._runner;
        const handles: Array<{ name: string }> = [];
        const errors: Array<{ path: string; error: string }> = [];
        let ingested = 0;
        let skipped = 0;
        let truncated = false;
        const byFormat: Record<string, number> = {};

        context.logger.info("Starting ingestion from {dir}", {
          dir: globalArgs.documentsDir,
        });

        for await (
          const doc of discoverDocuments(globalArgs.documentsDir, globalArgs)
        ) {
          // Bounded pagination: cap total documents processed
          if (ingested + skipped >= MAX_INGEST_FILES) {
            truncated = true;
            context.logger.warn(
              "Reached ingestion cap ({cap} files). Remaining documents skipped.",
              { cap: MAX_INGEST_FILES },
            );
            break;
          }

          const instanceName = `document-${await toInstanceName(
            doc.relativePath,
          )}`;

          // Compute content hash for idempotency
          const contentHash = await hashFile(doc.path);

          // Check if already ingested with same hash (unless forced)
          if (!args.force && context.readResource) {
            const existing = await context.readResource(instanceName);
            if (
              existing && typeof existing === "object" &&
              existing.contentHash === contentHash
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

          const { markdown, error } = await convertDocument(doc.path, {
            runner,
          });

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
          byFormat[doc.format] = (byFormat[doc.format] ?? 0) + 1;
        }

        // Write status
        const statusHandle = await context.writeResource("status", "status", {
          lastRunAt: new Date().toISOString(),
          documentsDir: globalArgs.documentsDir,
          totalIngested: ingested,
          totalErrors: errors.length,
          totalSkipped: skipped,
          truncated,
          byFormat,
          errors,
        });
        handles.push(statusHandle);

        context.logger.info(
          "Ingestion complete: {ingested} converted, {skipped} skipped, {errors} errors",
          { ingested, skipped, errors: errors.length },
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

        // Re-write to keep resource versioned for trend tracking
        const handle = await context.writeResource("status", "status", {
          lastRunAt: existing.lastRunAt,
          documentsDir: existing.documentsDir ??
            context.globalArgs.documentsDir,
          totalIngested: existing.totalIngested ?? 0,
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
