// SPDX-License-Identifier: Apache-2.0

/**
 * The three rendering engines. Each returns HTML that loads reveal.js from the
 * pinned CDN; inlining for self-contained decks happens afterwards, the same
 * way for all of them.
 *
 * External tools are run with `Deno.Command(...).output()`, every setting
 * passes as an argument, never through the environment, and each run is
 * bounded by a timeout. Engines write the deck to a file, which is read only
 * after its size is checked.
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

/** Largest deck an engine may produce, before local files are inlined. */
export const MAX_ENGINE_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Batch export through org-re-reveal. Arguments, in order: the directory
 * holding the pinned Emacs Lisp, the source file, the reveal.js root URL, the
 * default theme, the one directory the deck may read files from, and the
 * file to write the HTML to.
 *
 * A deck is untrusted input, so the export runs nothing it names:
 * - Babel, `#+BIND` and file-local variables are off.
 * - A `#+MACRO` whose template is `(eval ...)`, in the file or in any
 *   `#+SETUPFILE`, stops the export. Org's own macros still work.
 * - A `#+REVEAL_PREAMBLE`, `_POSTAMBLE` or `_POSTSCRIPT` that names a
 *   function stops the export; org-re-reveal would call it.
 * - Every file the deck makes Emacs read (`#+INCLUDE`, `#+SETUPFILE`, ...)
 *   must lie inside the allowed directory and outside `.git` and `.swamp`.
 *   Loading Emacs Lisp is not affected.
 *
 * Output is byte-for-byte reproducible: no export timestamp, and Org's random
 * heading IDs come from a fixed seed. Batch Emacs fills `user-full-name` from
 * the login and host, so a deck without `#+AUTHOR` gets no author.
 */
export const BUILD_EL =
  `;;; build.el --- org-re-reveal batch export  -*- lexical-binding: t; -*-
(defvar webframp-presentation--loading-lisp nil
  "Non-nil while Emacs reads Lisp source to load it.")
(let* ((args command-line-args-left)
       (lisp-dir (nth 0 args))
       (source (nth 1 args))
       (root (nth 2 args))
       (theme (nth 3 args))
       (allowed (file-name-as-directory (file-truename (nth 4 args))))
       (output (nth 5 args)))
  (setq command-line-args-left nil)
  (add-to-list 'load-path lisp-dir)
  ;; A one-shot export needs no cache between runs, and org-persist would
  ;; read its index from a temporary directory outside the deck.
  (setq org-element-cache-persistent nil
        org-persist-autoload nil)
  (require 'org)
  (require 'ox)
  (require 'org-macro)
  (require 'org-re-reveal)
  (setq org-export-use-babel nil
        org-confirm-babel-evaluate t
        org-export-allow-bind-keywords nil
        enable-local-variables nil
        org-export-time-stamp-file nil
        org-re-reveal-root root
        org-re-reveal-revealjs-version "6"
        org-re-reveal-single-file nil
        org-re-reveal-embed-local-resources nil
        org-re-reveal-theme theme
        user-full-name ""
        user-mail-address "")
  ;; Deck-defined macros come first; Org's four built-ins (author, email,
  ;; title, date) are the last entries and are left alone.
  (advice-add 'org-macro--collect-macros :filter-return
              (lambda (templates)
                (dolist (entry (butlast templates 4) templates)
                  (when (and (stringp (cdr entry))
                             (string-match-p "\\\\\`[ \\t\\n]*(eval\\\\>" (cdr entry)))
                    (error "Refusing to evaluate macro %s: a deck may not run Lisp"
                           (car entry))))))
  (advice-add 'org-re-reveal--build-pre-postamble :around
              (lambda (orig type info spec)
                (let ((section (plist-get info (intern (format ":reveal-%s" type)))))
                  (when (and (stringp section) (functionp (intern section)))
                    (error "Refusing to call %s named by #+REVEAL_%s"
                           section (upcase (format "%s" type))))
                  (funcall orig type info spec))))
  ;; Loading Lisp reads its source through load-with-code-conversion; this
  ;; script itself runs inside load, so load-in-progress cannot tell them
  ;; apart.
  (advice-add 'load-with-code-conversion :around
              (lambda (orig &rest load-args)
                (let ((webframp-presentation--loading-lisp t))
                  (apply orig load-args))))
  (let ((guard
         (lambda (orig file &rest rest)
           (unless webframp-presentation--loading-lisp
             (let ((true (file-truename (expand-file-name file))))
               (unless (and (file-in-directory-p true allowed)
                            (not (string-match-p "/\\\\.\\\\(git\\\\|swamp\\\\)\\\\(/\\\\|\\\\'\\\\)"
                                                 (concat "/" (substring true (length allowed))))))
                 (error "Refusing to read %s: outside %s" file allowed))))
           (apply orig file rest))))
    (advice-add 'insert-file-contents :around guard)
    (advice-add 'insert-file-contents-literally :around guard))
  (with-current-buffer (find-file-noselect source)
    (unless (cadr (assoc "AUTHOR" (org-collect-keywords '("AUTHOR"))))
      (setq-local org-export-with-author nil))
    (random "webframp-presentation")
    (let ((html (with-current-buffer (org-export-to-buffer 're-reveal " *deck*")
                  (buffer-string)))
          (coding-system-for-write 'utf-8-unix))
      (with-temp-file output (insert html)))))
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
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<ToolRun> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `${cmd} is not installed or not on PATH. Install it, or set the global argument that names it.`,
      );
    }
    throw e;
  }
  if (timeout.aborted) {
    throw new Error(
      `${cmd} did not finish within ${opts.timeoutMs / 1000} s and was stopped`,
    );
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

/** Read an engine's output file, refusing one that is missing or too large. */
export async function readEngineOutput(path: string): Promise<string> {
  let size: number;
  try {
    size = (await Deno.stat(path)).size;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error("the engine wrote no deck");
    }
    throw e;
  }
  if (size > MAX_ENGINE_OUTPUT_BYTES) {
    throw new Error(
      `the engine wrote ${size} bytes, over the ${MAX_ENGINE_OUTPUT_BYTES}-byte limit`,
    );
  }
  return await Deno.readTextFile(path);
}

/** Lines of a tool's error output worth recording as warnings. */
export function warningLines(
  stderr: string,
  engine: "org" | "pandoc",
): string[] {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return engine === "pandoc"
    ? lines.filter((l) => l.startsWith("[WARNING]"))
    : lines.filter((l) => /\bwarning\b/i.test(l));
}

/** Render an Org file with org-re-reveal. */
export async function renderOrg(opts: {
  emacs: string;
  buildEl: string;
  lispDir: string;
  source: string;
  theme: string;
  allowedDir: string;
  output: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ html: string; warnings: string[] }> {
  const r = await run(opts.emacs, [
    "--batch",
    "-Q",
    "-l",
    opts.buildEl,
    opts.lispDir,
    opts.source,
    REVEAL_CDN,
    opts.theme,
    opts.allowedDir,
    opts.output,
  ], { signal: opts.signal, timeoutMs: opts.timeoutMs });
  if (r.code !== 0) {
    throw new Error(`org-re-reveal export failed:\n${tail(r.stderr)}`);
  }
  return {
    html: await readEngineOutput(opts.output),
    warnings: warningLines(r.stderr, "org"),
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

/**
 * Render a Markdown file with pandoc. `--sandbox` limits pandoc to reading
 * the files named on its command line.
 */
export async function renderPandoc(opts: {
  pandoc: string;
  source: string;
  theme: string;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ html: string; warnings: string[]; version: string | null }> {
  const limits = { signal: opts.signal, timeoutMs: opts.timeoutMs };
  const ver = await run(opts.pandoc, ["--version"], limits);
  const version = ver.code === 0
    ? new TextDecoder().decode(ver.stdout).match(/^pandoc\S*\s+([\d.]+)/m)
      ?.[1] ?? null
    : null;

  const tpl = await run(opts.pandoc, ["-D", "revealjs"], limits);
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
  const output = `${opts.workDir}/deck.html`;

  const r = await run(opts.pandoc, [
    "--sandbox",
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
    `--output=${output}`,
    // Callers pass an absolute path, so it can never read as an option.
    opts.source,
  ], limits);
  if (r.code !== 0) {
    throw new Error(`pandoc failed:\n${tail(r.stderr)}`);
  }
  return {
    html: await readEngineOutput(output),
    warnings: warningLines(r.stderr, "pandoc"),
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
  // A textarea's content is decoded as text, so escaping & and < keeps the
  // Markdown exactly as written, entities included, and stops it from
  // ending the textarea early.
  const source = opts.markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;");
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

/**
 * Where Markdown for reveal.js's markdown plugin can point at a local file:
 * image links, reference definitions, `<img src>` and other resource
 * attributes in raw HTML, slide or element attribute comments, and CSS
 * `url()` in raw HTML styles.
 */
const MARKDOWN_REFS: readonly RegExp[] = [
  /(!\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g,
  /^( {0,3}\[[^\]]+\]:[ \t]*<?)([^\s>]+)(>?)/gm,
  /(\s(?:src|data-src|poster|data-background|data-background-image|data-background-video)=")([^"]*)(")/gi,
  /(\s(?:src|data-src|poster|data-background|data-background-image|data-background-video)=')([^']*)(')/gi,
  /(url\(\s*["']?)([^"')\s]+)(["']?\s*\))/gi,
];

/**
 * Inline the local files Markdown refers to as data URIs. `inline` resolves
 * a reference or explains why it cannot; `isMedia` says whether a reference
 * names a local media file worth inlining (a reference definition may point
 * at a page instead).
 */
export async function inlineMarkdownImages(
  markdown: string,
  inline: (ref: string) => Promise<{ uri: string } | { problem: string }>,
  isMedia: (ref: string) => boolean,
): Promise<{ markdown: string; problems: string[] }> {
  const problems: string[] = [];
  let text = markdown;
  for (const re of MARKDOWN_REFS) {
    const parts: string[] = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      parts.push(text.slice(last, m.index));
      if (isMedia(m[2])) {
        const r = await inline(m[2]);
        if ("uri" in r) parts.push(`${m[1]}${r.uri}${m[3]}`);
        else {
          problems.push(r.problem);
          parts.push(m[0]);
        }
      } else parts.push(m[0]);
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    text = parts.join("");
  }
  return { markdown: text, problems };
}

/** The body of a Markdown deck and its front-matter title and theme. */
export function markdownParts(
  text: string,
): { body: string; title: string | null; theme: string | null } {
  const { meta, body } = splitFrontMatter(text);
  return { body, title: meta.title ?? null, theme: meta.theme ?? null };
}
