// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import {
  type Deck,
  deckHtmlName,
  type DeckOutline,
  type DeckPdf,
  deckPdfName,
  deckResourceName,
  deps,
  model,
  outlineResourceName,
  pdfResourceName,
} from "./deck.ts";
import { sha256Hex } from "./_lib/cache.ts";
import { REVEAL_CDN, REVEAL_FILES } from "./_lib/pins.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** What org-re-reveal emits for a small deck, as the real export does. */
const ORG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="${REVEAL_CDN}/dist/reveal.css"/>
<link rel="stylesheet" href="${REVEAL_CDN}/dist/theme/moon.css" id="theme"/>
</head>
<body>
<div class="reveal">
<div class="slides">
<section id="sec-title-slide"><h1 class="title">Observe</h1></section>
<section>
<section id="slide-1">
<h2 id="1">Intro</h2>
<p>Hello</p>
<aside class="notes">
<p>Speaker notes.</p>
</aside>
</section>
</section>
<section>
<section id="slide-2">
<h2 id="2">Picture</h2>
<img src="img/a.png" alt="a.png" />
</section>
<section id="slide-2-1">
<h3 id="2-1">Below</h3>
</section>
</section>
</div>
</div>
<script src="${REVEAL_CDN}/dist/reveal.js"></script>
<script src="${REVEAL_CDN}/dist/plugin/notes.js"></script>
<script>
Reveal.initialize({ plugins: [RevealNotes] });
</script>
</body>
</html>`;

const ORG_SOURCE = `#+TITLE: Observe
#+REVEAL_THEME: moon
* Intro
Hello
#+BEGIN_NOTES
Speaker notes.
#+END_NOTES
* Picture
[[file:img/a.png]]
** Below
`;

async function withDeckDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/img`);
    await Deno.writeFile(`${dir}/img/a.png`, PNG);
    await Deno.writeTextFile(`${dir}/talk.org`, ORG_SOURCE);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Replace the network and browser dependencies for one test. */
async function withDeps<T>(
  overrides: Partial<typeof deps>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(deps, saved);
  }
}

const noElispDownload = { ensureElisp: () => Promise.resolve("/fake/elisp") };

/** A fake Emacs that writes `html` where the build script would. */
const emacsOutput =
  (html = ORG_HTML) => async (_cmd: string, args: string[]) => {
    await Deno.writeTextFile(args[args.length - 1], html);
    return { code: 0, stdout: "", stderr: "" };
  };

type BuildContext = Parameters<typeof model.methods.build.execute>[1];
type PdfContext = Parameters<typeof model.methods.export_pdf.execute>[1];

function context(dir: string, storedResources = {}) {
  const base = createModelTestContext({
    repoDir: dir,
    // Parsed by the model's schema, as swamp does, so defaults apply.
    globalArgs: model.globalArguments.parse({ cacheDir: `${dir}/cache` }),
    storedResources,
  });
  // The test context types globalArgs loosely; the values above match the
  // model's schema.
  return { ...base, context: base.context as unknown as BuildContext };
}

function buildArgs(over: Record<string, unknown>) {
  return model.methods.build.arguments.parse(over);
}

Deno.test("model declares its type, default report, specs and methods", () => {
  assertEquals(model.type, "@webframp/presentation/deck");
  assertEquals(model.reports, ["@webframp/presentation/deck-summary"]);
  assertEquals(Object.keys(model.resources).sort(), [
    "deck",
    "outline",
    "pdfInfo",
  ]);
  assertEquals(Object.keys(model.files).sort(), ["html", "pdf"]);
  assertEquals(Object.keys(model.methods).sort(), [
    "build",
    "export_pdf",
    "outline",
  ]);
  assertEquals(model.files.html.contentType, "text/html");
  assertEquals(model.files.pdf.contentType, "application/pdf");
});

Deno.test("data names never collide across specs or across decks", () => {
  const all = (n: string) => [
    deckResourceName(n),
    deckHtmlName(n),
    deckPdfName(n),
    outlineResourceName(n),
    pdfResourceName(n),
  ];
  // Deck names that a suffix scheme would confuse: "x-html"'s record would
  // be "x"'s HTML, and "x-pdf"'s record "x"'s PDF.
  const decks = [
    "x",
    "x-html",
    "x-pdf",
    "html-x",
    "pdf-x",
    "print-x",
    "deck-x",
  ];
  const names = decks.flatMap(all);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("build arguments need exactly one source, and content needs a name", () => {
  const args = model.methods.build.arguments;
  assert(args.safeParse({ source: "t.org" }).success);
  assert(args.safeParse({ content: "* x", name: "x", format: "org" }).success);
  assert(!args.safeParse({}).success);
  assert(
    !args.safeParse({ source: "t.org", content: "* x", name: "x" }).success,
  );
  assert(!args.safeParse({ content: "* x" }).success);
  assert(!args.safeParse({ source: "t.org", name: "Bad Name" }).success);
  assert(!model.globalArguments.safeParse({ theme: "nope" }).success);
});

Deno.test("build renders Org, inlines images, pins CDN assets and records slides", async () => {
  await withDeckDir(async (dir) => {
    const { context: ctx, getWrittenFiles, getWrittenResources } = context(dir);
    const { calls } = await withDeps(
      noElispDownload,
      () =>
        withMockedCommand(
          emacsOutput(),
          () =>
            model.methods.build.execute(buildArgs({ source: "talk.org" }), ctx),
        ),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].command, "emacs");
    assertEquals(calls[0].args.slice(4, 9), [
      "/fake/elisp",
      await Deno.realPath(`${dir}/talk.org`),
      REVEAL_CDN,
      "black",
      await Deno.realPath(dir),
    ]);
    assert(calls[0].args[9].endsWith("/deck.html"));

    const files = getWrittenFiles();
    assertEquals(files.map((f) => [f.specName, f.name]), [[
      "html",
      "html-talk",
    ]]);
    const html = new TextDecoder().decode(files[0].content);
    assertStringIncludes(html, 'src="data:image/png;base64,');
    assertStringIncludes(
      html,
      `integrity="sha256-${
        REVEAL_FILES["dist/reveal.js"]
      }" crossorigin="anonymous"`,
    );

    const [res] = getWrittenResources();
    assertEquals([res.specName, res.name], ["deck", "deck-talk"]);
    const deck = res.data as Deck;
    assertEquals(deck.title, "Observe");
    assertEquals(deck.engine, "org-re-reveal");
    assertEquals(deck.engineVersion, "org-re-reveal 3.39.0");
    assertEquals(deck.theme, "moon");
    assertEquals(deck.reveal.selfContained, false);
    assertEquals(
      deck.slides.map((s) => [s.index, s.title, s.hasNotes]),
      [
        ["1", "Observe", false],
        ["2", "Intro", true],
        ["3", "Picture", false],
        ["3.2", "Below", false],
      ],
    );
    assertEquals(deck.html.sha256, await sha256Hex(files[0].content));
    assertEquals(deck.source.path, "talk.org", "recorded relative to the repo");
    assertEquals(deck.unchanged, false);
    assertEquals(deck.external, []);
    assertEquals(deck.warnings, []);
  });
});

Deno.test("an identical rebuild writes no new HTML version", async () => {
  await withDeckDir(async (dir) => {
    const first = context(dir);
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ source: "talk.org" }),
            first.context,
          ),
      ));
    const prior = first.getWrittenResources()[0].data as Deck;

    const second = context(dir, { "deck-talk": prior });
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ source: "talk.org" }),
            second.context,
          ),
      ));
    assertEquals(second.getWrittenFiles(), []);
    const deck = second.getWrittenResources()[0].data as Deck;
    assertEquals(deck.unchanged, true);
    assertEquals(deck.html, prior.html);
  });
});

Deno.test("build refuses a deck name that belongs to another source", async () => {
  await withDeckDir(async (dir) => {
    const { context: ctx, getWrittenResources } = context(dir, {
      "deck-talk": { source: { path: "elsewhere/talk.org" } },
    });
    await withDeps(noElispDownload, async () => {
      await assertRejects(
        () =>
          model.methods.build.execute(buildArgs({ source: "talk.org" }), ctx),
        Error,
        'Deck name "talk" already belongs to elsewhere/talk.org',
      );
    });
    assertEquals(getWrittenResources(), []);
  });
});

Deno.test("build reports images it cannot inline and CDN files that are not pinned", async () => {
  await withDeckDir(async (dir) => {
    const html = ORG_HTML.replace("img/a.png", "img/missing.png")
      .replace("theme/moon.css", "theme/custom.css");
    const { context: ctx, getWrittenResources } = context(dir);
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(html),
        () =>
          model.methods.build.execute(buildArgs({ source: "talk.org" }), ctx),
      ));
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.warnings, [
      "img/missing.png: file not found",
      `${REVEAL_CDN}/dist/theme/custom.css: not a pinned reveal.js file`,
    ]);
    assertEquals(deck.external, [
      `${REVEAL_CDN}/dist/theme/custom.css`,
      "img/missing.png",
    ]);
  });
});

Deno.test("a self-contained build inlines every pinned file", async () => {
  await withDeckDir(async (dir) => {
    const fetched: string[] = [];
    const { context: ctx, getWrittenFiles, getWrittenResources } = context(dir);
    await withDeps({
      ...noElispDownload,
      fetchRevealFile: (_cache, path) => {
        fetched.push(path);
        return Promise.resolve(new TextEncoder().encode(`/* ${path} */`));
      },
    }, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ source: "talk.org", selfContained: true }),
            ctx,
          ),
      ));
    assertEquals(fetched.sort(), [
      "dist/plugin/notes.js",
      "dist/reveal.css",
      "dist/reveal.js",
      "dist/theme/moon.css",
    ]);
    const html = new TextDecoder().decode(getWrittenFiles()[0].content);
    assertEquals(html.includes(REVEAL_CDN), false);
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.reveal.selfContained, true);
    assertEquals(deck.theme, "moon");
    assertEquals(deck.external, []);
    assertEquals(deck.warnings, []);
  });
});

Deno.test("build from content resolves images against the repository", async () => {
  await withDeckDir(async (dir) => {
    const { context: ctx, getWrittenResources } = context(dir);
    const { calls } = await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ content: ORG_SOURCE, name: "inline", format: "org" }),
            ctx,
          ),
      ));
    // The engine read a temporary copy, not a file in the repository.
    assert(!calls[0].args[5].startsWith(dir));
    // ...and may read nothing beside that copy.
    assert(calls[0].args[8].endsWith("/content"));
    assertEquals(
      calls[0].args[5],
      `${calls[0].args[8]}/deck.org`,
    );
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.name, "inline");
    assertEquals(deck.source.path, null);
    assertEquals(deck.warnings, []);
  });
});

Deno.test("reveal-markdown builds without any external tool", async () => {
  await withDeckDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/web.md`,
      "---\ntheme: sky\n---\n# Intro\n![](img/a.png)\n\nNote: hi there\n\n---\n\n# Two\n",
    );
    const { context: ctx, getWrittenFiles, getWrittenResources } = context(dir);
    const { calls } = await withMockedCommand(
      () => ({ code: 1, stdout: "", stderr: "no tools expected" }),
      () =>
        model.methods.build.execute(
          buildArgs({ source: "web.md", engine: "reveal-markdown" }),
          ctx,
        ),
    );
    assertEquals(calls.length, 0);
    const html = new TextDecoder().decode(getWrittenFiles()[0].content);
    assertStringIncludes(html, "![](data:image/png;base64,");
    assertStringIncludes(html, `${REVEAL_CDN}/dist/theme/sky.css`);
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.theme, "sky");
    assertEquals(
      deck.slides.map((s) => [s.index, s.title, s.hasNotes]),
      [["1", "Intro", true], ["2", "Two", false]],
    );
  });
});

Deno.test("Org with the pandoc engine is refused before anything runs", async () => {
  await withDeckDir(async (dir) => {
    const { context: ctx } = context(dir);
    const { calls } = await withMockedCommand([], async () => {
      await assertRejects(
        () =>
          model.methods.build.execute(
            buildArgs({ source: "talk.org", engine: "pandoc" }),
            ctx,
          ),
        Error,
        "speaker notes",
      );
    });
    assertEquals(calls.length, 0);
  });
});

Deno.test("outline records slides, notes coverage and missing images", async () => {
  await withDeckDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/talk.org`,
      `${ORG_SOURCE}* Gone\n[[file:img/gone.png]]\n`,
    );
    const { context: ctx, getWrittenResources } = context(dir);
    const { calls } = await withMockedCommand(
      [],
      () =>
        model.methods.outline.execute(
          model.methods.outline.arguments.parse({ source: "talk.org" }),
          ctx,
        ),
    );
    assertEquals(calls.length, 0);
    const [res] = getWrittenResources();
    assertEquals([res.specName, res.name], ["outline", "outline-talk"]);
    const o = res.data as DeckOutline;
    assertEquals(o.slides.map((s) => s.index), ["1", "2", "2.2", "3"]);
    assertEquals(o.slidesWithoutNotes, ["2", "2.2", "3"]);
    assertEquals(o.missingImages, ["img/gone.png"]);
  });
});

function pdfContext(
  dir: string,
  stored: Record<string, Record<string, unknown>>,
  content: Uint8Array | null,
) {
  const base = context(dir, stored);
  const reads: Array<[string, number | undefined]> = [];
  const ctx = {
    ...(base.context as unknown as Record<string, unknown>),
    modelType: "@webframp/presentation/deck",
    modelId: "model-1",
    dataRepository: {
      getContent(_t: unknown, _id: string, name: string, version?: number) {
        reads.push([name, version]);
        return Promise.resolve(content);
      },
    },
  } as unknown as PdfContext;
  return { ...base, ctx, reads };
}

async function storedDeck(html: Uint8Array, selfContained = true) {
  return {
    name: "talk",
    reveal: { selfContained },
    html: { sha256: await sha256Hex(html), bytes: html.length, version: 3 },
  };
}

const pdfArgs = (over: Record<string, unknown>) =>
  model.methods.export_pdf.arguments.parse(over);

Deno.test("export_pdf prints the recorded HTML version and stores the PDF", async () => {
  await withDeckDir(async (dir) => {
    const html = new TextEncoder().encode("<html>deck</html>");
    const { ctx, reads, getWrittenFiles, getWrittenResources } = pdfContext(
      dir,
      { "deck-talk": await storedDeck(html) },
      html,
    );
    const printed: string[] = [];
    await withDeps(
      {
        exportPdf: async (o) => {
          printed.push(await Deno.readTextFile(new URL(o.url).pathname));
          assert(o.url.endsWith("?print-pdf"));
          return { pdf: new TextEncoder().encode("%PDF"), pages: 8 };
        },
      },
      () =>
        model.methods.export_pdf.execute(
          pdfArgs({ source: "x/talk.org" }),
          ctx,
        ),
    );
    assertEquals(reads, [["html-talk", 3]]);
    assertEquals(printed, ["<html>deck</html>"]);
    assertEquals(getWrittenFiles().map((f) => f.name), ["pdf-talk"]);
    const p = getWrittenResources()[0].data as DeckPdf;
    assertEquals(p.pdf.pages, 8);
    assertEquals(p.html.version, 3);
    assertEquals(p.unchanged, false);
  });
});

Deno.test("export_pdf skips printing when the HTML has not changed", async () => {
  await withDeckDir(async (dir) => {
    const html = new TextEncoder().encode("<html>deck</html>");
    const deck = await storedDeck(html);
    const prior = {
      html: { sha256: deck.html.sha256, version: 3 },
      pdf: { sha256: "p", bytes: 4, pages: 8, version: 2 },
    };
    const { ctx, getWrittenFiles, getWrittenResources } = pdfContext(
      dir,
      { "deck-talk": deck, "print-talk": prior },
      html,
    );
    await withDeps({
      exportPdf: () => Promise.reject(new Error("must not print")),
    }, () => model.methods.export_pdf.execute(pdfArgs({ name: "talk" }), ctx));
    assertEquals(getWrittenFiles(), []);
    const p = getWrittenResources()[0].data as DeckPdf;
    assertEquals(p.unchanged, true);
    assertEquals(p.pdf, prior.pdf);
  });
});

Deno.test("export_pdf refuses a missing build or HTML that does not match its record", async () => {
  await withDeckDir(async (dir) => {
    const none = pdfContext(dir, {}, null);
    await assertRejects(
      () =>
        model.methods.export_pdf.execute(pdfArgs({ name: "talk" }), none.ctx),
      Error,
      "Run build first",
    );
    const html = new TextEncoder().encode("<html>deck</html>");
    const tampered = pdfContext(
      dir,
      { "deck-talk": await storedDeck(html) },
      new TextEncoder().encode("<html>other</html>"),
    );
    await assertRejects(
      () =>
        model.methods.export_pdf.execute(
          pdfArgs({ name: "talk" }),
          tampered.ctx,
        ),
      Error,
      "does not match its build record",
    );
  });
});

Deno.test("a symlinked source keeps its own name, in build and export_pdf", async () => {
  await withDeckDir(async (dir) => {
    await Deno.symlink(`${dir}/talk.org`, `${dir}/current.org`);
    const { context: ctx, getWrittenResources } = context(dir);
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ source: "current.org" }),
            ctx,
          ),
      ));
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.name, "current");
    assertEquals(deck.source.path, "talk.org");
    const pdfArgs = model.methods.export_pdf.arguments.parse({
      source: "current.org",
    });
    const { ctx: pctx, reads } = pdfContext(
      dir,
      { "deck-current": deck },
      null,
    );
    await assertRejects(
      () => model.methods.export_pdf.execute(pdfArgs, pctx),
      Error,
      "is missing",
    );
    assertEquals(reads, [["html-current", deck.html.version]]);
  });
});

Deno.test("ownership survives a moved checkout, and outline checks it too", async () => {
  await withDeckDir(async (dir) => {
    // A record written from another clone, where the repo lived elsewhere.
    const moved = context(dir, {
      "deck-talk": { source: { path: "talk.org" } },
    });
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(),
        () =>
          model.methods.build.execute(
            buildArgs({ source: "talk.org" }),
            moved.context,
          ),
      ));
    assertEquals(moved.getWrittenResources().length, 1);

    const taken = context(dir, {
      "outline-talk": { source: { path: "other/talk.org" } },
    });
    await assertRejects(
      () =>
        model.methods.outline.execute(
          model.methods.outline.arguments.parse({ source: "talk.org" }),
          taken.context,
        ),
      Error,
      "already belongs to other/talk.org",
    );
    assertEquals(taken.getWrittenResources(), []);
  });
});

Deno.test("build records an unpinned theme as the stylesheet it loads", async () => {
  await withDeckDir(async (dir) => {
    const html = ORG_HTML.replace(
      `${REVEAL_CDN}/dist/theme/moon.css`,
      "https://evil.example/x.css",
    );
    const { context: ctx, getWrittenResources } = context(dir);
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        emacsOutput(html),
        () =>
          model.methods.build.execute(buildArgs({ source: "talk.org" }), ctx),
      ));
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.theme, "https://evil.example/x.css");
    assertEquals(deck.external, ["https://evil.example/x.css"]);
  });
});

Deno.test("org-re-reveal and pandoc warnings reach the build record", async () => {
  await withDeckDir(async (dir) => {
    const { context: ctx, getWrittenResources } = context(dir);
    await withDeps(noElispDownload, () =>
      withMockedCommand(
        async (_cmd, args) => {
          await Deno.writeTextFile(args[args.length - 1], ORG_HTML);
          return { code: 0, stdout: "", stderr: "Warning (org): odd link\n" };
        },
        () =>
          model.methods.build.execute(buildArgs({ source: "talk.org" }), ctx),
      ));
    const deck = getWrittenResources()[0].data as Deck;
    assertEquals(deck.warnings, ["Warning (org): odd link"]);
  });
});
