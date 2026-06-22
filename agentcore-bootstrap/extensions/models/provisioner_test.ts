import { assertMatch, assertEquals, assertRejects } from "@std/assert";
import { model } from "./provisioner.ts";

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
    #opts: Record<string, unknown>;

    constructor(cmd: string, options: Record<string, unknown>) {
      this.#cmd = cmd;
      this.#args = (options?.args as string[]) ?? [];
      this.#opts = options ?? {};
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

    spawn() {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return {
        stdin: {
          getWriter: () => ({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () =>
          Promise.resolve({
            success: result.success,
            code: result.code ?? (result.success ? 0 : 1),
            stdout: encoder.encode(result.stdout),
            stderr: result.success
              ? new Uint8Array()
              : encoder.encode("command failed"),
          }),
      };
    }
  };

  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

Deno.test("model export has correct type and version", () => {
  assertEquals(model.type, "@webframp/agentcore-bootstrap/provisioner");
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
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

// ---------------------------------------------------------------------------
// Execute tests with mocked Deno.Command
// ---------------------------------------------------------------------------

function makeProvisionContext() {
  const written: Array<{ specName: string; name: string; data: unknown }> = [];
  const context = {
    globalArgs: {
      region: "us-east-1",
      bucket_name: "test-bucket",
      ecr_repo_name: "test-ecr-repo",
      runtime_name: "test-runtime",
      role_name: "TestRole",
    },
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    extensionFile: () => Promise.resolve("/tmp/worker"),
  };
  return { context, written };
}

function awsMockHandler(cmd: string, args: string[]) {
  if (cmd !== "aws" && cmd !== "docker") {
    return { stdout: "", success: true };
  }

  if (cmd === "docker") {
    // buildx build, push, login
    return { stdout: "", success: true };
  }

  // AWS CLI mocks
  const subcommand = args.slice(0, 2).join(" ");

  if (subcommand === "s3api head-bucket") {
    return { stdout: "", success: true };
  }
  if (subcommand === "s3api put-public-access-block") {
    return { stdout: "", success: true };
  }
  if (subcommand === "s3api put-bucket-versioning") {
    return { stdout: "", success: true };
  }
  if (subcommand === "s3api put-bucket-lifecycle-configuration") {
    return { stdout: "", success: true };
  }
  if (subcommand === "ecr describe-repositories") {
    return {
      stdout: JSON.stringify({
        repositories: [{
          repositoryUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/test",
          repositoryArn: "arn:aws:ecr:us-east-1:123456789012:repository/test",
        }],
      }),
      success: true,
    };
  }
  if (subcommand === "ecr get-login-password") {
    return { stdout: "mock-token\n", success: true };
  }
  if (subcommand === "iam get-role") {
    return {
      stdout: JSON.stringify({
        Role: { Arn: "arn:aws:iam::123456789012:role/TestRole" },
      }),
      success: true,
    };
  }
  if (subcommand === "iam put-role-policy") {
    return { stdout: "", success: true };
  }
  if (subcommand === "bedrock-agentcore create-agent-runtime") {
    return {
      stdout: JSON.stringify({
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
      }),
      success: true,
    };
  }
  return { stdout: "", success: true };
}

Deno.test("provision execute: success path writes resource with all fields", async () => {
  await withMockedCommand(awsMockHandler, async () => {
    const { context, written } = makeProvisionContext();

    const result = await model.methods.provision.execute(
      { workerContextPath: "worker", platform: "linux/arm64" },
      context as unknown as Parameters<
        typeof model.methods.provision.execute
      >[1],
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "provision");
    assertEquals(written[0].name, "main");
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.region, "us-east-1");
    assertEquals(data.bucketName, "test-bucket");
    assertEquals(typeof data.ecrRepositoryUri, "string");
    assertEquals(typeof data.ecrRepositoryArn, "string");
    assertEquals(typeof data.roleArn, "string");
    assertEquals(typeof data.runtimeArn, "string");
    assertEquals(typeof data.durationMs, "number");
  });
});

Deno.test("provision execute: IAM get-role failure rethrows when stderr lacks NoSuchEntity", async () => {
  await withMockedCommand((cmd, args) => {
    if (cmd === "aws" && args[0] === "iam" && args[1] === "get-role") {
      return {
        stdout: "",
        success: false,
        code: 254,
      };
    }
    if (cmd === "aws" && args[0] === "iam" && args[1] === "create-role") {
      return {
        stdout: JSON.stringify({
          Role: { Arn: "arn:aws:iam::123456789012:role/NewRole" },
        }),
        success: true,
      };
    }
    return awsMockHandler(cmd, args);
  }, async () => {
    const { context } = makeProvisionContext();

    // The mock returns failure for get-role with "command failed" in stderr,
    // but awsCli wraps it as "AWS CLI failed: command failed" which doesn't
    // include NoSuchEntity — this will throw. We need to match the error pattern.
    // Actually awsCli throws with the stderr content. Let's test the rethrow path.
    await assertRejects(
      () =>
        model.methods.provision.execute(
          { workerContextPath: "worker", platform: "linux/arm64" },
          context as unknown as Parameters<
            typeof model.methods.provision.execute
          >[1],
        ),
      Error,
    );
  });
});

Deno.test("provision execute: transient IAM error rethrows instead of creating role", async () => {
  await assertRejects(
    () =>
      withMockedCommand((cmd, args) => {
        if (cmd === "aws" && args[0] === "iam" && args[1] === "get-role") {
          return { stdout: "", success: false, code: 1 };
        }
        return awsMockHandler(cmd, args);
      }, async () => {
        const { context } = makeProvisionContext();
        await model.methods.provision.execute(
          { workerContextPath: "worker", platform: "linux/arm64" },
          context as unknown as Parameters<
            typeof model.methods.provision.execute
          >[1],
        );
      }),
    Error,
    "AWS CLI failed",
  );
});
