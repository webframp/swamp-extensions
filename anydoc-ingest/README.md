# @webframp/anydoc-ingest

Document-to-knowledge ingestion pipeline powered by
[Firecrawl's anydoc](https://github.com/firecrawl/anydoc). Converts Word,
PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF files into structured
markdown, then materialises provenance-aware knowledge entries compatible with
[@stateless/sourced-kb](https://github.com/stateless/swamp-extensions/tree/main/sourced-kb).

This extension is the **intake layer** for a sourced knowledge base: point it at
a directory of documents, run `ingest`, and each file becomes a versioned KB
entry with full provenance (source path, conversion timestamp, format detected,
content hash).

## Installation

```bash
swamp extension pull @webframp/anydoc-ingest
```

Requires `npx` on PATH (Node.js 18+). The anydoc native binary is downloaded
automatically on first conversion via `npx @firecrawl/anydoc`.

## Usage

```bash
# Create a model instance
swamp model create @webframp/anydoc-ingest doc-ingest \
  --global-arg 'documentsDir=/path/to/docs'

# Preview what will be processed
swamp model method run doc-ingest scan

# Convert all documents
swamp model method run doc-ingest ingest

# Check status
swamp model method run doc-ingest status
```

## Methods

### scan

Discovers supported documents without converting them. Reports file counts,
formats, and total size.

```bash
swamp model method run doc-ingest scan
swamp data get doc-ingest scan-latest --json
```

### ingest

Converts each document to markdown via anydoc and writes one `document` resource
per file. Idempotent: re-running skips files whose SHA-256 content hash hasn't
changed.

```bash
# Normal run (skips unchanged)
swamp model method run doc-ingest ingest

# Force re-conversion of all documents
swamp model method run doc-ingest ingest --arg force=true
```

### status

Summarises the last ingestion run: total documents, errors, formats processed.

```bash
swamp model method run doc-ingest status
```

## Complementing @stateless/sourced-kb

Each `document` resource carries provenance metadata matching sourced-kb's entry
shape:

```json
{
  "id": "anydoc:a1b2c3d4e5f6g7h8",
  "kind": "document",
  "provenance": {
    "asOf": "2026-08-12T14:30:00Z",
    "source": "/path/to/report.docx",
    "tool": "@firecrawl/anydoc",
    "toolVersion": "0.1.8"
  }
}
```

Use a workflow to pipe ingested documents into a sourced-kb instance:

```yaml
jobs:
  ingest-docs:
    steps:
      - name: extract
        model: doc-ingest
        method: ingest
      - name: apply-kb
        model: my-kb
        method: apply
```

## Supported Formats

| Format           | Extensions                                                 |
| ---------------- | ---------------------------------------------------------- |
| Word             | `.doc`, `.docx`, `.docm`                                   |
| PowerPoint       | `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm` |
| Excel            | `.xls`, `.xlsx`, `.xlsm`, `.xlsb`                          |
| OpenDocument     | `.odt`, `.ods`, `.odp`                                     |
| Rich Text Format | `.rtf`                                                     |
| EPUB             | `.epub`                                                    |
| CSV              | `.csv`                                                     |
| PDF              | `.pdf`                                                     |

## Configuration

| Global Argument   | Default | Description                               |
| ----------------- | ------- | ----------------------------------------- |
| `documentsDir`    | —       | Directory containing documents (required) |
| `recursive`       | `true`  | Scan subdirectories                       |
| `maxFileSizeMb`   | `50`    | Skip files larger than this               |
| `includePatterns` | `[]`    | Glob patterns to include (empty = all)    |
| `excludePatterns` | `[]`    | Glob patterns to exclude                  |

## Troubleshooting

### `scan` caps at 5,000 files; `ingest` caps at 10,000

The `scan` method discovers at most `MAX_SCAN_FILES = 5000` documents. The
`ingest` method processes at most `MAX_INGEST_FILES = 10000` total (including
skipped and errored files). Both set `truncated: true` when the cap is reached.
Use `includePatterns` or `excludePatterns` to narrow the scope.

### Per-document conversion failures are non-fatal

If `anydoc` fails on a specific file (timeout, unsupported format, binary
corruption), the document resource is written with `markdown: ""` and
`error: "<message>"`. The ingest continues to the next file. Check the `errors`
array in the status resource for a summary.

### 120-second per-document timeout

The `anydoc` CLI is killed after 120 seconds per file. Large documents
(approaching the `maxFileSizeMb` limit, default 50MB) may hit this timeout. The
timeout is not configurable.

### `documentsDir` must be an absolute path

The Zod schema validates that `documentsDir` starts with `/`. Relative paths are
rejected at validation time before any filesystem access occurs.

### Idempotency: errored files are re-attempted on next run

Files that previously failed conversion (stored with a non-null `error` field)
are re-attempted on subsequent runs. Only successfully converted files (with
`error: null`) are skipped based on content hash. Set `--input force=true` to
reprocess all files regardless.

### Requires `npx` on PATH (Node.js 18+)

The extension spawns `npx --yes @firecrawl/anydoc@0.1.8` for each document. If
`npx` is not available, the method throws on the first conversion attempt.

### Files skipped silently on permission errors

During directory walking, files that return `PermissionDenied` from `stat()` are
silently skipped without logging. If expected files are missing from scan
results, check filesystem permissions.

## License

Apache-2.0 — see LICENSE.md for details.
