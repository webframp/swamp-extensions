// Pass (passwordstore.org) Vault Provider Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  assertVaultConformance,
  assertVaultExportConformance,
} from "@systeminit/swamp-testing";
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
      { prefix: "custom" },
      { prefix: "" },
    ],
    invalidConfigs: [
      { storeDir: 123 }, // Wrong type
      { prefix: 123 }, // Wrong type
    ],
  });
});

Deno.test("createProvider accepts empty config (uses defaults)", () => {
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
// Mock for Deno.Command that supports spawn() with piped stdin
//
// withMockedCommand from @systeminit/swamp-testing does not support spawn(),
// which the pass vault needs for piping secrets via stdin to `pass insert`.
// ---------------------------------------------------------------------------

const mockSecrets = new Map<string, string>();
const OriginalCommand = Deno.Command;
/** Environment handed to the most recent subprocess, for allowlist assertions. */
let lastEnv: Record<string, string> | undefined;

class MockCommand {
  #command: string;
  #args: string[];
  #stdinData: string | undefined;

  constructor(
    command: string,
    options: {
      args?: string[];
      env?: Record<string, string>;
      stdin?: string;
      stdout?: string;
      stderr?: string;
    },
  ) {
    this.#command = command;
    this.#args = options.args ?? [];
    if (options.env) lastEnv = options.env;
  }

  #resolve(): { code: number; stdout: Uint8Array; stderr: Uint8Array } {
    const enc = new TextEncoder();

    if (this.#command === "pass") {
      const sub = this.#args[0];
      if (sub === "show") {
        const key = this.#args[1];
        const val = mockSecrets.get(key);
        if (val === undefined) {
          return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: enc.encode(
              `Error: ${key} is not in the password store.`,
            ),
          };
        }
        return { code: 0, stdout: enc.encode(val), stderr: new Uint8Array() };
      }
      if (sub === "insert") {
        const key = this.#args[3]; // ["insert", "-m", "-f", key]
        mockSecrets.set(key, this.#stdinData ?? "");
        return {
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
    }

    if (this.#command === "find") {
      const storeDir = this.#args[0];
      // Collect -not -path glob patterns to mimic real find filtering
      const excludePatterns: string[] = [];
      for (let i = 1; i < this.#args.length; i++) {
        if (this.#args[i] === "-not" && this.#args[i + 1] === "-path") {
          excludePatterns.push(this.#args[i + 2]);
          i += 2;
        }
      }
      const files = [...mockSecrets.keys()]
        .map((key) => `${storeDir}/${key}.gpg`)
        .filter((path) =>
          !excludePatterns.some((pattern) => {
            // Convert glob */<dir>/* to a simple includes check
            const inner = pattern.replace(/^\*/, "").replace(/\*$/, "");
            return path.includes(inner);
          })
        )
        .join("\n");
      return { code: 0, stdout: enc.encode(files), stderr: new Uint8Array() };
    }

    return {
      code: 127,
      stdout: new Uint8Array(),
      stderr: enc.encode(`command not found: ${this.#command}`),
    };
  }

  output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
    return Promise.resolve(this.#resolve());
  }

  spawn() {
    // deno-lint-ignore no-this-alias
    const self = this;
    return {
      stdin: {
        getWriter() {
          let data = "";
          return {
            write(chunk: Uint8Array): Promise<void> {
              data += new TextDecoder().decode(chunk);
              return Promise.resolve();
            },
            close(): Promise<void> {
              self.#stdinData = data;
              return Promise.resolve();
            },
          };
        },
      },
      output(): Promise<{
        code: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
      }> {
        return Promise.resolve(self.#resolve());
      },
    };
  }
}

async function withMockedPass<T>(fn: () => Promise<T>): Promise<T> {
  mockSecrets.clear();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  try {
    return await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
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

Deno.test("pass vault: put stores secret with prefix", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("new-key", "new-value");
    // Default prefix "swamp" is prepended to the key in the store
    assertEquals(mockSecrets.get("swamp/new-key"), "new-value");
  });
});

Deno.test("pass vault: put with custom prefix", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", {
      storeDir: "/tmp/store",
      prefix: "myapp",
    });
    await provider.put("key", "value");
    assertEquals(mockSecrets.get("myapp/key"), "value");
  });
});

Deno.test("pass vault: put with empty prefix stores without namespace", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", {
      storeDir: "/tmp/store",
      prefix: "",
    });
    await provider.put("key", "value");
    assertEquals(mockSecrets.get("key"), "value");
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

Deno.test("pass vault: list excludes .git and .extensions entries", async () => {
  await withMockedPass(async () => {
    // Seed entries that would live under .git/ and .extensions/ in a real store
    mockSecrets.set(".git/config", "git-data");
    mockSecrets.set(".extensions/hook", "ext-data");
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("real-key", "real-value");
    const keys = await provider.list();
    assertEquals(keys, ["real-key"]);
  });
});

Deno.test("pass vault: list only returns keys under configured prefix", async () => {
  await withMockedPass(async () => {
    // Manually add an entry outside the prefix
    mockSecrets.set("other/secret", "hidden");
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await provider.put("visible", "yes");
    const keys = await provider.list();
    assertEquals(keys, ["visible"]);
    assertEquals(keys.includes("other/secret"), false);
  });
});

Deno.test("pass vault: getName returns vault name", async () => {
  await withMockedPass(() => {
    const provider = vault.createProvider("my-vault-name", {});
    assertEquals(provider.getName(), "my-vault-name");
    return Promise.resolve();
  });
});

Deno.test("pass vault: full VaultProvider conformance", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("conformance", {
      storeDir: "/tmp/store",
    });
    await assertVaultConformance(provider);
  });
});

// ---------------------------------------------------------------------------
// Hardening: byte fidelity, key validation, and subprocess environment
// ---------------------------------------------------------------------------

Deno.test("get preserves leading and trailing whitespace in a secret", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    // A secret whose padding is significant. The old `.trim()` returned
    // "padded" for all three of these.
    for (const secret of ["  padded  ", "\tleading tab", "trailing space "]) {
      await provider.put("ws", secret);
      assertEquals(await provider.get("ws"), secret);
    }
  });
});

Deno.test("get strips exactly one trailing newline, not a run of them", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    // The CLI adds one line terminator when printing; anything beyond that
    // belongs to the secret.
    mockSecrets.set("swamp/nl", "line\n\n");
    assertEquals(await provider.get("nl"), "line\n");
    mockSecrets.set("swamp/crlf", "line\r\n");
    assertEquals(await provider.get("crlf"), "line");
    mockSecrets.set("swamp/none", "line");
    assertEquals(await provider.get("none"), "line");
  });
});

Deno.test("keys containing .. are rejected before reaching the CLI", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    for (const key of ["../escape", "a/../../b", ".."]) {
      await assertRejects(
        () => provider.get(key),
        Error,
        "path segments",
      );
      await assertRejects(
        () => provider.put(key, "x"),
        Error,
        "path segments",
      );
    }
  });
});

Deno.test("absolute, empty, and flag-like keys are rejected", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    await assertRejects(() => provider.get("/etc/passwd"), Error, "relative");
    await assertRejects(() => provider.get(""), Error, "empty");
    // A leading dash would be read as a flag by pass itself.
    await assertRejects(() => provider.get("-c"), Error, "must not start with");
  });
});

Deno.test("the subprocess environment is an allowlist, not the whole parent", async () => {
  const marker = "SWAMP_PASS_TEST_UNRELATED_SECRET";
  Deno.env.set(marker, "must-not-be-forwarded");
  try {
    await withMockedPass(async () => {
      lastEnv = undefined;
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await provider.put("env-probe", "value");

      assertExists(lastEnv);
      const env: Record<string, string> = lastEnv;
      assertEquals(env[marker], undefined);
      assertEquals(env.PASSWORD_STORE_DIR, "/tmp/store");
      // Everything forwarded must be something pass or GPG needs.
      for (const name of Object.keys(env)) {
        assertEquals(
          name === "PASSWORD_STORE_DIR" || ENV_ALLOWLIST_FOR_TEST.has(name),
          true,
          `unexpected variable forwarded to the subprocess: ${name}`,
        );
      }
    });
  } finally {
    Deno.env.delete(marker);
  }
});

/** Mirror of the allowlist in pass.ts, so a change there fails this test. */
const ENV_ALLOWLIST_FOR_TEST = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "GNUPGHOME",
  "GPG_AGENT_INFO",
  "GPG_TTY",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "TERM",
  "PASSWORD_STORE_KEY",
  "PASSWORD_STORE_GPG_OPTS",
  "PASSWORD_STORE_UMASK",
  "PASSWORD_STORE_SIGNING_KEY",
]);
