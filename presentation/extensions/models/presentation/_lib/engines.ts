// SPDX-License-Identifier: Apache-2.0

/**
 * The three rendering engines. Each returns HTML that loads reveal.js from the
 * pinned CDN; inlining for self-contained decks happens afterwards, the same
 * way for all of them.
 *
 * External tools are run with `Deno.Command(...).output()` and every setting
 * passes as an argument, never through the environment.
 *
 * @module
 */

import { REVEAL_CDN, REVEAL_FILES, REVEAL_VERSION } from "./pins.ts";
import {
  REVEAL_MD_NOTES,
  REVEAL_MD_SEPARATOR,
  REVEAL_MD_VERTICAL,
  splitFrontMatter,
} from "./source.ts";

/** Marks around the HTML the Emacs build script prints. */
export const DECK_BEGIN = "<<<WEBFRAMP-DECK-BEGIN>>>";
export const DECK_END = "<<<WEBFRAMP-DECK-END>>>";

/**
 * Batch export through org-re-reveal. Arguments, in order: the directory
 * holding the pinned Emacs Lisp, the source file, the reveal.js root URL and
 * the default theme.
 *
 * - Babel never runs: exporting a deck must not execute its code blocks.
 * - File-local variables are ignored for the same reason.
 * - Output is byte-for-byte reproducible: no export timestamp, and Org's
 *   random heading IDs come from a fixed seed.
 * - Batch Emacs fills `user-full-name` from the login and host; a deck
 *   without `#+AUTHOR` gets no author rather than the machine's name.
 */
export const BUILD_EL =
  `;;; build.el --- org-re-reveal batch export  -*- lexical-binding: t; -*-
(let* ((args command-line-args-left)
       (lisp-dir (nth 0 args))
       (source (nth 1 args))
       (root (nth 2 args))
       (theme (nth 3 args)))
  (setq command-line-args-left nil)
  (add-to-list 'load-path lisp-dir)
  (require 'org)
  (require 'ox)
  (require 'org-re-reveal)
  (setq org-export-use-babel nil
        org-confirm-babel-evaluate t
        enable-local-variables nil
        org-export-time-stamp-file nil
        org-re-reveal-root root
        org-re-reveal-revealjs-version "6"
        org-re-reveal-single-file nil
        org-re-reveal-embed-local-resources nil
        org-re-reveal-theme theme
        user-full-name ""
        user-mail-address "")
  (with-current-buffer (find-file-noselect source)
    (unless (cadr (assoc "AUTHOR" (org-collect-keywords '("AUTHOR"))))
      (setq-local org-export-with-author nil))
    (random "webframp-presentation")
    (let ((html (with-current-buffer (org-export-to-buffer 're-reveal " *deck*")
                  (buffer-string)))
          (coding-system-for-write 'utf-8))
      (princ "${DECK_BEGIN}\\n")
      (princ html)
      (princ "\\n${DECK_END}\\n"))))
`;

/** Result of running a tool. */
export interface ToolRun {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<ToolRun> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, {
      args,
      cwd: opts.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: opts.signal,
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `${cmd} is not installed or not on PATH. Install it, or set the global argument that names it.`,
      );
    }
    throw e;
  }
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
}

function tail(text: string, lines = 15): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Extract the HTML between the build script's markers. */
export function extractDeck(stdout: string): string {
  const begin = stdout.indexOf(`${DECK_BEGIN}\n`);
  const end = stdout.lastIndexOf(`\n${DECK_END}`);
  if (begin < 0 || end < begin) {
    throw new Error("org-re-reveal produced no deck (markers missing)");
  }
  return stdout.slice(begin + DECK_BEGIN.length + 1, end);
}

/** Render an Org file with org-re-reveal. */
export async function renderOrg(opts: {
  emacs: string;
  buildEl: string;
  lispDir: string;
  source: string;
  theme: string;
  signal?: AbortSignal;
}): Promise<{ html: string; log: string }> {
  const r = await run(opts.emacs, [
    "--batch",
    "-Q",
    "-l",
    opts.buildEl,
    opts.lispDir,
    opts.source,
    REVEAL_CDN,
    opts.theme,
  ], { signal: opts.signal });
  if (r.code !== 0) {
    throw new Error(`org-re-reveal export failed:\n${tail(r.stderr)}`);
  }
  return {
    html: extractDeck(new TextDecoder().decode(r.stdout)),
    log: tail(r.stderr),
  };
}

/**
 * Adapt pandoc's own reveal.js template to reveal.js 6, which moved plugins
 * from `plugin/<name>/<name>.js` to `dist/plugin/<name>.js`. A template that
 * already uses the new layout passes through unchanged.
 */
export function adaptPandocTemplate(template: string): string {
  return template.replace(
    /\$revealjs-url\$\/plugin\/([a-z]+)\/\1\.js/g,
    "$revealjs-url$/dist/plugin/$1.js",
  );
}

/** Render a Markdown file with pandoc. */
export async function renderPandoc(opts: {
  pandoc: string;
  source: string;
  theme: string;
  workDir: string;
  signal?: AbortSignal;
}): Promise<{ html: string; log: string; version: string | null }> {
  const ver = await run(opts.pandoc, ["--version"], { signal: opts.signal });
  const version = ver.code === 0
    ? new TextDecoder().decode(ver.stdout).match(/^pandoc\S*\s+([\d.]+)/m)
      ?.[1] ?? null
    : null;

  const tpl = await run(opts.pandoc, ["-D", "revealjs"], {
    signal: opts.signal,
  });
  if (tpl.code !== 0) {
    throw new Error(`pandoc -D revealjs failed:\n${tail(tpl.stderr)}`);
  }
  const template = `${opts.workDir}/revealjs.template`;
  await Deno.writeTextFile(
    template,
    adaptPandocTemplate(new TextDecoder().decode(tpl.stdout)),
  );
  // A default theme that the document's own `theme:` overrides.
  const defaults = `${opts.workDir}/defaults.yaml`;
  await Deno.writeTextFile(defaults, `theme: ${JSON.stringify(opts.theme)}\n`);

  const r = await run(opts.pandoc, [
    "--standalone",
    "--from",
    "markdown",
    "--to",
    "revealjs",
    "--slide-level=2",
    `--template=${template}`,
    `--metadata-file=${defaults}`,
    "--variable",
    `revealjs-url=${REVEAL_CDN}`,
    // Callers pass an absolute path, so it can never read as an option.
    opts.source,
  ], { signal: opts.signal });
  if (r.code !== 0) {
    throw new Error(`pandoc failed:\n${tail(r.stderr)}`);
  }
  return {
    html: new TextDecoder().decode(r.stdout),
    log: tail(r.stderr),
    version,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a page that renders Markdown in the browser with reveal.js's
 * markdown plugin. `markdown` is the document body without front matter;
 * its images should already be inlined.
 */
export function renderRevealMarkdown(opts: {
  markdown: string;
  title: string;
  theme: string;
}): string {
  const asset = (p: string) => {
    if (!Object.hasOwn(REVEAL_FILES, p)) {
      throw new Error(`reveal.js ${REVEAL_VERSION} has no ${p}`);
    }
    return `${REVEAL_CDN}/${p}`;
  };
  // A textarea ends at the first "</textarea"; keep the source from ending it.
  const source = opts.markdown.replace(/<\/textarea/gi, "&lt;/textarea");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${asset("dist/reset.css")}">
<link rel="stylesheet" href="${asset("dist/reveal.css")}">
<link rel="stylesheet" href="${
    asset(`dist/theme/${opts.theme}.css`)
  }" id="theme">
<link rel="stylesheet" href="${asset("dist/plugin/highlight/monokai.css")}">
</head>
<body>
<div class="reveal">
<div class="slides">
<section data-markdown data-separator="${
    escapeHtml(REVEAL_MD_SEPARATOR)
  }" data-separator-vertical="${
    escapeHtml(REVEAL_MD_VERTICAL)
  }" data-separator-notes="${escapeHtml(REVEAL_MD_NOTES)}">
<textarea data-template>
${source}
</textarea>
</section>
</div>
</div>
<script src="${asset("dist/reveal.js")}"></script>
<script src="${asset("dist/plugin/markdown.js")}"></script>
<script src="${asset("dist/plugin/highlight.js")}"></script>
<script src="${asset("dist/plugin/notes.js")}"></script>
<script>
Reveal.initialize({
  hash: true,
  plugins: [RevealMarkdown, RevealHighlight, RevealNotes]
});
</script>
</body>
</html>
`;
}

/** Inline local images in Markdown source as data URIs. */
export async function inlineMarkdownImages(
  markdown: string,
  inline: (ref: string) => Promise<{ uri: string } | { problem: string }>,
  isLocal: (ref: string) => boolean,
): Promise<{ markdown: string; problems: string[] }> {
  const problems: string[] = [];
  const re = /(!\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g;
  const parts: string[] = [];
  let last = 0;
  for (const m of markdown.matchAll(re)) {
    parts.push(markdown.slice(last, m.index));
    if (isLocal(m[2])) {
      const r = await inline(m[2]);
      if ("uri" in r) parts.push(`${m[1]}${r.uri}${m[3]}`);
      else {
        problems.push(r.problem);
        parts.push(m[0]);
      }
    } else parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(markdown.slice(last));
  return { markdown: parts.join(""), problems };
}

/** The body of a Markdown deck and its front-matter title and theme. */
export function markdownParts(
  text: string,
): { body: string; title: string | null; theme: string | null } {
  const { meta, body } = splitFrontMatter(text);
  return { body, title: meta.title ?? null, theme: meta.theme ?? null };
}
