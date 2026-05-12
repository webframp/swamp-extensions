// AWS Bedrock Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { model } from "./bedrock_usage.ts";

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/bedrock-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments defaults profiles to ['default']", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.profiles, ["default"]);
  assertEquals(parsed.regions, ["us-east-1", "us-west-2"]);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
  assertEquals("active_models" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_accounts" in model.methods, true);
  assertEquals("get_token_usage" in model.methods, true);
  assertEquals("list_active_models" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_accounts rejects days=0", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_accounts accepts days=1", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_accounts defaults days to 30", () => {
  const schema = model.methods.scan_accounts.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

Deno.test("get_token_usage rejects days=0", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});
