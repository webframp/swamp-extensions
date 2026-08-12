# @webframp/anydoc-ingest

Document-to-knowledge ingestion pipeline powered by [Firecrawl's anydoc](https://github.com/firecrawl/anydoc).
Converts Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF files into structured
markdown, then materialises provenance-aware knowledge entries compatible with
[@stateless/sourced-kb](https://github.com/stateless/swamp-extensions/tree/main/sourced-kb).

This extension is the **intake layer** for a sourced knowledge base: point it at a directory
of documents, run `ingest`, and each file becomes a versioned KB entry with full provenance
(source path, conversion timestamp, format detected, content hash).

## Installation

```bash
swamp extension pull @webframp/anydoc-ingest
```

Requires `npx` on PATH (Node.js 18+). The anydoc native binary is downloaded automatically
on first conversion via `npx @firecrawl/anydoc`.

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

Discovers supported documents without converting them. Reports file counts, formats,
and total size.

```bash
swamp model method run doc-ingest scan
swamp data get doc-ingest scan-latest --json
```

### ingest

Converts each document to markdown via anydoc and writes one `document` resource per file.
Idempotent: re-running skips files whose SHA-256 content hash hasn't changed.

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

Each `document` resource carries provenance metadata matching sourced-kb's
entry shape:

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

| Format           | Extensions                                                  |
| ---------------- | ----------------------------------------------------------- |
| Word             | `.doc`, `.docx`, `.docm`                                    |
| PowerPoint       | `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm` |
| Excel            | `.xls`, `.xlsx`, `.xlsm`, `.xlsb`                           |
| OpenDocument     | `.odt`, `.ods`, `.odp`                                      |
| Rich Text Format | `.rtf`                                                      |
| EPUB             | `.epub`                                                     |
| CSV              | `.csv`                                                      |
| PDF              | `.pdf`                                                      |

## Configuration

| Global Argument    | Default | Description                                    |
| ------------------ | ------- | ---------------------------------------------- |
| `documentsDir`     | —       | Directory containing documents (required)      |
| `recursive`        | `true`  | Scan subdirectories                            |
| `maxFileSizeMb`    | `50`    | Skip files larger than this                    |
| `includePatterns`  | `[]`    | Glob patterns to include (empty = all)         |
| `excludePatterns`  | `[]`    | Glob patterns to exclude                       |

## License

Apache-2.0 — see LICENSE.md for details.
