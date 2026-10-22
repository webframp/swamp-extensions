// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import {
  defaultCacheDir,
  ensureElisp,
  fetchRevealFile,
  fetchVerified,
  sha256Base64,
  sha256Hex,
} from "./cache.ts";
import { ELISP_PINS, REVEAL_CDN } from "./pins.ts";

const enc = new TextEncoder();

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("sha256 helpers match known digests", async () => {
  assertEquals(
    await sha256Hex(enc.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    await sha256Base64(enc.encode("abc")),
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
  );
});

Deno.test("defaultCacheDir prefers XDG_CACHE_HOME, then HOME", () => {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME");
  try {
    Deno.env.set("XDG_CACHE_HOME", "/xdg");
    assertEquals(defaultCacheDir(), "/xdg/webframp-presentation");
    Deno.env.delete("XDG_CACHE_HOME");
    Deno.env.set("HOME", "/home/u");
    assertEquals(defaultCacheDir(), "/home/u/.cache/webframp-presentation");
  } finally {
    if (xdg === undefined) Deno.env.delete("XDG_CACHE_HOME");
    else Deno.env.set("XDG_CACHE_HOME", xdg);
    if (home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", home);
  }
});

Deno.test("fetchVerified downloads once, then serves the verified cache", async () => {
  await withDir(async (dir) => {
    const body = enc.encode("pinned bytes");
    const want = await sha256Hex(body);
    const verify = async (b: Uint8Array) => await sha256Hex(b) === want;
    const path = `${dir}/sub/file.js`;

    const first = await withMockedFetch(
      () => new Response(body),
      () => fetchVerified("https://x.test/file.js", path, verify),
    );
    assertEquals(first.calls.length, 1);
    assertEquals(await Deno.readFile(path), body);

    const second = await withMockedFetch(
      () => new Response("must not be fetched"),
      () => fetchVerified("https://x.test/file.js", path, verify),
    );
    assertEquals(second.calls.length, 0);
    assertEquals(second.result, body);

    // A corrupted cache is fetched again, not trusted.
    await Deno.writeTextFile(path, "tampered");
    const third = await withMockedFetch(
      () => new Response(body),
      () => fetchVerified("https://x.test/file.js", path, verify),
    );
    assertEquals(third.calls.length, 1);
    assertEquals(await Deno.readFile(path), body);
  });
});

Deno.test("fetchVerified refuses bytes that do not match and caches nothing", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/file.js`;
    await withMockedFetch(() => new Response("evil"), async () => {
      await assertRejects(
        () =>
          fetchVerified("https://x.test/f", path, () => Promise.resolve(false)),
        Error,
        "Integrity check failed",
      );
    });
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    const entries = [...Deno.readDirSync(dir)];
    assertEquals(entries.length, 0, "no temporary file left behind");
  });
});

Deno.test("fetchVerified reports HTTP errors", async () => {
  await withDir(async (dir) => {
    await withMockedFetch(
      () => new Response("nope", { status: 404 }),
      async () => {
        await assertRejects(
          () =>
            fetchVerified(
              "https://x.test/f",
              `${dir}/f`,
              () => Promise.resolve(true),
            ),
          Error,
          "HTTP 404",
        );
      },
    );
  });
});

Deno.test("fetchRevealFile fetches from the pinned CDN and rejects other paths", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => fetchRevealFile(dir, "dist/reveal.mjs"),
      Error,
      "Not a pinned",
    );
    const { calls } = await withMockedFetch(
      () => new Response("not reveal.js"),
      async () => {
        await assertRejects(
          () => fetchRevealFile(dir, "dist/reveal.js"),
          Error,
          "Integrity check failed",
        );
      },
    );
    assertEquals(calls.map((c) => c.url), [`${REVEAL_CDN}/dist/reveal.js`]);
  });
});

Deno.test("ensureElisp fetches each pinned file by commit URL", async () => {
  await withDir(async (dir) => {
    const { calls } = await withMockedFetch(
      () => new Response("(provide 'not-the-real-file)"),
      async () => {
        const err = await assertRejects(() => ensureElisp(dir), Error);
        assertStringIncludes(err.message, ELISP_PINS[0].url);
      },
    );
    assertEquals(calls.map((c) => c.url), [ELISP_PINS[0].url]);
    for (const pin of ELISP_PINS) {
      assertStringIncludes(pin.url, "/raw");
      assertEquals(pin.sha256.length, 64);
    }
  });
});
