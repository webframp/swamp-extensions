import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createDriverTestContext } from "@systeminit/swamp-testing";
import { driver } from "./dry_run.ts";

Deno.test("dry-run: exports driver with correct type", () => {
  assertEquals(driver.type, "@webframp/dry-run");
  assertEquals(driver.name, "Dry Run");
  assertEquals(typeof driver.createDriver, "function");
});

Deno.test("dry-run: creates driver instance", () => {
  const instance = driver.createDriver();
  assertEquals(instance.type, "@webframp/dry-run");
  assertEquals(typeof instance.execute, "function");
});

Deno.test("dry-run: captures request without executing", async () => {
  const instance = driver.createDriver();
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    modelType: "@webframp/aws/inventory",
    methodName: "describe_instances",
    globalArgs: { region: "us-east-1" },
    methodArgs: { filters: [] },
    definitionMeta: {
      name: "aws-inventory",
      version: 3,
      tags: { env: "prod" },
    },
  });

  const result = await instance.execute(request, callbacks);

  assertEquals(result.status, "success");
  assertEquals(result.durationMs >= 0, true);
  assertEquals(result.outputs.length, 1);

  const output = result.outputs[0];
  assertEquals(output.kind, "pending");
  if (output.kind === "pending") {
    assertEquals(output.specName, "dry_run_capture");
    assertEquals(output.name, "dry-run-describe_instances");
    assertEquals(output.type, "resource");
    assertEquals(output.tags?.modelType, "@webframp/aws/inventory");
    assertEquals(output.tags?.methodName, "describe_instances");

    const capture = JSON.parse(new TextDecoder().decode(output.content));
    assertEquals(capture.modelType, "@webframp/aws/inventory");
    assertEquals(capture.methodName, "describe_instances");
    assertEquals(capture.globalArgs, { region: "us-east-1" });
    assertEquals(capture.methodArgs, { filters: [] });
    assertEquals(capture.definitionMeta.name, "aws-inventory");
    assertEquals(capture.definitionMeta.version, 3);
    assertEquals(capture.hasBundle, false);
    assertEquals(capture.bundleSize, 0);
    assertEquals(capture.driver, "@webframp/dry-run");
    assertEquals(typeof capture.capturedAt, "string");
  }

  const logs = getCapturedLogs();
  assertEquals(logs.length >= 4, true);
  assertStringIncludes(
    logs[0].line,
    "[dry-run] Captured request for @webframp/aws/inventory::describe_instances",
  );
});

Deno.test("dry-run: logs resource and file specs", async () => {
  const instance = driver.createDriver();
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "list_metrics",
    resourceSpecs: { metrics: { type: "array" } },
    fileSpecs: { report: { path: "report.json" } },
  });

  const result = await instance.execute(request, callbacks);

  assertEquals(result.status, "success");

  const logs = getCapturedLogs();
  const logLines = logs.map((l) => l.line);
  assertEquals(
    logLines.some((l) => l.includes("Resource specs: metrics")),
    true,
  );
  assertEquals(
    logLines.some((l) => l.includes("File specs: report")),
    true,
  );
});

Deno.test("dry-run: logs bundle info when present", async () => {
  const instance = driver.createDriver();
  const bundle = new TextEncoder().encode("console.log('hello')");
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "run",
    bundle,
  });

  const result = await instance.execute(request, callbacks);

  assertEquals(result.status, "success");

  const output = result.outputs[0];
  if (output.kind === "pending") {
    const capture = JSON.parse(new TextDecoder().decode(output.content));
    assertEquals(capture.hasBundle, true);
    assertEquals(capture.bundleSize, bundle.byteLength);
  }

  const logs = getCapturedLogs();
  const logLines = logs.map((l) => l.line);
  assertEquals(
    logLines.some((l) => l.includes(`Bundle size: ${bundle.byteLength}`)),
    true,
  );
});

Deno.test("dry-run: works without callbacks", async () => {
  const instance = driver.createDriver();
  const { request } = createDriverTestContext({
    methodName: "run",
  });

  const result = await instance.execute(request);

  assertEquals(result.status, "success");
  assertEquals(result.outputs.length, 1);
});

Deno.test("dry-run: logs trace headers when present", async () => {
  const instance = driver.createDriver();
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "run",
    traceHeaders: { traceparent: "00-abc-def-01" },
  });

  const result = await instance.execute(request, callbacks);

  assertEquals(result.status, "success");

  const logs = getCapturedLogs();
  const logLines = logs.map((l) => l.line);
  assertEquals(
    logLines.some((l) => l.includes("Trace headers:")),
    true,
  );
});
