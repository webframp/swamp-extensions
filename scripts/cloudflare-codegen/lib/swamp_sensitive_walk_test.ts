/**
 * The sensitive-path helper emitted into generated tests must find exactly
 * the fields swamp's extractSensitiveFields moves into a vault: object fields
 * through optional, nullable and default wrappers, and no others.
 */

import { assertEquals } from "@std/assert";
import { generateSecretHelpers } from "./test_generator.ts";

Deno.test("generated sensitivePathsOf: unwraps only the wrappers swamp unwraps", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(
      tmp,
      `import { z } from "npm:zod@4.6.5";
${generateSecretHelpers()}
const secret = () => z.string().meta({ sensitive: true });
const schema = z.object({
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
});
export const paths = sensitivePathsOf(schema).map((p) => p.join("."));
export const wrappedRoot = sensitivePathsOf(z.object({ a: secret() }).readonly());
export const persisted = persistedLikeSwamp(schema, {
  plain: "p",
  readonlyField: "r",
  nested: { token: "t" },
  optional: null,
});
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
    // Present values become references; a null and an unmarked field stay.
    assertEquals(mod.persisted, {
      plain: "${{ vault.get('test-vault', 'plain') }}",
      readonlyField: "r",
      nested: { token: "${{ vault.get('test-vault', 'nested.token') }}" },
      optional: null,
    });
  } finally {
    await Deno.remove(tmp);
  }
});
