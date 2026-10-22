// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests against real Emacs, pandoc, Chromium and the network.
 * They also prove every pinned URL still serves the pinned bytes.
 *
 *   PRESENTATION_INTEGRATION=1 deno task test
 *
 * Set PRESENTATION_NO_SANDBOX=1 where Chromium's sandbox is unavailable
 * (containers, WSL).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { type Deck, type DeckPdf, model } from "./deck.ts";
import { ensureElisp, fetchRevealFile } from "./_lib/cache.ts";
import { REVEAL_FILES } from "./_lib/pins.ts";

const enabled = Deno.env.get("PRESENTATION_INTEGRATION") === "1";
const noSandbox = Deno.env.get("PRESENTATION_NO_SANDBOX") === "1";

const ORG = `#+TITLE: Integration
#+REVEAL_PLUGINS: (notes highlight)
#+OPTIONS: toc:nil
* Intro
Hello
#+BEGIN_NOTES
Notes.
#+END_NOTES
* Code
#+BEGIN_SRC typescript
const x = 1;
#+END_SRC
* Stack
** Below
`;

const MD = `---
title: Integration
---

# Intro

::: notes
Notes.
:::

# Stack

## Below
`;

/** reveal.js's markdown plugin splits on separators, not headings. */
const RMD = `# Intro

Note: Notes.

---

# Stack

--

## Below
`;

type Ctx = Parameters<typeof model.methods.build.execute>[1];

function ctxFor(
  dir: string,
  stored: Record<string, Record<string, unknown>> = {},
) {
  const base = createModelTestContext({
    repoDir: dir,
    globalArgs: model.globalArguments.parse({
      cacheDir: `${dir}/cache`,
      chromiumNoSandbox: noSandbox,
    }),
    storedResources: stored,
  });
  return { ...base, context: base.context as unknown as Ctx };
}

Deno.test({
  name: "every pinned reveal.js and Emacs Lisp file still matches its hash",
  ignore: !enabled,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      for (const path of Object.keys(REVEAL_FILES)) {
        assert((await fetchRevealFile(dir, path)).length > 0, path);
      }
      await ensureElisp(dir);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "org-re-reveal, pandoc and reveal-markdown build real decks, and one prints",
  ignore: !enabled,
  sanitizeResources: false, // Chromium's DevTools socket and fetch keep-alive
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${dir}/talk.org`, ORG);
      await Deno.writeTextFile(`${dir}/talk.md`, MD);
      await Deno.writeTextFile(`${dir}/web.md`, RMD);
      const builds: Array<[Record<string, unknown>, number]> = [
        [{ source: "talk.org" }, 5],
        [{ source: "talk.org", name: "talk-offline", selfContained: true }, 5],
        [{ source: "talk.md", name: "talk-md" }, 4],
        [{ source: "web.md", engine: "reveal-markdown" }, 3],
      ];
      let offline: { deck: Deck; html: Uint8Array } | null = null;
      for (const [args, slides] of builds) {
        const c = ctxFor(dir);
        await model.methods.build.execute(
          model.methods.build.arguments.parse(args),
          c.context,
        );
        const deck = c.getWrittenResources()[0].data as Deck;
        assertEquals(deck.slideCount, slides, JSON.stringify(args));
        assertEquals(deck.warnings, [], JSON.stringify(args));
        assertEquals(deck.external, [], JSON.stringify(args));
        if (args.selfContained) {
          offline = { deck, html: c.getWrittenFiles()[0].content };
        }
      }

      // Rebuilding the same source is byte-identical.
      const first = ctxFor(dir);
      await model.methods.build.execute(
        model.methods.build.arguments.parse({
          source: "talk.org",
          name: "repeat",
        }),
        first.context,
      );
      const prior = first.getWrittenResources()[0].data as Deck;
      const again = ctxFor(dir, { "deck-repeat": prior });
      await model.methods.build.execute(
        model.methods.build.arguments.parse({
          source: "talk.org",
          name: "repeat",
        }),
        again.context,
      );
      assertEquals(
        (again.getWrittenResources()[0].data as Deck).unchanged,
        true,
      );
      assertEquals(again.getWrittenFiles(), []);

      assert(offline);
      const html = new TextDecoder().decode(offline.html);
      assertEquals(html.includes("cdn.jsdelivr.net/npm/reveal.js@"), false);
      assertStringIncludes(html, "Reveal.initialize");

      const p = ctxFor(dir, { "deck-talk-offline": offline.deck });
      const pdfCtx = {
        ...(p.context as unknown as Record<string, unknown>),
        modelType: model.type,
        modelId: "integration",
        dataRepository: {
          getContent: () => Promise.resolve(offline!.html),
        },
      } as unknown as Parameters<typeof model.methods.export_pdf.execute>[1];
      await model.methods.export_pdf.execute(
        model.methods.export_pdf.arguments.parse({ name: "talk-offline" }),
        pdfCtx,
      );
      const pdf = p.getWrittenResources()[0].data as DeckPdf;
      // Title slide, four content slides, and no fragments.
      assertEquals(pdf.pdf.pages, 5);
      const bytes = p.getWrittenFiles()[0].content;
      assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
