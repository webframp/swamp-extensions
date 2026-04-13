import { assertEquals } from "jsr:@std/assert@1";
import { createDriverTestContext } from "@systeminit/swamp-testing";
import { driver } from "./nix_driver.ts";

Deno.test("nix: exports driver with correct type", () => {
  assertEquals(driver.type, "@webframp/nix");
  assertEquals(driver.name, "Nix Shell");
  assertEquals(typeof driver.createDriver, "function");
});

Deno.test("nix: requires packages in config", () => {
  try {
    driver.createDriver({});
    throw new Error("should have thrown");
  } catch (e) {
    assertEquals(
      (e as Error).message.includes("requires 'packages' array"),
      true,
    );
  }
});

Deno.test("nix: requires non-empty packages array", () => {
  try {
    driver.createDriver({ packages: [] });
    throw new Error("should have thrown");
  } catch (e) {
    assertEquals(
      (e as Error).message.includes("at least one package"),
      true,
    );
  }
});

Deno.test("nix: creates driver instance with valid config", () => {
  const instance = driver.createDriver({ packages: ["dig"] });
  assertEquals(instance.type, "@webframp/nix");
  assertEquals(typeof instance.execute, "function");
});

Deno.test("nix: returns error when no bundle or run command", async () => {
  const instance = driver.createDriver({ packages: ["dig"] });
  const { request } = createDriverTestContext({
    methodName: "run",
    methodArgs: {},
  });

  const result = await instance.execute(request);
  assertEquals(result.status, "error");
  assertEquals(
    result.error!.includes("requires either a bundle or a 'run' string"),
    true,
  );
});

Deno.test("nix: returns error for empty run string", async () => {
  const instance = driver.createDriver({ packages: ["dig"] });
  const { request } = createDriverTestContext({
    methodName: "run",
    methodArgs: { run: "   " },
  });

  const result = await instance.execute(request);
  assertEquals(result.status, "error");
});

// Integration test: only runs when nix is available
const nixAvailable = await (async () => {
  try {
    const cmd = new Deno.Command("nix", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const status = await cmd.output();
    return status.success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "nix: command mode executes in nix shell",
  ignore: !nixAvailable,
  // nix shell spawns subprocesses that may hold resources briefly
  sanitizeResources: false,
  async fn() {
    const instance = driver.createDriver({
      packages: ["coreutils"],
      impure: true,
    });
    const { request, callbacks, getCapturedLogs } = createDriverTestContext({
      methodName: "run",
      methodArgs: { run: "echo hello-from-nix" },
    });

    const result = await instance.execute(request, callbacks);

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 1);

    const output = result.outputs[0];
    assertEquals(output.kind, "pending");
    const content = new TextDecoder().decode(output.content);
    assertEquals(content.trim(), "hello-from-nix");

    const logs = getCapturedLogs();
    assertEquals(
      logs.some((l) => l.line.includes("[nix] Running command")),
      true,
    );
  },
});

Deno.test({
  name: "nix: command mode with pinned nixpkgs rev",
  ignore: !nixAvailable,
  sanitizeResources: false,
  async fn() {
    const instance = driver.createDriver({
      packages: ["coreutils"],
      nixpkgsRev: "nixos-unstable",
      impure: true,
    });
    const { request, callbacks, getCapturedLogs } = createDriverTestContext({
      methodName: "run",
      methodArgs: { run: "echo pinned-rev-test" },
    });

    const result = await instance.execute(request, callbacks);

    assertEquals(result.status, "success");
    const content = new TextDecoder().decode(result.outputs[0].content);
    assertEquals(content.trim(), "pinned-rev-test");

    const logs = getCapturedLogs();
    assertEquals(
      logs.some((l) => l.line.includes("nixpkgs rev")),
      true,
    );
  },
});

Deno.test({
  name: "nix: command mode captures non-zero exit as error",
  ignore: !nixAvailable,
  sanitizeResources: false,
  async fn() {
    const instance = driver.createDriver({
      packages: ["coreutils"],
      impure: true,
    });
    const { request, callbacks } = createDriverTestContext({
      methodName: "run",
      methodArgs: { run: "exit 42" },
    });

    const result = await instance.execute(request, callbacks);

    assertEquals(result.status, "error");
    assertEquals(result.durationMs > 0, true);
  },
});
