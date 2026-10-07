/**
 * Tests for the reference-inspired hardening in the generated Datadog _lib:
 * instance-name sanitization and 429 rate-limit retry.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { generateApiLib } from "./extension_generator.ts";

Deno.test("generateApiLib: exports sanitizeInstanceName", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("export function sanitizeInstanceName("), true);
});

Deno.test("generateApiLib: retries on 429 honoring Retry-After", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("429"), true);
  assertEquals(lib.includes("Retry-After"), true);
});

Deno.test("generateApiLib: sanitizeInstanceName strips path-traversal chars at runtime", async () => {
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, lib);
    const mod = await import(`file://${tmp}`);
    // "/" and "\" -> "_", ".." -> "_", null byte removed.
    assertEquals(mod.sanitizeInstanceName("a/b\\c..d\0e"), "a_b_c_de");
    assertEquals(mod.sanitizeInstanceName("plain"), "plain");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("generateApiLib: ddApi returns {} for an empty 2xx body", async () => {
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  const realFetch = globalThis.fetch;
  try {
    await Deno.writeTextFile(tmp, lib);
    const mod = await import(`file://${tmp}`);
    globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 202 }));
    const result = await mod.ddApi("k", "a", "us1", "PATCH", "/api/v2/x", {});
    assertEquals(result, {});
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ ok: true }, { status: 200 }));
    assertEquals(await mod.ddApi("k", "a", "us1", "GET", "/api/v2/x"), {
      ok: true,
    });
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(tmp);
  }
});

/** Import the generated api.ts with `fetch` replaced by `handler`. */
async function withApiLib(
  handler: () => Response,
  fn: (mod: Record<string, (...a: unknown[]) => Promise<unknown>>) => Promise<
    void
  >,
): Promise<void> {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  const realFetch = globalThis.fetch;
  try {
    await Deno.writeTextFile(tmp, generateApiLib());
    const mod = await import(`file://${tmp}`);
    globalThis.fetch = () => Promise.resolve(handler());
    await fn(mod);
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(tmp);
  }
}

const CURSOR_CFG = {
  style: "cursor",
  limitParam: "page[limit]",
  limitDefault: 10,
  cursorParam: "page[cursor]",
};

Deno.test("generateApiLib: ddApi returns {} for 204", async () => {
  await withApiLib(() => new Response(null, { status: 204 }), async (mod) => {
    assertEquals(await mod.ddApi("k", "a", "us1", "DELETE", "/api/v2/x"), {});
  });
});

Deno.test("generateApiLib: ddApi flattens a JSON:API object", async () => {
  await withApiLib(
    () =>
      Response.json({
        data: { id: "1", type: "t", attributes: { name: "n" } },
      }),
    async (mod) => {
      const r = await mod.ddApi("k", "a", "us1", "GET", "/api/v2/x") as Record<
        string,
        unknown
      >;
      assertEquals(r.id, "1");
      assertEquals(r.name, "n");
    },
  );
});

Deno.test("generateApiLib: malformed JSON error names method, path and status", async () => {
  await withApiLib(
    () => new Response("<html>oops", { status: 200 }),
    async (mod) => {
      const err = await assertRejects(() =>
        mod.ddApi("k", "a", "us1", "PATCH", "/api/v2/x", {})
      );
      const msg = (err as Error).message;
      assertStringIncludes(msg, "PATCH");
      assertStringIncludes(msg, "/api/v2/x");
      assertStringIncludes(msg, "200");
      assertStringIncludes(msg, "<html>oops");
    },
  );
});

Deno.test("generateApiLib: paginated GET tolerates an empty body", async () => {
  await withApiLib(() => new Response(null, { status: 200 }), async (mod) => {
    const r = await mod.ddApiPaginated(
      "k",
      "a",
      "us1",
      "/api/v2/x",
      CURSOR_CFG,
    ) as { results: unknown[] };
    assertEquals(r.results, []);
  });
});

Deno.test("generateApiLib: paginated GET malformed body error has path", async () => {
  await withApiLib(() => new Response("nope", { status: 200 }), async (mod) => {
    const err = await assertRejects(() =>
      mod.ddApiPaginated("k", "a", "us1", "/api/v2/x", CURSOR_CFG)
    );
    assertStringIncludes((err as Error).message, "/api/v2/x");
    assertStringIncludes((err as Error).message, "GET");
  });
});

Deno.test("generateApiLib: POST paginated tolerates an empty body", async () => {
  await withApiLib(() => new Response(null, { status: 200 }), async (mod) => {
    const r = await mod.ddApiPostPaginated(
      "k",
      "a",
      "us1",
      "/api/v2/x",
      {},
    ) as { results: unknown[] };
    assertEquals(r.results, []);
  });
});
