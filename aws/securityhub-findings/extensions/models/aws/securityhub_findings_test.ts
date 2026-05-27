/**
 * Unit tests for @webframp/aws/securityhub-findings model.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./securityhub_findings.ts";

// =============================================================================
// Test helpers
// =============================================================================

function createMockContext() {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    globalArgs: { region: "us-east-1" },
    logger: {
      info: (msg: string, _props?: Record<string, unknown>) => {
        logs.push(msg);
      },
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
    written,
    logs,
  };
}

// =============================================================================
// Model structure tests
// =============================================================================

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/aws/securityhub-findings");
  assertEquals(typeof model.version, "string");
  assertEquals(model.version.startsWith("2026."), true);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.includes("list_findings"), true);
  assertEquals(methodNames.includes("get_finding_details"), true);
  assertEquals(methodNames.includes("get_severity_summary"), true);
  assertEquals(methodNames.includes("archive_findings"), true);
  assertEquals(methodNames.includes("resolve_findings"), true);
  assertEquals(methodNames.includes("reopen_findings"), true);
});

Deno.test("model has all expected resource specs", () => {
  const specs = Object.keys(model.resources);
  assertEquals(specs.includes("finding_list"), true);
  assertEquals(specs.includes("finding_details"), true);
  assertEquals(specs.includes("severity_summary"), true);
  assertEquals(specs.includes("update_result"), true);
});

Deno.test("all resource specs have lifetime and garbageCollection", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    assertEquals(
      typeof spec.lifetime,
      "string",
      `${name} missing lifetime`,
    );
    assertEquals(
      typeof spec.garbageCollection,
      "number",
      `${name} missing garbageCollection`,
    );
  }
});

// =============================================================================
// ARN validation tests (HIGH finding fix)
// =============================================================================

Deno.test("archive_findings rejects malformed ARN", async () => {
  const ctx = createMockContext();
  await assertRejects(
    () =>
      model.methods.archive_findings.execute(
        { findingArns: ["not-an-arn"], note: "test" },
        ctx,
      ),
    Error,
    "Invalid finding ARN format",
  );
});

Deno.test("archive_findings rejects ARN with too few parts", async () => {
  const ctx = createMockContext();
  await assertRejects(
    () =>
      model.methods.archive_findings.execute(
        { findingArns: ["arn:aws:securityhub"], note: "test" },
        ctx,
      ),
    Error,
    "Invalid finding ARN format",
  );
});

Deno.test("resolve_findings rejects malformed ARN", async () => {
  const ctx = createMockContext();
  await assertRejects(
    () =>
      model.methods.resolve_findings.execute(
        { findingArns: ["bad"], note: "test" },
        ctx,
      ),
    Error,
    "Invalid finding ARN format",
  );
});

Deno.test("reopen_findings rejects malformed ARN", async () => {
  const ctx = createMockContext();
  await assertRejects(
    () =>
      model.methods.reopen_findings.execute(
        { findingArns: [":::"], note: "test" },
        ctx,
      ),
    Error,
    "Invalid finding ARN format",
  );
});

// =============================================================================
// Schema validation tests
// =============================================================================

Deno.test("list_findings arguments schema validates correctly", () => {
  const schema = model.methods.list_findings.arguments;
  const result = schema.safeParse({ startTime: "24h", limit: 50 });
  assertEquals(result.success, true);
});

Deno.test("list_findings arguments rejects limit > 100", () => {
  const schema = model.methods.list_findings.arguments;
  const result = schema.safeParse({ startTime: "24h", limit: 200 });
  assertEquals(result.success, false);
});

Deno.test("list_findings arguments rejects limit < 1", () => {
  const schema = model.methods.list_findings.arguments;
  const result = schema.safeParse({ startTime: "24h", limit: 0 });
  assertEquals(result.success, false);
});

Deno.test("get_finding_details arguments rejects empty array", () => {
  const schema = model.methods.get_finding_details.arguments;
  const result = schema.safeParse({ findingArns: [] });
  assertEquals(result.success, false);
});

Deno.test("archive_findings arguments rejects empty note", () => {
  const schema = model.methods.archive_findings.arguments;
  const result = schema.safeParse({
    findingArns: ["arn:aws:securityhub:us-east-1:123456789012:finding/abc"],
    note: "",
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Logging tests (MEDIUM finding fix)
// =============================================================================

Deno.test("list_findings logs on entry", async () => {
  const ctx = createMockContext();
  // Will fail on AWS call but we can verify logging happened before that
  try {
    await model.methods.list_findings.execute(
      { startTime: "24h", limit: 5 },
      ctx,
    );
  } catch {
    // Expected — no real AWS credentials in test
  }
  assertEquals(ctx.logs.length > 0, true);
  assertEquals(ctx.logs[0], "Listing findings");
});

Deno.test("get_finding_details logs on entry", async () => {
  const ctx = createMockContext();
  try {
    await model.methods.get_finding_details.execute(
      { findingArns: ["arn:aws:securityhub:us-east-1:123:finding/x"] },
      ctx,
    );
  } catch {
    // Expected
  }
  assertEquals(ctx.logs[0], "Getting details for {count} findings");
});

Deno.test("get_severity_summary logs on entry", async () => {
  const ctx = createMockContext();
  try {
    await model.methods.get_severity_summary.execute(
      { startTime: "24h" },
      ctx,
    );
  } catch {
    // Expected
  }
  assertEquals(ctx.logs[0], "Generating severity summary");
});

Deno.test("archive_findings logs on entry before ARN validation", async () => {
  const ctx = createMockContext();
  try {
    await model.methods.archive_findings.execute(
      {
        findingArns: ["arn:aws:securityhub:us-east-1:123456789012:finding/x"],
        note: "test",
      },
      ctx,
    );
  } catch {
    // Expected — will fail on AWS call
  }
  assertEquals(ctx.logs[0], "Updating {count} findings to {status}");
});
