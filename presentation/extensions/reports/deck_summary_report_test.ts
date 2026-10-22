// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  cell,
  renderDeck,
  renderOutline,
  renderPdf,
  report,
} from "./deck_summary_report.ts";

const deck = {
  name: "talk",
  title: "Observe | Declare",
  engine: "org-re-reveal",
  engineVersion: "org-re-reveal 3.39.0",
  reveal: { version: "6.0.1", selfContained: false },
  theme: "moon",
  slides: [
    { index: "1", title: "Observe | Declare", hasNotes: false },
    { index: "2", title: "Intro", hasNotes: true },
    { index: "2.2", title: "", hasNotes: false },
  ],
  slideCount: 3,
  html: { sha256: "abc", bytes: 4096, version: 2 },
  unchanged: true,
  external: ["img/missing.png"],
  warnings: ["img/missing.png: file not found"],
  durationMs: 12,
};

function ctx(
  methodName: string,
  handles: Array<{ name: string; specName: string; version?: number }>,
  stored: Record<string, unknown>,
) {
  return {
    modelType: "@webframp/presentation/deck",
    modelId: "m1",
    methodName,
    executionStatus: "succeeded",
    dataHandles: handles,
    dataRepository: {
      getContent(_t: unknown, _id: string, name: string) {
        const v = stored[name];
        return Promise.resolve(
          v === undefined ? null : new TextEncoder().encode(JSON.stringify(v)),
        );
      },
    },
  };
}

Deno.test("cell escapes table syntax", () => {
  assertEquals(cell("a|b\nc"), "a\\|b c");
  assertEquals(cell(null), "");
});

Deno.test("renderDeck lists slides, notes gaps, external resources and warnings", () => {
  const md = renderDeck(deck);
  assertStringIncludes(md, "# Deck: Observe \\| Declare");
  assertStringIncludes(
    md,
    "version 2, 4.0 KiB, unchanged since the last build",
  );
  assertStringIncludes(md, "| 2 | Intro | yes |");
  assertStringIncludes(md, "| 2.2 | (untitled) |  |");
  assertStringIncludes(md, "2 of 3 slides have no speaker notes.");
  assertStringIncludes(md, "## Loaded from elsewhere\n\n- img/missing.png");
  assertStringIncludes(md, "## Warnings\n\n- img/missing.png: file not found");
});

Deno.test("renderOutline and renderPdf summarise their records", () => {
  const o = renderOutline({
    name: "talk",
    title: null,
    engine: "pandoc",
    slides: [{ index: "1", title: "One", notesWords: 4, images: ["a.png"] }],
    slideCount: 1,
    slidesWithoutNotes: [],
    missingImages: ["a.png"],
  });
  assertStringIncludes(o, "# Outline: talk");
  assertStringIncludes(o, "| 1 | One | 4 | 1 |");
  assertStringIncludes(o, "## Missing images\n\n- a.png");

  const p = renderPdf({
    name: "talk",
    html: { version: 2 },
    pdf: { bytes: 2048, pages: 8, version: 1 },
    selfContained: false,
    unchanged: false,
  });
  assertStringIncludes(p, "**Pages**: 8");
  assertStringIncludes(p, "HTML version 2 (loaded reveal.js from the CDN)");
});

Deno.test("report picks the record by spec name, whatever the deck is called", async () => {
  // A deck named "slides-html" must not be mistaken for an HTML file.
  const r = await report.execute(ctx("build", [
    { name: "deck-slides-html-html", specName: "html", version: 1 },
    { name: "deck-slides-html", specName: "deck", version: 1 },
  ], { "deck-slides-html": { ...deck, name: "slides-html" } }));
  assertEquals(r.json.kind, "deck");
  assertEquals(r.json.name, "slides-html");
});

Deno.test("report says so when there is nothing to summarise or data is unreadable", async () => {
  const none = await report.execute(ctx("build", [], {}));
  assertEquals(none.json.available, false);
  assertStringIncludes(none.markdown, "Nothing to summarise for build");

  const broken = await report.execute({
    ...ctx("outline", [{ name: "outline-x", specName: "outline" }], {}),
    dataRepository: {
      getContent: () => Promise.reject(new Error("datastore offline")),
    },
  });
  assertEquals(broken.json.available, false);
  assertStringIncludes(broken.markdown, "datastore offline");
});
