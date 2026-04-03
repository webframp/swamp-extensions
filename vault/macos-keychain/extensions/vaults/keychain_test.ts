// ABOUTME: Tests for macOS Keychain vault provider
// ABOUTME: Uses Deno.Command stubbing to mock the security CLI

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertVaultExportConformance } from "@systeminit/swamp-testing";
import { vault } from "./keychain.ts";

// ---------------------------------------------------------------------------
// Export conformance tests
// ---------------------------------------------------------------------------

Deno.test("vault export conforms to VaultProvider contract", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      {},
      { service: "myapp" },
      { service: "custom-service" },
    ],
    invalidConfigs: [
      { service: 123 }, // Wrong type
      { service: "" }, // Empty string not allowed
    ],
  });
});

Deno.test("createProvider accepts empty config (uses defaults)", () => {
  const provider = vault.createProvider("test-vault", {});
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createProvider accepts custom service", () => {
  const provider = vault.createProvider("custom-vault", { service: "myapp" });
  assertEquals(provider.getName(), "custom-vault");
});

Deno.test("createProvider throws on invalid service type", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { service: 123 }),
    Error,
  );
});

Deno.test("createProvider throws on empty service string", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { service: "" }),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Behavioral tests using Deno.Command stubbing
// ---------------------------------------------------------------------------

/** In-memory store for mock keychain items (service/account -> password) */
const mockKeychain = new Map<string, string>();

/** Original Deno.Command constructor */
const OriginalCommand = Deno.Command;

/** Track the last args passed to security for verification */
let lastSecurityArgs: string[] = [];

/** Mock Deno.Command that simulates macOS security CLI */
class MockCommand {
  private command: string;
  private args: string[];

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
    if (command === "security") {
      lastSecurityArgs = this.args;
    }
  }

  spawn(): MockProcess {
    return new MockProcess(this.command, this.args);
  }
}

class MockProcess {
  stdin: MockStdin;
  private command: string;
  private args: string[];

  constructor(command: string, args: string[]) {
    this.command = command;
    this.args = args;
    this.stdin = new MockStdin();
  }

  output(): Promise<{
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }> {
    const encoder = new TextEncoder();

    if (this.command === "security") {
      const subcommand = this.args[0];

      // security find-generic-password -s <service> -a <account> -w
      if (subcommand === "find-generic-password") {
        const serviceIdx = this.args.indexOf("-s");
        const accountIdx = this.args.indexOf("-a");
        const service = serviceIdx >= 0 ? this.args[serviceIdx + 1] : "";
        const account = accountIdx >= 0 ? this.args[accountIdx + 1] : "";

        const key = `${service}/${account}`;
        const value = mockKeychain.get(key);

        if (value === undefined) {
          return Promise.resolve({
            code: 44, // Item not found error code
            stdout: new Uint8Array(),
            stderr: encoder.encode(
              "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
            ),
          });
        }
        return Promise.resolve({
          code: 0,
          stdout: encoder.encode(value),
          stderr: new Uint8Array(),
        });
      }

      // security add-generic-password -s <service> -a <account> -w <password> -U
      if (subcommand === "add-generic-password") {
        const serviceIdx = this.args.indexOf("-s");
        const accountIdx = this.args.indexOf("-a");
        const passwordIdx = this.args.indexOf("-w");
        const service = serviceIdx >= 0 ? this.args[serviceIdx + 1] : "";
        const account = accountIdx >= 0 ? this.args[accountIdx + 1] : "";
        const password = passwordIdx >= 0 ? this.args[passwordIdx + 1] : "";

        const key = `${service}/${account}`;
        mockKeychain.set(key, password);

        return Promise.resolve({
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }

      // security delete-generic-password -s <service> -a <account>
      if (subcommand === "delete-generic-password") {
        const serviceIdx = this.args.indexOf("-s");
        const accountIdx = this.args.indexOf("-a");
        const service = serviceIdx >= 0 ? this.args[serviceIdx + 1] : "";
        const account = accountIdx >= 0 ? this.args[accountIdx + 1] : "";

        const key = `${service}/${account}`;
        if (!mockKeychain.has(key)) {
          return Promise.resolve({
            code: 44,
            stdout: new Uint8Array(),
            stderr: encoder.encode(
              "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
            ),
          });
        }
        mockKeychain.delete(key);
        return Promise.resolve({
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    }

    return Promise.resolve({
      code: 127,
      stdout: new Uint8Array(),
      stderr: encoder.encode(`command not found: ${this.command}`),
    });
  }
}

class MockStdin {
  getWriter(): MockWriter {
    return new MockWriter();
  }
}

class MockWriter {
  write(_chunk: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function installMock(): void {
  mockKeychain.clear();
  lastSecurityArgs = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
}

function uninstallMock(): void {
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = OriginalCommand;
}

async function withMockedSecurity<T>(fn: () => Promise<T>): Promise<T> {
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

Deno.test("keychain vault: get returns stored secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("my-key", "my-secret-value");
    const result = await provider.get("my-key");
    assertEquals(result, "my-secret-value");
  });
});

Deno.test("keychain vault: get rejects for missing secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await assertRejects(
      () => provider.get("nonexistent-key"),
      Error,
      "not be found",
    );
  });
});

Deno.test("keychain vault: get uses correct service and account", async () => {
  await withMockedSecurity(async () => {
    mockKeychain.set("swamp/test-key", "password123");
    const provider = vault.createProvider("test", {});
    await provider.get("test-key");
    assertEquals(lastSecurityArgs.includes("-s"), true);
    assertEquals(lastSecurityArgs.includes("swamp"), true);
    assertEquals(lastSecurityArgs.includes("-a"), true);
    assertEquals(lastSecurityArgs.includes("test-key"), true);
  });
});

Deno.test("keychain vault: get uses custom service name", async () => {
  await withMockedSecurity(async () => {
    mockKeychain.set("myapp/test-key", "password123");
    const provider = vault.createProvider("test", { service: "myapp" });
    await provider.get("test-key");
    assertEquals(lastSecurityArgs.includes("myapp"), true);
  });
});

Deno.test("keychain vault: put stores secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("new-key", "new-value");
    assertEquals(mockKeychain.get("swamp/new-key"), "new-value");
  });
});

Deno.test("keychain vault: put overwrites existing secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("overwrite-key", "original");
    await provider.put("overwrite-key", "updated");
    const result = await provider.get("overwrite-key");
    assertEquals(result, "updated");
  });
});

Deno.test("keychain vault: put uses -U flag for upsert", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await provider.put("any-key", "any-value");
    assertEquals(lastSecurityArgs.includes("-U"), true);
  });
});

Deno.test("keychain vault: list throws not supported error", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    await assertRejects(
      () => provider.list(),
      Error,
      "not supported",
    );
  });
});

Deno.test("keychain vault: getName returns vault name", async () => {
  await withMockedSecurity(() => {
    const provider = vault.createProvider("my-keychain-vault", {});
    assertEquals(provider.getName(), "my-keychain-vault");
    return Promise.resolve();
  });
});

Deno.test("keychain vault: custom service is applied to all operations", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", { service: "custom-svc" });

    await provider.put("key1", "val1");
    assertEquals(mockKeychain.has("custom-svc/key1"), true);

    const result = await provider.get("key1");
    assertEquals(result, "val1");
  });
});
