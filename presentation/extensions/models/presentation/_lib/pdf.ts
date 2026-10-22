// SPDX-License-Identifier: Apache-2.0

/**
 * PDF export through Chromium's DevTools protocol.
 *
 * `chromium --print-to-pdf` cannot be used: it prints before reveal.js has
 * finished laying out its print view and produces one blank page. Driving
 * the browser over the protocol lets us wait until the layout settles.
 *
 * @module
 */

/** The protocol calls the printer needs. */
export interface Cdp {
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** How long to wait between layout checks, and how many equal counts in a row mean settled. */
const POLL_MS = 250;
const STABLE_POLLS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open `url` (a deck with `?print-pdf`), wait until reveal.js's print layout
 * stops adding pages, and print it. Returns the PDF and the page count.
 */
export async function printDeck(
  cdp: Cdp,
  url: string,
  timeoutMs: number,
): Promise<{ pdf: Uint8Array; pages: number }> {
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (stable < STABLE_POLLS) {
    if (Date.now() > deadline) {
      throw new Error(
        `reveal.js print layout did not settle within ${timeoutMs} ms (last page count ${last}). A deck that loads reveal.js from the CDN needs network access.`,
      );
    }
    await sleep(POLL_MS);
    const r = await cdp.send("Runtime.evaluate", {
      expression: "document.querySelectorAll('.pdf-page').length",
      returnByValue: true,
    });
    const n = Number(
      (r.result as { value?: unknown } | undefined)?.value ?? 0,
    );
    stable = n > 0 && n === last ? stable + 1 : 0;
    last = n;
  }
  const printed = await cdp.send("Page.printToPDF", {
    preferCSSPageSize: true,
    printBackground: true,
  });
  const data = printed.data;
  if (typeof data !== "string") throw new Error("Chromium returned no PDF");
  const bin = atob(data);
  const pdf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pdf[i] = bin.charCodeAt(i);
  return { pdf, pages: last };
}

/** A protocol session over a WebSocket. */
export function cdpOverWebSocket(ws: WebSocket): Cdp {
  let id = 0;
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(`DevTools ${msg.error.message ?? "error"}`));
    } else p.resolve(msg.result ?? {});
  };
  ws.onclose = () => {
    for (const p of pending.values()) {
      p.reject(new Error("DevTools connection closed"));
    }
    pending.clear();
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
  };
}

/**
 * Launch headless Chromium on a private profile, print the deck at `url`,
 * and shut the browser down whatever happens.
 */
export async function exportPdf(opts: {
  chromium: string;
  url: string;
  profileDir: string;
  timeoutMs: number;
  noSandbox: boolean;
}): Promise<{ pdf: Uint8Array; pages: number }> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.profileDir}`,
    ...(opts.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(opts.chromium, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `${opts.chromium} is not installed or not on PATH. Set the chromium global argument.`,
      );
    }
    throw e;
  }
  let ws: WebSocket | null = null;
  const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Chromium did not start its DevTools endpoint")),
        30_000,
      );
      let seen = "";
      let ready = false;
      // Keep draining stderr after the endpoint appears: Chromium goes on
      // logging, and a full pipe would stall it mid-print.
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (ready) continue;
          seen = (seen + value).slice(-8192);
          const m = seen.match(/DevTools listening on (ws:\/\/\S+)/);
          if (m) {
            ready = true;
            clearTimeout(timer);
            resolve(m[1]);
          }
        }
        if (!ready) {
          clearTimeout(timer);
          reject(
            new Error(
              `Chromium exited before it was ready:\n${seen.slice(-800)}`,
            ),
          );
        }
      })().catch((e) => {
        if (!ready) reject(e);
      });
    });
    const port = new URL(endpoint).port;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`))
      .json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chromium opened no page");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("DevTools connection failed"));
    });
    return await printDeck(cdpOverWebSocket(socket), opts.url, opts.timeoutMs);
  } finally {
    ws?.close();
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    await reader.cancel().catch(() => {});
    await child.status;
  }
}
