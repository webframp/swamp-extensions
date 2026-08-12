## 2026.08.12.1

**Added:** Initial release of the anydoc-ingest extension.

- `scan` method discovers supported documents in a configured directory,
  reporting file counts, formats, and total size without conversion.
- `ingest` method converts documents to markdown via Firecrawl's anydoc and
  writes provenance-aware `document` resources (one per file). Idempotent:
  skips files whose SHA-256 content hash hasn't changed since last run.
- `status` method summarises the last ingestion run.
- Supports Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF.
- Each document resource carries provenance metadata compatible with
  @stateless/sourced-kb's entry shape (id, kind, asOf, source, tool).
- Configurable include/exclude glob patterns, recursive scanning, and max
  file size limit.
