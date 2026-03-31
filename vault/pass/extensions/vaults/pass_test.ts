// Pass (passwordstore.org) Vault Provider Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertVaultExportConformance } from "@systeminit/swamp-testing";
import { vault } from "./pass.ts";

// ---------------------------------------------------------------------------
// Export conformance tests
// ---------------------------------------------------------------------------

Deno.test("vault export conforms to VaultProvider contract", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      {},
      { storeDir: "/tmp/test-store" },
      { storeDir: "/home/user/.password-store" },
    ],
    invalidConfigs: [
      { storeDir: 123 }, // Wrong type
    ],
  });
});

Deno.test("createProvider accepts empty config (uses defaults)", () => {
  // Should not throw - storeDir is optional
  const provider = vault.createProvider("test-vault", {});
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createProvider accepts custom storeDir", () => {
  const provider = vault.createProvider("custom-vault", {
    storeDir: "/custom/path",
  });
  assertEquals(provider.getName(), "custom-vault");
});

Deno.test("createProvider throws on invalid storeDir type", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { storeDir: 123 }),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Behavioral tests using Deno.Command stubbing
// ---------------------------------------------------------------------------

/** In-memory store for mock pass commands */
const mockSecrets = new Map<string, string>();

/** Original Deno.Command constructor */
const OriginalCommand = Deno.Command;

/** Mock Deno.Command that simulates pass and find commands */
class MockCommand {
  private command: string;
  private args: string[];
  private stdin: "piped" | "null";
  private stdinData: string | undefined;

  constructor(
    command: string,
    options: {
      args?: string[];
      env?: Record<string, string>;
      stdin?: "piped" | "null";
      stdout?: "piped";
      stderr?: "piped";
    },
  ) {
    this.command = command;
    this.args = options.args ?? [];
    this.stdin = options.stdin ?? "null";
  }

  spawn(): MockProcess {
    return new MockProcess(
      this.command,
      this.args,
      this.stdin,
      (data) => {
        this.stdinData = data;
      },
      () => this.stdinData,
    );
  }

  /** Direct output() method for commands that don't use spawn() */
  output(): Promise<{
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }> {
    const encoder = new TextEncoder();

    // Handle find command for listing
    if (this.command === "find") {
      const storeDir = this.args[0];
      // Generate fake .gpg file paths from mockSecrets
      const files = [...mockSecrets.keys()]
        .map((key) => `${storeDir}/${key}.gpg`)
        .join("\n");
      return Promise.resolve({
        code: 0,
        stdout: encoder.encode(files),
        stderr: new Uint8Array(),
      });
    }

    // Unknown command
    return Promise.resolve({
      code: 127,
      stdout: new Uint8Array(),
      stderr: encoder.encode(`command not found: ${this.command}`),
    });
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
    _stdinType: "piped" | "null",
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

    // Handle pass commands
    if (this.command === "pass") {
      const subcommand = this.args[0];

      if (subcommand === "show") {
        const key = this.args[1];
        const value = mockSecrets.get(key);
        if (value === undefined) {
          return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(
              `Error: ${key} is not in the password store.`,
            ),
          };
        }
        return {
          code: 0,
          stdout: encoder.encode(value),
          stderr: new Uint8Array(),
        };
      }

      if (subcommand === "insert") {
        // Args: ["insert", "-m", "-f", key]
        const key = this.args[3];
        // Wait a tick for stdin to be written
        await new Promise((r) => setTimeout(r, 0));
        const value = this.getStdinData() ?? "";
        mockSecrets.set(key, value);
        return {
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
    }

    // Handle find command for listing
    if (this.command === "find") {
      const storeDir = this.args[0];
      // Generate fake .gpg file paths from mockSecrets
      const files = [...mockSecrets.keys()]
        .map((key) => `${storeDir}/${key}.gpg`)
        .join("\n");
      return {
        code: 0,
        stdout: encoder.encode(files),
        stderr: new Uint8Array(),
      };
    }

    // Unknown command
    return {
      code: 127,
      stdout: new Uint8Array(),
      stderr: encoder.encode(`command not found: ${this.command}`),
    };
  }
}

class MockStdin {
  private onWrite: (data: string) => void;
  private writer: MockWriter | null = null;

  constructor(onWrite: (data: string) => void) {
    this.onWrite = onWrite;
  }

  getWriter(): MockWriter {
    this.writer = new MockWriter(this.onWrite);
    return this.writer;
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

/** Replace Deno.Command with mock for testing */
function installMock(): void {
  mockSecrets.clear();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
}

/** Restore original Deno.Command */
function uninstallMock(): void {
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = OriginalCommand;
}

/** Run a test with mocked Deno.Command */
async function withMockedPass<T>(fn: () => Promise<T>): Promise<T> {
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

Deno.test("pass vault: get returns stored secret", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("my-key", "my-secret-value");
    const result = await provider.get("my-key");
    assertEquals(result, "my-secret-value");
  });
});

Deno.test("pass vault: get rejects for missing secret", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await assertRejects(
      () => provider.get("nonexistent-key"),
      Error,
      "is not in the password store",
    );
  });
});

Deno.test("pass vault: put stores secret", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("new-key", "new-value");
    // Verify it was stored in our mock
    assertEquals(mockSecrets.get("new-key"), "new-value");
  });
});

Deno.test("pass vault: put overwrites existing secret", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("overwrite-key", "original");
    await provider.put("overwrite-key", "updated");
    const result = await provider.get("overwrite-key");
    assertEquals(result, "updated");
  });
});

Deno.test("pass vault: list returns stored keys", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("key-a", "val-a");
    await provider.put("key-b", "val-b");
    await provider.put("nested/key-c", "val-c");
    const keys = await provider.list();
    assertEquals(keys.includes("key-a"), true);
    assertEquals(keys.includes("key-b"), true);
    assertEquals(keys.includes("nested/key-c"), true);
  });
});

Deno.test("pass vault: list returns empty array for empty store", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    const keys = await provider.list();
    assertEquals(keys, []);
  });
});

Deno.test("pass vault: list returns sorted keys", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("zebra", "z");
    await provider.put("apple", "a");
    await provider.put("mango", "m");
    const keys = await provider.list();
    assertEquals(keys, ["apple", "mango", "zebra"]);
  });
});

Deno.test("pass vault: getName returns vault name", async () => {
  await withMockedPass(() => {
    const provider = vault.createProvider("my-vault-name", {});
    assertEquals(provider.getName(), "my-vault-name");
    return Promise.resolve();
  });
});
