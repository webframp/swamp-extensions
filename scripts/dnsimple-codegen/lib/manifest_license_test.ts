import { assertEquals } from "@std/assert";
import { generateManifest } from "./extension_generator.ts";

Deno.test("generateManifest: declares an SPDX license (registry has-license point)", () => {
  const manifest = generateManifest(
    // deno-lint-ignore no-explicit-any
    { name: "demo", description: "Demo", labels: ["demo"], tags: [] } as any,
    "2026.01.01.1",
    "demo.ts",
  );
  assertEquals(/^license: Apache-2\.0$/m.test(manifest), true);
});
