/**
 * Test fixture loader: a pinned snapshot of DNSimple's OpenAPI spec, taken
 * 2026-11-02, so the generator's tests never touch the network. Refresh
 * `openapi.json` deliberately when the generator is taught a new spec shape.
 */

import type { OpenAPISpec } from "./schema_fetcher.ts";

let cached: OpenAPISpec | undefined;

/** The pinned spec. Returns a fresh deep copy so tests may not corrupt it. */
export function loadSpec(): OpenAPISpec {
  cached ??= JSON.parse(
    Deno.readTextFileSync(new URL("./testdata/openapi.json", import.meta.url)),
  ) as OpenAPISpec;
  return structuredClone(cached);
}
