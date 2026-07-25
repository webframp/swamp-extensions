import { assertEquals } from "@std/assert";
import { model } from "./maintainer.ts";

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/extension-maintenance/maintainer");
  assertEquals(model.version, "2026.07.25.2");
});

Deno.test("model has all four methods", () => {
  assertEquals(typeof model.methods.audit.execute, "function");
  assertEquals(typeof model.methods["plan-bump"].execute, "function");
  assertEquals(typeof model.methods["apply-bump"].execute, "function");
  assertEquals(typeof model.methods["quality-gate"].execute, "function");
});

Deno.test("model has all four resources", () => {
  assertEquals(model.resources.audit.lifetime, "infinite");
  assertEquals(model.resources.plan.lifetime, "infinite");
  assertEquals(model.resources.apply.lifetime, "infinite");
  assertEquals(model.resources.quality.lifetime, "infinite");
});

Deno.test("globalArguments validates defaults", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.repo_root, ".");
  assertEquals(parsed.registry_timeout, 30);
});

Deno.test("globalArguments validates registry_timeout range", () => {
  const tooLow = model.globalArguments.safeParse({ registry_timeout: 2 });
  assertEquals(tooLow.success, false);

  const tooHigh = model.globalArguments.safeParse({ registry_timeout: 200 });
  assertEquals(tooHigh.success, false);

  const valid = model.globalArguments.safeParse({ registry_timeout: 60 });
  assertEquals(valid.success, true);
});

Deno.test("audit arguments accepts optional filter", () => {
  const valid = model.methods.audit.arguments.safeParse({});
  assertEquals(valid.success, true);

  const withFilter = model.methods.audit.arguments.safeParse({
    filter: "aws/",
  });
  assertEquals(withFilter.success, true);
});

Deno.test("plan-bump arguments defaults skip_testing to false", () => {
  const parsed = model.methods["plan-bump"].arguments.parse({});
  assertEquals(parsed.skip_testing, false);
});

Deno.test("apply-bump arguments defaults dry_run to false", () => {
  const parsed = model.methods["apply-bump"].arguments.parse({});
  assertEquals(parsed.dry_run, false);
});

Deno.test("quality-gate arguments accepts optional filter and stop_on_failure", () => {
  const valid = model.methods["quality-gate"].arguments.safeParse({
    filter: "cloudflare",
    stop_on_failure: true,
  });
  assertEquals(valid.success, true);
});
