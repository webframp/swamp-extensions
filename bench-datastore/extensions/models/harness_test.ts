import { assertEquals, assertExists } from "@std/assert";
import { model } from "./harness.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

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

// =============================================================================
// Deno.Command Mock Helper
// =============================================================================

const OriginalCommand = Deno.Command;

interface SpawnedCommand {
  cmd: string;
  args: string[];
  stdinData?: string;
}

type CommandHandler = (
  cmd: string,
  args: string[],
  stdinData?: string,
) => { stdout: string; success: boolean };

/**
 * Mock Deno.Command that supports both .output() and .spawn() with stdin
 * piping. Tracks all spawned commands for assertion.
 */
function withMockedCommand<T>(
  handler: CommandHandler,
  fn: (getCommands: () => SpawnedCommand[]) => Promise<T>,
): Promise<T> {
  const commands: SpawnedCommand[] = [];

  class MockCommand {
    #cmd: string;
    #args: string[];
    #useStdin: boolean;

    constructor(
      cmd: string,
      options: {
        args?: string[];
        stdin?: "piped" | "null";
        stdout?: "piped" | "null";
        stderr?: "piped" | "null";
      },
    ) {
      this.#cmd = cmd;
      this.#args = options?.args ?? [];
      this.#useStdin = options?.stdin === "piped";
    }

    output(): Promise<{
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const record: SpawnedCommand = {
        cmd: this.#cmd,
        args: [...this.#args],
      };
      commands.push(record);
      const result = handler(this.#cmd, this.#args, undefined);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode(result.stdout),
      });
    }

    spawn(): MockChildProcess {
      const record: SpawnedCommand = {
        cmd: this.#cmd,
        args: [...this.#args],
      };
      commands.push(record);
      return new MockChildProcess(
        this.#cmd,
        this.#args,
        this.#useStdin,
        handler,
        record,
      );
    }
  }

  class MockChildProcess {
    stdin: MockStdin;
    #cmd: string;
    #args: string[];
    #handler: CommandHandler;
    #record: SpawnedCommand;
    #stdinData = "";

    constructor(
      cmd: string,
      args: string[],
      useStdin: boolean,
      spawnHandler: CommandHandler,
      record: SpawnedCommand,
    ) {
      this.#cmd = cmd;
      this.#args = args;
      this.#handler = spawnHandler;
      this.#record = record;
      this.stdin = new MockStdin(
        useStdin,
        (data) => {
          this.#stdinData = data;
          this.#record.stdinData = data;
        },
      );
    }

    output(): Promise<{
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const result = this.#handler(
        this.#cmd,
        this.#args,
        this.#stdinData,
      );
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode(result.stdout),
      });
    }
  }

  class MockStdin {
    #enabled: boolean;
    #onData: (data: string) => void;

    constructor(enabled: boolean, onData: (data: string) => void) {
      this.#enabled = enabled;
      this.#onData = onData;
    }

    getWriter(): MockWriter {
      return new MockWriter(this.#onData);
    }
  }

  class MockWriter {
    #chunks: string[] = [];
    #onData: (data: string) => void;

    constructor(onData: (data: string) => void) {
      this.#onData = onData;
    }

    write(chunk: Uint8Array): Promise<void> {
      this.#chunks.push(new TextDecoder().decode(chunk));
      return Promise.resolve();
    }

    close(): Promise<void> {
      this.#onData(this.#chunks.join(""));
      return Promise.resolve();
    }
  }

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  return fn(() => commands).finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

// =============================================================================
// Behavioral Tests — setup method
// =============================================================================

Deno.test("setup: creates worker models and probe model for throughput", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({ stdout: "{}", success: true }),
    async (getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "throughput" as const,
          worker_id: 1,
          models_per_worker: 3,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      const result = await model.methods.setup.execute({}, context);

      // Should create 3 worker models + 1 probe = 4 total Deno.Command calls
      const commands = getCommands();
      assertEquals(commands.length, 4);

      // Verify model names
      assertEquals(commands[0].args.includes("bench-w001-m001"), true);
      assertEquals(commands[1].args.includes("bench-w001-m002"), true);
      assertEquals(commands[2].args.includes("bench-w001-m003"), true);
      assertEquals(commands[3].args.includes("bench-probe-w001"), true);

      // All use "model create command/shell"
      for (const c of commands) {
        assertEquals(c.args[0], "model");
        assertEquals(c.args[1], "create");
        assertEquals(c.args[2], "command/shell");
      }

      // Result resource written correctly
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "setup");
      assertEquals(written[0].name, "w1");
      assertEquals(written[0].data.modelsCreated, 4);
      assertEquals(written[0].data.scenario, "throughput");
      assertEquals(written[0].data.workerId, 1);
      assertEquals(written[0].data.readProbeName, "bench-probe-w001");

      assertEquals(result.dataHandles.length, 1);
    },
  );
});

Deno.test("setup: creates 1 worker model + probe for write-stress", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({ stdout: "{}", success: true }),
    async (getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "write-stress" as const,
          worker_id: 5,
          models_per_worker: 50,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      await model.methods.setup.execute({}, context);

      const commands = getCommands();
      // 1 worker model + 1 probe = 2
      assertEquals(commands.length, 2);
      assertEquals(commands[0].args.includes("bench-w005-m001"), true);
      assertEquals(commands[1].args.includes("bench-probe-w005"), true);

      assertEquals(written[0].data.modelsCreated, 2);
      assertEquals(written[0].name, "w5");
    },
  );
});

Deno.test("setup: handles already-exists gracefully (idempotent)", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({ stdout: "already exists", success: false }),
    async (getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "write-stress" as const,
          worker_id: 2,
          models_per_worker: 50,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      // Should not throw even though all commands "fail" with "already exists"
      const result = await model.methods.setup.execute({}, context);
      assertEquals(result.dataHandles.length, 1);

      const commands = getCommands();
      assertEquals(commands.length, 2);
    },
  );
});

// =============================================================================
// Behavioral Tests — execute method
// =============================================================================

Deno.test("execute: throughput scenario spawns swamp with --stdin and correct target model", async () => {
  await withMockedCommand(
    (_cmd, _args, _stdinData) => ({ stdout: "{}", success: true }),
    async (getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "throughput" as const,
          worker_id: 1,
          models_per_worker: 5,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      await model.methods.execute.execute({ iteration: 3 }, context);

      const commands = getCommands();
      // runModelMethod spawns one swamp command
      assertEquals(commands.length, 1);
      const spawnedCmd = commands[0];
      assertEquals(spawnedCmd.cmd, "swamp");
      assertEquals(spawnedCmd.args.includes("--stdin"), true);
      assertEquals(spawnedCmd.args.includes("bench-w001-m003"), true);
      assertEquals(spawnedCmd.args.includes("execute"), true);

      // Verify stdin payload contains a shell command with swamp data write
      assertExists(spawnedCmd.stdinData);
      const stdinPayload = JSON.parse(spawnedCmd.stdinData!);
      assertExists(stdinPayload.run);
      assertEquals(stdinPayload.run.includes("swamp data write"), true);
      assertEquals(stdinPayload.run.includes("bench-w001-m003"), true);

      // Result resource written with correct data
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "result");
      assertEquals(written[0].name, "w1-iter-3");
      assertEquals(written[0].data.success, true);
      assertEquals(written[0].data.operation, "write-timestamp");
      assertEquals(written[0].data.modelName, "bench-w001-m003");
      assertEquals(written[0].data.scenario, "throughput");
    },
  );
});

Deno.test("execute: write-stress scenario uses correct model and payload size", async () => {
  await withMockedCommand(
    (_cmd, _args, _stdinData) => ({ stdout: "{}", success: true }),
    async (getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "write-stress" as const,
          worker_id: 3,
          models_per_worker: 50,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      // iteration 2 => PAYLOAD_SIZES[(2-1) % 3] = "medium"
      await model.methods.execute.execute({ iteration: 2 }, context);

      const commands = getCommands();
      assertEquals(commands.length, 1);
      assertEquals(commands[0].args.includes("bench-w003-m001"), true);

      assertEquals(written[0].data.operation, "write-medium");
      assertEquals(written[0].data.payloadSize, "medium");
      assertEquals(written[0].data.modelName, "bench-w003-m001");
      assertEquals(written[0].name, "w3-iter-2");
    },
  );
});

Deno.test("execute: write-stress respects explicit payload_size input", async () => {
  await withMockedCommand(
    (_cmd, _args, _stdinData) => ({ stdout: "{}", success: true }),
    async (_getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "write-stress" as const,
          worker_id: 1,
          models_per_worker: 50,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      // Explicit large payload regardless of iteration rotation
      await model.methods.execute.execute(
        { iteration: 1, payload_size: "large" },
        context,
      );

      assertEquals(written[0].data.payloadSize, "large");
      assertEquals(written[0].data.operation, "write-large");
      // Large payload is ~500KB
      assertEquals((written[0].data.payloadBytes as number) > 400_000, true);
    },
  );
});

Deno.test("execute: records error on command failure", async () => {
  await withMockedCommand(
    (_cmd, _args, _stdinData) => ({
      stdout: "connection refused",
      success: false,
    }),
    async (_getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "throughput" as const,
          worker_id: 1,
          models_per_worker: 5,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      const result = await model.methods.execute.execute(
        { iteration: 1 },
        context,
      );

      assertEquals(result.dataHandles.length, 1);
      assertEquals(written[0].data.success, false);
      assertEquals(
        (written[0].data.errorMessage as string).includes("connection refused"),
        true,
      );
    },
  );
});

Deno.test("execute: resource name includes worker_id to prevent collision", async () => {
  await withMockedCommand(
    (_cmd, _args, _stdinData) => ({ stdout: "{}", success: true }),
    async (_getCommands) => {
      const written: Array<{
        specName: string;
        name: string;
        data: Record<string, unknown>;
      }> = [];
      const context = {
        globalArgs: {
          scenario: "throughput" as const,
          worker_id: 7,
          models_per_worker: 5,
        },
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ specName, name, data });
          return Promise.resolve({ name });
        },
      };

      await model.methods.execute.execute({ iteration: 42 }, context);

      // Resource name must include worker ID
      assertEquals(written[0].name, "w7-iter-42");
    },
  );
});
