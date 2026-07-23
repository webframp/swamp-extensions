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

function createMockContext(globalArgs: {
  location: string;
  resource_group: string;
  storage_account: string;
  container_name: string;
  blob_prefix: string;
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

const BASE_ARGS = {
  location: "eastus",
  resource_group: "test-rg",
  storage_account: "testaccount",
  container_name: "test-container",
  blob_prefix: "swamp",
};

Deno.test("model exports correct type and version", () => {
  assertEquals(
    model.type,
    "@webframp/azure-blob-datastore-bootstrap/provisioner",
  );
  assertEquals(model.version, "2026.07.22.1");
});

Deno.test("model has provision method", () => {
  assertEquals(typeof model.methods.provision.execute, "function");
});

Deno.test("globalArguments defaults are correct", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.location, "eastus");
  assertEquals(parsed.resource_group, "swamp-datastore-rg");
  assertEquals(parsed.storage_account, "swampdatastore");
  assertEquals(parsed.container_name, "swamp-datastore");
  assertEquals(parsed.blob_prefix, "swamp");
});

Deno.test("globalArguments validates storage_account (lowercase only)", () => {
  const result = model.globalArguments.safeParse({
    storage_account: "HAS-UPPERCASE",
  });
  assertEquals(result.success, false);
});

Deno.test("provision creates all resources when none exist", async () => {
  const { context, written } = createMockContext(BASE_ARGS);

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    // Resource group show (not found)
    if (sub === "group show") {
      return { success: false, stdout: "ResourceGroupNotFound" };
    }
    // Resource group create
    if (sub === "group create") {
      return { success: true, stdout: "{}" };
    }

    // Storage account show (not found)
    if (sub === "storage account" && args[2] === "show") {
      return { success: false, stdout: "ResourceNotFound" };
    }
    // Storage account create
    if (sub === "storage account" && args[2] === "create") {
      return { success: true, stdout: "{}" };
    }

    // Container show (not found)
    if (sub === "storage container" && args[2] === "show") {
      return { success: false, stdout: "ContainerNotFound" };
    }
    // Container create
    if (sub === "storage container" && args[2] === "create") {
      return { success: true, stdout: "{}" };
    }

    // Connection string
    if (sub === "storage account" && args[2] === "show-connection-string") {
      return {
        success: true,
        stdout: JSON.stringify({
          connectionString:
            "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=abc123==;EndpointSuffix=core.windows.net",
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
    assertEquals(written[0]!.data.resourceGroupCreated, true);
    assertEquals(written[0]!.data.storageAccountCreated, true);
    assertEquals(written[0]!.data.containerCreated, true);
    assertEquals(written[0]!.data.storageAccount, "testaccount");

    const config = JSON.parse(written[0]!.data.datastoreConfig as string);
    assertEquals(config.auth.mode, "connectionString");
    assertEquals(config.container, "test-container");
    assertEquals(config.prefix, "swamp");
    assertEquals(config.auth.connectionString.includes("testaccount"), true);
  });
});

Deno.test("provision reuses existing resources", async () => {
  const { context, written } = createMockContext(BASE_ARGS);

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    // All exist
    if (sub === "group show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage account" && args[2] === "show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage container" && args[2] === "show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage account" && args[2] === "show-connection-string") {
      return {
        success: true,
        stdout: JSON.stringify({
          connectionString:
            "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=xyz==",
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
    assertEquals(written[0]!.data.resourceGroupCreated, false);
    assertEquals(written[0]!.data.storageAccountCreated, false);
    assertEquals(written[0]!.data.containerCreated, false);
  });
});

Deno.test("provision throws on storage account creation failure", async () => {
  const { context } = createMockContext(BASE_ARGS);

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "group show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage account" && args[2] === "show") {
      return { success: false, stdout: "ResourceNotFound" };
    }
    if (sub === "storage account" && args[2] === "create") {
      return {
        success: false,
        stdout: "StorageAccountAlreadyTaken: testaccount is already taken",
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
      "Azure CLI failed",
    );
  });
});

Deno.test("provision throws when connection string unavailable", async () => {
  const { context } = createMockContext(BASE_ARGS);

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "group show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage account" && args[2] === "show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage container" && args[2] === "show") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "storage account" && args[2] === "show-connection-string") {
      return { success: true, stdout: JSON.stringify({}) };
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
      "Could not retrieve connection string",
    );
  });
});
