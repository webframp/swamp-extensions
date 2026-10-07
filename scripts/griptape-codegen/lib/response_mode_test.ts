/**
 * Tests for response-side schema tolerance and description truncation.
 *
 * Response schemas are observational: a single unexpected value must not fail a
 * whole page of results. Request schemas stay strict.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { schemaToZod, truncateAtWord } from "./type_mapper.ts";
import type { SchemaObject } from "./schema_fetcher.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";

const entity: SchemaObject = {
  type: "object",
  required: ["id", "status", "count", "created_at"],
  properties: {
    id: {
      type: "string",
      pattern: "^[0-9(a-f|A-F)]{8}$",
      minLength: 8,
      maxLength: 8,
    },
    status: { type: "string", enum: ["a", "b"] },
    count: { type: "integer", minimum: 1, maximum: 5 },
    created_at: { type: "string", format: "date-time" },
    level: { type: "integer", enum: [1, 2] },
    meta: { type: "object", properties: { k: { type: "string" } } },
    tags: { type: "array", items: { type: "string", enum: ["x"] } },
    plan: { type: "string", default: "free" },
  },
};

Deno.test("schemaToZod request mode: keeps enums, constraints, and required fields", () => {
  const zod = schemaToZod(entity, { indent: 2 }, 1);
  assertStringIncludes(zod, `z.enum(["a", "b"])`);
  assertStringIncludes(zod, ".min(1)");
  assertStringIncludes(zod, ".max(5)");
  assertStringIncludes(zod, ".regex(");
  assertStringIncludes(zod, `id: z.string()`);
  assertEquals(
    zod.includes("id: z.string().min(8).max(8).regex(new RegExp("),
    true,
  );
  assertStringIncludes(zod, `.default("free")`);
  // Required fields are not optional.
  assertEquals(/\bid:[^\n]*\.optional\(\)/.test(zod), false);
});

Deno.test("schemaToZod response mode: enums become their base type", () => {
  const zod = schemaToZod(entity, { indent: 2, mode: "response" }, 1);
  assertEquals(zod.includes("z.enum("), false);
  assertStringIncludes(zod, "status: z.string().nullish()");
  assertStringIncludes(zod, "level: z.number().nullish()");
  assertStringIncludes(zod, "tags: z.array(z.string()).nullish()");
});

Deno.test("schemaToZod response mode: constraints and patterns are dropped", () => {
  const zod = schemaToZod(entity, { indent: 2, mode: "response" }, 1);
  for (const frag of [".min(", ".max(", ".regex(", ".int()"]) {
    assertEquals(zod.includes(frag), false, frag);
  }
});

Deno.test("schemaToZod response mode: every field is nullish, required or not", () => {
  const zod = schemaToZod(entity, { indent: 2, mode: "response" }, 1);
  assertStringIncludes(zod, "id: z.string().nullish()");
  assertStringIncludes(zod, "count: z.number().nullish()");
  assertStringIncludes(zod, "created_at: z.string().nullish()");
  // No doubled null handling from the date-time or nullable wrappers.
  assertEquals(zod.includes(".nullable().nullish()"), false);
  assertEquals(zod.includes(".optional()"), false);
});

Deno.test("schemaToZod response mode: unknown keys are preserved at every level", () => {
  const zod = schemaToZod(entity, { indent: 2, mode: "response" }, 1);
  assertStringIncludes(zod, "z.looseObject({");
  assertStringIncludes(zod, "meta: z.looseObject({");
  assertEquals(zod.includes("z.object("), false);
  // Freeform objects keep their keys too.
  assertEquals(
    schemaToZod({ type: "object" }, { mode: "response" }),
    "z.looseObject({})",
  );
});

Deno.test("schemaToZod response mode: spec defaults are not fabricated", () => {
  const zod = schemaToZod(entity, { indent: 2, mode: "response" }, 1);
  assertEquals(zod.includes(".default("), false);
});

Deno.test("schemaToZod response mode: mixed enums fall back to z.unknown()", () => {
  assertEquals(
    schemaToZod({ enum: ["a", 1] }, { mode: "response" }),
    "z.unknown()",
  );
});

Deno.test("generated model: response schemas are tolerant, request args stay strict", () => {
  const op: GroupedOperation = {
    httpMethod: "post",
    path: "/api/things",
    operationId: "CreateThing",
    summary: "Create a thing",
    description: "",
    pathParams: [],
    queryParams: [],
    requestBody: {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["alpha", "beta"] } },
    },
    responseSchema: entity,
    isCollection: false,
    deprecated: false,
    tags: [],
  };
  const group: ServiceGroup = {
    config: {
      name: "things",
      description: "Things",
      pathPrefixes: ["/api/things"],
      labels: [],
    },
    operations: [op],
  };
  const src = generateModelSource(
    group,
    classifyServiceMethods(group),
    "0.0.0.0",
  );
  // Request side: strict enum survives.
  assertStringIncludes(src, `kind: z.enum(["alpha", "beta"])`);
  // Response side: the strict enum on `status` does not.
  assertStringIncludes(src, "status: z.string().nullish()");
  assertEquals(src.includes(`z.enum(["a", "b"])`), false);
});

// ---------------------------------------------------------------------------
// truncateAtWord
// ---------------------------------------------------------------------------

Deno.test("truncateAtWord: short text passes through, whitespace collapsed", () => {
  assertEquals(truncateAtWord("  hello \n  world  ", 100), "hello world");
});

Deno.test("truncateAtWord: never ends mid-word and respects the limit", () => {
  const text =
    "The quick brown fox jumps over the lazy dog and keeps running through the extraordinarily verbose meadow";
  const out = truncateAtWord(text, 40);
  assertEquals(out.length <= 40, true);
  assertEquals(out.endsWith("..."), true);
  const body = out.slice(0, -3);
  // The kept text is a whole-word prefix of the original.
  assertEquals(text.startsWith(body), true);
  assertEquals(text[body.length], " ");
});

Deno.test("truncateAtWord: a word ending exactly at the budget survives", () => {
  // 10 chars budget = 7 + "..."; "abcdefg" fits exactly, next char is a space.
  assertEquals(truncateAtWord("abcdefg hijklm nop", 10), "abcdefg...");
});

Deno.test("truncateAtWord: trailing punctuation is trimmed before the ellipsis", () => {
  assertEquals(truncateAtWord("alpha beta, gamma delta", 16), "alpha beta...");
});

Deno.test("truncateAtWord: a single over-long word is hard-cut", () => {
  const out = truncateAtWord("x".repeat(200), 20);
  assertEquals(out, "x".repeat(17) + "...");
});
