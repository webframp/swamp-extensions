// SPDX-License-Identifier: Apache-2.0

/**
 * Post-processing for rendered decks, the same for every engine: local files
 * become data URIs, pinned reveal.js assets are inlined or given subresource
 * integrity, and whatever still loads from elsewhere is reported.
 *
 * A deck is untrusted input. Local files are inlined only from inside one
 * allowed directory (the source's own), never from `.git` or `.swamp`, only
 * as media or `.css`, and within per-file and total size limits.
 *
 * Nothing here rewrites the bodies of `<script>`, `<style>` or `<textarea>`
 * elements, or comments. Inlined reveal.js code is full of HTML-looking
 * strings, and the reveal-markdown engine keeps its source in a textarea.
 * Tags are scanned quote-aware, so a `>` inside an attribute value does not
 * end a tag.
 *
 * @module
 */

import { REVEAL_CDN, REVEAL_FILES } from "./pins.ts";

/** Largest local file inlined. */
export const MAX_INLINE_BYTES = 32 * 1024 * 1024;

/** Largest total of local files inlined into one deck. */
export const MAX_TOTAL_INLINE_BYTES = 128 * 1024 * 1024;

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** Attributes that load a resource, on any element. */
const RESOURCE_ATTRS: ReadonlySet<string> = new Set([
  "src",
  "data-src",
  "srcset",
  "data-srcset",
  "poster",
  "data",
  "background",
  "xlink:href",
  "data-background",
  "data-background-image",
  "data-background-video",
]);

/** Attributes whose value is a `srcset` list rather than one URL. */
const SRCSET_ATTRS: ReadonlySet<string> = new Set(["srcset", "data-srcset"]);

/** SVG elements whose plain `href` loads a resource. */
const SVG_HREF_ELEMENTS: ReadonlySet<string> = new Set([
  "image",
  "use",
  "feimage",
  "script",
]);

/** `<link rel>` values that make the browser fetch the href. */
const FETCHING_RELS =
  /\b(stylesheet|icon|preload|modulepreload|prefetch|manifest|apple-touch-icon)\b/i;

/**
 * The inside of a tag, quote-aware: a `>` inside a quoted attribute value
 * does not end the tag.
 */
const TAG_BODY = String.raw`(?:"[^"]*"|'[^']*'|[^'">])*`;

/** A regex matching opening tags of `names` (an alternation). */
function tagRe(names: string, flags = "gi"): RegExp {
  return new RegExp(`<(${names})\\b${TAG_BODY}>`, flags);
}

/** Any opening tag; group 1 is the element name. */
const ANY_TAG = () => tagRe("[a-z][a-z0-9:-]*");

/**
 * One attribute: name, then a double-quoted, single-quoted or unquoted
 * value. Each quote style is matched on its own, so an apostrophe inside a
 * double-quoted value (`src="it's.png"`) is part of the value.
 */
const ATTR =
  /(\s)([A-Za-z_:][-A-Za-z0-9_:.]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** A CSS `url(...)`, quoted or not. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]+))\s*\)/gi;

/** A run of markup, or the untouchable body of a script/style/textarea or a comment. */
export interface Segment {
  markup: boolean;
  text: string;
  /** For a body: the element it belongs to, lowercased, or `comment`. */
  element?: string;
}

/**
 * Split `html` into markup and opaque bodies, in order. Opening and closing
 * tags of script, style and textarea elements count as markup; a comment is
 * opaque as a whole.
 */
export function segments(html: string): Segment[] {
  const out: Segment[] = [];
  const openRe = new RegExp(
    `<!--|<(script|style|textarea)\\b${TAG_BODY}>`,
    "gi",
  );
  let last = 0;
  for (let m = openRe.exec(html); m; m = openRe.exec(html)) {
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", m.index + 4);
      const stop = end < 0 ? html.length : end + 3;
      out.push({ markup: true, text: html.slice(last, m.index) });
      out.push({
        markup: false,
        text: html.slice(m.index, stop),
        element: "comment",
      });
      last = stop;
      openRe.lastIndex = stop;
      continue;
    }
    const bodyStart = m.index + m[0].length;
    const closeRe = new RegExp(`</${m[1]}\\s*>`, "gi");
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(html);
    const bodyEnd = close ? close.index : html.length;
    out.push({ markup: true, text: html.slice(last, bodyStart) });
    out.push({
      markup: false,
      text: html.slice(bodyStart, bodyEnd),
      element: m[1].toLowerCase(),
    });
    last = bodyEnd;
    openRe.lastIndex = bodyEnd;
  }
  out.push({ markup: true, text: html.slice(last) });
  return out;
}

/** `html` with every opaque body and comment removed, for scanning markup only. */
export function markupOnly(html: string): string {
  return segments(html).filter((s) => s.markup).map((s) => s.text).join("");
}

async function replaceAsync(
  text: string,
  re: RegExp,
  fn: (m: RegExpMatchArray) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), await fn(m));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

function decodeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(
    /&amp;/g,
    "&",
  );
}

interface Attr {
  name: string;
  value: string;
}

/** Every attribute of one tag. */
function attrsOf(tag: string): Attr[] {
  return [...tag.matchAll(ATTR)].map((m) => ({
    name: m[2].toLowerCase(),
    value: decodeAttr(m[4] ?? m[5] ?? m[6] ?? ""),
  }));
}

function attr(tag: string, name: string): string | null {
  return attrsOf(tag).find((a) => a.name === name)?.value ?? null;
}

/** Replace attribute values in `tag`; `fn` returns a new value or null. */
async function mapAttrs(
  tag: string,
  fn: (a: Attr) => Promise<string | null>,
): Promise<string> {
  return await replaceAsync(tag, ATTR, async (m) => {
    const replaced = await fn({
      name: m[2].toLowerCase(),
      value: decodeAttr(m[4] ?? m[5] ?? m[6] ?? ""),
    });
    return replaced === null
      ? m[0]
      : `${m[1]}${m[2]}${m[3]}"${replaced.replace(/"/g, "&quot;")}"`;
  });
}

/** Remove the named attributes from `tag`. */
function dropAttrs(tag: string, names: readonly string[]): string {
  return tag.replace(
    ATTR,
    (whole, _sp, name: string) =>
      names.includes(name.toLowerCase()) ? "" : whole,
  );
}

/** Whether attribute `name` on element `element` loads a resource. */
function loadsResource(element: string, name: string, tag: string): boolean {
  if (RESOURCE_ATTRS.has(name)) return true;
  if (name !== "href") return false;
  return SVG_HREF_ELEMENTS.has(element) || element === "base" ||
    (element === "link" && FETCHING_RELS.test(attr(tag, "rel") ?? ""));
}

/** The URLs one resource attribute value names. */
function urlsOf(name: string, value: string): string[] {
  if (!SRCSET_ATTRS.has(name)) return [value];
  return value.split(/,(?=\s*\S)/).map((c) => c.trim().split(/\s+/)[0])
    .filter((u) => u !== "");
}

/** True for a reference to a local file rather than a URL or a fragment. */
export function isLocalPath(ref: string): boolean {
  if (ref === "" || ref.startsWith("#") || ref.startsWith("//")) return false;
  if (/^file:/i.test(ref)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function localPath(ref: string, baseDir: string): string {
  let p = ref.replace(/^file:(\/\/)?/i, "").split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not valid percent-encoding: use the path as written.
  }
  return p.startsWith("/") ? p : `${baseDir}/${p}`;
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.includes(".")
    ? base.slice(base.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

/** True when `ref` names a local file of a media type that can be inlined. */
export function isLocalMedia(ref: string): boolean {
  return isLocalPath(ref) && Object.hasOwn(MIME, extOf(ref.split(/[?#]/)[0]));
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** Result of resolving one local reference. */
export type Inlined = { uri: string } | { problem: string };

/** Where a local reference is, or why it may not be read. */
export type Located = { path: string; size: number } | { problem: string };

/**
 * Reads local files for inlining, confined to one directory and a total
 * byte budget shared by everything inlined into one deck.
 */
export interface Inliner {
  /** The real path of the allowed directory. */
  readonly root: string;
  /** Where `ref` is, if it may be read: inside the root, a file, small enough. */
  locate(ref: string, baseDir: string): Promise<Located>;
  /** A media file as a data URI. */
  dataUri(ref: string, baseDir: string): Promise<Inlined>;
  /** A stylesheet's text, with its own `url()` references inlined. */
  stylesheet(
    ref: string,
    baseDir: string,
  ): Promise<{ css: string; problems: string[] } | { problem: string }>;
}

/**
 * Create an inliner that reads only from inside `allowedDir`. `limits`
 * defaults to `MAX_INLINE_BYTES` per file and `MAX_TOTAL_INLINE_BYTES` in
 * all. Problems name references as written, never absolute paths, since
 * they are stored in records others may read.
 */
export async function createInliner(
  allowedDir: string,
  limits: { perFile: number; total: number } = {
    perFile: MAX_INLINE_BYTES,
    total: MAX_TOTAL_INLINE_BYTES,
  },
): Promise<Inliner> {
  const root = await Deno.realPath(allowedDir);
  let used = 0;

  async function locate(ref: string, baseDir: string): Promise<Located> {
    let real: string;
    try {
      real = await Deno.realPath(localPath(ref, baseDir));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return { problem: `${ref}: file not found` };
      }
      throw e;
    }
    const inside = real === root || real.startsWith(`${root}/`);
    if (!inside || /\/\.(git|swamp)(\/|$)/i.test(real.slice(root.length))) {
      return {
        problem:
          `${ref}: outside the deck's directory, or inside .git or .swamp; not inlined`,
      };
    }
    const info = await Deno.stat(real);
    if (!info.isFile) return { problem: `${ref}: not a file` };
    if (info.size > limits.perFile) {
      return {
        problem:
          `${ref}: ${info.size} bytes is over the ${limits.perFile}-byte limit; not inlined`,
      };
    }
    if (used + info.size > limits.total) {
      return {
        problem:
          `${ref}: the deck would inline more than ${limits.total} bytes; not inlined`,
      };
    }
    return { path: real, size: info.size };
  }

  async function dataUri(ref: string, baseDir: string): Promise<Inlined> {
    const mime = MIME[extOf(localPath(ref, baseDir))];
    if (!mime) return { problem: `${ref}: not a media file; not inlined` };
    const r = await locate(ref, baseDir);
    if ("problem" in r) return r;
    used += r.size;
    return {
      uri: `data:${mime};base64,${toBase64(await Deno.readFile(r.path))}`,
    };
  }

  async function stylesheet(ref: string, baseDir: string) {
    if (extOf(localPath(ref, baseDir)) !== "css") {
      return { problem: `${ref}: not a .css file; not inlined` };
    }
    const r = await locate(ref, baseDir);
    if ("problem" in r) return r;
    used += r.size;
    const css = await Deno.readTextFile(r.path);
    const cssDir = r.path.slice(0, r.path.lastIndexOf("/"));
    return await inlineCssUrls(css, cssDir, self);
  }

  const self: Inliner = { root, locate, dataUri, stylesheet };
  return self;
}

/** Inline the local `url()` references in `css`, resolved against `dir`. */
export async function inlineCssUrls(
  css: string,
  dir: string,
  inliner: Inliner,
): Promise<{ css: string; problems: string[] }> {
  const problems: string[] = [];
  const out = await replaceAsync(css, CSS_URL, async (m) => {
    const ref = m[1] ?? m[2] ?? m[3] ?? "";
    if (!isLocalPath(ref)) return m[0];
    const r = await inliner.dataUri(ref, dir);
    if ("problem" in r) {
      problems.push(r.problem);
      return m[0];
    }
    return `url("${r.uri}")`;
  });
  return { css: out, problems };
}

function isStylesheet(tag: string): boolean {
  return (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes(
    "stylesheet",
  );
}

/**
 * Replace local references in resource attributes (`srcset` candidates
 * included), `style` attributes and stylesheet links with inline content
 * resolved against `baseDir`. Returns the new HTML and one problem per
 * reference that could not be inlined.
 */
export async function inlineLocalFiles(
  html: string,
  baseDir: string,
  inliner: Inliner,
): Promise<{ html: string; problems: string[] }> {
  const problems: string[] = [];
  const inlineOne = async (ref: string): Promise<string | null> => {
    if (!isLocalMedia(ref)) return null;
    const r = await inliner.dataUri(ref, baseDir);
    if ("problem" in r) {
      problems.push(r.problem);
      return null;
    }
    return r.uri;
  };
  const parts: string[] = [];
  for (const seg of segments(html)) {
    if (!seg.markup) {
      parts.push(seg.text);
      continue;
    }
    parts.push(
      await replaceAsync(seg.text, ANY_TAG(), async (m) => {
        const tag = m[0];
        const element = m[1].toLowerCase();
        if (element === "link" && isStylesheet(tag)) {
          const href = attr(tag, "href");
          if (href === null || !isLocalPath(href)) return tag;
          const r = await inliner.stylesheet(href, baseDir);
          if ("problem" in r) {
            problems.push(r.problem);
            return tag;
          }
          problems.push(...r.problems);
          return `<style>\n${
            r.css.replace(/<\/style/gi, "<\\/style")
          }\n</style>`;
        }
        return await mapAttrs(tag, async (a) => {
          if (a.name === "style") {
            const r = await inlineCssUrls(a.value, baseDir, inliner);
            problems.push(...r.problems);
            return r.css === a.value ? null : r.css;
          }
          if (!loadsResource(element, a.name, tag)) return null;
          if (SRCSET_ATTRS.has(a.name)) {
            let changed = false;
            const out: string[] = [];
            for (const candidate of a.value.split(/,(?=\s*\S)/)) {
              const [url, ...descriptor] = candidate.trim().split(/\s+/);
              const uri = url ? await inlineOne(url) : null;
              if (uri) changed = true;
              out.push([uri ?? url, ...descriptor].join(" "));
            }
            return changed ? out.join(", ") : null;
          }
          return await inlineOne(a.value);
        });
      }),
    );
  }
  return { html: parts.join(""), problems };
}

/** The pinned `dist/` path a URL refers to, or null for any other URL. */
export function pinnedPath(url: string): string | null {
  const prefix = `${REVEAL_CDN}/`;
  if (!url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length).split(/[?#]/)[0];
  return Object.hasOwn(REVEAL_FILES, path) ? path : null;
}

function isCdn(url: string): boolean {
  return url.startsWith(`${REVEAL_CDN}/`);
}

/**
 * Add `integrity` and `crossorigin` to every script and stylesheet loaded from
 * the pinned CDN, so a browser refuses altered files. Returns the CDN URLs it
 * could not pin.
 */
export function addIntegrity(
  html: string,
): { html: string; problems: string[] } {
  const problems: string[] = [];
  const out = segments(html).map((seg) =>
    !seg.markup ? seg.text : seg.text.replace(
      tagRe("script|link"),
      (tag, name: string) => {
        const url = attr(tag, name.toLowerCase() === "script" ? "src" : "href");
        if (url === null || !isCdn(url) || attr(tag, "integrity") !== null) {
          return tag;
        }
        const path = pinnedPath(url);
        if (!path) {
          problems.push(`${url}: not a pinned reveal.js file`);
          return tag;
        }
        const extra = ` integrity="sha256-${
          REVEAL_FILES[path]
        }" crossorigin="anonymous"`;
        return tag.endsWith("/>")
          ? `${tag.slice(0, -2).trimEnd()}${extra}/>`
          : `${tag.slice(0, -1)}${extra}>`;
      },
    )
  ).join("");
  return { html: out, problems };
}

/**
 * Inline every pinned reveal.js script and stylesheet the page loads, using
 * `fetchFile` for verified bytes. Unpinned CDN paths are left as links and
 * reported.
 */
export async function inlineReveal(
  html: string,
  fetchFile: (path: string) => Promise<Uint8Array>,
): Promise<{ html: string; problems: string[] }> {
  const problems: string[] = [];
  const decoder = new TextDecoder();
  const parts = segments(html);
  const scriptAtEnd = new RegExp(`<script\\b${TAG_BODY}>$`, "i");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg.markup) {
      out.push(seg.text);
      continue;
    }
    // A segment that ends in <script src=…> is followed by its (empty) body.
    let text = seg.text;
    const scriptOpen = text.match(scriptAtEnd);
    const src = scriptOpen ? attr(scriptOpen[0], "src") : null;
    if (scriptOpen && src !== null && isCdn(src)) {
      const path = pinnedPath(src);
      const body = parts[i + 1];
      if (!path) {
        problems.push(`${src}: not a pinned reveal.js file, left as a link`);
      } else if (body && !body.markup && body.text.trim() === "") {
        const js = decoder.decode(await fetchFile(path));
        text = text.slice(0, text.length - scriptOpen[0].length) +
          dropAttrs(scriptOpen[0], ["src", "integrity", "crossorigin"]);
        parts[i + 1] = {
          markup: false,
          text: `\n${js.replace(/<\/script/gi, "<\\/script")}\n`,
          element: "script",
        };
      }
    }
    out.push(
      await replaceAsync(text, tagRe("link"), async (m) => {
        const href = attr(m[0], "href");
        if (!isStylesheet(m[0]) || href === null || !isCdn(href)) return m[0];
        const path = pinnedPath(href);
        if (!path) {
          problems.push(`${href}: not a pinned reveal.js file, left as a link`);
          return m[0];
        }
        const css = decoder.decode(await fetchFile(path));
        const id = attr(m[0], "id");
        return `<style${id ? ` id="${id.replace(/"/g, "&quot;")}"` : ""}>\n${
          css.replace(/<\/style/gi, "<\\/style")
        }\n</style>`;
      }),
    );
  }
  return { html: out.join(""), problems };
}

/**
 * Every resource the page still loads from outside itself: remote URLs and
 * local paths in resource attributes (`srcset` candidates, SVG `href`,
 * `<base href>` included), script sources, fetching `<link>`s, `style`
 * attributes and `<style>` blocks. Links a viewer clicks (`<a href>`) and
 * anything inside comments are not resources and are not listed.
 */
export function externalResources(html: string): string[] {
  const found = new Set<string>();
  const add = (v: string) => {
    if (v === "" || v.startsWith("data:") || v.startsWith("#")) return;
    if (/^javascript:/i.test(v)) return;
    found.add(v);
  };
  const addCss = (css: string) => {
    for (const m of css.matchAll(CSS_URL)) add(m[1] ?? m[2] ?? m[3] ?? "");
    for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
      add(m[1] ?? m[2]);
    }
  };
  for (const seg of segments(html)) {
    if (!seg.markup) {
      // Stylesheets may still point elsewhere. Scripts are code, comments
      // load nothing, and the reveal-markdown source is checked when its
      // images are inlined.
      if (seg.element === "style") addCss(seg.text);
      continue;
    }
    for (const tag of seg.text.matchAll(ANY_TAG())) {
      const element = tag[1].toLowerCase();
      if (element === "a") continue;
      for (const a of attrsOf(tag[0])) {
        if (a.name === "style") {
          addCss(a.value);
          continue;
        }
        if (!loadsResource(element, a.name, tag[0])) continue;
        // data-background also takes colours and gradients.
        if (a.name.startsWith("data-background") && !/[./]/.test(a.value)) {
          continue;
        }
        for (const u of urlsOf(a.name, a.value)) add(u);
      }
    }
  }
  return [...found].sort();
}

/**
 * The theme a rendered deck loads, from its `<link id="theme">`: the theme's
 * name when it is a pinned reveal.js theme, otherwise the stylesheet's href,
 * so the record never names a theme the deck does not use.
 */
export function themeOf(html: string, fallback: string): string {
  for (const m of markupOnly(html).matchAll(tagRe("link"))) {
    const href = attr(m[0], "href");
    const isTheme = attr(m[0], "id") === "theme" ||
      (href !== null && /\/dist\/theme\/[^/]+\.css$/.test(href));
    if (!isTheme || href === null) continue;
    const path = pinnedPath(href);
    return path?.startsWith("dist/theme/")
      ? path.slice("dist/theme/".length, -".css".length)
      : href;
  }
  return fallback;
}

/** One slide as rendered. */
export interface RenderedSlide {
  /** reveal.js numbering: "4" for a slide or a stack's first slide, "4.2" below it. */
  index: string;
  title: string;
  hasNotes: boolean;
}

/** Plain text of an HTML fragment, without Org's headline tags. */
export function textOf(s: string): string {
  return s
    // Org renders headline tags as <span class="tag"><span …>x</span></span>.
    .replace(
      /<span\b[^>]*class="tag"[^>]*>(?:<span\b[^>]*>[^<]*<\/span>|[^<])*<\/span>/gi,
      "",
    )
    .replace(/<[^>]*>/g, "")
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, h: string) => String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;?/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&rsquo;|&apos;/g, "'").replace(
      /&amp;/g,
      "&",
    )
    .replace(/[\s ]+/g, " ").trim();
}

function describe(inner: string): { title: string; hasNotes: boolean } {
  const heading = inner.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
  return {
    title: heading ? textOf(heading[1]) : "",
    hasNotes: /<aside\b[^>]*class=(["'])[^"']*\bnotes\b[^"']*\1/i.test(inner),
  };
}

/**
 * The slides of a rendered deck, as reveal.js sees them: a top-level
 * `<section>` with no child sections is a slide, and each child of a
 * top-level section is a slide in that stack. Sections nested deeper belong
 * to their parent slide.
 */
export function renderedSlides(html: string): RenderedSlide[] {
  const markup = markupOnly(html);
  const start = markup.search(
    /<div\b[^>]*\sclass=(["'])(?:[^"']*\s)?slides(?:\s[^"']*)?\1[^>]*>/i,
  );
  if (start < 0) return [];
  const slides: RenderedSlide[] = [];
  const tokenRe = new RegExp(`<section\\b${TAG_BODY}>|</section\\s*>`, "gi");
  tokenRe.lastIndex = start;
  interface Open {
    from: number;
    children: number;
  }
  const open: Open[] = [];
  let h = 0;
  for (let m = tokenRe.exec(markup); m; m = tokenRe.exec(markup)) {
    if (!m[0].startsWith("</")) {
      if (open.length === 0) h += 1;
      else if (open.length === 1) {
        open[0].children += 1;
        // Record the child slide when it closes; remember its number now.
        open.push({ from: m.index + m[0].length, children: -open[0].children });
        continue;
      }
      open.push({ from: m.index + m[0].length, children: 0 });
      continue;
    }
    const sec = open.pop();
    if (!sec) break;
    const inner = markup.slice(sec.from, m.index);
    if (open.length === 0 && sec.children === 0) {
      slides.push({ index: String(h), ...describe(inner) });
    } else if (open.length === 1 && sec.children < 0) {
      const v = -sec.children;
      slides.push({
        index: v === 1 ? String(h) : `${h}.${v}`,
        ...describe(inner),
      });
    }
    if (open.length === 0) {
      // Stop at the end of the slides container.
      const rest = markup.slice(m.index + m[0].length);
      const nextSection = rest.search(/<section\b/i);
      const divClose = rest.search(/<\/div\s*>/i);
      if (divClose >= 0 && (nextSection < 0 || divClose < nextSection)) break;
    }
  }
  return slides;
}
