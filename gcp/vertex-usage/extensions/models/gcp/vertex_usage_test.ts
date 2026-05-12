// GCP Vertex Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { model } from "./vertex_usage.ts";

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/gcp/vertex-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments requires projects array", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("model globalArguments accepts projects array", () => {
  const parsed = model.globalArguments.parse({ projects: ["my-project"] });
  assertEquals(parsed.projects, ["my-project"]);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_projects" in model.methods, true);
  assertEquals("get_token_usage" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_projects rejects days=0", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_projects accepts days=1", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_projects defaults days to 30", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

Deno.test("get_token_usage requires project", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("get_token_usage rejects days=0", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({ project: "test", days: 0 });
  assertEquals(result.success, false);
});
