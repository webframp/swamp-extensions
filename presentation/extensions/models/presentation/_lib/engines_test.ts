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
  DECK_BEGIN,
  DECK_END,
  extractDeck,
  inlineMarkdownImages,
  renderOrg,
  renderPandoc,
  renderRevealMarkdown,
} from "./engines.ts";
import { REVEAL_CDN } from "./pins.ts";

Deno.test("BUILD_EL never runs code and never leaks the machine's identity", () => {
  assertStringIncludes(BUILD_EL, "org-export-use-babel nil");
  assertStringIncludes(BUILD_EL, "enable-local-variables nil");
  assertStringIncludes(BUILD_EL, 'user-full-name ""');
  assertStringIncludes(BUILD_EL, 'user-mail-address ""');
  assertStringIncludes(BUILD_EL, "org-export-time-stamp-file nil");
  assertStringIncludes(BUILD_EL, '(random "webframp-presentation")');
  assertStringIncludes(BUILD_EL, 'org-re-reveal-revealjs-version "6"');
  assertStringIncludes(BUILD_EL, `(princ "${DECK_BEGIN}\\n")`);
});

Deno.test("extractDeck takes the HTML between the markers only", () => {
  const out = `noise\n${DECK_BEGIN}\n<html>x</html>\n${DECK_END}\n`;
  assertEquals(extractDeck(out), "<html>x</html>");
  assertThrows(() => extractDeck("<html>no markers</html>"), Error, "markers");
});

Deno.test("renderOrg runs batch Emacs with every setting as an argument", async () => {
  const { result, calls } = await withMockedCommand(
    () => ({
      code: 0,
      stdout: `${DECK_BEGIN}\n<html>deck</html>\n${DECK_END}\n`,
      stderr: "Loading org...",
    }),
    () =>
      renderOrg({
        emacs: "/opt/emacs",
        buildEl: "/tmp/w/build.el",
        lispDir: "/cache/elisp",
        source: "/talks/t.org",
        theme: "moon",
      }),
  );
  assertEquals(result.html, "<html>deck</html>");
  assertEquals(calls.length, 1);
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
  ]);
});

Deno.test("renderOrg reports Emacs's error output on failure", async () => {
  await withMockedCommand(
    () => ({
      code: 255,
      stdout: "",
      stderr: "Symbol’s function definition is void: org-re-reveal",
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
          }),
        Error,
        "is void: org-re-reveal",
      );
    },
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
  assertEquals(
    adaptPandocTemplate(out),
    out,
    "already-adapted input is unchanged",
  );
});

Deno.test("renderPandoc adapts pandoc's own template and keeps the document's theme in charge", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let template = "";
    let defaults = "";
    const { result, calls } = await withMockedCommand(
      async (_cmd, args) => {
        if (args[0] === "--version") {
          return { code: 0, stdout: "pandoc 3.7.0.2\nFeatures: +server" };
        }
        if (args[0] === "-D") return { code: 0, stdout: PANDOC_TEMPLATE };
        template = await Deno.readTextFile(
          args.find((a) => a.startsWith("--template="))!.slice(11),
        );
        defaults = await Deno.readTextFile(
          args.find((a) => a.startsWith("--metadata-file="))!.slice(16),
        );
        return { code: 0, stdout: "<html>pandoc deck</html>" };
      },
      () =>
        renderPandoc({
          pandoc: "pandoc",
          source: "/talks/t.md",
          theme: "white",
          workDir: dir,
        }),
    );
    assertEquals(result.html, "<html>pandoc deck</html>");
    assertEquals(result.version, "3.7.0.2");
    assertEquals(calls.length, 3);
    const args = calls[2].args;
    for (
      const want of [
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderRevealMarkdown builds a page reveal.js renders in the browser", () => {
  const html = renderRevealMarkdown({
    markdown: "# One <b>\n\n</textarea><script>alert(1)</script>",
    title: 'A "deck" & <more>',
    theme: "moon",
  });
  assertStringIncludes(
    html,
    "<title>A &quot;deck&quot; &amp; &lt;more&gt;</title>",
  );
  assertStringIncludes(html, `${REVEAL_CDN}/dist/theme/moon.css`);
  assertStringIncludes(html, `${REVEAL_CDN}/dist/plugin/markdown.js`);
  assertStringIncludes(html, "&lt;/textarea><script>alert(1)</script>");
  assertEquals(
    html.match(/<\/textarea>/g)?.length,
    1,
    "source cannot close the textarea",
  );
  assertThrows(
    () => renderRevealMarkdown({ markdown: "", title: "t", theme: "nope" }),
    Error,
    "dist/theme/nope.css",
  );
});

Deno.test("inlineMarkdownImages rewrites local images and reports failures", async () => {
  const { markdown, problems } = await inlineMarkdownImages(
    '![a](img/a.png) ![b](https://x/b.png) ![c](<img/c.png> "title")',
    (ref) =>
      Promise.resolve(
        ref === "img/a.png"
          ? { uri: "data:image/png;base64,AA" }
          : { problem: `${ref}: file not found` },
      ),
    (ref) => !ref.startsWith("http"),
  );
  assertEquals(
    markdown,
    '![a](data:image/png;base64,AA) ![b](https://x/b.png) ![c](<img/c.png> "title")',
  );
  assertEquals(problems, ["img/c.png: file not found"]);
});
