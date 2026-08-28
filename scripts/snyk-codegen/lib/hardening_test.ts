/**
 * Tests for the reference-inspired hardening in the generated Snyk _lib:
 * instance-name sanitization and 429 rate-limit retry.
 */

import { assertEquals } from "@std/assert";
import { generateApiLib } from "./extension_generator.ts";

Deno.test("generateApiLib: exports sanitizeInstanceName", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("export function sanitizeInstanceName("), true);
});

Deno.test("generateApiLib: retries on 429 honoring Retry-After", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("status !== 429"), true);
  assertEquals(lib.includes('headers.get("Retry-After")'), true);
  assertEquals(lib.includes("const MAX_RETRIES = 3"), true);
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
