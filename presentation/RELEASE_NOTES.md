## 2026.10.21.1

**Added:** First release. The `@webframp/presentation/deck` model builds
reveal.js 6.0.1 presentations from Org or Markdown and stores each build as
versioned swamp data.

- `build` renders a deck with org-re-reveal (Org), pandoc (Markdown) or
  reveal.js's markdown plugin. Decks load reveal.js from jsDelivr with
  subresource integrity, or inline every file with `selfContained` and work
  offline. Local images are always inlined. A rebuild with identical output
  writes no new HTML version.
- `outline` reads a source without rendering it: slides, speaker-notes coverage
  and missing images.
- `export_pdf` prints the latest build with headless Chromium.
- The `@webframp/presentation-build` workflow outlines, builds and optionally
  prints one deck.
- The `@webframp/presentation/deck-summary` report summarises each method run.

Downloads are pinned by SHA-256: reveal.js files from jsDelivr, and
org-re-reveal 3.39.0 and htmlize 1.59 by commit. The org-re-reveal engine runs
Emacs with `-Q` and never executes code blocks.
