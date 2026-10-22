// SPDX-License-Identifier: Apache-2.0

/**
 * `@webframp/presentation/deck`: build reveal.js presentations from Org or
 * Markdown and keep each build, its outline and its PDF as versioned swamp
 * data.
 *
 * Engines:
 * - `org-re-reveal` for Org, run in batch Emacs against a pinned
 *   org-re-reveal and htmlize (Org is the copy built into Emacs).
 * - `pandoc` for Markdown, with pandoc's own reveal.js template adapted to
 *   reveal.js 6.
 * - `reveal-markdown` for Markdown, rendered in the browser by reveal.js's
 *   markdown plugin; needs no external tool.
 *
 * Every deck loads reveal.js from a pinned jsDelivr URL with subresource
 * integrity, or, with `selfContained`, carries every reveal.js file inline,
 * checked against pinned SHA-256s. Local images are always inlined, so a
 * stored deck never depends on the files beside its source.
 *
 * @module
 */

import { z } from "npm:zod@4.6.5";
import {
  defaultCacheDir,
  ensureElisp,
  fetchRevealFile,
  sha256Hex,
} from "./_lib/cache.ts";
import {
  BUILD_EL,
  inlineMarkdownImages,
  markdownParts,
  renderOrg,
  renderPandoc,
  renderRevealMarkdown,
} from "./_lib/engines.ts";
import {
  addIntegrity,
  dataUri,
  externalResources,
  inlineLocalFiles,
  inlineReveal,
  isLocalPath,
  pinnedPath,
  renderedSlides,
} from "./_lib/html.ts";
import { exportPdf } from "./_lib/pdf.ts";
import {
  ELISP_PINS,
  REVEAL_CDN,
  REVEAL_THEMES,
  REVEAL_VERSION,
} from "./_lib/pins.ts";
import {
  chooseEngine,
  DECK_NAME_PATTERN,
  deckNameFromPath,
  detectFormat,
  type Engine,
  type Format,
  type Outline,
  outlineFor,
} from "./_lib/source.ts";

/**
 * Network and browser access, replaceable in tests: the pinned downloads only
 * accept the real upstream bytes, and printing needs a real Chromium.
 */
export const deps = { ensureElisp, fetchRevealFile, exportPdf };

// =============================================================================
// Schemas
// =============================================================================

const ThemeSchema = z.enum(REVEAL_THEMES as [string, ...string[]]);

const GlobalArgsSchema = z.object({
  theme: ThemeSchema.default("black").describe(
    "Theme for decks whose source names none (#+REVEAL_THEME or front-matter theme:)",
  ),
  emacs: z.string().min(1).default("emacs").describe(
    "Emacs executable for the org-re-reveal engine",
  ),
  pandoc: z.string().min(1).default("pandoc").describe(
    "pandoc executable for the pandoc engine",
  ),
  chromium: z.string().min(1).default("chromium").describe(
    "Chromium or Chrome executable for export_pdf",
  ),
  chromiumNoSandbox: z.boolean().default(false).describe(
    "Pass --no-sandbox to Chromium. Needed in some containers and WSL; leave off otherwise",
  ),
  cacheDir: z.string().min(1).optional().describe(
    "Where pinned downloads are cached (default: $XDG_CACHE_HOME/webframp-presentation or ~/.cache/webframp-presentation)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const NameSchema = z.string().regex(DECK_NAME_PATTERN).describe(
  "Deck name used in data names (default: the source file's name without its extension)",
);

const SourceArgs = {
  source: z.string().min(1).optional().describe(
    "Path to the .org or .md source, absolute or relative to the repository",
  ),
  content: z.string().min(1).optional().describe(
    "Source text instead of a file (requires name and format). Relative image paths resolve against the repository",
  ),
  format: z.enum(["auto", "org", "markdown"]).default("auto").describe(
    "Source format (auto: from the file extension)",
  ),
  engine: z.enum(["auto", "org-re-reveal", "pandoc", "reveal-markdown"])
    .default("auto").describe(
      "Rendering engine (auto: org-re-reveal for Org, pandoc for Markdown)",
    ),
  name: NameSchema.optional(),
};

function exactlyOneSource(
  a: { source?: string; content?: string; name?: string },
): boolean {
  return (a.source === undefined) !== (a.content === undefined) &&
    (a.content === undefined || a.name !== undefined);
}

const SOURCE_RULE =
  "Pass exactly one of source or content; content also needs name";

const BuildArgsSchema = z.object({
  ...SourceArgs,
  selfContained: z.boolean().default(false).describe(
    "Inline every reveal.js file so the deck works offline (larger file)",
  ),
}).refine(exactlyOneSource, { message: SOURCE_RULE });

const OutlineArgsSchema = z.object(SourceArgs).refine(exactlyOneSource, {
  message: SOURCE_RULE,
});

const ExportPdfArgsSchema = z.object({
  name: NameSchema.optional(),
  source: z.string().min(1).optional().describe(
    "Source path, used only to derive the deck name",
  ),
  timeoutSeconds: z.number().int().min(10).max(600).default(120).describe(
    "Longest wait for reveal.js to lay out its print view",
  ),
}).refine((a) => (a.name === undefined) !== (a.source === undefined), {
  message: "Pass exactly one of name or source",
});

const SourceInfoSchema = z.object({
  path: z.string().nullable(),
  sha256: z.string(),
  format: z.enum(["org", "markdown"]),
});

const SlideSchema = z.object({
  index: z.string(),
  title: z.string(),
  hasNotes: z.boolean(),
});

const DeckSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  engine: z.enum(["org-re-reveal", "pandoc", "reveal-markdown"]),
  engineVersion: z.string().nullable(),
  source: SourceInfoSchema,
  reveal: z.object({
    version: z.string(),
    cdn: z.string(),
    selfContained: z.boolean(),
  }),
  theme: z.string(),
  slides: z.array(SlideSchema),
  slideCount: z.number().int(),
  html: z.object({
    sha256: z.string(),
    bytes: z.number().int(),
    version: z.number().int(),
  }),
  unchanged: z.boolean(),
  external: z.array(z.string()),
  warnings: z.array(z.string()),
  durationMs: z.number(),
  builtAt: z.string(),
});

const OutlineSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  theme: z.string().nullable(),
  engine: z.enum(["org-re-reveal", "pandoc", "reveal-markdown"]),
  source: SourceInfoSchema,
  slides: z.array(z.object({
    index: z.string(),
    level: z.number().int(),
    title: z.string(),
    notesWords: z.number().int(),
    images: z.array(z.string()),
  })),
  slideCount: z.number().int(),
  slidesWithoutNotes: z.array(z.string()),
  missingImages: z.array(z.string()),
  outlinedAt: z.string(),
});

const PdfSchema = z.object({
  name: z.string(),
  html: z.object({ sha256: z.string(), version: z.number().int() }),
  pdf: z.object({
    sha256: z.string(),
    bytes: z.number().int(),
    pages: z.number().int(),
    version: z.number().int(),
  }),
  selfContained: z.boolean(),
  unchanged: z.boolean(),
  durationMs: z.number(),
  exportedAt: z.string(),
});

/** Build record of one deck, stored as `deck-<name>`. */
export type Deck = z.infer<typeof DeckSchema>;
/** Outline of a deck source, stored as `outline-<name>`. */
export type DeckOutline = z.infer<typeof OutlineSchema>;
/** Record of one PDF export, stored as `pdf-<name>`. */
export type DeckPdf = z.infer<typeof PdfSchema>;

// =============================================================================
// Data names
// =============================================================================

/** Data name of a deck's build record. */
export const deckResourceName = (name: string) => `deck-${name}`;
/** Data name of a deck's HTML file. */
export const deckHtmlName = (name: string) => `deck-${name}-html`;
/** Data name of a deck's PDF file. */
export const deckPdfName = (name: string) => `deck-${name}-pdf`;
/** Data name of a deck's outline. */
export const outlineResourceName = (name: string) => `outline-${name}`;
/** Data name of a deck's PDF record. */
export const pdfResourceName = (name: string) => `pdf-${name}`;

// =============================================================================
// Context
// =============================================================================

interface DataHandle {
  name: string;
  version?: number;
}

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
}

interface DeckContext {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: Logger;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
  readResource(name: string): Promise<Record<string, unknown> | null>;
  createFileWriter(spec: string, name: string): {
    writeAll(content: Uint8Array): Promise<DataHandle>;
  };
}

interface PdfContext extends DeckContext {
  modelType: unknown;
  modelId: string;
  dataRepository: {
    getContent(
      modelType: unknown,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

// =============================================================================
// Source loading
// =============================================================================

interface LoadedSource {
  name: string;
  path: string | null;
  /** Directory relative references resolve against. */
  baseDir: string;
  text: string;
  format: Format;
  engine: Engine;
  sha256: string;
}

async function loadSource(
  args: z.infer<typeof OutlineArgsSchema>,
  repoDir: string,
): Promise<LoadedSource> {
  if (args.content !== undefined) {
    const format = detectFormat(null, args.format);
    const bytes = new TextEncoder().encode(args.content);
    return {
      name: args.name!,
      path: null,
      baseDir: repoDir,
      text: args.content,
      format,
      engine: chooseEngine(format, args.engine),
      sha256: await sha256Hex(bytes),
    };
  }
  const given = args.source!;
  const absolute = given.startsWith("/") ? given : `${repoDir}/${given}`;
  let path: string;
  try {
    path = await Deno.realPath(absolute);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`Source not found: ${given}`);
    }
    throw e;
  }
  const bytes = await Deno.readFile(path);
  const format = detectFormat(path, args.format);
  return {
    name: args.name ?? deckNameFromPath(path),
    path,
    baseDir: path.slice(0, path.lastIndexOf("/")) || "/",
    text: new TextDecoder().decode(bytes),
    format,
    engine: chooseEngine(format, args.engine),
    sha256: await sha256Hex(bytes),
  };
}

/**
 * Refuse to let one deck name hold two different sources. Two files called
 * `talk.org` in different directories would otherwise overwrite each
 * other's data.
 */
function assertSameSource(
  prior: Record<string, unknown> | null,
  src: LoadedSource,
): void {
  const priorPath = (prior?.source as { path?: string | null } | undefined)
    ?.path;
  if (prior === null || priorPath === undefined) return;
  if (priorPath !== src.path) {
    throw new Error(
      `Deck name "${src.name}" already belongs to ${
        priorPath ?? "inline content"
      }. Pass a different name for ${src.path ?? "this content"}.`,
    );
  }
}

function cacheDirOf(g: GlobalArgs): string {
  return g.cacheDir ?? defaultCacheDir();
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "webframp-presentation-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Where the engine reads the source from: the file, or a temp copy of content. */
async function sourceFile(
  src: LoadedSource,
  dir: string,
): Promise<string> {
  if (src.path !== null) return src.path;
  const file = `${dir}/deck.${src.format === "org" ? "org" : "md"}`;
  await Deno.writeTextFile(file, src.text);
  return file;
}

// =============================================================================
// Build
// =============================================================================

interface Rendered {
  html: string;
  engineVersion: string | null;
  slides: Array<{ index: string; title: string; hasNotes: boolean }> | null;
  warnings: string[];
}

async function render(
  src: LoadedSource,
  g: GlobalArgs,
  dir: string,
  signal?: AbortSignal,
): Promise<Rendered> {
  const file = await sourceFile(src, dir);
  switch (src.engine) {
    case "org-re-reveal": {
      const lispDir = await deps.ensureElisp(cacheDirOf(g), signal);
      const buildEl = `${dir}/build.el`;
      await Deno.writeTextFile(buildEl, BUILD_EL);
      const r = await renderOrg({
        emacs: g.emacs,
        buildEl,
        lispDir,
        source: file,
        theme: g.theme,
        signal,
      });
      const pin = ELISP_PINS.find((p) => p.file === "org-re-reveal.el");
      return {
        html: r.html,
        engineVersion: pin ? `org-re-reveal ${pin.version}` : null,
        slides: null,
        warnings: [],
      };
    }
    case "pandoc": {
      const r = await renderPandoc({
        pandoc: g.pandoc,
        source: file,
        theme: g.theme,
        workDir: dir,
        signal,
      });
      return {
        html: r.html,
        engineVersion: r.version ? `pandoc ${r.version}` : null,
        slides: null,
        warnings: [],
      };
    }
    case "reveal-markdown": {
      const parts = markdownParts(src.text);
      const images = await inlineMarkdownImages(
        parts.body,
        (ref) => dataUri(ref, src.baseDir),
        isLocalPath,
      );
      const theme = parts.theme ?? g.theme;
      const outline = outlineFor("reveal-markdown", src.text);
      return {
        html: renderRevealMarkdown({
          markdown: images.markdown,
          title: parts.title ?? outline.title ?? src.name,
          theme: REVEAL_THEMES.includes(theme) ? theme : g.theme,
        }),
        engineVersion: `reveal.js markdown plugin ${REVEAL_VERSION}`,
        // Rendered in the browser, so the outline is the slide list.
        slides: outline.slides.map((s) => ({
          index: s.index,
          title: s.title,
          hasNotes: s.notesWords > 0,
        })),
        warnings: [
          ...images.problems,
          ...(parts.theme !== null && !REVEAL_THEMES.includes(parts.theme)
            ? [
              `theme "${parts.theme}" is not a reveal.js theme; used ${g.theme}`,
            ]
            : []),
        ],
      };
    }
  }
}

/** Theme a rendered deck loads, read from its theme stylesheet. */
function themeOf(html: string, fallback: string): string {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = m[0].match(/\shref=(["'])([^"']*)\1/i)?.[2] ?? "";
    const path = pinnedPath(href);
    if (path?.startsWith("dist/theme/")) {
      return path.slice("dist/theme/".length, -".css".length);
    }
  }
  return fallback;
}

async function build(
  args: z.infer<typeof BuildArgsSchema>,
  context: DeckContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const started = Date.now();
  const g = context.globalArgs;
  const src = await loadSource(args, context.repoDir);
  const prior = await context.readResource(deckResourceName(src.name));
  assertSameSource(prior, src);

  const rendered = await withTempDir((dir) =>
    render(src, g, dir, context.signal)
  );
  const warnings = [...rendered.warnings];

  const local = await inlineLocalFiles(rendered.html, src.baseDir);
  warnings.push(...local.problems);
  let html = local.html;
  // Read the theme before inlining replaces the stylesheet links.
  const theme = themeOf(html, g.theme);

  if (args.selfContained) {
    const cacheDir = cacheDirOf(g);
    const inlined = await inlineReveal(
      html,
      (path) => deps.fetchRevealFile(cacheDir, path, context.signal),
    );
    html = inlined.html;
    warnings.push(...inlined.problems);
  } else {
    const pinned = await addIntegrity(html);
    html = pinned.html;
    warnings.push(...pinned.problems);
  }

  const external = externalResources(html).filter((u) =>
    args.selfContained || pinnedPath(u) === null
  );
  if (args.selfContained) {
    for (const u of external) {
      warnings.push(`not self-contained: the deck still loads ${u}`);
    }
  }
  if (/\bRevealMath\b/.test(html)) {
    warnings.push(
      "the math plugin loads KaTeX or MathJax from a CDN when the deck opens",
    );
  }

  const bytes = new TextEncoder().encode(html);
  const sha256 = await sha256Hex(bytes);
  const priorHtml = (prior as Deck | null)?.html;
  const unchanged = priorHtml?.sha256 === sha256;

  const handles: DataHandle[] = [];
  let version: number;
  if (unchanged && priorHtml) {
    version = priorHtml.version;
  } else {
    const handle = await context.createFileWriter(
      "html",
      deckHtmlName(src.name),
    ).writeAll(bytes);
    handles.push(handle);
    version = handle.version ?? 1;
  }

  const slides = rendered.slides ?? renderedSlides(html);
  const deck: Deck = {
    name: src.name,
    title: outlineFor(src.engine, src.text).title,
    engine: src.engine,
    engineVersion: rendered.engineVersion,
    source: { path: src.path, sha256: src.sha256, format: src.format },
    reveal: {
      version: REVEAL_VERSION,
      cdn: REVEAL_CDN,
      selfContained: args.selfContained,
    },
    theme,
    slides,
    slideCount: slides.length,
    html: { sha256, bytes: bytes.length, version },
    unchanged,
    external,
    warnings,
    durationMs: Date.now() - started,
    builtAt: new Date().toISOString(),
  };
  handles.push(
    await context.writeResource("deck", deckResourceName(src.name), deck),
  );
  for (const w of warnings) context.logger.warning(w, { deck: src.name });
  context.logger.info(
    unchanged
      ? "Deck {name} unchanged ({slides} slides); kept HTML version {version}"
      : "Built deck {name}: {slides} slides, {bytes} bytes, HTML version {version}",
    { name: src.name, slides: slides.length, bytes: bytes.length, version },
  );
  return { dataHandles: handles };
}

// =============================================================================
// Outline
// =============================================================================

async function missingImages(
  outline: Outline,
  baseDir: string,
): Promise<string[]> {
  const missing = new Set<string>();
  for (const s of outline.slides) {
    for (const ref of s.images) {
      const path = ref.startsWith("/") ? ref : `${baseDir}/${ref}`;
      try {
        if (!(await Deno.stat(path)).isFile) missing.add(ref);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) missing.add(ref);
        else throw e;
      }
    }
  }
  return [...missing].sort();
}

async function outline(
  args: z.infer<typeof OutlineArgsSchema>,
  context: DeckContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const src = await loadSource(args, context.repoDir);
  const o = outlineFor(src.engine, src.text);
  const data: DeckOutline = {
    name: src.name,
    title: o.title,
    theme: o.theme,
    engine: src.engine,
    source: { path: src.path, sha256: src.sha256, format: src.format },
    slides: o.slides,
    slideCount: o.slides.length,
    slidesWithoutNotes: o.slides.filter((s) => s.notesWords === 0).map((s) =>
      s.index
    ),
    missingImages: await missingImages(o, src.baseDir),
    outlinedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource(
    "outline",
    outlineResourceName(src.name),
    data,
  );
  context.logger.info(
    "Outlined {name}: {slides} slides, {missing} missing images",
    {
      name: src.name,
      slides: data.slideCount,
      missing: data.missingImages.length,
    },
  );
  return { dataHandles: [handle] };
}

// =============================================================================
// PDF
// =============================================================================

async function exportDeckPdf(
  args: z.infer<typeof ExportPdfArgsSchema>,
  context: PdfContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const started = Date.now();
  const name = args.name ?? deckNameFromPath(args.source!);
  const deck = await context.readResource(deckResourceName(name)) as
    | Deck
    | null;
  if (!deck) {
    throw new Error(`No build of deck "${name}". Run build first.`);
  }
  const html = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    deckHtmlName(name),
    deck.html.version,
  );
  if (!html) {
    throw new Error(
      `HTML version ${deck.html.version} of deck "${name}" is missing. Run build again.`,
    );
  }
  if (await sha256Hex(html) !== deck.html.sha256) {
    throw new Error(
      `HTML version ${deck.html.version} of deck "${name}" does not match its build record. Run build again.`,
    );
  }

  const prior = await context.readResource(pdfResourceName(name)) as
    | DeckPdf
    | null;
  const handles: DataHandle[] = [];
  let pdfInfo: DeckPdf["pdf"];
  const unchanged = prior?.html.sha256 === deck.html.sha256;
  if (unchanged && prior) {
    pdfInfo = prior.pdf;
  } else {
    const printed = await withTempDir(async (dir) => {
      const file = `${dir}/deck.html`;
      await Deno.writeFile(file, html);
      return await deps.exportPdf({
        chromium: context.globalArgs.chromium,
        url: `file://${file}?print-pdf`,
        profileDir: `${dir}/profile`,
        timeoutMs: args.timeoutSeconds * 1000,
        noSandbox: context.globalArgs.chromiumNoSandbox,
      });
    });
    const handle = await context.createFileWriter("pdf", deckPdfName(name))
      .writeAll(printed.pdf);
    handles.push(handle);
    pdfInfo = {
      sha256: await sha256Hex(printed.pdf),
      bytes: printed.pdf.length,
      pages: printed.pages,
      version: handle.version ?? 1,
    };
  }

  const data: DeckPdf = {
    name,
    html: { sha256: deck.html.sha256, version: deck.html.version },
    pdf: pdfInfo,
    selfContained: deck.reveal.selfContained,
    unchanged,
    durationMs: Date.now() - started,
    exportedAt: new Date().toISOString(),
  };
  handles.push(
    await context.writeResource("pdfInfo", pdfResourceName(name), data),
  );
  context.logger.info(
    unchanged
      ? "PDF of {name} unchanged; kept PDF version {version}"
      : "Exported {name}: {pages} pages, PDF version {version}",
    { name, pages: pdfInfo.pages, version: pdfInfo.version },
  );
  return { dataHandles: handles };
}

// =============================================================================
// Model
// =============================================================================

/**
 * The `@webframp/presentation/deck` model type: `build`, `outline` and
 * `export_pdf`, with the deck-summary report as its default report.
 */
export const model = {
  type: "@webframp/presentation/deck",
  version: "2026.10.21.1",
  reports: ["@webframp/presentation/deck-summary"],
  globalArguments: GlobalArgsSchema,

  resources: {
    deck: {
      description:
        "Build record of one deck: engine, pinned reveal.js, slides, HTML hash and version, warnings",
      schema: DeckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    outline: {
      description:
        "Outline of a deck source: slides, speaker-notes coverage, missing images",
      schema: OutlineSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    pdfInfo: {
      description: "Record of one PDF export: page count, hashes, versions",
      schema: PdfSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  files: {
    html: {
      description: "A reveal.js deck, named deck-<name>-html",
      contentType: "text/html",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    pdf: {
      description: "A deck printed to PDF, named deck-<name>-pdf",
      contentType: "application/pdf",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    build: {
      description:
        "Render an Org or Markdown source to a reveal.js deck and store the HTML. Skips writing a new HTML version when the output is byte-identical to the last build",
      arguments: BuildArgsSchema,
      execute: (args: z.infer<typeof BuildArgsSchema>, context: DeckContext) =>
        build(args, context),
    },
    outline: {
      description:
        "Read a source without rendering it: slide titles, speaker-notes coverage and missing images",
      arguments: OutlineArgsSchema,
      execute: (
        args: z.infer<typeof OutlineArgsSchema>,
        context: DeckContext,
      ) => outline(args, context),
    },
    export_pdf: {
      description:
        "Print the latest build of a deck to PDF with headless Chromium. Decks that load reveal.js from the CDN need network access",
      arguments: ExportPdfArgsSchema,
      execute: (
        args: z.infer<typeof ExportPdfArgsSchema>,
        context: PdfContext,
      ) => exportDeckPdf(args, context),
    },
  },
};
