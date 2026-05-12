// Azure OpenAI Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { model } from "./openai_usage.ts";

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/azure/openai-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments requires subscriptions array", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("model globalArguments accepts subscriptions array", () => {
  const parsed = model.globalArguments.parse({
    subscriptions: ["sub-123"],
  });
  assertEquals(parsed.subscriptions, ["sub-123"]);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_subscriptions" in model.methods, true);
  assertEquals("list_ai_resources" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_subscriptions rejects days=0", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_subscriptions accepts days=1", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_subscriptions defaults days to 30", () => {
  const schema = model.methods.scan_subscriptions.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});
