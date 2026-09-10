/**
 * Tests for the extension generator module, including hardening tests for
 * the generated _lib/api.ts helper: 429 retry, error-shape parsing,
 * pagination truncation, and missing-field responses.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  generateApiLib,
  generateDenoJson,
  generateGitignore,
  generateLicense,
  generateManifest,
  generateReadme,
  generateReleaseNotes,
  generateSwampYaml,
} from "./extension_generator.ts";
import type { ServiceConfig } from "../config.ts";

const CONFIG: ServiceConfig = {
  name: "assets",
  description: "fal.ai Assets — media library",
  tags: ["Assets"],
  labels: ["falai", "assets", "media"],
};

// ---------------------------------------------------------------------------
// Static content generators
// ---------------------------------------------------------------------------

Deno.test("generateManifest: uses the @webframp/falai/<name> naming convention", () => {
  const manifest = generateManifest(CONFIG, "2026.01.01.1", "assets.ts");
  assertStringIncludes(manifest, 'name: "@webframp/falai/assets"');
  assertStringIncludes(manifest, "- falai/assets.ts");
  assertStringIncludes(manifest, "- README.md");
  assertStringIncludes(manifest, "- LICENSE.md");
  // No top-level `license:` field per the project's licensing rule.
  assertEquals(/^license:/m.test(manifest), false);
});

Deno.test("generateDenoJson: pins swamp-testing via jsr and excludes no-import-prefix", () => {
  const json = JSON.parse(generateDenoJson());
  assertStringIncludes(
    json.imports["@systeminit/swamp-testing"],
    "jsr:@systeminit/swamp-testing@",
  );
  assertEquals(json.lint.rules.exclude.includes("no-import-prefix"), true);
  assertStringIncludes(json.tasks.check, "extensions/models/falai");
});

Deno.test("generateReadme: usage example carries only apiToken, no scope arg", () => {
  const readme = generateReadme(CONFIG, [
    { name: "list_assets", description: "List assets", type: "list" },
  ]);
  assertStringIncludes(readme, "swamp extension pull @webframp/falai/assets");
  assertStringIncludes(readme, "--global-arg apiToken=FAL_API_KEY");
  assertStringIncludes(readme, "FAL_KEY");
  assertEquals(readme.includes("accountId"), false);
  assertEquals(readme.includes("zoneId"), false);
});

Deno.test("generateReleaseNotes: default body describes an initial release", () => {
  const notes = generateReleaseNotes(CONFIG, "2026.01.01.1", 5);
  assertStringIncludes(notes, "## 2026.01.01.1");
  assertStringIncludes(notes, "Initial code-generated release");
  assertStringIncludes(notes, "@webframp/falai/assets");
});

Deno.test("generateReleaseNotes: an explicit body overrides the initial-release default", () => {
  const notes = generateReleaseNotes(
    CONFIG,
    "2026.01.02.1",
    5,
    "**Fixed:** something",
  );
  assertStringIncludes(notes, "**Fixed:** something");
  assertEquals(notes.includes("Initial code-generated release"), false);
});

Deno.test("generateSwampYaml: preserves an existing repoId across regeneration", () => {
  const yaml = generateSwampYaml("repoVersion: 1\nrepoId: abc-123\n");
  assertStringIncludes(yaml, "repoId: abc-123");
});

Deno.test("generateSwampYaml: omits repoId when there is no existing file", () => {
  const yaml = generateSwampYaml(undefined);
  assertEquals(yaml.includes("repoId:"), false);
});

Deno.test("generateGitignore: excludes local dev-aid files", () => {
  const gitignore = generateGitignore();
  assertStringIncludes(gitignore, ".swamp/");
  assertStringIncludes(gitignore, "CLAUDE.md");
});

Deno.test("generateLicense: Apache-2.0 with the canonical copyright line", () => {
  const license = generateLicense();
  assertStringIncludes(license, "Apache License");
  assertStringIncludes(license, "Copyright 2026 Sean Escriva");
  assertEquals(license.includes("MIT License"), false);
});

// ---------------------------------------------------------------------------
// Hardening tests for the generated _lib/api.ts — source-text assertions,
// mirroring datadog-codegen's hardening_test.ts style.
// ---------------------------------------------------------------------------

Deno.test("generateApiLib: uses Authorization: Key <token>, not Bearer", () => {
  const lib = generateApiLib();
  assertStringIncludes(lib, "`Key ${token}`");
  assertEquals(lib.includes("Bearer"), false);
});

Deno.test("generateApiLib: falls back to the FAL_KEY environment variable", () => {
  const lib = generateApiLib();
  assertStringIncludes(lib, 'Deno.env.get("FAL_KEY")');
});

Deno.test("generateApiLib: base URL is https://api.fal.ai/v1", () => {
  const lib = generateApiLib();
  assertStringIncludes(lib, 'const FAL_API_BASE = "https://api.fal.ai/v1"');
});

Deno.test("generateApiLib: exports sanitizeInstanceName", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("export function sanitizeInstanceName("), true);
});

Deno.test("generateApiLib: retries on 429 honoring Retry-After", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("429"), true);
  assertEquals(lib.includes("Retry-After"), true);
  assertEquals(lib.includes("MAX_RETRIES"), true);
});

Deno.test("generateApiLib: bounds pagination at MAX_PAGES and reports truncated", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("const MAX_PAGES = 20;"), true);
  assertStringIncludes(lib, "truncated: boolean");
});

Deno.test("generateApiLib: falApiPaginated takes an explicit resultsField, never hardcodes a field name", () => {
  const lib = generateApiLib();
  assertStringIncludes(lib, "resultsField: string");
  assertStringIncludes(lib, "data[resultsField]");
});

Deno.test("generateApiLib: extracts error.message from fal.ai's documented error shape", () => {
  const lib = generateApiLib();
  assertStringIncludes(lib, "parsed.error?.message");
});

Deno.test("generateApiLib: sanitizeInstanceName strips path-traversal chars at runtime", async () => {
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, lib);
    const mod = await import(`file://${tmp}`);
    assertEquals(mod.sanitizeInstanceName("a/b\\c..d\0e"), "a_b_c_de");
    assertEquals(mod.sanitizeInstanceName("plain"), "plain");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test({
  name:
    "generateApiLib: falApiPaginated stops and reports truncated when a page never shrinks and no cursor is offered",
  // The imported module makes real fetch() calls against a local mock server;
  // the underlying HTTP client keeps connection-pool resources open beyond
  // this test's lifetime, so sanitizeResources is disabled deliberately.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const lib = generateApiLib();
    const tmp = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      await Deno.writeTextFile(tmp, lib);
      const mod = await import(`file://${tmp}`);

      const server = Deno.serve({ port: 0, onListen() {} }, () => {
        // Always return exactly `limit` (100) items, no has_more/next_cursor,
        // and no cursor to advance with — the codegen's fallback heuristic
        // must not loop forever when the API gives it nothing to advance on.
        const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        return Response.json({ instances: items });
      });
      const addr = server.addr as Deno.NetAddr;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const reqUrl = typeof input === "string" ? input : input.toString();
        const newUrl = reqUrl.replace(
          "https://api.fal.ai/v1",
          `http://localhost:${addr.port}`,
        );
        return originalFetch(newUrl, init);
      };

      try {
        const result = await mod.falApiPaginated(
          "test-token",
          "/compute/instances",
          "instances",
        );
        // Stops on page 1 because there's no cursor to advance with. The
        // page came back exactly at the requested limit, so more results
        // may exist that this call can't reach — truncated must say so.
        assertEquals(result.results.length, 100);
        assertEquals(result.truncated, true);
      } finally {
        globalThis.fetch = originalFetch;
        await server.shutdown();
      }
    } finally {
      await Deno.remove(tmp);
    }
  },
});

Deno.test({
  name:
    "generateApiLib: falApiPaginated handles a missing results field as an empty page",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const lib = generateApiLib();
    const tmp = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      await Deno.writeTextFile(tmp, lib);
      const mod = await import(`file://${tmp}`);

      const server = Deno.serve({ port: 0, onListen() {} }, () => {
        // Response body omits the expected "instances" field entirely.
        return Response.json({ unexpected: true });
      });
      const addr = server.addr as Deno.NetAddr;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const reqUrl = typeof input === "string" ? input : input.toString();
        const newUrl = reqUrl.replace(
          "https://api.fal.ai/v1",
          `http://localhost:${addr.port}`,
        );
        return originalFetch(newUrl, init);
      };

      try {
        const result = await mod.falApiPaginated(
          "test-token",
          "/compute/instances",
          "instances",
        );
        assertEquals(result.results.length, 0);
        assertEquals(result.truncated, false);
      } finally {
        globalThis.fetch = originalFetch;
        await server.shutdown();
      }
    } finally {
      await Deno.remove(tmp);
    }
  },
});
