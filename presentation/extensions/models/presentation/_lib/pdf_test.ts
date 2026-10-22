// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { beforeDeadline, type Cdp, printDeck } from "./pdf.ts";

/** A DevTools session whose page count follows `counts`, then stays at the last value. */
function fakeCdp(counts: number[]): { cdp: Cdp; methods: string[] } {
  const methods: string[] = [];
  let i = 0;
  return {
    methods,
    cdp: {
      send(method, params) {
        methods.push(method);
        if (method === "Runtime.evaluate") {
          const value = counts[Math.min(i++, counts.length - 1)];
          return Promise.resolve({ result: { value } });
        }
        if (method === "Page.printToPDF") {
          assertEquals(params, {
            preferCSSPageSize: true,
            printBackground: true,
          });
          return Promise.resolve({ data: btoa("%PDF-1.7 fake") });
        }
        return Promise.resolve({});
      },
    },
  };
}

Deno.test("printDeck waits for the print layout to settle before printing", async () => {
  const { cdp, methods } = fakeCdp([0, 0, 3, 6, 8, 8, 8, 8, 8]);
  const { pdf, pages } = await printDeck(
    cdp,
    "file:///d.html?print-pdf",
    Date.now() + 20_000,
  );
  assertEquals(pages, 8);
  assertEquals(new TextDecoder().decode(pdf), "%PDF-1.7 fake");
  assertEquals(methods[0], "Page.enable");
  assertEquals(methods[1], "Page.navigate");
  assertEquals(methods.at(-1), "Page.printToPDF");
  // Printed only after the first 8 is seen again four times in a row.
  assertEquals(methods.filter((m) => m === "Runtime.evaluate").length, 9);
});

Deno.test("printDeck gives up when reveal.js never lays out pages", async () => {
  const { cdp, methods } = fakeCdp([0]);
  await assertRejects(
    () => printDeck(cdp, "file:///d.html?print-pdf", Date.now() + 800),
    Error,
    "did not settle",
  );
  assertEquals(methods.includes("Page.printToPDF"), false);
});

Deno.test("printDeck gives up when the page never answers", async () => {
  // A deck whose script blocks the page's main thread: Runtime.evaluate
  // never returns.
  const cdp: Cdp = {
    send(method) {
      return method === "Runtime.evaluate"
        ? new Promise(() => {})
        : Promise.resolve({});
    },
  };
  const started = Date.now();
  await assertRejects(
    () => printDeck(cdp, "file:///d.html?print-pdf", Date.now() + 1_000),
    Error,
    "Runtime.evaluate did not finish before the deadline",
  );
  const took = Date.now() - started;
  assertEquals(took < 3_000, true, `took ${took} ms`);
});

Deno.test("beforeDeadline passes results through and clears its timer", async () => {
  assertEquals(
    await beforeDeadline(Promise.resolve(7), Date.now() + 50, "x"),
    7,
  );
  await assertRejects(
    () =>
      beforeDeadline(Promise.reject(new Error("boom")), Date.now() + 50, "x"),
    Error,
    "boom",
  );
});
