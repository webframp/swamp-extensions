import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./container_image.ts";

type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean; code?: number };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const OriginalCommand = Deno.Command;

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    #cmd: string;
    #args: string[];

    constructor(
      cmd: string,
      options: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = options?.args ?? [];
    }

    output(): Promise<{
      success: boolean;
      code: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        code: result.code ?? (result.success ? 0 : 1),
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode("command failed"),
      });
    }
  };

  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

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

// ---------------------------------------------------------------------------
// Execute tests with mocked Deno.Command
// ---------------------------------------------------------------------------

Deno.test("build execute: success path writes resource", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("buildx")) {
      return { stdout: "", success: true };
    }
    // docker image inspect for imageId
    return { stdout: "sha256:abc123\n", success: true };
  }, async () => {
    const written: Array<{ specName: string; name: string; data: unknown }> =
      [];
    const context = {
      globalArgs: { command: "docker" },
      logger: { info: () => {} },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    };

    const result = await model.methods.build.execute(
      { contextPath: "/tmp/app", tag: "myrepo:v1" },
      context as Parameters<typeof model.methods.build.execute>[1],
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "build");
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.tag, "myrepo:v1");
    assertEquals(data.imageId, "sha256:abc123");
    assertEquals(data.contextPath, "/tmp/app");
  });
});

Deno.test("build execute: failure throws with stderr", async () => {
  await assertRejects(
    () =>
      withMockedCommand((_cmd, _args) => {
        return { stdout: "", success: false, code: 1 };
      }, async () => {
        const context = {
          globalArgs: { command: "docker" },
          logger: { info: () => {} },
          writeResource: () => Promise.resolve({ name: "x" }),
        };
        await model.methods.build.execute(
          { contextPath: "/tmp/app", tag: "myrepo:v1" },
          context as unknown as Parameters<
            typeof model.methods.build.execute
          >[1],
        );
      }),
    Error,
    "Build failed",
  );
});

Deno.test("inspect execute: success path writes metadata", async () => {
  const inspectJson = JSON.stringify({
    Id: "sha256:def456",
    RepoDigests: ["myrepo@sha256:digest123"],
    Architecture: "arm64",
    Os: "linux",
    Size: 52428800,
    Created: "2026-06-12T00:00:00Z",
  });
  await withMockedCommand((_cmd, _args) => {
    return { stdout: inspectJson, success: true };
  }, async () => {
    const written: Array<{ specName: string; data: unknown }> = [];
    const context = {
      globalArgs: { command: "docker" },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, data });
        return Promise.resolve({ name });
      },
    };

    const result = await model.methods.inspect.execute(
      { tag: "myrepo:v1" },
      context as Parameters<typeof model.methods.inspect.execute>[1],
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "inspect");
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.id, "sha256:def456");
    assertEquals(data.architecture, "arm64");
    assertEquals(data.os, "linux");
    assertEquals(data.size, 52428800);
  });
});

Deno.test("inspect execute: empty stdout throws", async () => {
  await assertRejects(
    () =>
      withMockedCommand((_cmd, _args) => {
        return { stdout: "", success: true };
      }, async () => {
        const context = {
          globalArgs: { command: "docker" },
          writeResource: () => Promise.resolve({ name: "x" }),
        };
        await model.methods.inspect.execute(
          { tag: "myrepo:v1" },
          context as unknown as Parameters<
            typeof model.methods.inspect.execute
          >[1],
        );
      }),
    Error,
    "empty output",
  );
});
