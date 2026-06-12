import { assertEquals } from "@std/assert";
import { model } from "./provisioner.ts";

Deno.test("model export has correct type and version", () => {
  assertEquals(model.type, "@webframp/agentcore-bootstrap/provisioner");
  assertEquals(model.version, "2026.06.12.1");
});

Deno.test("model has provision method", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.includes("provision"), true);
  assertEquals(methodNames.length, 1);
});

Deno.test("model has provision resource spec", () => {
  const specNames = Object.keys(model.resources);
  assertEquals(specNames.includes("provision"), true);
});

Deno.test("globalArguments applies correct defaults", () => {
  const parsed = model.globalArguments.parse({
    bucket_name: "my-test-bucket",
  });
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.ecr_repo_name, "swamp-agentcore-worker");
  assertEquals(parsed.runtime_name, "swamp-worker");
  assertEquals(parsed.role_name, "SwampAgentCoreWorkerRole");
});

Deno.test("globalArguments rejects invalid bucket names", () => {
  const result = model.globalArguments.safeParse({
    bucket_name: "INVALID",
  });
  assertEquals(result.success, false);
});

Deno.test("globalArguments rejects short bucket names", () => {
  const result = model.globalArguments.safeParse({
    bucket_name: "ab",
  });
  assertEquals(result.success, false);
});

Deno.test("provision method arguments apply defaults", () => {
  const parsed = model.methods.provision.arguments.parse({});
  assertEquals(parsed.workerContextPath, "worker");
  assertEquals(parsed.platform, "linux/arm64");
});
