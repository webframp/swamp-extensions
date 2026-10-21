import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { INSTRUMENTATION_VERSION } from "./tracing.ts";

Deno.test("INSTRUMENTATION_VERSION matches manifest.yaml version", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../../../manifest.yaml", import.meta.url),
  );
  const match = manifest.match(/^version:\s*"([^"]+)"\s*$/m);
  assertMatch(manifest, /^version:/m);
  assertEquals(INSTRUMENTATION_VERSION, match?.[1]);
});
