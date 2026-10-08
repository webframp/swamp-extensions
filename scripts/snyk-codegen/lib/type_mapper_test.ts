// SPDX-License-Identifier: Apache-2.0
import { assertEquals, assertStringIncludes } from "@std/assert";
import { schemaToZod, truncateAtBoundary } from "./type_mapper.ts";
import type { SchemaObject } from "./schema_fetcher.ts";

const SCHEMA: SchemaObject = {
  type: "object",
  required: ["id", "kind"],
  properties: {
    id: { type: "string", minLength: 2, maxLength: 9, pattern: "^a" },
    kind: { type: "string", enum: ["a", "b"] },
    count: { type: "integer", minimum: 1, maximum: 5, default: 3 },
    flag: { type: "boolean", enum: [true] },
    nested: {
      type: "object",
      required: ["level"],
      properties: { level: { type: "string", enum: ["low", "high"] } },
    },
  },
};

Deno.test("schemaToZod strict mode keeps enums, constraints and required fields", () => {
  const out = schemaToZod(SCHEMA, { indent: 2 }, 1);
  assertStringIncludes(out, 'kind: z.enum(["a", "b"])');
  assertStringIncludes(out, "z.string().min(2).max(9).regex(");
  assertStringIncludes(out, "z.number().int().min(1).max(5).optional()");
  assertStringIncludes(out, ".default(3)");
  assertEquals(
    out.includes(
      'id: z.string().min(2).max(9).regex(new RegExp("^a")).optional()',
    ),
    false,
  );
});

Deno.test("schemaToZod lenient mode accepts unexpected response values", () => {
  const out = schemaToZod(SCHEMA, { indent: 2, lenient: true }, 1);
  // Enums widen to their primitive type, so a new server-side value parses.
  assertEquals(out.includes("z.enum("), false);
  assertStringIncludes(out, "kind: z.string().nullish()");
  assertStringIncludes(out, "flag: z.boolean().nullish()");
  assertStringIncludes(out, "level: z.string().nullish()");
  // Constraints and defaults are dropped; every property is nullish (the API
  // returns null for attributes the spec types as plain values).
  assertStringIncludes(out, "id: z.string().nullish()");
  assertStringIncludes(out, "count: z.number().nullish()");
  assertEquals(out.includes(".min("), false);
  assertEquals(out.includes(".int()"), false);
  assertEquals(out.includes(".regex("), false);
  assertEquals(out.includes(".default("), false);
});

Deno.test("schemaToZod lenient mode widens a mixed enum to unknown", () => {
  const out = schemaToZod({ type: "string", enum: ["a", 1] }, {
    lenient: true,
  });
  assertEquals(out, "z.unknown()");
});

Deno.test("schemaToZod lenient mode keeps nullable and array shape", () => {
  const out = schemaToZod(
    { type: "array", items: { type: "string", enum: ["x"] }, nullable: true },
    { lenient: true },
  );
  assertEquals(out, "z.array(z.string()).nullable()");
});

Deno.test("truncateAtBoundary leaves short text alone and collapses whitespace", () => {
  assertEquals(truncateAtBoundary("one\n  two", 80), "one two");
});

Deno.test("truncateAtBoundary never cuts a word in half", () => {
  const text =
    "Whether the model's risk assessment is complete. A model can have some risk scores while its assessment is partial";
  const out = truncateAtBoundary(text, 80);
  // Prefers the last whole sentence inside the budget.
  assertEquals(out, "Whether the model's risk assessment is complete.");

  const noSentence =
    "matches any provider slug supplied in the query string for this request today";
  const cut = truncateAtBoundary(noSentence, 40);
  assertEquals(cut.endsWith("..."), true);
  assertEquals(cut.length <= 40, true);
  const body = cut.slice(0, -3);
  // The kept text is a whole-word prefix of the original.
  assertEquals(noSentence.startsWith(body), true);
  assertEquals(noSentence[body.length], " ");
});

Deno.test("truncateAtBoundary ignores dots inside words", () => {
  const out = truncateAtBoundary(
    "Use the e.g.value form for the version v1.2 identifier when requesting data from API",
    50,
  );
  assertEquals(out.endsWith("..."), true);
  assertEquals(out.includes("v1.2 ide"), false);
});

Deno.test("schemaToZod lenient mode passes unknown fields through at every depth", () => {
  const out = schemaToZod(SCHEMA, { indent: 2, lenient: true }, 1);
  // Top-level object and the nested object both keep unlisted fields.
  assertEquals((out.match(/\.passthrough\(\)/g) ?? []).length, 2);
  assertEquals(
    schemaToZod({ type: "object" }, { lenient: true }),
    "z.object({}).passthrough()",
  );
  // Strict mode never adds it.
  assertEquals(schemaToZod(SCHEMA, {}, 1).includes("passthrough"), false);
});
