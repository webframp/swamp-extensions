// AI Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { model } from "./ai_usage.ts";

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/ai-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments accepts empty object", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(typeof parsed, "object");
});

Deno.test("model defines expected resources", () => {
  assertEquals("status" in model.resources, true);
  assertEquals("report" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("status" in model.methods, true);
  assertEquals("generate" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("generate rejects days=0", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("generate accepts days=1", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("generate defaults days to 30", () => {
  const schema = model.methods.generate.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});
