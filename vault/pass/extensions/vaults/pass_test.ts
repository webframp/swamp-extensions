// Pass (passwordstore.org) Vault Provider Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  context as otelContext,
  SpanStatusCode,
  trace as otelTrace,
} from "npm:@opentelemetry/api@1.9.1";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@2.10.0";
import { AsyncLocalStorageContextManager } from "npm:@opentelemetry/context-async-hooks@2.10.0";
import {
  assertVaultConformance,
  assertVaultExportConformance,
} from "@swamp-club/swamp-testing";
import { ENV_ALLOWLIST, vault } from "./pass.ts";

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
      { passwordOnly: true },
      { fieldSeparator: "#" },
    ],
    invalidConfigs: [
      { storeDir: 123 }, // Wrong type
      { prefix: 123 }, // Wrong type
      { passwordOnly: "yes" }, // Wrong type
      { fieldSeparator: "" }, // Empty separator would split every key
      { fieldSeparator: "/" }, // Would split on path segments
      { fieldSeparator: " " }, // "my entry" would read the "entry:" field of "my"
      { fieldSeparator: "#\t" }, // Whitespace anywhere in the separator
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
// withMockedCommand from @swamp-club/swamp-testing does not support spawn(),
// which the pass vault needs for piping secrets via stdin to `pass insert`.
// ---------------------------------------------------------------------------

const mockSecrets = new Map<string, string>();
const OriginalCommand = Deno.Command;

/**
 * When set, `insert` fails and quotes the submitted value back on stderr.
 *
 * That is the shape that turns a CLI error into a secret disclosure, since the
 * swamp host publishes thrown error messages to the trace backend.
 */
let insertEchoesValueOnFailure = false;
/** When set, the mocked `find` subprocess fails instead of listing files. */
let findFails = false;
/** Options handed to the most recent subprocess, for environment assertions. */
interface CapturedOptions {
  command: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
}
let lastOptions: CapturedOptions | undefined;

/**
 * Returns the captured options, throwing if nothing was spawned.
 *
 * Reading through a function keeps the declared type: assigning `undefined` to
 * the variable inside a test body narrows it to `undefined` for the rest of
 * that body, and an assertion on top of that narrows to `never`.
 */
function captured(): CapturedOptions {
  const opts = lastOptions;
  if (!opts) throw new Error("no subprocess was spawned");
  return opts;
}

class MockCommand {
  #command: string;
  #args: string[];
  #stdinData: string | undefined;

  constructor(
    command: string,
    options: {
      args?: string[];
      env?: Record<string, string>;
      clearEnv?: boolean;
      stdin?: string;
      stdout?: string;
      stderr?: string;
    },
  ) {
    this.#command = command;
    this.#args = options.args ?? [];
    lastOptions = {
      command,
      env: options.env,
      clearEnv: options.clearEnv,
    };
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
        const value = this.#stdinData ?? "";
        if (insertEchoesValueOnFailure) {
          return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: enc.encode(`pass: rejected value: ${value}`),
          };
        }
        mockSecrets.set(key, value);
        return {
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
    }

    if (this.#command === "find") {
      if (findFails) {
        return {
          code: 1,
          stdout: new Uint8Array(),
          stderr: enc.encode(
            `find: '${this.#args[0]}': No such file or directory`,
          ),
        };
      }
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
  insertEchoesValueOnFailure = false;
  findFails = false;
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

Deno.test("pass vault: failed get names the pass subcommand and exit code", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    const err = await assertRejects(
      () => provider.get("nonexistent-key"),
      Error,
    );
    assertEquals(err.message.startsWith("pass show"), true);
    assertEquals(/exited with code \d+/.test(err.message), true);
  });
});

Deno.test("pass vault: list throws (not silently empty) when find itself fails", async () => {
  await withMockedPass(async () => {
    findFails = true;
    const provider = vault.createProvider("test", { storeDir: "/tmp/store" });
    await assertRejects(
      () => provider.list(),
      Error,
      "pass list failed: find /tmp/store exited with code 1",
    );
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

Deno.test("keys with empty path segments are rejected", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    for (const key of ["a//b", "trailing/"]) {
      await assertRejects(() => provider.get(key), Error, "empty path segment");
    }
  });
});

Deno.test("the subprocess environment is an allowlist, not the whole parent", async () => {
  const marker = "SWAMP_PASS_TEST_UNRELATED_SECRET";
  Deno.env.set(marker, "must-not-be-forwarded");
  try {
    await withMockedPass(async () => {
      lastOptions = undefined;
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await provider.put("env-probe", "value");

      const opts = captured();
      // Deno merges `env` into the parent environment unless clearEnv is set,
      // so without this flag the allowlist below would filter nothing.
      assertEquals(opts.clearEnv, true);
      const env = opts.env ?? {};
      assertEquals(env[marker], undefined);
      assertEquals(env.PASSWORD_STORE_DIR, "/tmp/store");
      // Everything forwarded must be something pass or GPG needs.
      const allowed = new Set<string>(ENV_ALLOWLIST);
      for (const name of Object.keys(env)) {
        assertEquals(
          name === "PASSWORD_STORE_DIR" || allowed.has(name),
          true,
          `unexpected variable forwarded to the subprocess: ${name}`,
        );
      }
    });
  } finally {
    Deno.env.delete(marker);
  }
});

Deno.test("the find subprocess gets the same narrowed environment", async () => {
  const marker = "SWAMP_PASS_TEST_UNRELATED_SECRET_LIST";
  Deno.env.set(marker, "must-not-be-forwarded");
  try {
    await withMockedPass(async () => {
      lastOptions = undefined;
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await provider.list();

      const findOpts = captured();
      assertEquals(findOpts.command, "find");
      assertEquals(findOpts.clearEnv, true);
      assertEquals((findOpts.env ?? {})[marker], undefined);
    });
  } finally {
    Deno.env.delete(marker);
  }
});

Deno.test("extraEnv forwards additional named variables", async () => {
  const extra = "SWAMP_PASS_TEST_EXOTIC_PINENTRY_VAR";
  Deno.env.set(extra, "needed");
  try {
    await withMockedPass(async () => {
      lastOptions = undefined;
      const provider = vault.createProvider("v", {
        storeDir: "/tmp/store",
        extraEnv: [extra],
      });
      await provider.put("env-probe", "value");

      assertEquals((captured().env ?? {})[extra], "needed");
    });
  } finally {
    Deno.env.delete(extra);
  }
});

/**
 * Proves the narrowing end to end rather than through the mock.
 *
 * The mock can only show which options the provider passed; it cannot show
 * what the operating system handed the child process. This test puts a fake
 * `pass` on PATH that dumps its own environment to a file, then asserts a
 * variable set in this process did not reach it. An allowlist without
 * `clearEnv: true` passes every mock-level assertion above and still fails
 * this one, because Deno merges `env` into the parent environment.
 */
Deno.test({
  name: "a real subprocess does not receive unrelated parent variables",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const marker = "SWAMP_PASS_TEST_REAL_SUBPROCESS_SECRET";
    const tmp = await Deno.makeTempDir({ prefix: "swamp-pass-env-" });
    const originalPath = Deno.env.get("PATH") ?? "";
    const dumpFile = `${tmp}/env.txt`;

    await Deno.writeTextFile(
      `${tmp}/pass`,
      `#!/bin/sh\nenv > ${dumpFile}\ncat > /dev/null\nexit 0\n`,
    );
    await Deno.chmod(`${tmp}/pass`, 0o755);
    Deno.env.set(marker, "must-not-be-forwarded");
    Deno.env.set("PATH", `${tmp}:${originalPath}`);

    try {
      const provider = vault.createProvider("v", { storeDir: tmp });
      await provider.put("real-env-probe", "value");

      const dumped = await Deno.readTextFile(dumpFile);
      const names = new Set(
        dumped.split("\n").filter(Boolean).map((line) =>
          line.slice(0, line.indexOf("="))
        ),
      );

      assertEquals(
        names.has(marker),
        false,
        "the parent variable reached the subprocess",
      );
      assertEquals(
        dumped.includes(`PASSWORD_STORE_DIR=${tmp}`),
        true,
        "PASSWORD_STORE_DIR did not reach the subprocess",
      );
    } finally {
      Deno.env.set("PATH", originalPath);
      Deno.env.delete(marker);
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Multiline entries: passwordOnly and field selection
//
// pass convention puts the password on line 1 and `name: value` metadata on
// the lines after it. The default still returns the whole entry, so existing
// consumers see no change.
// ---------------------------------------------------------------------------

const MULTILINE_ENTRY = "s3cr3t-value\n" +
  "login: user@example.com\n" +
  "host: smtp.example.com\n";

Deno.test("multiline: the default returns the whole entry", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    mockSecrets.set("swamp/example", MULTILINE_ENTRY);
    assertEquals(
      await provider.get("example"),
      "s3cr3t-value\nlogin: user@example.com\nhost: smtp.example.com",
    );
  });
});

Deno.test("multiline: passwordOnly returns line 1 only", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      passwordOnly: true,
    });
    mockSecrets.set("swamp/example", MULTILINE_ENTRY);
    assertEquals(await provider.get("example"), "s3cr3t-value");
  });
});

Deno.test("multiline: passwordOnly keeps edge whitespace and drops CRLF", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      passwordOnly: true,
    });
    mockSecrets.set("swamp/crlf", "  pad ded \r\nlogin: x\r\n");
    mockSecrets.set("swamp/single", "only-line\n");
    assertEquals(await provider.get("crlf"), "  pad ded ");
    assertEquals(await provider.get("single"), "only-line");
  });
});

Deno.test("multiline: fieldSeparator selects a named field", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set("swamp/smtp/example", MULTILINE_ENTRY);
    assertEquals(await provider.get("smtp/example#login"), "user@example.com");
    assertEquals(await provider.get("smtp/example#host"), "smtp.example.com");
    // Field names match case-insensitively, as browserpass matches them.
    assertEquals(await provider.get("smtp/example#LOGIN"), "user@example.com");
    // A key without the separator still returns the whole entry.
    assertEquals(
      await provider.get("smtp/example"),
      "s3cr3t-value\nlogin: user@example.com\nhost: smtp.example.com",
    );
  });
});

Deno.test("multiline: field parsing never treats line 1 as a field", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set("swamp/tricky", "url: not-a-field\nurl: https://x.test\n");
    assertEquals(await provider.get("tricky#url"), "https://x.test");
  });
});

Deno.test("multiline: a field value keeps colons and the first match wins", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set(
      "swamp/svc",
      "pw\nurl:https://a.test:8443/x\nurl: https://b.test\n",
    );
    assertEquals(await provider.get("svc#url"), "https://a.test:8443/x");
  });
});

Deno.test("multiline: the separator splits at its last occurrence", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set("swamp/team#a/entry", "pw\nlogin: me\n");
    assertEquals(await provider.get("team#a/entry#login"), "me");
  });
});

Deno.test("multiline: fieldSeparator works with passwordOnly and a multi-char separator", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      passwordOnly: true,
      fieldSeparator: "::",
    });
    mockSecrets.set("swamp/example", MULTILINE_ENTRY);
    assertEquals(await provider.get("example"), "s3cr3t-value");
    assertEquals(await provider.get("example::login"), "user@example.com");
  });
});

Deno.test("multiline: without fieldSeparator a # in a key is literal", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
    mockSecrets.set("swamp/a#b", "literal");
    assertEquals(await provider.get("a#b"), "literal");
  });
});

Deno.test("multiline: a missing field fails without quoting the entry", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set("swamp/example", MULTILINE_ENTRY);
    const err = await assertRejects(
      () => provider.get("example#otp"),
      Error,
      'pass entry "example" has no "otp:" field',
    );
    assertEquals(err.message.includes("s3cr3t-value"), false);
    assertEquals(err.message.includes("user@example.com"), false);
  });
});

Deno.test("multiline: text after the separator that is not a field name is part of the entry name", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set("swamp/team#a/entry", "dir-entry");
    mockSecrets.set("swamp/a#", "trailing");
    mockSecrets.set("swamp/b# ", "blank");
    mockSecrets.set("swamp/c#x:y", "colon");
    for (const key of ["team#a/entry", "a#", "b# ", "c#x:y"]) {
      assertEquals(
        await provider.get(key),
        mockSecrets.get(`swamp/${key}`),
        `"${key}" was not read as a whole entry`,
      );
    }
  });
});

Deno.test("multiline: every key list returns stays readable with fieldSeparator set", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    await provider.put("plain", "p");
    await provider.put("team#a/entry", "d");
    await provider.put("a#", "t");
    const keys = await provider.list();
    assertEquals(keys, ["a#", "plain", "team#a/entry"]);
    for (const key of keys) {
      assertEquals(await provider.get(key), mockSecrets.get(`swamp/${key}`));
    }
  });
});

Deno.test("multiline: an empty entry path is rejected before the CLI runs", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    lastOptions = undefined;
    await assertRejects(
      () => provider.get("#login"),
      Error,
      "must not be empty",
    );
    assertEquals(lastOptions, undefined);
  });
});

Deno.test("multiline: field parsing handles CRLF, empty values, and surrounding whitespace", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set(
      "swamp/e",
      "pw\r\nlogin: me\r\n  User : spaced \r\nempty:\r\n",
    );
    assertEquals(await provider.get("e#login"), "me");
    // Whitespace around the name is ignored; trailing value whitespace is kept.
    assertEquals(await provider.get("e#user"), "spaced ");
    assertEquals(await provider.get("e#empty"), "");
  });
});

Deno.test("multiline: URI lines such as otpauth:// are not fields", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    mockSecrets.set(
      "swamp/e",
      "pw\notpauth://totp/a?secret=ABC\nhttps://example.test\n",
    );
    await assertRejects(
      () => provider.get("e#otpauth"),
      Error,
      'no "otpauth:"',
    );
    await assertRejects(() => provider.get("e#https"), Error, 'no "https:"');
  });
});

Deno.test("multiline: put refuses a key that selects a field", async () => {
  await withMockedPass(async () => {
    const provider = vault.createProvider("v", {
      storeDir: "/tmp/store",
      fieldSeparator: "#",
    });
    await assertRejects(
      () => provider.put("example#login", "x"),
      Error,
      'selects the "login" field of "example"',
    );
    assertEquals(mockSecrets.size, 0);
  });
});

// ---------------------------------------------------------------------------
// OpenTelemetry spans
//
// The absence assertions matter as much as the presence ones: a span that
// reports a successful read while carrying the secret it read is worse than no
// span at all.
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with a TracerProvider installed and returns the spans it produced.
 *
 * The flush-then-yield before teardown is not decoration: InMemorySpanExporter
 * defers its export callback through a timer, and Deno's test sanitizer reports
 * that timer as a leak if the provider is torn down first.
 */
async function withSpans(fn: () => Promise<void>): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const ctxManager = new AsyncLocalStorageContextManager().enable();
  otelContext.setGlobalContextManager(ctxManager);
  otelTrace.setGlobalTracerProvider(provider);
  try {
    await fn();
    await provider.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return exporter.getFinishedSpans();
  } finally {
    await provider.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    otelTrace.disable();
    otelContext.disable();
    ctxManager.disable();
    await provider.shutdown();
  }
}

function attrKeys(span: ReadableSpan): string[] {
  return Object.keys(span.attributes).sort();
}

function spanNamed(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `no span named "${name}"; got ${spans.map((s) => s.name).join(", ")}`,
    );
  }
  return found;
}

/** Everything a span could carry, flattened for canary searching. */
function spanText(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events,
    links: span.links,
  });
}

Deno.test("otel: get emits a span with the documented attribute set", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("app-secrets", {
        storeDir: "/tmp/store",
      });
      mockSecrets.set("swamp/db/password", "s3cret");
      assertEquals(await provider.get("db/password"), "s3cret");
    })
  );

  const span = spanNamed(spans, "pass get");
  assertEquals(span.instrumentationScope.name, "@webframp/pass");
  assertEquals(attrKeys(span), [
    "rpc.method",
    "rpc.service",
    "rpc.system",
    "vault.name",
    "vault.prefix",
    "vault.secret_key",
  ]);
  assertEquals(span.attributes["vault.name"], "app-secrets");
  assertEquals(span.attributes["vault.prefix"], "swamp");
  assertEquals(span.attributes["vault.secret_key"], "db/password");
  assertEquals(span.attributes["rpc.system"], "pass");
  assertEquals(span.status.code, SpanStatusCode.UNSET);
});

Deno.test("otel: an empty prefix is omitted rather than recorded blank", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {
        storeDir: "/tmp/store",
        prefix: "",
      });
      mockSecrets.set("k", "v");
      await provider.get("k");
    })
  );

  assertEquals(
    spanNamed(spans, "pass get").attributes["vault.prefix"],
    undefined,
  );
});

Deno.test("otel: put and list emit spans, list reports the key count", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await provider.put("a", "SECRET-CANARY-9b31");
      await provider.put("b", "another");
      assertEquals(await provider.list(), ["a", "b"]);
    })
  );

  assertEquals(spanNamed(spans, "pass put").attributes["rpc.method"], "put");
  const list = spanNamed(spans, "pass list");
  assertEquals(list.attributes["vault.keys_returned"], 2);
  assertEquals(list.attributes["vault.secret_key"], undefined);

  for (const s of spans) {
    assertEquals(
      spanText(s).includes("SECRET-CANARY-9b31"),
      false,
      `secret value present in span "${s.name}"`,
    );
  }
});

Deno.test("otel: a failed get is marked ERROR with a type and no message", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await assertRejects(() => provider.get("missing"), Error);
    })
  );

  const span = spanNamed(spans, "pass get");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  assertEquals(span.status.message, undefined);
  assertEquals(span.attributes["error.type"], "Error");
  assertEquals(span.events.length, 0);
});

Deno.test("otel: stderr echoing the submitted value does not leak it", async () => {
  const secret = "SECRET-ECHOED-BY-CLI-7c4d";
  let thrown: Error | undefined;
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      insertEchoesValueOnFailure = true;
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      thrown = await assertRejects(() => provider.put("k", secret), Error);
    })
  );

  assertEquals(thrown?.message.includes(secret), false);
  assertEquals(thrown?.message.includes("[redacted]"), true);
  for (const s of spans) {
    assertEquals(
      spanText(s).includes(secret),
      false,
      `secret present in span "${s.name}"`,
    );
  }
});

Deno.test("otel: a rejected key is still recorded as a failed span", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", { storeDir: "/tmp/store" });
      await assertRejects(() => provider.get("../escape"), Error);
    })
  );

  const span = spanNamed(spans, "pass get");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  assertEquals(span.attributes["vault.secret_key"], "../escape");
});

Deno.test("otel: a field selection records the entry and field, never the value", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {
        storeDir: "/tmp/store",
        fieldSeparator: "#",
      });
      mockSecrets.set(
        "swamp/smtp",
        "PW-CANARY-1f2e\nlogin: LOGIN-CANARY-3a4b\n",
      );
      assertEquals(await provider.get("smtp#login"), "LOGIN-CANARY-3a4b");
    })
  );

  const span = spanNamed(spans, "pass get");
  assertEquals(span.attributes["vault.secret_key"], "smtp");
  assertEquals(span.attributes["vault.secret_field"], "login");
  const text = spanText(span);
  assertEquals(text.includes("PW-CANARY-1f2e"), false);
  assertEquals(text.includes("LOGIN-CANARY-3a4b"), false);
});

Deno.test("otel: a put that selects a field records the entry and field like get", async () => {
  const spans = await withMockedPass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {
        storeDir: "/tmp/store",
        fieldSeparator: "#",
      });
      await assertRejects(
        () => provider.put("smtp#login", "VALUE-CANARY-5d6e"),
        Error,
      );
    })
  );

  const span = spanNamed(spans, "pass put");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  assertEquals(span.attributes["vault.secret_key"], "smtp");
  assertEquals(span.attributes["vault.secret_field"], "login");
  assertEquals(spanText(span).includes("VALUE-CANARY-5d6e"), false);
});
