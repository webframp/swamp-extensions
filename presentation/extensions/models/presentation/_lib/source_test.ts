// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  chooseEngine,
  deckNameFromPath,
  detectFormat,
  outlineMarkdownPandoc,
  outlineMarkdownReveal,
  outlineOrg,
  splitFrontMatter,
} from "./source.ts";

Deno.test("detectFormat reads the extension and honours an explicit choice", () => {
  assertEquals(detectFormat("/a/talk.org", "auto"), "org");
  assertEquals(detectFormat("/a/TALK.MD", "auto"), "markdown");
  assertEquals(detectFormat("/a/notes.markdown", "auto"), "markdown");
  assertEquals(detectFormat("/a/talk.txt", "org"), "org");
  assertThrows(() => detectFormat("/a/talk.txt", "auto"), Error, "format");
  assertThrows(() => detectFormat(null, "auto"), Error, "content");
});

Deno.test("chooseEngine defaults per format and refuses lossy pairings", () => {
  assertEquals(chooseEngine("org", "auto"), "org-re-reveal");
  assertEquals(chooseEngine("markdown", "auto"), "pandoc");
  assertEquals(chooseEngine("markdown", "reveal-markdown"), "reveal-markdown");
  assertThrows(() => chooseEngine("org", "pandoc"), Error, "speaker notes");
  assertThrows(
    () => chooseEngine("markdown", "org-re-reveal"),
    Error,
    "Org sources",
  );
});

Deno.test("deckNameFromPath folds the file stem to a data-name-safe slug", () => {
  assertEquals(
    deckNameFromPath("/x/Observe Don't Declare.org"),
    "observe-don-t-declare",
  );
  assertEquals(deckNameFromPath("/x/talk.v2.md"), "talk-v2");
  assertEquals(deckNameFromPath("talk"), "talk");
  assertEquals(deckNameFromPath(`/x/${"a".repeat(80)}.org`).length, 63);
  assertThrows(() => deckNameFromPath("/x/!!!.org"), Error, "name");
});

Deno.test("splitFrontMatter reads simple YAML keys", () => {
  const { meta, body } = splitFrontMatter(
    '---\ntitle: "Hello: world"\ntheme: moon\n---\n# One\n',
  );
  assertEquals(meta, { title: "Hello: world", theme: "moon" });
  assertEquals(body, "# One\n");
  assertEquals(splitFrontMatter("# No front matter").meta, {});
});

const ORG = `#+TITLE: Observe
#+REVEAL_THEME: moon
* Intro
Hello
#+BEGIN_NOTES
three notes words
#+END_NOTES
* TODO Code :tag:
#+begin_notes
one
#+end_notes
* COMMENT Hidden
** Also hidden
* Skipped :noexport:
** Child of skipped
* Vertical
** Child one
[[file:img/a.png]] and [[./img/b.svg][label]] and [[https://example.com/c.png]]
*** Third level
**** Fourth level is content
[[img/d.jpg]]
`;

Deno.test("outlineOrg follows org-re-reveal's slide rules", () => {
  const o = outlineOrg(ORG);
  assertEquals(o.title, "Observe");
  assertEquals(o.theme, "moon");
  assertEquals(
    o.slides.map((s) => [s.index, s.title, s.notesWords]),
    [
      ["1", "Intro", 3],
      ["2", "Code", 1],
      ["3", "Vertical", 0],
      ["3.2", "Child one", 0],
      ["3.3", "Third level", 0],
    ],
  );
  assertEquals(o.slides[3].images, ["img/a.png", "./img/b.svg"]);
  // A level-4 heading is content of the level-3 slide, images included.
  assertEquals(o.slides[4].images, ["img/d.jpg"]);
});

Deno.test("outlineOrg honours #+OPTIONS: H:", () => {
  const o = outlineOrg("#+OPTIONS: toc:nil H:1\n* One\n** Two\n* Three\n");
  assertEquals(o.slides.map((s) => s.title), ["One", "Three"]);
});

Deno.test("outlineMarkdownPandoc uses slide level 2 and ::: notes", () => {
  const md = `---
title: Deck
---

# Intro

Hello

::: notes
Speaker notes here.
:::

# Vertical

## Child one

![a](img/a.png)

\`\`\`md
# Not a heading
\`\`\`

## Child two
<img src="img/b.png">
`;
  const o = outlineMarkdownPandoc(md);
  assertEquals(o.title, "Deck");
  assertEquals(
    o.slides.map((s) => [s.index, s.title, s.notesWords]),
    [
      ["1", "Intro", 3],
      ["2", "Vertical", 0],
      ["2.2", "Child one", 0],
      ["2.3", "Child two", 0],
    ],
  );
  assertEquals(o.slides[2].images, ["img/a.png"]);
  assertEquals(o.slides[3].images, ["img/b.png"]);
});

Deno.test("outlineMarkdownReveal splits where reveal.js's markdown plugin does", () => {
  const md = `# Intro
Hello

Note: four words of notes

---

# Code

--

## Child
![](img/a.png)
`;
  const o = outlineMarkdownReveal(md);
  assertEquals(o.title, "Intro");
  assertEquals(
    o.slides.map((s) => [s.index, s.title, s.notesWords]),
    [
      ["1", "Intro", 4],
      ["2", "Code", 0],
      ["2.2", "Child", 0],
    ],
  );
  assertEquals(o.slides[2].images, ["img/a.png"]);
});

Deno.test("outlineMarkdownReveal does not split on --- without blank lines", () => {
  const o = outlineMarkdownReveal("# One\ntext\n---\nmore\n");
  assertEquals(o.slides.length, 1);
});

Deno.test("outlineMarkdownPandoc follows pandoc's rules and setext headings", () => {
  const md = `Intro
=====

Hello

---

After a rule

# Stack

Child
-----

text

***

\`\`\`
---
\`\`\`
`;
  const o = outlineMarkdownPandoc(md);
  assertEquals(
    o.slides.map((s) => [s.index, s.title]),
    [
      // As pandoc 3.7 renders it.
      ["1", "Intro"],
      ["1.2", ""],
      ["2", "Stack"],
      ["2.2", "Child"],
      ["2.3", ""],
    ],
  );
});
