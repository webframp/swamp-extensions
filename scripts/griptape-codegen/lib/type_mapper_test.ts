/**
 * Tests for the type mapper — focused on Griptape-specific normalization.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { normalizePattern, schemaToZod } from "./type_mapper.ts";

Deno.test("normalizePattern: fixes the malformed Griptape UUID hex class", () => {
  const bad =
    "^[0-9(a-f|A-F)]{8}-[0-9(a-f|A-F)]{4}-4[0-9(a-f|A-F)]{3}-[89ab][0-9(a-f|A-F)]{3}-[0-9(a-f|A-F)]{12}$";
  const good =
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
  assertEquals(normalizePattern(bad), good);
});

Deno.test("normalizePattern: leaves a well-formed pattern unchanged", () => {
  const p = "^[a-z0-9-]+$";
  assertEquals(normalizePattern(p), p);
});

Deno.test("normalizePattern: the fixed class rejects stray parens/pipes", () => {
  const good = normalizePattern("^[0-9(a-f|A-F)]{8}$");
  const re = new RegExp(good);
  // Literal '(' '|' ')' must NOT satisfy the hex class after normalization.
  assertEquals(re.test("(((((((("), false);
  assertEquals(re.test("deadbeef"), true);
});

Deno.test("schemaToZod: date-time field is nullable (lifecycle timestamps)", () => {
  const zod = schemaToZod({ type: "string", format: "date-time" });
  assertStringIncludes(zod, ".nullable()");
});

Deno.test("schemaToZod: spec-nullable date-time is not double-wrapped", () => {
  const zod = schemaToZod({
    type: "string",
    format: "date-time",
    nullable: true,
  });
  // Exactly one .nullable() (the outer wrapper), not two.
  assertEquals(zod.match(/\.nullable\(\)/g)?.length, 1);
});
Deno.test("schemaToZod: emits the normalized regex for a UUID field", () => {
  const zod = schemaToZod({
    type: "string",
    pattern:
      "^[0-9(a-f|A-F)]{8}-[0-9(a-f|A-F)]{4}-4[0-9(a-f|A-F)]{3}-[89ab][0-9(a-f|A-F)]{3}-[0-9(a-f|A-F)]{12}$",
  });
  assertStringIncludes(zod, "[0-9a-fA-F]");
  assertEquals(zod.includes("(a-f|A-F)"), false);
});
