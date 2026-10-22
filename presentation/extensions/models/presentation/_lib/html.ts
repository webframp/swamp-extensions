// SPDX-License-Identifier: Apache-2.0

/**
 * Post-processing for rendered decks, the same for every engine: local files
 * become data URIs, pinned reveal.js assets are inlined or given subresource
 * integrity, and whatever still loads from elsewhere is reported.
 *
 * Nothing here reads or rewrites the bodies of `<script>`, `<style>` or
 * `<textarea>` elements. Inlined reveal.js code is full of HTML-looking
 * strings, and the reveal-markdown engine keeps its source in a textarea.
 *
 * @module
 */

import { REVEAL_CDN, REVEAL_FILES } from "./pins.ts";

/** Largest local file inlined as a data URI. */
export const MAX_INLINE_BYTES = 32 * 1024 * 1024;

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
};

/** Attributes that load a resource. */
const RESOURCE_ATTRS = [
  "src",
  "data-src",
  "poster",
  "data-background",
  "data-background-image",
  "data-background-video",
];

/** A run of markup, or the untouchable body of a script/style/textarea. */
export interface Segment {
  markup: boolean;
  text: string;
}

/**
 * Split `html` into markup and opaque bodies, in order. Opening and closing
 * tags of script, style and textarea elements count as markup.
 */
export function segments(html: string): Segment[] {
  const out: Segment[] = [];
  const openRe = /<(script|style|textarea)\b[^>]*>/gi;
  let last = 0;
  for (let m = openRe.exec(html); m; m = openRe.exec(html)) {
    const bodyStart = m.index + m[0].length;
    const closeRe = new RegExp(`</${m[1]}\\s*>`, "gi");
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(html);
    const bodyEnd = close ? close.index : html.length;
    out.push({ markup: true, text: html.slice(last, bodyStart) });
    out.push({ markup: false, text: html.slice(bodyStart, bodyEnd) });
    last = bodyEnd;
    openRe.lastIndex = bodyEnd;
  }
  out.push({ markup: true, text: html.slice(last) });
  return out;
}

async function mapMarkup(
  html: string,
  fn: (markup: string) => Promise<string> | string,
): Promise<string> {
  const parts: string[] = [];
  for (const s of segments(html)) {
    parts.push(s.markup ? await fn(s.text) : s.text);
  }
  return parts.join("");
}

/** `html` with every opaque body emptied, for scanning markup only. */
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
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(
    /&amp;/g,
    "&",
  );
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

function mimeFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? null;
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** Read a local media file as a data URI, or say why it cannot be. */
export async function dataUri(
  ref: string,
  baseDir: string,
): Promise<{ uri: string } | { problem: string }> {
  const path = localPath(ref, baseDir);
  const mime = mimeFor(path);
  if (!mime) return { problem: `${ref}: unknown media type, left as a link` };
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return { problem: `${ref}: not a file` };
    if (info.size > MAX_INLINE_BYTES) {
      return {
        problem:
          `${ref}: ${info.size} bytes is over the ${MAX_INLINE_BYTES}-byte inline limit, left as a link`,
      };
    }
    return {
      uri: `data:${mime};base64,${toBase64(await Deno.readFile(path))}`,
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { problem: `${ref}: file not found` };
    }
    throw e;
  }
}

function isStylesheet(tag: string): boolean {
  return /\brel=(["']?)stylesheet\1/i.test(tag);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}=(["'])([^"']*)\\1`, "i"));
  return m ? decodeAttr(m[2]) : null;
}

/**
 * Replace local media references in resource attributes, and local
 * stylesheet links, with inline content resolved against `baseDir`. Returns
 * the new HTML and one problem per reference that could not be inlined.
 */
export async function inlineLocalFiles(
  html: string,
  baseDir: string,
): Promise<{ html: string; problems: string[] }> {
  const problems: string[] = [];
  const attrRe = new RegExp(
    `(\\s(?:${RESOURCE_ATTRS.join("|")})=)(["'])([^"']*)\\2`,
    "gi",
  );
  const out = await mapMarkup(html, async (markup) => {
    const media = await replaceAsync(markup, attrRe, async (m) => {
      const ref = decodeAttr(m[3]);
      if (!isLocalPath(ref) || !mimeFor(localPath(ref, baseDir))) return m[0];
      const r = await dataUri(ref, baseDir);
      if ("problem" in r) {
        problems.push(r.problem);
        return m[0];
      }
      return `${m[1]}${m[2]}${r.uri}${m[2]}`;
    });
    return await replaceAsync(media, /<link\b[^>]*>/gi, async (m) => {
      const href = attr(m[0], "href");
      if (!isStylesheet(m[0]) || href === null || !isLocalPath(href)) {
        return m[0];
      }
      try {
        const css = await Deno.readTextFile(localPath(href, baseDir));
        return `<style>\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          problems.push(`${href}: file not found`);
          return m[0];
        }
        throw e;
      }
    });
  });
  return { html: out, problems };
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
export async function addIntegrity(
  html: string,
): Promise<{ html: string; problems: string[] }> {
  const problems: string[] = [];
  const out = await mapMarkup(
    html,
    (markup) =>
      markup.replace(/<(script|link)\b[^>]*>/gi, (tag, name: string) => {
        const url = attr(tag, name.toLowerCase() === "script" ? "src" : "href");
        if (
          url === null || !isCdn(url) || /\sintegrity=/i.test(tag)
        ) return tag;
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
      }),
  );
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
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg.markup) {
      out.push(seg.text);
      continue;
    }
    // A segment that ends in <script src=…> is followed by its (empty) body
    // and the next segment starts with </script>.
    let text = seg.text;
    const scriptOpen = text.match(/<script\b[^>]*>$/i);
    const src = scriptOpen ? attr(scriptOpen[0], "src") : null;
    if (scriptOpen && src !== null && isCdn(src)) {
      const path = pinnedPath(src);
      const body = parts[i + 1];
      if (!path) {
        problems.push(`${src}: not a pinned reveal.js file, left as a link`);
      } else if (body && !body.markup && body.text.trim() === "") {
        const js = decoder.decode(await fetchFile(path));
        const kept = scriptOpen[0].replace(
          /\s(src|integrity|crossorigin)=(["'])[^"']*\2/gi,
          "",
        );
        text = text.slice(0, text.length - scriptOpen[0].length) + kept;
        parts[i + 1] = {
          markup: false,
          text: `\n${js.replace(/<\/script/gi, "<\\/script")}\n`,
        };
      }
    }
    out.push(
      await replaceAsync(text, /<link\b[^>]*>/gi, async (m) => {
        const href = attr(m[0], "href");
        if (!isStylesheet(m[0]) || href === null || !isCdn(href)) return m[0];
        const path = pinnedPath(href);
        if (!path) {
          problems.push(`${href}: not a pinned reveal.js file, left as a link`);
          return m[0];
        }
        const css = decoder.decode(await fetchFile(path));
        const id = attr(m[0], "id");
        return `<style${id ? ` id="${id}"` : ""}>\n${
          css.replace(/<\/style/gi, "<\\/style")
        }\n</style>`;
      }),
    );
  }
  return { html: out.join(""), problems };
}

/**
 * Every resource the page still loads from outside itself: remote URLs and
 * local paths in resource attributes, script sources and stylesheet links.
 * Links a viewer clicks (`<a href>`) are not resources and are not listed.
 */
export function externalResources(html: string): string[] {
  const found = new Set<string>();
  const markup = markupOnly(html);
  for (const tag of markup.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = tag[1].toLowerCase();
    if (name === "a") continue;
    for (const a of tag[0].matchAll(/\s([a-z-]+)=(["'])([^"']*)\2/gi)) {
      const key = a[1].toLowerCase();
      const value = decodeAttr(a[3]);
      const loads = RESOURCE_ATTRS.includes(key) ||
        (key === "href" && name === "link" &&
          /\brel=(["']?)(stylesheet|icon|preload)\1/i.test(tag[0]));
      if (!loads || value === "" || value.startsWith("data:")) continue;
      if (value.startsWith("#") || /^javascript:/i.test(value)) continue;
      // data-background also takes colours and gradients.
      if (key.startsWith("data-background") && !/[./]/.test(value)) continue;
      found.add(value);
    }
  }
  return [...found].sort();
}

/** One slide as rendered. */
export interface RenderedSlide {
  /** reveal.js numbering: "4" for a slide or a stack's first slide, "4.2" below it. */
  index: string;
  title: string;
  hasNotes: boolean;
}

function textOf(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
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
  const tokenRe = /<section\b[^>]*>|<\/section\s*>/gi;
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
        const v = open[0].children;
        // Record the child slide when it closes; remember its number now.
        open.push({ from: m.index + m[0].length, children: -v });
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
    if (open.length === 0 && start >= 0) {
      // Stop at the end of the slides container: the next top-level token
      // after it would not be a slide.
      const rest = markup.slice(m.index + m[0].length);
      const nextSection = rest.search(/<section\b/i);
      const divClose = rest.search(/<\/div\s*>/i);
      if (divClose >= 0 && (nextSection < 0 || divClose < nextSection)) break;
    }
  }
  return slides;
}
