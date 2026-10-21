/**
 * The sensitive-path helper emitted into generated tests must find exactly
 * the fields swamp's extractSensitiveFields moves into a vault: object fields
 * through optional, nullable and default wrappers, and no others.
 */

import { assertEquals } from "@std/assert";
import { swampSensitivePathsHelper } from "./test_generator.ts";

Deno.test("generated swampSensitivePaths: unwraps only the wrappers swamp unwraps", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(
      tmp,
      `// deno-lint-ignore-file
import { z } from "npm:zod@4.6.5";
${swampSensitivePathsHelper()}
const secret = () => z.string().meta({ sensitive: true });
export const paths = swampSensitivePaths(z.object({
  plain: secret(),
  optional: secret().optional(),
  outerMeta: z.string().optional().meta({ sensitive: true }),
  nullableDefault: secret().nullable().default(null),
  readonlyField: secret().readonly(),
  caught: secret().catch(""),
  nested: z.object({ token: secret() }).optional(),
  hiddenNested: z.object({ token: secret() }).readonly(),
  list: z.array(z.object({ token: secret() })),
  markedObject: z.object({ inner: secret() }).meta({ sensitive: true }),
}));
export const wrappedRoot = swampSensitivePaths(z.object({ a: secret() }).readonly());
`,
    );
    const mod = await import(`file://${tmp}`);
    // Checked against swamp's own extractSensitiveFields for this schema.
    assertEquals([...mod.paths].sort(), [
      "markedObject",
      "markedObject.inner",
      "nested.token",
      "nullableDefault",
      "optional",
      "outerMeta",
      "plain",
    ]);
    assertEquals(mod.wrappedRoot, []);
  } finally {
    await Deno.remove(tmp);
  }
});
