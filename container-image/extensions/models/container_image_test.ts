import { assertEquals } from "@std/assert";
import { model } from "./container_image.ts";

Deno.test("model export has correct type and version", () => {
  assertEquals(model.type, "@webframp/container-image");
  assertEquals(model.version, "2026.06.12.1");
});

Deno.test("model has expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.includes("build"), true);
  assertEquals(methodNames.includes("push"), true);
  assertEquals(methodNames.includes("inspect"), true);
  assertEquals(methodNames.includes("login"), true);
});

Deno.test("model has expected resource specs", () => {
  const specNames = Object.keys(model.resources);
  assertEquals(specNames.includes("build"), true);
  assertEquals(specNames.includes("push"), true);
  assertEquals(specNames.includes("inspect"), true);
});

Deno.test("globalArguments defaults command to docker", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.command, "docker");
});

Deno.test("build arguments validates required fields", () => {
  const result = model.methods.build.arguments.safeParse({
    contextPath: "/tmp/myapp",
    tag: "myrepo:latest",
  });
  assertEquals(result.success, true);
});

Deno.test("build arguments rejects missing tag", () => {
  const result = model.methods.build.arguments.safeParse({
    contextPath: "/tmp/myapp",
  });
  assertEquals(result.success, false);
});

Deno.test("push arguments validates tag", () => {
  const result = model.methods.push.arguments.safeParse({
    tag: "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:v1",
  });
  assertEquals(result.success, true);
});

Deno.test("login arguments validates required fields", () => {
  const result = model.methods.login.arguments.safeParse({
    registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    password: "token123",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.username, "AWS");
  }
});

Deno.test("globalArguments accepts buildah as command", () => {
  const parsed = model.globalArguments.parse({ command: "buildah" });
  assertEquals(parsed.command, "buildah");
});
