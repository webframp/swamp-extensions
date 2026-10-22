// SPDX-License-Identifier: Apache-2.0

/**
 * Report: @webframp/presentation/deck-summary (method scope).
 *
 * The default report of `@webframp/presentation/deck`. After `build` it lists
 * the slides, which lack speaker notes, what the deck still loads from
 * elsewhere, and any warnings. After `outline` it lists the source's slides,
 * notes coverage and missing images. After `export_pdf` it records the page
 * count and which build was printed. It never throws: data it cannot read is
 * reported as unavailable.
 *
 * @module
 */

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface MethodReportContext {
  modelType: unknown;
  modelId: string;
  methodName?: string;
  executionStatus?: string;
  dataHandles?: DataHandle[];
  dataRepository: DataRepository;
}

interface Slide {
  index: string;
  title: string;
  hasNotes?: boolean;
  notesWords?: number;
  images?: string[];
}

interface Deck {
  name: string;
  title: string | null;
  engine: string;
  engineVersion: string | null;
  reveal: { version: string; selfContained: boolean };
  theme: string;
  slides: Slide[];
  slideCount: number;
  html: { sha256: string; bytes: number; version: number };
  unchanged: boolean;
  external: string[];
  warnings: string[];
  durationMs: number;
}

interface DeckOutline {
  name: string;
  title: string | null;
  engine: string;
  slides: Slide[];
  slideCount: number;
  slidesWithoutNotes: string[];
  missingImages: string[];
}

interface DeckPdf {
  name: string;
  html: { version: number };
  pdf: { bytes: number; pages: number; version: number };
  selfContained: boolean;
  unchanged: boolean;
}

/** Escape a value for a Markdown table cell. */
export function cell(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function list(items: string[]): string {
  return items.map((i) => `- ${cell(i)}`).join("\n");
}

/** Markdown for a build record. */
export function renderDeck(d: Deck): string {
  const lines = [
    `# Deck: ${cell(d.title ?? d.name)}`,
    "",
    `- **Name**: ${cell(d.name)}`,
    `- **Engine**: ${cell(d.engineVersion ?? d.engine)}`,
    `- **reveal.js**: ${cell(d.reveal.version)} (${
      d.reveal.selfContained ? "inlined, works offline" : "pinned CDN"
    })`,
    `- **Theme**: ${cell(d.theme)}`,
    `- **HTML**: version ${d.html.version}, ${kib(d.html.bytes)}${
      d.unchanged ? ", unchanged since the last build" : ""
    }`,
    `- **Slides**: ${d.slideCount}`,
    "",
    "| # | Title | Notes |",
    "|---|-------|-------|",
    ...d.slides.map((s) =>
      `| ${cell(s.index)} | ${cell(s.title || "(untitled)")} | ${
        s.hasNotes ? "yes" : ""
      } |`
    ),
  ];
  const missing = d.slides.filter((s) => !s.hasNotes).length;
  if (d.slideCount > 0) {
    lines.push(
      "",
      `${missing} of ${d.slideCount} slides have no speaker notes.`,
    );
  }
  if (d.external.length > 0) {
    lines.push("", "## Loaded from elsewhere", "", list(d.external));
  }
  if (d.warnings.length > 0) {
    lines.push("", "## Warnings", "", list(d.warnings));
  }
  return lines.join("\n") + "\n";
}

/** Markdown for an outline. */
export function renderOutline(o: DeckOutline): string {
  const lines = [
    `# Outline: ${cell(o.title ?? o.name)}`,
    "",
    `- **Name**: ${cell(o.name)}`,
    `- **Engine**: ${cell(o.engine)}`,
    `- **Slides**: ${o.slideCount}`,
    "",
    "| # | Title | Notes (words) | Images |",
    "|---|-------|---------------|--------|",
    ...o.slides.map((s) =>
      `| ${cell(s.index)} | ${cell(s.title || "(untitled)")} | ${
        s.notesWords ?? 0
      } | ${(s.images ?? []).length} |`
    ),
  ];
  if (o.slidesWithoutNotes.length > 0) {
    lines.push(
      "",
      `Slides without speaker notes: ${
        o.slidesWithoutNotes.map(cell).join(", ")
      }`,
    );
  }
  if (o.missingImages.length > 0) {
    lines.push("", "## Missing images", "", list(o.missingImages));
  }
  return lines.join("\n") + "\n";
}

/** Markdown for a PDF record. */
export function renderPdf(p: DeckPdf): string {
  return [
    `# PDF: ${cell(p.name)}`,
    "",
    `- **Pages**: ${p.pdf.pages}`,
    `- **PDF**: version ${p.pdf.version}, ${kib(p.pdf.bytes)}${
      p.unchanged ? ", unchanged since the last export" : ""
    }`,
    `- **Printed from**: HTML version ${p.html.version}${
      p.selfContained ? "" : " (loaded reveal.js from the CDN)"
    }`,
  ].join("\n") + "\n";
}

async function read<T>(
  context: MethodReportContext,
  handle: DataHandle,
): Promise<T | null> {
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  return raw ? JSON.parse(new TextDecoder().decode(raw)) as T : null;
}

async function renderReport(
  context: MethodReportContext,
): Promise<{ markdown: string; json: Record<string, unknown> }> {
  const handles = context.dataHandles ?? [];
  const find = (spec: string) => handles.find((h) => h.specName === spec);
  const method = context.methodName ?? "";

  if (method === "build") {
    const h = find("deck");
    const d = h ? await read<Deck>(context, h) : null;
    if (d) return { markdown: renderDeck(d), json: { kind: "deck", ...d } };
  } else if (method === "outline") {
    const h = find("outline");
    const o = h ? await read<DeckOutline>(context, h) : null;
    if (o) {
      return { markdown: renderOutline(o), json: { kind: "outline", ...o } };
    }
  } else if (method === "export_pdf") {
    const h = find("pdfInfo");
    const p = h ? await read<DeckPdf>(context, h) : null;
    if (p) return { markdown: renderPdf(p), json: { kind: "pdf", ...p } };
  }
  return {
    markdown: `# Presentation\n\nNothing to summarise for ${
      cell(method || "this method")
    } (status: ${cell(context.executionStatus ?? "unknown")}).\n`,
    json: { available: false, method },
  };
}

/** The `@webframp/presentation/deck-summary` method-scope report. */
export const report = {
  name: "@webframp/presentation/deck-summary",
  description:
    "Summarises a deck build, outline or PDF export: slides, speaker-notes coverage, external resources and warnings",
  scope: "method" as const,
  labels: ["presentation", "reveal.js", "slides"],

  async execute(
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    try {
      return await renderReport(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        markdown: `# Presentation\n\nThe report could not render: ${
          cell(message)
        }\n`,
        json: { available: false, error: message },
      };
    }
  },
};
