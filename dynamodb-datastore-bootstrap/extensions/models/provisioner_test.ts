import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./provisioner.ts";

type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const OriginalCommand = Deno.Command;

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    #cmd: string;
    #args: string[];

    constructor(cmd: string, options: Record<string, unknown>) {
      this.#cmd = cmd;
      this.#args = (options?.args as string[]) ?? [];
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
        code: result.success ? 0 : 1,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode(result.stdout),
      });
    }
  };

  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

/** Fake context that captures writeResource calls. */
function createMockContext(globalArgs: {
  region: string;
  table_name: string;
  policy_name: string;
}) {
  const written: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];

  return {
    context: {
      globalArgs,
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
    written,
  };
}

Deno.test("model exports correct type and version", () => {
  assertEquals(
    model.type,
    "@webframp/dynamodb-datastore-bootstrap/provisioner",
  );
  assertEquals(model.version, "2026.07.22.1");
});

Deno.test("model has provision method", () => {
  assertEquals(typeof model.methods.provision.execute, "function");
  assertEquals(
    model.methods.provision.description,
    "Create/verify the DynamoDB table and scoped IAM managed policy for @webframp/dynamodb-datastore.",
  );
});

Deno.test("model has state resource with correct schema", () => {
  assertEquals(model.resources.state.lifetime, "infinite");
  assertEquals(model.resources.state.garbageCollection, 3);
});

Deno.test("globalArguments defaults are correct", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.table_name, "swamp-datastore");
  assertEquals(parsed.policy_name, "SwampDynamoDBDatastorePolicy");
});

Deno.test("globalArguments validates region pattern", () => {
  const result = model.globalArguments.safeParse({ region: "INVALID!" });
  assertEquals(result.success, false);
});

Deno.test("globalArguments validates table_name pattern", () => {
  const result = model.globalArguments.safeParse({ table_name: "no spaces!" });
  assertEquals(result.success, false);
});

Deno.test("provision creates table when it does not exist", async () => {
  const { context, written } = createMockContext({
    region: "us-east-1",
    table_name: "test-table",
    policy_name: "TestPolicy",
  });

  let tableCreated = false;

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      if (tableCreated) {
        return {
          success: true,
          stdout: JSON.stringify({
            Table: {
              TableName: "test-table",
              TableArn:
                "arn:aws:dynamodb:us-east-1:123456789012:table/test-table",
              TableStatus: "ACTIVE",
            },
          }),
        };
      }
      return { success: false, stdout: "ResourceNotFoundException" };
    }

    if (subcommand === "dynamodb create-table") {
      tableCreated = true;
      return {
        success: true,
        stdout: JSON.stringify({
          TableDescription: {
            TableName: "test-table",
            TableArn:
              "arn:aws:dynamodb:us-east-1:123456789012:table/test-table",
            TableStatus: "CREATING",
          },
        }),
      };
    }

    if (subcommand === "dynamodb describe-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
        }),
      };
    }

    if (subcommand === "dynamodb update-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
        }),
      };
    }

    if (subcommand === "sts get-caller-identity") {
      return {
        success: true,
        stdout: JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/test",
        }),
      };
    }

    if (subcommand === "iam get-policy") {
      return { success: false, stdout: "NoSuchEntity" };
    }

    if (subcommand === "iam create-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: {
            Arn: "arn:aws:iam::123456789012:policy/TestPolicy",
            PolicyName: "TestPolicy",
          },
        }),
      };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    const result = await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0]!.specName, "state");
    assertEquals(written[0]!.data.tableName, "test-table");
    assertEquals(written[0]!.data.tableCreated, true);
    assertEquals(written[0]!.data.policyCreated, true);
    assertEquals(
      written[0]!.data.policyArn,
      "arn:aws:iam::123456789012:policy/TestPolicy",
    );
    assertEquals(written[0]!.data.ttlEnabled, true);
    assertEquals(written[0]!.data.gsiName, "gsi1");
  });
});

Deno.test("provision reuses existing table and policy", async () => {
  const { context, written } = createMockContext({
    region: "us-west-2",
    table_name: "existing-table",
    policy_name: "ExistingPolicy",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      return {
        success: true,
        stdout: JSON.stringify({
          Table: {
            TableName: "existing-table",
            TableArn:
              "arn:aws:dynamodb:us-west-2:111222333444:table/existing-table",
            TableStatus: "ACTIVE",
          },
        }),
      };
    }

    if (subcommand === "dynamodb describe-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveDescription: {
            TimeToLiveStatus: "ENABLED",
            AttributeName: "ttl",
          },
        }),
      };
    }

    if (subcommand === "sts get-caller-identity") {
      return {
        success: true,
        stdout: JSON.stringify({ Account: "111222333444" }),
      };
    }

    if (subcommand === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: {
            Arn: "arn:aws:iam::111222333444:policy/ExistingPolicy",
          },
        }),
      };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    const result = await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0]!.data.tableCreated, false);
    assertEquals(written[0]!.data.policyCreated, false);
    assertEquals(written[0]!.data.region, "us-west-2");
  });
});

Deno.test("provision throws on AWS CLI failure during table creation", async () => {
  const { context } = createMockContext({
    region: "us-east-1",
    table_name: "fail-table",
    policy_name: "FailPolicy",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      return { success: false, stdout: "ResourceNotFoundException" };
    }

    if (subcommand === "dynamodb create-table") {
      return {
        success: false,
        stdout: "LimitExceededException: Too many tables",
      };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "AWS CLI failed",
    );
  });
});

Deno.test("provision throws when account ID cannot be determined", async () => {
  const { context } = createMockContext({
    region: "us-east-1",
    table_name: "test-table",
    policy_name: "TestPolicy",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      return {
        success: true,
        stdout: JSON.stringify({
          Table: {
            TableName: "test-table",
            TableArn:
              "arn:aws:dynamodb:us-east-1:123456789012:table/test-table",
            TableStatus: "ACTIVE",
          },
        }),
      };
    }

    if (subcommand === "dynamodb describe-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" },
        }),
      };
    }

    if (subcommand === "sts get-caller-identity") {
      return { success: false, stdout: "ExpiredToken" };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "AWS CLI failed",
    );
  });
});

Deno.test("provision creates policy with correct resource ARNs", async () => {
  const { context } = createMockContext({
    region: "eu-west-1",
    table_name: "my-table",
    policy_name: "MyPolicy",
  });

  let capturedPolicyDoc = "";

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      return {
        success: true,
        stdout: JSON.stringify({
          Table: {
            TableName: "my-table",
            TableArn: "arn:aws:dynamodb:eu-west-1:999888777666:table/my-table",
            TableStatus: "ACTIVE",
          },
        }),
      };
    }

    if (subcommand === "dynamodb describe-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" },
        }),
      };
    }

    if (subcommand === "sts get-caller-identity") {
      return {
        success: true,
        stdout: JSON.stringify({ Account: "999888777666" }),
      };
    }

    if (subcommand === "iam get-policy") {
      return { success: false, stdout: "NoSuchEntity" };
    }

    if (subcommand === "iam create-policy") {
      const docIdx = args.indexOf("--policy-document");
      if (docIdx >= 0 && args[docIdx + 1]) {
        capturedPolicyDoc = args[docIdx + 1]!;
      }
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: {
            Arn: "arn:aws:iam::999888777666:policy/MyPolicy",
          },
        }),
      };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );

    const doc = JSON.parse(capturedPolicyDoc);
    const resources = doc.Statement[0].Resource as string[];
    assertEquals(
      resources[0],
      "arn:aws:dynamodb:eu-west-1:999888777666:table/my-table",
    );
    assertEquals(
      resources[1],
      "arn:aws:dynamodb:eu-west-1:999888777666:table/my-table/index/*",
    );

    const actions = doc.Statement[0].Action as string[];
    assertEquals(actions.length, 7);
    assertEquals(actions.includes("dynamodb:GetItem"), true);
    assertEquals(actions.includes("dynamodb:BatchWriteItem"), true);
  });
});

Deno.test("provision handles TOCTOU race on policy creation", async () => {
  // Simulates: get-policy returns NoSuchEntity, but create-policy fails with
  // EntityAlreadyExists because another process created it in between.
  const { context, written } = createMockContext({
    region: "us-east-1",
    table_name: "race-table",
    policy_name: "RacePolicy",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const subcommand = args.slice(0, 2).join(" ");

    if (subcommand === "dynamodb describe-table") {
      return {
        success: true,
        stdout: JSON.stringify({
          Table: {
            TableName: "race-table",
            TableArn:
              "arn:aws:dynamodb:us-east-1:111222333444:table/race-table",
            TableStatus: "ACTIVE",
          },
        }),
      };
    }

    if (subcommand === "dynamodb describe-time-to-live") {
      return {
        success: true,
        stdout: JSON.stringify({
          TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" },
        }),
      };
    }

    if (subcommand === "sts get-caller-identity") {
      return {
        success: true,
        stdout: JSON.stringify({ Account: "111222333444" }),
      };
    }

    if (subcommand === "iam get-policy") {
      // Policy does not exist at check time
      return { success: false, stdout: "NoSuchEntity" };
    }

    if (subcommand === "iam create-policy") {
      // Another process created the policy between our check and create
      return { success: false, stdout: "EntityAlreadyExists" };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    const result = await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0]!.data.policyCreated, false);
    assertEquals(
      written[0]!.data.policyArn,
      "arn:aws:iam::111222333444:policy/RacePolicy",
    );
  });
});
