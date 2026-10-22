# @webframp/presentation

Build reveal.js presentations from Org or Markdown with swamp. Each build, its
outline and its PDF are stored as versioned swamp data, so a deck can be opened,
printed or compared against an earlier version long after its source has moved
on.

## Requirements

| Engine            | Source   | Needs                                                        |
| ----------------- | -------- | ------------------------------------------------------------ |
| `org-re-reveal`   | Org      | Emacs 27.2 or later; its built-in Org (9.4 or newer) is used |
| `pandoc`          | Markdown | pandoc 3                                                     |
| `reveal-markdown` | Markdown | nothing                                                      |

`export_pdf` needs Chromium or Chrome. The first build downloads what it needs
and caches it; after that, building works offline.

## Setup

```bash
swamp extension pull @webframp/presentation
swamp model create @webframp/presentation/deck talks
```

Global arguments, all optional:

| Argument            | Default                                 | Purpose                                                      |
| ------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `theme`             | `black`                                 | Theme for decks whose source names none                      |
| `emacs`             | `emacs`                                 | Emacs executable                                             |
| `pandoc`            | `pandoc`                                | pandoc executable                                            |
| `chromium`          | `chromium`                              | Chromium or Chrome executable, by name or path               |
| `chromiumNoSandbox` | `false`                                 | Pass `--no-sandbox`; needed in some containers               |
| `cacheDir`          | `$XDG_CACHE_HOME/webframp-presentation` | Where pinned downloads are kept (`~/.cache/...` without XDG) |

## Methods

### `build`

Renders a source and stores the HTML.

```bash
swamp model method run talks build --input source=talk.org
swamp model method run talks build --input source=talk.md --input engine=reveal-markdown
swamp model method run talks build --input source=talk.org --input selfContained=true --input name=talk-offline
```

| Input           | Default | Meaning                                                                  |
| --------------- | ------- | ------------------------------------------------------------------------ |
| `source`        |         | Path to the `.org` or `.md` file, absolute or relative to the repository |
| `content`       |         | Source text instead of a file; needs `name` and `format`                 |
| `format`        | `auto`  | `org`, `markdown`, or `auto` (from the extension)                        |
| `engine`        | `auto`  | `org-re-reveal` for Org, `pandoc` or `reveal-markdown` for Markdown      |
| `name`          | stem    | Deck name; defaults to the file name without its extension               |
| `selfContained` | `false` | Inline every reveal.js file so the deck works offline                    |

A rebuild whose HTML is byte-identical to the last one writes no new HTML
version. Builds are reproducible: the same source gives the same bytes.

A deck name belongs to one source. Building `slides/talk.md` after `talk.org`
fails rather than overwrite it; pass `name` to keep both.

### `outline`

Reads a source without rendering it: slide titles, words of speaker notes per
slide, the slides with none, and images that do not exist.

```bash
swamp model method run talks outline --input source=talk.org
```

### `export_pdf`

Prints the latest build with headless Chromium. If the HTML has not changed
since the last export, the existing PDF is kept.

```bash
swamp model method run talks export_pdf --input name=talk
```

A deck that loads reveal.js from the CDN needs network access to print.

## Workflow

`@webframp/presentation-build` outlines, builds and optionally prints one deck.
Each step runs only if the one before it succeeded.

```bash
swamp workflow run @webframp/presentation-build --input source=talk.org
swamp workflow run @webframp/presentation-build \
  --input deck=talks --input source=talk.org --input selfContained=true --input pdf=true
```

## Data

For a deck named `talk`:

| Data name        | Kind     | Contents                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `deck-talk`      | resource | Engine, pinned reveal.js, theme, slides, HTML hash and version, warnings |
| `deck-talk-html` | file     | The deck (`text/html`)                                                   |
| `outline-talk`   | resource | Slides, notes word counts, missing images                                |
| `pdf-talk`       | resource | Page count, hashes, which HTML version was printed                       |
| `deck-talk-pdf`  | file     | The PDF                                                                  |

Every method also writes a `@webframp/presentation/deck-summary` report.

```bash
# The deck, ready to open:
swamp data query 'model("talks") && name == "deck-talk-html"' --select content > talk.html
# The PDF, which swamp prints as base64:
swamp data query 'model("talks") && name == "deck-talk-pdf"' --select content | base64 -d > talk.pdf
# The build record as JSON:
swamp data query 'model("talks") && name == "deck-talk"' --select content --json
```

`--select content` prints the HTML as text and the PDF as base64, each
followed by one newline. For a resource, add `--json`; without it the record
prints as a table.

## Engines

**org-re-reveal** exports Org exactly as `C-c C-e v v` does in Emacs, with
org-re-reveal 3.39.0. `#+REVEAL_THEME`, `#+REVEAL_PLUGINS`, `#+ATTR_REVEAL`
fragments, `#+BEGIN_NOTES` and `:reveal_background:` all apply. Emacs runs with
`-Q`, so nothing in your configuration changes the result. Three settings differ
from an interactive export:

- Code blocks never run (`org-export-use-babel` is off) and file-local variables
  are ignored. Building a deck you did not write is safe.
- A deck without `#+AUTHOR` has no author. Batch Emacs would otherwise fill it
  from your login and hostname.
- There is no export timestamp, and Org's heading IDs come from a fixed seed, so
  rebuilds are byte-identical.

Org sources always use this engine. pandoc's Org reader drops `#+REVEAL_`
options and fragments, and turns speaker notes into visible slide text.

**pandoc** renders Markdown with `--slide-level=2`: level-1 and level-2 headings
start slides, and level-2 headings under a level-1 heading form a vertical
stack. Speaker notes go in `::: notes` blocks. The extension takes pandoc's own
reveal.js template from `pandoc -D revealjs` and moves its plugin paths to
reveal.js 6's layout. A `theme:` in the front matter wins over the `theme`
global argument.

**reveal-markdown** wraps the Markdown in a page that reveal.js's markdown
plugin renders in the browser. A line of `---` between blank lines starts a
slide, `--` a vertical one, and text after `Note:` is speaker notes.

## reveal.js and pinned downloads

Every deck is built against reveal.js 6.0.1. Without `selfContained`, the page
loads it from `cdn.jsdelivr.net/npm/reveal.js@6.0.1` and each script and
stylesheet carries an `integrity` hash, so a browser refuses a changed file.
With `selfContained`, every reveal.js file is inlined (about 1.8 MB) and the
deck opens offline. Either way, local images, videos and stylesheets are inlined
as data URIs.

Each file the extension downloads is checked against a SHA-256 in
`extensions/models/presentation/_lib/pins.ts`:

- reveal.js runtime files, from jsDelivr
- org-re-reveal 3.39.0 and htmlize 1.59, by commit URL

A download that does not match is refused, and a cached copy that no longer
matches is downloaded again. The build record's `external` field lists anything
the deck still loads from elsewhere; with `selfContained`, each entry is also a
warning. The math plugin loads KaTeX or MathJax when the deck opens, so a deck
that uses it is never fully offline.

### Moving to a new reveal.js release

1. Set `REVEAL_VERSION` in `pins.ts`.
2. Regenerate `REVEAL_FILES` from that release's npm tarball, after checking the
   tarball against the registry's `dist.integrity`:

   ```bash
   v=6.0.1
   curl -sL "https://registry.npmjs.org/reveal.js/-/reveal.js-$v.tgz" | tar xz
   (cd package && find dist -type f \( -name '*.js' -o -name '*.css' \) ! -name '*.d.ts' | sort |
     while read -r f; do printf '  "%s": "%s",\n' "$f" "$(openssl dgst -sha256 -binary "$f" | base64)"; done)
   ```

3. Run the integration tests, which download every pinned file.

## Emacs

[emacs-swamp](https://github.com/webframp/emacs-swamp) includes `swamp-present`,
which builds, previews and outlines the deck in the current buffer through this
extension. The two are independent: the extension reads no Emacs configuration,
and `swamp-present` only runs swamp commands.

## Development

```bash
deno task check && deno task lint && deno task fmt:check && deno task test
```

The integration tests run real Emacs, pandoc and Chromium and download every
pinned file:

```bash
PRESENTATION_INTEGRATION=1 deno task test
# Where Chromium's sandbox is unavailable:
PRESENTATION_INTEGRATION=1 PRESENTATION_NO_SANDBOX=1 deno task test
```

## License

Apache-2.0. reveal.js (MIT), org-re-reveal and htmlize (GPL-3.0-or-later) are
downloaded at build time and are not part of this package.
