// gopass Vault Provider Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertVaultExportConformance } from "@systeminit/swamp-testing";
import { vault } from "./gopass.ts";

// ---------------------------------------------------------------------------
// Export conformance tests
// ---------------------------------------------------------------------------

Deno.test("vault export conforms to VaultProvider contract", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      {},
      { store: "work" },
      { passwordOnly: false },
      { store: "personal", passwordOnly: true },
    ],
    invalidConfigs: [
      { store: 123 }, // Wrong type
      { passwordOnly: "yes" }, // Wrong type
    ],
  });
});

Deno.test("createProvider accepts empty config (uses defaults)", () => {
  const provider = vault.createProvider("test-vault", {});
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createProvider accepts custom store", () => {
  const provider = vault.createProvider("work-vault", { store: "work" });
  assertEquals(provider.getName(), "work-vault");
});

Deno.test("createProvider throws on invalid store type", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { store: 123 }),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Behavioral tests using Deno.Command stubbing
// ---------------------------------------------------------------------------

/** In-memory store for mock gopass commands */
const mockSecrets = new Map<string, string>();

/** Original Deno.Command constructor */
const OriginalCommand = Deno.Command;

/** Track the last args passed to gopass for verification */
let lastGopassArgs: string[] = [];

/** Mock Deno.Command that simulates gopass commands */
class MockCommand {
  private command: string;
  private args: string[];
  private stdinData: string | undefined;

  constructor(
    command: string,
    options: {
      args?: string[];
      stdin?: "piped" | "null";
      stdout?: "piped";
      stderr?: "piped";
    },
  ) {
    this.command = command;
    this.args = options.args ?? [];
    if (command === "gopass") {
      lastGopassArgs = this.args;
    }
  }

  spawn(): MockProcess {
    return new MockProcess(
      this.command,
      this.args,
      (data) => {
        this.stdinData = data;
      },
      () => this.stdinData,
    );
  }
}

class MockProcess {
  stdin: MockStdin;
  private command: string;
  private args: string[];
  private getStdinData: () => string | undefined;

  constructor(
    command: string,
    args: string[],
    onStdinWrite: (data: string) => void,
    getStdinData: () => string | undefined,
  ) {
    this.command = command;
    this.args = args;
    this.getStdinData = getStdinData;
    this.stdin = new MockStdin(onStdinWrite);
  }

  async output(): Promise<{
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }> {
    const encoder = new TextEncoder();

    if (this.command === "gopass") {
      const subcommand = this.args[0];

      // gopass show [-o] [-n] <path>
      if (subcommand === "show") {
        const path = this.args[this.args.length - 1];
        const value = mockSecrets.get(path);
        if (value === undefined) {
          return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(`Error: ${path}: entry not found`),
          };
        }
        return {
          code: 0,
          stdout: encoder.encode(value),
          stderr: new Uint8Array(),
        };
      }

      // gopass insert --force --multiline <path>
      if (subcommand === "insert") {
        const path = this.args[this.args.length - 1];
        await new Promise((r) => setTimeout(r, 0));
        const value = this.getStdinData() ?? "";
        mockSecrets.set(path, value);
        return {
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }

      // gopass list --flat [store]
      if (subcommand === "list") {
        const storeArg = this.args.includes("--flat")
          ? this.args[this.args.length - 1]
          : null;
        const isStoreFilter = storeArg && storeArg !== "--flat";

        const keys = [...mockSecrets.keys()].filter((k) => {
          if (isStoreFilter) {
            return k.startsWith(`${storeArg}/`);
          }
          return true;
        });

        return {
          code: 0,
          stdout: encoder.encode(keys.join("\n")),
          stderr: new Uint8Array(),
        };
      }
    }

    return {
      code: 127,
      stdout: new Uint8Array(),
      stderr: encoder.encode(`command not found: ${this.command}`),
    };
  }
}

class MockStdin {
  private onWrite: (data: string) => void;

  constructor(onWrite: (data: string) => void) {
    this.onWrite = onWrite;
  }

  getWriter(): MockWriter {
    return new MockWriter(this.onWrite);
  }
}

class MockWriter {
  private data = "";
  private onWrite: (data: string) => void;

  constructor(onWrite: (data: string) => void) {
    this.onWrite = onWrite;
  }

  write(chunk: Uint8Array): Promise<void> {
    this.data += new TextDecoder().decode(chunk);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onWrite(this.data);
    return Promise.resolve();
  }
}

function installMock(): void {
  mockSecrets.clear();
  lastGopassArgs = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
}

function uninstallMock(): void {
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = OriginalCommand;
}

async function withMockedGopass<T>(fn: () => Promise<T>): Promise<T> {
  installMock();
  try {
    return await fn();
  } finally {
    uninstallMock();
  }
}

// ---------------------------------------------------------------------------
// Behavioral tests
// ---------------------------------------------------------------------------

Deno.test("gopass vault: get returns stored secret", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("my-key", "my-secret-value");
    const result = await provider.get("my-key");
    assertEquals(result, "my-secret-value");
  });
});

Deno.test("gopass vault: get rejects for missing secret", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    await assertRejects(
      () => provider.get("nonexistent-key"),
      Error,
      "entry not found",
    );
  });
});

Deno.test("gopass vault: get uses -o flag when passwordOnly is true", async () => {
  await withMockedGopass(async () => {
    mockSecrets.set("test-key", "password123");
    const provider = vault.createProvider("test", { passwordOnly: true });
    await provider.get("test-key");
    assertEquals(lastGopassArgs.includes("-o"), true);
  });
});

Deno.test("gopass vault: get omits -o flag when passwordOnly is false", async () => {
  await withMockedGopass(async () => {
    mockSecrets.set("test-key", "password123\nusername: user");
    const provider = vault.createProvider("test", { passwordOnly: false });
    await provider.get("test-key");
    assertEquals(lastGopassArgs.includes("-o"), false);
  });
});

Deno.test("gopass vault: put stores secret", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("new-key", "new-value");
    assertEquals(mockSecrets.get("new-key"), "new-value");
  });
});

Deno.test("gopass vault: put overwrites existing secret", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("overwrite-key", "original");
    await provider.put("overwrite-key", "updated");
    const result = await provider.get("overwrite-key");
    assertEquals(result, "updated");
  });
});

Deno.test("gopass vault: list returns stored keys", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("key-a", "val-a");
    await provider.put("key-b", "val-b");
    const keys = await provider.list();
    assertEquals(keys.includes("key-a"), true);
    assertEquals(keys.includes("key-b"), true);
  });
});

Deno.test("gopass vault: list returns empty array for empty store", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", {});
    const keys = await provider.list();
    assertEquals(keys, []);
  });
});

Deno.test("gopass vault: store prefix is applied to paths", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("test", { store: "work" });
    await provider.put("api-key", "secret123");
    // The secret should be stored with the store prefix
    assertEquals(mockSecrets.has("work/api-key"), true);
  });
});

Deno.test("gopass vault: list with store filters correctly", async () => {
  await withMockedGopass(async () => {
    // Add secrets with different prefixes
    mockSecrets.set("work/key1", "val1");
    mockSecrets.set("work/key2", "val2");
    mockSecrets.set("personal/key3", "val3");

    const provider = vault.createProvider("test", { store: "work" });
    const keys = await provider.list();
    // Should only return work keys, with prefix stripped
    assertEquals(keys.length, 2);
    assertEquals(keys.includes("key1"), true);
    assertEquals(keys.includes("key2"), true);
  });
});

Deno.test("gopass vault: getName returns vault name", async () => {
  await withMockedGopass(() => {
    const provider = vault.createProvider("my-gopass-vault", {});
    assertEquals(provider.getName(), "my-gopass-vault");
    return Promise.resolve();
  });
});
