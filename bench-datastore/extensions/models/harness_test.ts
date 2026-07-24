import { assertEquals } from "@std/assert";
import { model } from "./harness.ts";

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/bench-datastore/harness");
  assertEquals(model.version, "2026.07.24.1");
});

Deno.test("model has setup and execute methods", () => {
  assertEquals(typeof model.methods.setup.execute, "function");
  assertEquals(typeof model.methods.execute.execute, "function");
});

Deno.test("model has setup and result resources", () => {
  assertEquals(model.resources.setup.lifetime, "infinite");
  assertEquals(model.resources.result.lifetime, "infinite");
  assertEquals(model.resources.result.garbageCollection, 1000);
});

Deno.test("globalArguments validates scenario enum", () => {
  const valid = model.globalArguments.safeParse({
    scenario: "throughput",
    worker_id: 1,
  });
  assertEquals(valid.success, true);

  const invalid = model.globalArguments.safeParse({
    scenario: "invalid",
    worker_id: 1,
  });
  assertEquals(invalid.success, false);
});

Deno.test("globalArguments defaults models_per_worker to 50", () => {
  const parsed = model.globalArguments.parse({
    scenario: "throughput",
    worker_id: 5,
  });
  assertEquals(parsed.models_per_worker, 50);
});

Deno.test("globalArguments validates worker_id range", () => {
  const tooLow = model.globalArguments.safeParse({
    scenario: "throughput",
    worker_id: 0,
  });
  assertEquals(tooLow.success, false);

  const tooHigh = model.globalArguments.safeParse({
    scenario: "throughput",
    worker_id: 101,
  });
  assertEquals(tooHigh.success, false);
});

Deno.test("execute arguments validates iteration", () => {
  const valid = model.methods.execute.arguments.safeParse({
    iteration: 1,
  });
  assertEquals(valid.success, true);

  const invalid = model.methods.execute.arguments.safeParse({
    iteration: 0,
  });
  assertEquals(invalid.success, false);
});

Deno.test("execute arguments accepts optional payload_size", () => {
  const withSize = model.methods.execute.arguments.safeParse({
    iteration: 1,
    payload_size: "large",
  });
  assertEquals(withSize.success, true);

  const without = model.methods.execute.arguments.safeParse({
    iteration: 42,
  });
  assertEquals(without.success, true);
});

Deno.test("execute arguments rejects invalid payload_size", () => {
  const invalid = model.methods.execute.arguments.safeParse({
    iteration: 1,
    payload_size: "huge",
  });
  assertEquals(invalid.success, false);
});
