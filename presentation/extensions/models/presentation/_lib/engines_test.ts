// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { withMockedCommand } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import {
  adaptPandocTemplate,
  BUILD_EL,
  inlineMarkdownImages,
  MAX_ENGINE_OUTPUT_BYTES,
  readEngineOutput,
  renderOrg,
  renderPandoc,
  renderRevealMarkdown,
  warningLines,
} from "./engines.ts";
import { REVEAL_CDN } from "./pins.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("BUILD_EL runs nothing a deck names and leaks no identity", () => {
  for (
    const want of [
      "org-export-use-babel nil",
      "org-export-allow-bind-keywords nil",
      "enable-local-variables nil",
      'user-full-name ""',
      'user-mail-address ""',
      "org-export-time-stamp-file nil",
      '(random "webframp-presentation")',
      'org-re-reveal-revealjs-version "6"',
      "org-element-cache-persistent nil",
      "Refusing to evaluate macro",
      "Refusing to call",
      "Refusing to read",
      "(advice-add 'insert-file-contents :around guard)",
      "(advice-add 'insert-file-contents-literally :around guard)",
      "load-with-code-conversion",
    ]
  ) {
    assertStringIncludes(BUILD_EL, want);
  }
  // Elisp string escapes survive the template literal: the macro guard
  // matches "\\`" (start of string) and the path guard ".git" or ".swamp".
  assertStringIncludes(BUILD_EL, '"\\\\`[ \\t\\n]*(eval\\\\>"');
  assertStringIncludes(
    BUILD_EL,
    '"/\\\\.\\\\(git\\\\|swamp\\\\)\\\\(/\\\\|\\\\\'\\\\)"',
  );
});

Deno.test("renderOrg runs batch Emacs with every setting as an argument", async () => {
  await withDir(async (dir) => {
    const output = `${dir}/deck.html`;
    const { result, calls } = await withMockedCommand(
      async (_cmd, args) => {
        await Deno.writeTextFile(args[args.length - 1], "<html>deck</html>");
        return {
          code: 0,
          stdout: "",
          stderr: "Loading org...\nWarning (org-element): something odd\n",
        };
      },
      () =>
        renderOrg({
          emacs: "/opt/emacs",
          buildEl: "/tmp/w/build.el",
          lispDir: "/cache/elisp",
          source: "/talks/t.org",
          theme: "moon",
          allowedDir: "/talks",
          output,
          timeoutMs: 10_000,
        }),
    );
    assertEquals(result.html, "<html>deck</html>");
    assertEquals(result.warnings, ["Warning (org-element): something odd"]);
    assertEquals(calls[0].command, "/opt/emacs");
    assertEquals(calls[0].args, [
      "--batch",
      "-Q",
      "-l",
      "/tmp/w/build.el",
      "/cache/elisp",
      "/talks/t.org",
      REVEAL_CDN,
      "moon",
      "/talks",
      output,
    ]);
  });
});

Deno.test("renderOrg reports Emacs's error output on failure", async () => {
  await withMockedCommand(
    () => ({
      code: 255,
      stdout: "",
      stderr: "Refusing to evaluate macro pw: a deck may not run Lisp",
    }),
    async () => {
      await assertRejects(
        () =>
          renderOrg({
            emacs: "emacs",
            buildEl: "b.el",
            lispDir: "l",
            source: "/s.org",
            theme: "black",
            allowedDir: "/",
            output: "/nonexistent/out.html",
            timeoutMs: 10_000,
          }),
        Error,
        "Refusing to evaluate macro pw",
      );
    },
  );
});

Deno.test("readEngineOutput refuses a missing or oversized deck", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => readEngineOutput(`${dir}/none.html`),
      Error,
      "wrote no deck",
    );
    const big = `${dir}/big.html`;
    const f = await Deno.open(big, { create: true, write: true });
    await f.truncate(MAX_ENGINE_OUTPUT_BYTES + 1);
    f.close();
    await assertRejects(() => readEngineOutput(big), Error, "over the");
  });
});

Deno.test("warningLines keeps only warnings", () => {
  assertEquals(
    warningLines("[INFO] x\n[WARNING] Could not fetch a.png\n\n", "pandoc"),
    ["[WARNING] Could not fetch a.png"],
  );
  assertEquals(
    warningLines("Loading foo\nWarning (emacs): bar\n", "org"),
    ["Warning (emacs): bar"],
  );
});

const PANDOC_TEMPLATE =
  `<link rel="stylesheet" href="$revealjs-url$/dist/reveal.css">
<script src="$revealjs-url$/dist/reveal.js"></script>
<script src="$revealjs-url$/plugin/notes/notes.js"></script>
<script src="$revealjs-url$/plugin/zoom/zoom.js"></script>
$if(mathjax)$<script src="$revealjs-url$/plugin/math/math.js"></script>$endif$`;

Deno.test("adaptPandocTemplate moves plugin paths to reveal.js 6's layout", () => {
  const out = adaptPandocTemplate(PANDOC_TEMPLATE);
  assertStringIncludes(out, "$revealjs-url$/dist/plugin/notes.js");
  assertStringIncludes(out, "$revealjs-url$/dist/plugin/zoom.js");
  assertStringIncludes(out, "$revealjs-url$/dist/plugin/math.js");
  assertEquals(out.includes("/plugin/notes/notes.js"), false);
  assertEquals(adaptPandocTemplate(out), out);
});

Deno.test("renderPandoc sandboxes pandoc and keeps the document's theme in charge", async () => {
  await withDir(async (dir) => {
    let template = "";
    let defaults = "";
    const { result, calls } = await withMockedCommand(
      async (_cmd, args) => {
        if (args[0] === "--version") {
          return { code: 0, stdout: "pandoc 3.7.0.2\nFeatures: +server" };
        }
        if (args[0] === "-D") return { code: 0, stdout: PANDOC_TEMPLATE };
        const opt = (p: string) =>
          args.find((a) => a.startsWith(p))!.slice(p.length);
        template = await Deno.readTextFile(opt("--template="));
        defaults = await Deno.readTextFile(opt("--metadata-file="));
        await Deno.writeTextFile(opt("--output="), "<html>pandoc deck</html>");
        return {
          code: 0,
          stdout: "",
          stderr: "[WARNING] Duplicate identifier 'intro'\n",
        };
      },
      () =>
        renderPandoc({
          pandoc: "pandoc",
          source: "/talks/t.md",
          theme: "white",
          workDir: dir,
          timeoutMs: 10_000,
        }),
    );
    assertEquals(result.html, "<html>pandoc deck</html>");
    assertEquals(result.version, "3.7.0.2");
    assertEquals(result.warnings, ["[WARNING] Duplicate identifier 'intro'"]);
    const args = calls[2].args;
    for (
      const want of [
        "--sandbox",
        "--standalone",
        "revealjs",
        "--slide-level=2",
        `revealjs-url=${REVEAL_CDN}`,
      ]
    ) {
      assertEquals(args.includes(want), true, `missing ${want}`);
    }
    assertEquals(args[args.length - 1], "/talks/t.md");
    assertStringIncludes(template, "/dist/plugin/notes.js");
    assertEquals(defaults, 'theme: "white"\n');
  });
});

Deno.test("renderRevealMarkdown keeps the source exactly as written", () => {
  const html = renderRevealMarkdown({
    markdown: "# One `&lt;b&gt;` & co\n\n</textarea><script>alert(1)</script>",
    title: 'A "deck" & <more>',
    theme: "moon",
  });
  assertStringIncludes(
    html,
    "<title>A &quot;deck&quot; &amp; &lt;more&gt;</title>",
  );
  assertStringIncludes(html, `${REVEAL_CDN}/dist/theme/moon.css`);
  // Entities stay entities once the browser decodes the textarea.
  assertStringIncludes(html, "`&amp;lt;b&amp;gt;` &amp; co");
  assertStringIncludes(html, "&lt;/textarea>&lt;script>alert(1)&lt;/script>");
  assertEquals(html.match(/<\/textarea>/g)?.length, 1);
  assertThrows(
    () => renderRevealMarkdown({ markdown: "", title: "t", theme: "nope" }),
    Error,
    "dist/theme/nope.css",
  );
});

Deno.test("inlineMarkdownImages handles every way Markdown points at a file", async () => {
  const md = [
    "![a](img/a.png)",
    "![b](https://x/b.png)",
    "![r][logo]",
    "[logo]: img/logo.png",
    "[doc]: notes.pdf",
    '<img src="img/raw.png" alt="x">',
    "<img src='img/single.png'>",
    '<!-- .slide: data-background="img/bg.jpg" -->',
    '<div style="background: url(img/css.png)"></div>',
    "![gone](img/gone.png)",
  ].join("\n");
  const inlined = new Set(
    [
      "img/a.png",
      "img/logo.png",
      "img/raw.png",
      "img/single.png",
      "img/bg.jpg",
      "img/css.png",
    ],
  );
  const { markdown, problems } = await inlineMarkdownImages(
    md,
    (ref) =>
      Promise.resolve(
        inlined.has(ref)
          ? { uri: `data:x;${ref}` }
          : { problem: `${ref}: file not found` },
      ),
    (ref) => !ref.startsWith("http") && !ref.endsWith(".pdf"),
  );
  for (const ref of inlined) {
    assertStringIncludes(markdown, `data:x;${ref}`);
  }
  assertStringIncludes(markdown, "![b](https://x/b.png)");
  assertStringIncludes(markdown, "[doc]: notes.pdf");
  assertEquals(problems, ["img/gone.png: file not found"]);
});
