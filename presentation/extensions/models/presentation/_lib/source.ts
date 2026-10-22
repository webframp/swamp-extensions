// SPDX-License-Identifier: Apache-2.0

/**
 * Reading deck sources: format detection, deck names, and the outline parser
 * for Org and Markdown. Nothing here runs an external tool.
 *
 * @module
 */

/** Source formats the extension reads. */
export type Format = "org" | "markdown";

/** Rendering engines. */
export type Engine = "org-re-reveal" | "pandoc" | "reveal-markdown";

/** Deck names: lowercase, digits and dashes, starting with a letter or digit. */
export const DECK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;

/** Pick the format from an explicit choice or the file extension. */
export function detectFormat(
  path: string | null,
  explicit: "auto" | Format,
): Format {
  if (explicit !== "auto") return explicit;
  if (path === null) {
    throw new Error("format must be org or markdown when content is given");
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".org")) return "org";
  if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return "markdown";
  throw new Error(
    `Cannot tell the format of ${path} from its extension. Pass format: org or format: markdown.`,
  );
}

/** Pick and validate the engine for a format. */
export function chooseEngine(
  format: Format,
  explicit: "auto" | Engine,
): Engine {
  if (explicit === "auto") {
    return format === "org" ? "org-re-reveal" : "pandoc";
  }
  if (format === "org" && explicit !== "org-re-reveal") {
    throw new Error(
      `Org sources build only with org-re-reveal. The ${explicit} engine drops #+REVEAL_ options and fragments, and turns speaker notes into visible slide text.`,
    );
  }
  if (format === "markdown" && explicit === "org-re-reveal") {
    throw new Error(
      "org-re-reveal builds Org sources only. Use pandoc or reveal-markdown.",
    );
  }
  return explicit;
}

/**
 * Derive a deck name from a file path: the basename without its extension,
 * lowercased, with every run of other characters folded to one dash.
 */
export function deckNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const name = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  if (!DECK_NAME_PATTERN.test(name)) {
    throw new Error(
      `Cannot derive a deck name from ${path}. Pass name explicitly (lowercase letters, digits and dashes).`,
    );
  }
  return name;
}

/** One slide in a source outline. */
export interface OutlineSlide {
  /**
   * Position among the content slides, numbered as reveal.js does: "3", or
   * "3.2" for the second slide of a stack. Title and table-of-contents
   * slides an engine adds are not counted.
   */
  index: string;
  /** Heading level in the source (1 for a top-level heading). */
  level: number;
  title: string;
  /** Words of speaker notes on this slide. */
  notesWords: number;
  /** Local image references, as written in the source. */
  images: string[];
}

/** What the source says about itself before any rendering. */
export interface Outline {
  title: string | null;
  theme: string | null;
  slides: OutlineSlide[];
}

function words(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

function isLocalRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref) || /^file:/i.test(ref);
}

function stripFileScheme(ref: string): string {
  return ref.replace(/^file:(\/\/)?/i, "");
}

/**
 * Number slides the way reveal.js does: each top-level slide starts a stack
 * and is "h"; the slides below it are "h.2", "h.3", and so on.
 */
function indexSlides(
  raw: Array<Omit<OutlineSlide, "index">>,
): OutlineSlide[] {
  let h = 0;
  let v = 1;
  return raw.map((s) => {
    if (s.level <= 1 || h === 0) {
      h += 1;
      v = 1;
      return { ...s, index: String(h) };
    }
    v += 1;
    return { ...s, index: `${h}.${v}` };
  });
}

interface OrgOptions {
  headlineLevels: number;
}

function orgOptions(text: string): OrgOptions {
  let headlineLevels = 3;
  for (const m of text.matchAll(/^#\+OPTIONS:(.*)$/gim)) {
    const h = m[1].match(/(?:^|\s)H:(\d+)/);
    if (h) headlineLevels = Number(h[1]);
  }
  return { headlineLevels };
}

function orgKeyword(text: string, key: string): string | null {
  const re = new RegExp(`^#\\+${key}:[ \\t]*(.*)$`, "im");
  const m = text.match(re);
  const v = m?.[1].trim() ?? "";
  return v === "" ? null : v;
}

function orgImages(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]]+?)\](?:\[[^\]]*\])?\]/g)) {
    const ref = m[1].trim();
    if (isLocalRef(ref) && IMAGE_EXT.test(ref)) out.push(stripFileScheme(ref));
  }
  return out;
}

/**
 * Outline an Org deck the way org-re-reveal exports it: headings down to the
 * `H:` export level (Org's default is 3) become slides, level 1 horizontally
 * and deeper levels as a vertical stack. COMMENT headings, `:noexport:`
 * subtrees and everything beneath them are skipped.
 */
export function outlineOrg(text: string): Outline {
  const { headlineLevels } = orgOptions(text);
  const lines = text.split("\n");
  const raw: Array<Omit<OutlineSlide, "index">> = [];
  let current: Omit<OutlineSlide, "index"> | null = null;
  let body: string[] = [];
  let skipBelow: number | null = null;
  let notes: string[] | null = null;

  const flush = () => {
    if (current) {
      current.images = orgImages(body.join("\n"));
      raw.push(current);
    }
    body = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(\*+)\s+(.*?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (skipBelow !== null && level > skipBelow) continue;
      skipBelow = null;
      if (level > headlineLevels) {
        body.push(line);
        continue;
      }
      flush();
      let title = heading[2];
      const tags = title.match(/\s+(:[\w@#%:]+:)$/);
      if (tags) title = title.slice(0, title.length - tags[0].length);
      const excluded = /^COMMENT\b/.test(title) ||
        (tags !== null && /:noexport:/.test(tags[1]));
      if (excluded) {
        current = null;
        skipBelow = level;
        continue;
      }
      title = title.replace(/^(TODO|DONE|NEXT)\s+/, "")
        .replace(/^\[#[A-Z]\]\s+/, "");
      current = { level, title, notesWords: 0, images: [] };
      continue;
    }
    if (skipBelow !== null) continue;
    if (/^\s*#\+BEGIN_NOTES\b/i.test(line)) {
      notes = [];
      continue;
    }
    if (/^\s*#\+END_NOTES\b/i.test(line)) {
      if (current && notes) current.notesWords += words(notes.join(" "));
      notes = null;
      continue;
    }
    if (notes) {
      notes.push(line);
      continue;
    }
    body.push(line);
  }
  flush();

  return {
    title: orgKeyword(text, "TITLE"),
    theme: orgKeyword(text, "REVEAL_THEME"),
    slides: indexSlides(raw),
  };
}

/** Split YAML front matter from a Markdown document. */
export function splitFrontMatter(
  text: string,
): { meta: Record<string, string>; body: string } {
  const m = text.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
  );
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(m[0].length) };
}

function markdownImages(body: string): string[] {
  const out: string[] = [];
  for (
    const m of body.matchAll(
      /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    )
  ) {
    if (isLocalRef(m[1])) out.push(stripFileScheme(m[1]));
  }
  for (
    const m of body.matchAll(/<img\b[^>]*\ssrc=(?:"([^"]*)"|'([^']*)')/gi)
  ) {
    const ref = m[1] ?? m[2];
    if (ref !== "" && isLocalRef(ref)) out.push(stripFileScheme(ref));
  }
  return out;
}

/** Remove fenced code blocks so headings and notes inside them are ignored. */
function withoutFences(body: string): string {
  return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
}

/**
 * Outline a Markdown deck as pandoc renders it with `--slide-level=2`:
 * level-1 and level-2 headings (ATX or setext) start slides, a horizontal
 * rule starts an untitled slide at the current level, and `::: notes` divs
 * hold speaker notes.
 */
export function outlineMarkdownPandoc(text: string): Outline {
  const { meta, body } = splitFrontMatter(text);
  const raw: Array<Omit<OutlineSlide, "index">> = [];
  let current: Omit<OutlineSlide, "index"> | null = null;
  let chunk: string[] = [];
  let inNotes = false;
  let notes: string[] = [];

  const flush = () => {
    if (current) {
      current.images = markdownImages(chunk.join("\n"));
      raw.push(current);
    }
    chunk = [];
  };

  let prev = "";
  for (const line of withoutFences(body).split("\n")) {
    const before = prev;
    prev = line;
    const h = line.match(/^(#{1,2})\s+(.*?)\s*#*\s*$/);
    if (h && !inNotes) {
      flush();
      current = { level: h[1].length, title: h[2], notesWords: 0, images: [] };
      continue;
    }
    const rule = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
      .test(line);
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (
      !inNotes && underline && before.trim() !== "" &&
      !/^\s*[-*+]\s/.test(before)
    ) {
      // Setext heading: the text line above belongs to the heading, not
      // to the slide before it.
      chunk.pop();
      flush();
      current = {
        level: underline[1].startsWith("=") ? 1 : 2,
        title: before.trim(),
        notesWords: 0,
        images: [],
      };
      continue;
    }
    if (!inNotes && rule && before.trim() === "") {
      const level: number = current?.level ?? 1;
      flush();
      current = { level, title: "", notesWords: 0, images: [] };
      continue;
    }
    if (/^:::+\s*\{?\s*\.?notes\s*\}?\s*$/.test(line)) {
      inNotes = true;
      notes = [];
      continue;
    }
    if (inNotes && /^:::+\s*$/.test(line)) {
      if (current) current.notesWords += words(notes.join(" "));
      inNotes = false;
      continue;
    }
    if (inNotes) {
      notes.push(line);
      continue;
    }
    chunk.push(line);
  }
  flush();

  return {
    title: meta.title ?? null,
    theme: meta.theme ?? null,
    slides: indexSlides(raw),
  };
}

/** Separators reveal.js's markdown plugin is configured with. */
export const REVEAL_MD_SEPARATOR = "^\\r?\\n---\\r?\\n$";
export const REVEAL_MD_VERTICAL = "^\\r?\\n--\\r?\\n$";
export const REVEAL_MD_NOTES = "^Note:";

/**
 * Outline a Markdown deck as reveal.js's markdown plugin splits it: a line of
 * `---` between blank lines starts a new slide, `--` a vertical one, and
 * everything after a line starting `Note:` is speaker notes.
 */
export function outlineMarkdownReveal(text: string): Outline {
  const { meta, body } = splitFrontMatter(text);
  const raw: Array<Omit<OutlineSlide, "index">> = [];
  // The same expressions the generated page hands the plugin, so the outline
  // splits exactly where reveal.js will.
  const horizontal = new RegExp(REVEAL_MD_SEPARATOR, "m");
  const vertical = new RegExp(REVEAL_MD_VERTICAL, "m");
  const notesAt = new RegExp(REVEAL_MD_NOTES, "mi");
  for (const hChunk of body.split(horizontal)) {
    hChunk.split(vertical).forEach((vChunk, vi) => {
      const at = vChunk.search(notesAt);
      const content = at < 0 ? vChunk : vChunk.slice(0, at);
      const notes = at < 0 ? "" : vChunk.slice(at).replace(notesAt, "");
      const heading = withoutFences(content).match(/^#{1,6}\s+(.*?)\s*#*\s*$/m);
      raw.push({
        level: vi === 0 ? 1 : 2,
        title: heading?.[1] ?? "",
        notesWords: words(notes),
        images: markdownImages(content),
      });
    });
  }
  return {
    title: meta.title ?? raw.find((s) => s.title !== "")?.title ?? null,
    theme: meta.theme ?? null,
    slides: indexSlides(raw),
  };
}

/** Outline a source for the engine that will render it. */
export function outlineFor(engine: Engine, text: string): Outline {
  switch (engine) {
    case "org-re-reveal":
      return outlineOrg(text);
    case "pandoc":
      return outlineMarkdownPandoc(text);
    case "reveal-markdown":
      return outlineMarkdownReveal(text);
  }
}
