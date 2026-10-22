// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  addIntegrity,
  externalResources,
  inlineLocalFiles,
  inlineReveal,
  isLocalPath,
  markupOnly,
  pinnedPath,
  renderedSlides,
  segments,
} from "./html.ts";
import { REVEAL_CDN, REVEAL_FILES } from "./pins.ts";

/** A 1x1 transparent PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("segments keeps script, style and textarea bodies opaque", () => {
  const html =
    '<p>a</p><script src="x.js"></script><script>var s="<img src=\'q.png\'>";</script><style>p{}</style><textarea>![](i.png)</textarea><p>b</p>';
  const segs = segments(html);
  assertEquals(segs.map((s) => s.text).join(""), html);
  assertEquals(
    segs.filter((s) => !s.markup).map((s) => s.text),
    ["", "var s=\"<img src='q.png'>\";", "p{}", "![](i.png)"],
  );
  assertEquals(
    markupOnly(html),
    '<p>a</p><script src="x.js"></script><script></script><style></style><textarea></textarea><p>b</p>',
  );
});

Deno.test("isLocalPath tells files from URLs and fragments", () => {
  assert(isLocalPath("img/a.png"));
  assert(isLocalPath("/abs/a.png"));
  assert(isLocalPath("file:///abs/a.png"));
  assert(!isLocalPath("https://x/a.png"));
  assert(!isLocalPath("//cdn/a.png"));
  assert(!isLocalPath("data:image/png;base64,AA"));
  assert(!isLocalPath("#top"));
});

Deno.test("inlineLocalFiles inlines media and local stylesheets, never script bodies", async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/img`);
    await Deno.writeFile(`${dir}/img/a.png`, PNG);
    await Deno.writeTextFile(`${dir}/extra.css`, "h1{color:red}");
    const html = [
      '<img src="img/a.png">',
      '<section data-background-image="img/a.png" data-background="#ff0000">',
      '<img data-src="img/missing.png">',
      '<img src="https://example.com/r.png">',
      '<link rel="stylesheet" href="extra.css">',
      '<script>const t = `<img src="img/a.png">`;</script>',
    ].join("\n");
    const { html: out, problems } = await inlineLocalFiles(html, dir);
    assertEquals(
      out.match(/src="data:image\/png;base64,/g)?.length,
      1,
      "only the markup img is rewritten",
    );
    assertStringIncludes(out, 'data-background-image="data:image/png;base64,');
    assertStringIncludes(out, 'data-background="#ff0000"');
    assertStringIncludes(out, '<img src="https://example.com/r.png">');
    assertStringIncludes(out, "<style>\nh1{color:red}\n</style>");
    assertStringIncludes(out, 'const t = `<img src="img/a.png">`;');
    assertEquals(problems, ["img/missing.png: file not found"]);
  });
});

Deno.test("addIntegrity pins CDN assets and reports unpinned CDN paths", async () => {
  const html = [
    `<link rel="stylesheet" href="${REVEAL_CDN}/dist/reveal.css"/>`,
    `<script src="${REVEAL_CDN}/dist/reveal.js"></script>`,
    `<link rel="stylesheet" href="${REVEAL_CDN}/dist/theme/nope.css">`,
    '<script src="https://other.example/x.js"></script>',
  ].join("\n");
  const { html: out, problems } = await addIntegrity(html);
  assertStringIncludes(
    out,
    `href="${REVEAL_CDN}/dist/reveal.css" integrity="sha256-${
      REVEAL_FILES["dist/reveal.css"]
    }" crossorigin="anonymous"/>`,
  );
  assertStringIncludes(
    out,
    `src="${REVEAL_CDN}/dist/reveal.js" integrity="sha256-${
      REVEAL_FILES["dist/reveal.js"]
    }" crossorigin="anonymous">`,
  );
  assertStringIncludes(out, '<script src="https://other.example/x.js">');
  assertEquals(problems, [
    `${REVEAL_CDN}/dist/theme/nope.css: not a pinned reveal.js file`,
  ]);
  // Idempotent: a second pass adds nothing.
  assertEquals((await addIntegrity(out)).html, out);
});

Deno.test("inlineReveal inlines pinned assets and escapes closing tags", async () => {
  const html = [
    `<link rel="stylesheet" href="${REVEAL_CDN}/dist/theme/black.css" id="theme"/>`,
    `<script src="${REVEAL_CDN}/dist/reveal.js" integrity="sha256-x" crossorigin="anonymous"></script>`,
    `<script src="${REVEAL_CDN}/dist/missing.js"></script>`,
    "<script>Reveal.initialize({});</script>",
  ].join("\n");
  const fetched: string[] = [];
  const { html: out, problems } = await inlineReveal(html, (path) => {
    fetched.push(path);
    return Promise.resolve(
      new TextEncoder().encode(
        path.endsWith(".css") ? "body{}</style>" : 'var tpl = "</script><p>";',
      ),
    );
  });
  assertEquals(fetched, ["dist/reveal.js", "dist/theme/black.css"]);
  assertStringIncludes(out, '<style id="theme">\nbody{}<\\/style>\n</style>');
  assertStringIncludes(out, '<script>\nvar tpl = "<\\/script><p>";\n</script>');
  assertStringIncludes(out, `<script src="${REVEAL_CDN}/dist/missing.js">`);
  assertStringIncludes(out, "<script>Reveal.initialize({});</script>");
  assertEquals(problems, [
    `${REVEAL_CDN}/dist/missing.js: not a pinned reveal.js file, left as a link`,
  ]);
  assertEquals(externalResources(out), [`${REVEAL_CDN}/dist/missing.js`]);
});

Deno.test("pinnedPath accepts only pinned files under the pinned CDN", () => {
  assertEquals(pinnedPath(`${REVEAL_CDN}/dist/reveal.js`), "dist/reveal.js");
  assertEquals(
    pinnedPath(`${REVEAL_CDN}/dist/reveal.js?v=1`),
    "dist/reveal.js",
  );
  assertEquals(pinnedPath(`${REVEAL_CDN}/dist/reveal.mjs`), null);
  assertEquals(
    pinnedPath("https://cdn.jsdelivr.net/npm/reveal.js@5.0.0/dist/reveal.js"),
    null,
  );
});

Deno.test("externalResources lists what still loads, not links or inline data", () => {
  const html = [
    '<a href="https://example.com/page">link</a>',
    '<img src="data:image/png;base64,AA">',
    '<img src="img/local.png">',
    '<section data-background="#000"><section data-background="bg.jpg">',
    '<link rel="stylesheet" href="https://fonts.example/x.css">',
    '<link rel="canonical" href="https://example.com/">',
    "<script>var x = \"<img src='https://in.script/x.png'>\";</script>",
  ].join("\n");
  assertEquals(externalResources(html), [
    "bg.jpg",
    "https://fonts.example/x.css",
    "img/local.png",
  ]);
});

Deno.test("renderedSlides counts slides the way reveal.js does", () => {
  // The shape org-re-reveal and pandoc both produce: a title slide, a lone
  // slide, and a stack whose children are siblings in one wrapper.
  const html = `<div class="reveal"><div class="slides">
<section id="title"><h1 class="title">Deck &amp; co</h1></section>
<section><section id="a"><h2>Intro</h2><aside class="notes">n</aside></section></section>
<section>
  <section id="b"><h2>Stack</h2></section>
  <section id="c"><h3>Child</h3>
    <section><h4>Nested content, not a slide</h4></section>
  </section>
</section>
</div></div>
<script>var s = "<section><h2>in script</h2></section>";</script>`;
  assertEquals(renderedSlides(html), [
    { index: "1", title: "Deck & co", hasNotes: false },
    { index: "2", title: "Intro", hasNotes: true },
    { index: "3", title: "Stack", hasNotes: false },
    { index: "3.2", title: "Child", hasNotes: false },
  ]);
  assertEquals(renderedSlides("<p>no slides</p>"), []);
});
