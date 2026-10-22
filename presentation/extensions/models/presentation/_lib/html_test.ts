// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  addIntegrity,
  createInliner,
  externalResources,
  inlineLocalFiles,
  inlineReveal,
  isLocalMedia,
  isLocalPath,
  markupOnly,
  pinnedPath,
  renderedSlides,
  segments,
  themeOf,
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

Deno.test("inlineLocalFiles inlines media, styles and stylesheets, never script bodies", async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/img`);
    await Deno.writeFile(`${dir}/img/a.png`, PNG);
    await Deno.writeFile(`${dir}/img/it's.png`, PNG);
    await Deno.writeTextFile(
      `${dir}/extra.css`,
      "h1{background:url('img/a.png')}",
    );
    const html = [
      '<img src="img/a.png">',
      `<img src="img/it's.png">`,
      "<img src=img/a.png>",
      '<section data-background-image="img/a.png" data-background="#ff0000">',
      '<div style="background: url(img/a.png)"></div>',
      '<img data-src="img/missing.png">',
      '<img src="https://example.com/r.png">',
      '<link rel="stylesheet" href="extra.css">',
      '<script>const t = `<img src="img/a.png">`;</script>',
    ].join("\n");
    const inliner = await createInliner(dir);
    const { html: out, problems } = await inlineLocalFiles(html, dir, inliner);
    assertEquals(
      out.match(/src="data:image\/png;base64,/g)?.length,
      3,
      "the three markup images, whatever their quoting",
    );
    assertStringIncludes(out, 'data-background-image="data:image/png;base64,');
    assertStringIncludes(out, 'data-background="#ff0000"');
    assertStringIncludes(out, 'style="background: url(&quot;data:image/png;');
    assertStringIncludes(out, '<img src="https://example.com/r.png">');
    assertStringIncludes(out, 'h1{background:url("data:image/png;base64,');
    assertStringIncludes(out, 'const t = `<img src="img/a.png">`;');
    assertEquals(problems, ["img/missing.png: file not found"]);
    assertEquals(externalResources(out), [
      "https://example.com/r.png",
      "img/missing.png",
    ]);
  });
});

Deno.test("inlining is confined to the deck's directory", async () => {
  await withDir(async (outer) => {
    const dir = `${outer}/deck`;
    await Deno.mkdir(`${dir}/.git`, { recursive: true });
    await Deno.mkdir(`${dir}/.swamp`);
    await Deno.writeFile(`${outer}/secret.png`, PNG);
    await Deno.writeTextFile(`${outer}/secret.css`, "x{}");
    await Deno.writeFile(`${dir}/.git/leak.png`, PNG);
    await Deno.writeFile(`${dir}/.swamp/leak.png`, PNG);
    await Deno.symlink(`${outer}/secret.png`, `${dir}/link.png`);
    await Deno.writeTextFile(`${dir}/notes.txt`, "not css");
    await Deno.writeTextFile(`${dir}/hostname.css`, "y{}");
    const html = [
      '<img src="../secret.png">',
      `<img src="${outer}/secret.png">`,
      `<img src="file://${outer}/secret.png">`,
      '<img src="link.png">',
      '<img src=".git/leak.png">',
      '<img src=".swamp/leak.png">',
      '<link rel="stylesheet" href="../secret.css">',
      '<link rel="stylesheet" href="notes.txt">',
      '<link rel="stylesheet" href="/etc/hostname">',
    ].join("\n");
    const { html: out, problems } = await inlineLocalFiles(
      html,
      dir,
      await createInliner(dir),
    );
    assertEquals(out.includes("data:"), false, "nothing was inlined");
    assertEquals(out.includes("x{}"), false);
    assertEquals(problems.length, 9);
    for (const p of problems.slice(0, 7)) {
      assert(/outside .*\.git or \.swamp; not inlined$/.test(p), p);
    }
    assertEquals(problems[7], "notes.txt: not a .css file; not inlined");
    assertEquals(problems[8], "/etc/hostname: not a .css file; not inlined");
  });
});

Deno.test("inlining stops at the per-file and per-deck limits", async () => {
  await withDir(async (dir) => {
    for (const n of ["a", "b", "c"]) {
      await Deno.writeFile(`${dir}/${n}.png`, new Uint8Array(40));
    }
    await Deno.writeFile(`${dir}/big.png`, new Uint8Array(200));
    const inliner = await createInliner(dir, { perFile: 100, total: 100 });
    const { problems } = await inlineLocalFiles(
      '<img src="a.png"><img src="b.png"><img src="c.png"><img src="big.png">',
      dir,
      inliner,
    );
    assertEquals(problems, [
      "c.png: the deck would inline more than 100 bytes; not inlined",
      "big.png: 200 bytes is over the 100-byte limit; not inlined",
    ]);
  });
});

Deno.test("isLocalMedia accepts only local media types", () => {
  assert(isLocalMedia("img/a.PNG"));
  assert(isLocalMedia("clip.mp4?t=3"));
  assert(!isLocalMedia("notes.pdf"));
  assert(!isLocalMedia("https://x/a.png"));
  assert(!isLocalMedia("/etc/hostname"));
});

Deno.test("themeOf names a pinned theme and gives the href of any other", () => {
  assertEquals(
    themeOf(
      `<link rel="stylesheet" href="${REVEAL_CDN}/dist/theme/moon.css" id="theme"/>`,
      "black",
    ),
    "moon",
  );
  assertEquals(
    themeOf(
      '<link rel="stylesheet" href="https://evil.example/x.css" id="theme">',
      "black",
    ),
    "https://evil.example/x.css",
  );
  assertEquals(themeOf("<p>no theme</p>", "black"), "black");
});

Deno.test("addIntegrity pins CDN assets and reports unpinned CDN paths", () => {
  const html = [
    `<link rel="stylesheet" href="${REVEAL_CDN}/dist/reveal.css"/>`,
    `<script src="${REVEAL_CDN}/dist/reveal.js"></script>`,
    `<link rel="stylesheet" href="${REVEAL_CDN}/dist/theme/nope.css">`,
    '<script src="https://other.example/x.js"></script>',
  ].join("\n");
  const { html: out, problems } = addIntegrity(html);
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
  assertEquals(addIntegrity(out).html, out);
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
