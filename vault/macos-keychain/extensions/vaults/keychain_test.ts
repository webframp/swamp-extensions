// ABOUTME: Tests for macOS Keychain vault provider
// ABOUTME: Uses Deno.Command stubbing to mock the security CLI

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
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
      { service: "line\nbreak" }, // Would split the security -i command line
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

Deno.test("createProvider throws on service with control characters", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { service: "svc\nname" }),
    Error,
  );
  assertThrows(
    () => vault.createProvider("bad-vault", { service: "svc\tname" }),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Mock of the `security` CLI
//
// The behaviors mocked here are not guesses: each one was probed on real
// hardware (macOS 26.5.2, build 25F84) and recorded in #275.
//
//  - `find-generic-password -w` prints lowercase hex instead of the value
//    when any byte falls outside printable ASCII (0x20-0x7E), plus one
//    trailing newline either way. `mockMode = "legacy"` disables the hex
//    behavior to model older macOS.
//  - `find-generic-password -g` prints the password on stderr, marked
//    `password: "..."` for printable values and `password: 0x<HEX>` when it
//    hex-encodes. `-g` hex-encodes for backslashes too, not only for
//    non-printable bytes.
//  - `security -i` reads whitespace-tokenized commands from stdin. Quotes
//    group a token; inside double quotes a backslash escapes the next
//    character. Lines longer than 4096 bytes (newline included) are split by
//    the real CLI and can store corrupted values, so the mock refuses them —
//    the provider must never send one.
// ---------------------------------------------------------------------------

/** In-memory store for mock keychain items (service/account -> password) */
const mockKeychain = new Map<string, string>();

/** Original Deno.Command constructor */
const OriginalCommand = Deno.Command;

/** Track the last args passed to security for verification */
let lastSecurityArgs: string[] = [];

/** The last full line handed to `security -i` on stdin. */
let lastInteractiveLine: string | undefined;

/** Number of security processes spawned since the mock was installed. */
let securitySpawnCount = 0;

/** "macos26" hex-encodes non-printable output; "legacy" prints raw bytes. */
let mockMode: "macos26" | "legacy" = "macos26";

/**
 * When set, the `-i` write fails and `security` echoes the submitted line —
 * hex-encoded secret included — back on stderr, the way its parser echoes
 * input it rejects. The swamp host publishes thrown error messages to the
 * trace backend, so this is the disclosure path worth having a test for.
 */
let addEchoesValueOnFailure = false;

/**
 * Overrides the `-g` password line. `null` omits the line entirely; a string
 * is used verbatim. For probing the provider's fail-loud paths.
 */
let gPasswordLineOverride: string | null | undefined;

const PRINTABLE = /^[\x20-\x7e]*$/;

function toLowerHex(value: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(value)) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToString(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Tokenizes a `security -i` line with the probed rules: whitespace splits,
 * single or double quotes group, and inside double quotes (or bare) a
 * backslash escapes the next character.
 */
function tokenizeInteractive(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      i++;
      continue;
    }
    inToken = true;
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          current += line[i + 1];
          i += 2;
        } else {
          current += line[i];
          i++;
        }
      }
      i++; // closing quote
      continue;
    }
    if (c === "'") {
      i++;
      while (i < line.length && line[i] !== "'") {
        current += line[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function flagValue(tokens: string[], flag: string): string | undefined {
  const idx = tokens.indexOf(flag);
  return idx >= 0 ? tokens[idx + 1] : undefined;
}

const encoder = new TextEncoder();

function notFoundResult() {
  return {
    code: 44,
    stdout: new Uint8Array(),
    stderr: encoder.encode(
      "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
    ),
  };
}

type MockOutput = { code: number; stdout: Uint8Array; stderr: Uint8Array };

function handleAdd(tokens: string[]): MockOutput {
  const service = flagValue(tokens, "-s") ?? "";
  const account = flagValue(tokens, "-a") ?? "";
  const hex = flagValue(tokens, "-X");
  if (hex === undefined || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    return {
      code: 2,
      stdout: new Uint8Array(),
      stderr: encoder.encode("security: mock expected -X <hex>"),
    };
  }
  mockKeychain.set(`${service}/${account}`, hexToString(hex));
  return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
}

function handleFind(args: string[]): MockOutput {
  const sIdx = args.indexOf("-s");
  const aIdx = args.indexOf("-a");
  const service = sIdx >= 0 ? args[sIdx + 1] : "";
  const account = aIdx >= 0 ? args[aIdx + 1] : "";
  const value = mockKeychain.get(`${service}/${account}`);
  if (value === undefined) return notFoundResult();

  if (args.includes("-w")) {
    const hexEncode = mockMode === "macos26" && !PRINTABLE.test(value);
    const body = hexEncode ? toLowerHex(value) : value;
    return {
      code: 0,
      stdout: encoder.encode(body + "\n"),
      stderr: new Uint8Array(),
    };
  }

  if (args.includes("-g")) {
    let pwLine: string | null;
    if (gPasswordLineOverride !== undefined) {
      pwLine = gPasswordLineOverride;
    } else if (value === "") {
      pwLine = "password: ";
    } else if (!PRINTABLE.test(value) || value.includes("\\")) {
      // -g hex-encodes more aggressively than -w: backslashes trigger it too.
      pwLine = `password: 0x${toLowerHex(value).toUpperCase()} `;
    } else {
      pwLine = `password: "${value}"`;
    }
    const stderrText = pwLine === null ? "" : pwLine + "\n";
    return {
      code: 0,
      stdout: encoder.encode(
        `keychain: "/Users/mock/Library/Keychains/login.keychain-db"\n`,
      ),
      stderr: encoder.encode(stderrText),
    };
  }

  return notFoundResult();
}

/** Mock Deno.Command that simulates the macOS security CLI */
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
    if (this.command === "security") securitySpawnCount++;
    return new MockProcess(this.command, this.args);
  }
}

class MockProcess {
  stdin: MockStdin;
  private command: string;
  private args: string[];
  private stdinChunks: Uint8Array[] = [];

  constructor(command: string, args: string[]) {
    this.command = command;
    this.args = args;
    this.stdin = new MockStdin(this.stdinChunks);
  }

  output(): Promise<MockOutput> {
    if (this.command !== "security") {
      return Promise.resolve({
        code: 127,
        stdout: new Uint8Array(),
        stderr: encoder.encode(`command not found: ${this.command}`),
      });
    }

    // security -i: commands arrive on stdin, one per line.
    if (this.args[0] === "-i") {
      const stdinBytes = Uint8Array.from(
        this.stdinChunks.flatMap((c) => [...c]),
      );
      const text = new TextDecoder().decode(stdinBytes);
      const newlineIdx = text.indexOf("\n");
      const line = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
      lastInteractiveLine = line;

      // The real CLI splits longer lines and can store a corrupted value.
      // The provider guards before spawning, so reaching this is a bug.
      // Like the real readline buffer, count UTF-8 bytes, not code units.
      const newlineByteIdx = stdinBytes.indexOf(0x0a);
      const lineBytes = newlineByteIdx === -1
        ? stdinBytes.byteLength
        : newlineByteIdx;
      if (lineBytes + 1 > 4096) {
        return Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: encoder.encode(
            "mock: line exceeds the security -i 4096-byte buffer",
          ),
        });
      }

      if (addEchoesValueOnFailure) {
        return Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: encoder.encode(`security: unknown command "${line}"`),
        });
      }

      const tokens = tokenizeInteractive(line);
      if (tokens[0] === "add-generic-password") {
        return Promise.resolve(handleAdd(tokens));
      }
      return Promise.resolve({
        code: 1,
        stdout: new Uint8Array(),
        stderr: encoder.encode(`security: unknown command "${tokens[0]}"`),
      });
    }

    const subcommand = this.args[0];
    if (subcommand === "find-generic-password") {
      return Promise.resolve(handleFind(this.args));
    }
    if (subcommand === "add-generic-password") {
      // argv add is only used for the empty value, where -X "" is safe.
      return Promise.resolve(handleAdd(this.args));
    }

    return Promise.resolve({
      code: 2,
      stdout: new Uint8Array(),
      stderr: encoder.encode(`security: unknown command "${subcommand}"`),
    });
  }
}

class MockStdin {
  constructor(private chunks: Uint8Array[]) {}

  getWriter(): MockWriter {
    return new MockWriter(this.chunks);
  }
}

class MockWriter {
  constructor(private chunks: Uint8Array[]) {}

  write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function installMock(): void {
  mockKeychain.clear();
  lastSecurityArgs = [];
  lastInteractiveLine = undefined;
  securitySpawnCount = 0;
  mockMode = "macos26";
  addEchoesValueOnFailure = false;
  gPasswordLineOverride = undefined;
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

Deno.test("keychain vault: failed get names the security subcommand and exit code", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("test", {});
    const err = await assertRejects(
      () => provider.get("nonexistent-key"),
      Error,
    );
    assertEquals(
      err.message.startsWith("security find-generic-password"),
      true,
    );
    assertEquals(/exited with code \d+/.test(err.message), true);
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

// ---------------------------------------------------------------------------
// The write path: secret on stdin, never in argv (#275 part 1)
// ---------------------------------------------------------------------------

Deno.test("put spawns security -i and keeps the secret out of argv", async () => {
  await withMockedSecurity(async () => {
    const secret = "SECRET-MUST-NOT-BE-IN-ARGV-51c2";
    const provider = vault.createProvider("v", {});
    await provider.put("k", secret);

    assertEquals(lastSecurityArgs, ["-i"]);
    const argvText = lastSecurityArgs.join(" ");
    assertEquals(argvText.includes(secret), false);
    assertEquals(argvText.includes(toLowerHex(secret)), false);
  });
});

Deno.test("put sends one -X command line, upserting, within the -i budget", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", { service: "my svc" });
    await provider.put("some-key", "hunter2");

    const line = lastInteractiveLine!;
    assertStringIncludes(line, "add-generic-password");
    assertStringIncludes(line, `-s "my svc"`);
    assertStringIncludes(line, `-a "some-key"`);
    assertStringIncludes(line, `-X ${toLowerHex("hunter2")}`);
    assertStringIncludes(line, "-U");
    // The raw secret itself must not be on the line either.
    assertEquals(line.includes("hunter2"), false);
    assertEquals(encoder.encode(line).byteLength + 1 <= 4096, true);
  });
});

Deno.test("put quotes service and key with backslash escapes", async () => {
  await withMockedSecurity(async () => {
    const service = `we ird"svc`;
    const key = `spaced "key\\name`;
    const provider = vault.createProvider("v", { service });
    await provider.put(key, "value1");

    // The mock tokenizer implements the probed -i quoting rules; storage
    // under the exact raw names proves the escaping round-trips.
    assertEquals(mockKeychain.get(`${service}/${key}`), "value1");
    assertEquals(await provider.get(key), "value1");
  });
});

Deno.test("put rejects an oversize secret before spawning anything", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // Default service "swamp", key "k": the -i line budget allows 2025
    // bytes of secret. One more must throw without touching `security`,
    // because an over-long line stores corrupted bytes before erroring.
    await provider.put("k", "a".repeat(2025));

    securitySpawnCount = 0;
    await assertRejects(
      () => provider.put("k", "a".repeat(2026)),
      Error,
      "too large",
    );
    assertEquals(securitySpawnCount, 0);

    await assertRejects(
      () => provider.put("k", "a".repeat(4096)),
      Error,
      "too large",
    );
    assertEquals(securitySpawnCount, 0);
  });
});

Deno.test("put budgets the -i line in UTF-8 bytes, not code units", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // "🔑" is 2 UTF-16 code units but 4 UTF-8 bytes. With the default
    // service "swamp", a 2024-byte secret makes the line 4095 code units
    // (passes a code-unit check) but 4097 bytes (over the real buffer).
    securitySpawnCount = 0;
    await assertRejects(
      () => provider.put("🔑", "a".repeat(2024)),
      Error,
      "too large",
    );
    assertEquals(securitySpawnCount, 0);

    // One byte under the buffer must still work.
    await provider.put("🔑", "a".repeat(2023));
    assertEquals(mockKeychain.get("swamp/🔑"), "a".repeat(2023));
  });
});

Deno.test("put of an empty secret uses argv, where nothing can leak", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    await provider.put("empty-key", "");
    assertEquals(lastSecurityArgs.includes("-X"), true);
    assertEquals(lastSecurityArgs.includes(""), true);
    assertEquals(mockKeychain.get("swamp/empty-key"), "");
    assertEquals(await provider.get("empty-key"), "");
  });
});

// ---------------------------------------------------------------------------
// The read path: macOS 26 hex output (#275 part 2)
// ---------------------------------------------------------------------------

/** The nine probe values from #275. */
const TABLE_VALUES: [string, string][] = [
  ["baseline", "simple"],
  ["space", "with space"],
  ["quotes", `with"double'single`],
  ["backslash", "back\\slash"],
  ["newline", "line1\nline2"],
  ["padded", "  padded  "],
  ["non-ascii", "é日本語"],
  ["4KiB-printable", printable4KiB()],
  ["hex-looking", "DEADBEEF"],
];

/** Deterministic 4 KiB of printable ASCII (Lehmer LCG, no float overflow). */
function printable4KiB(): string {
  let out = "";
  let x = 42;
  for (let i = 0; i < 4096; i++) {
    x = (x * 48271) % 2147483647;
    out += String.fromCharCode(33 + (x % 94));
  }
  return out;
}

Deno.test("all nine #275 table values round-trip through get (macOS 26 mode)", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    for (const [label, value] of TABLE_VALUES) {
      mockKeychain.set("swamp/probe", value);
      assertEquals(await provider.get("probe"), value, label);
    }
  });
});

Deno.test("all nine #275 table values round-trip through get (legacy raw mode)", async () => {
  await withMockedSecurity(async () => {
    mockMode = "legacy";
    const provider = vault.createProvider("v", {});
    for (const [label, value] of TABLE_VALUES) {
      mockKeychain.set("swamp/probe", value);
      assertEquals(await provider.get("probe"), value, label);
    }
  });
});

Deno.test("table values that fit the write budget round-trip through put + get", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    for (const [label, value] of TABLE_VALUES) {
      if (label === "4KiB-printable") continue; // exceeds the put budget
      await provider.put("probe", value);
      assertEquals(await provider.get("probe"), value, label);
    }
  });
});

Deno.test("get decodes hex-encoded output back to the exact secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    for (
      const secret of [
        "line1\nline2",
        "é日本語",
        "tab\there",
        "ends with newline\n",
        "control",
      ]
    ) {
      mockKeychain.set("swamp/hexed", secret);
      assertEquals(await provider.get("hexed"), secret);
    }
  });
});

Deno.test("get returns hex-looking secrets verbatim, never decoded", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // Each of these is a printable secret the naive "looks like hex, decode
    // it" fix would corrupt. `-g` answers "quoted", so they come back raw.
    for (
      const secret of [
        "DEADBEEF",
        "deadbeef",
        "6c696e65310a6c696e6532",
        toLowerHex(printable4KiB()).slice(0, 4000),
      ]
    ) {
      mockKeychain.set("swamp/hexlike", secret);
      assertEquals(await provider.get("hexlike"), secret);
    }
  });
});

Deno.test("get consults -g only for hex-looking output", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});

    mockKeychain.set("swamp/plain", "just a password");
    securitySpawnCount = 0;
    await provider.get("plain");
    assertEquals(securitySpawnCount, 1); // -w only

    mockKeychain.set("swamp/hexlike", "deadbeef");
    securitySpawnCount = 0;
    await provider.get("hexlike");
    assertEquals(securitySpawnCount, 2); // -w, then -g to disambiguate
  });
});

Deno.test("get fails loudly when -g yields no password line", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    mockKeychain.set("swamp/k", "line1\nline2"); // forces the hex path
    gPasswordLineOverride = null;
    await assertRejects(
      () => provider.get("k"),
      Error,
      "could not determine",
    );
  });
});

Deno.test("get fails loudly on a malformed -g hex token", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    mockKeychain.set("swamp/k", "line1\nline2");
    gPasswordLineOverride = "password: 0xNOTHEX";
    await assertRejects(
      () => provider.get("k"),
      Error,
      "could not determine",
    );
  });
});

Deno.test("get fails loudly when the stored bytes are not valid UTF-8", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    mockKeychain.set("swamp/k", "line1\nline2");
    // 0xC3 is a dangling UTF-8 lead byte. Returning replacement characters
    // would be silent corruption; the provider must throw instead.
    gPasswordLineOverride = "password: 0xC3 ";
    await assertRejects(() => provider.get("k"));
  });
});

// ---------------------------------------------------------------------------
// Hardening: byte fidelity and key validation
// ---------------------------------------------------------------------------

Deno.test("get preserves leading and trailing whitespace in a secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // "\tleading tab" hex-encodes on macOS 26; cover the raw path too.
    for (const mode of ["macos26", "legacy"] as const) {
      mockMode = mode;
      for (const secret of ["  padded  ", "\tleading tab", "trailing space "]) {
        mockKeychain.set("swamp/ws", secret);
        assertEquals(await provider.get("ws"), secret, mode);
      }
    }
  });
});

Deno.test("trailing newlines survive exactly (hex path) and via the one-strip rule (raw path)", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // macOS 26: any newline forces hex output, which decodes exactly.
    mockKeychain.set("swamp/nl", "line\n\n");
    assertEquals(await provider.get("nl"), "line\n\n");
    // Legacy: output is value + exactly one CLI newline; one strip is exact.
    mockMode = "legacy";
    mockKeychain.set("swamp/nl", "line\n\n");
    assertEquals(await provider.get("nl"), "line\n\n");
    mockKeychain.set("swamp/none", "line");
    assertEquals(await provider.get("none"), "line");
  });
});

Deno.test("empty, flag-like, and control-character keys are rejected", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    await assertRejects(() => provider.get(""), Error, "empty");
    await assertRejects(() => provider.put("", "x"), Error, "empty");
    // A leading dash becomes a flag to `security`, not an account name.
    await assertRejects(
      () => provider.get("-w"),
      Error,
      "must not start with",
    );
    await assertRejects(
      () => provider.put("-U", "x"),
      Error,
      "must not start with",
    );
    // A newline would split the -i command line; other control characters
    // are rejected with it.
    for (const key of ["a\nb", "a\rb", "a\tb", "a\x00b"]) {
      await assertRejects(
        () => provider.put(key, "x"),
        Error,
        "control",
      );
      await assertRejects(() => provider.get(key), Error, "control");
    }
  });
});

// ---------------------------------------------------------------------------
// OpenTelemetry spans
//
// `put` feeds the hex-encoded secret to `security -i` on stdin. The absence
// assertions here are the ones that matter: neither the secret, nor its hex
// encoding, nor the submitted command line may reach a span — and neither may
// an error message built from the CLI's stderr.
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
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      const provider = vault.createProvider("laptop-secrets", {
        service: "myapp",
      });
      await provider.put("db/password", "s3cret");
      assertEquals(await provider.get("db/password"), "s3cret");
    })
  );

  const span = spanNamed(spans, "Keychain get");
  assertEquals(span.instrumentationScope.name, "@webframp/macos-keychain");
  assertEquals(attrKeys(span), [
    "rpc.method",
    "rpc.service",
    "rpc.system",
    "vault.name",
    "vault.secret_key",
    "vault.service",
  ]);
  assertEquals(span.attributes["vault.name"], "laptop-secrets");
  assertEquals(span.attributes["vault.service"], "myapp");
  assertEquals(span.attributes["vault.secret_key"], "db/password");
  assertEquals(span.attributes["rpc.system"], "keychain");
  assertEquals(span.status.code, SpanStatusCode.UNSET);
});

Deno.test("otel: the secret is absent from argv and from every span", async () => {
  const secret = "SECRET-NEVER-IN-ARGV-9b31";
  let argvAtPut: string[] = [];
  let lineAtPut = "";
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await provider.put("k", secret);
      argvAtPut = [...lastSecurityArgs];
      lineAtPut = lastInteractiveLine!;
      await provider.get("k");
    })
  );

  // The #275 fix itself: argv carries only "-i"; the secret travels on stdin
  // as hex.
  assertEquals(argvAtPut, ["-i"]);
  assertStringIncludes(lineAtPut, toLowerHex(secret));

  assertEquals(spans.length > 0, true);
  for (const s of spans) {
    const text = spanText(s);
    assertEquals(
      text.includes(secret),
      false,
      `secret present in span "${s.name}"`,
    );
    assertEquals(
      text.includes(toLowerHex(secret)),
      false,
      `hex-encoded secret present in span "${s.name}"`,
    );
    // No attribute may carry the command line in any form.
    assertEquals(text.includes("add-generic-password"), false);
    assertEquals(text.includes("find-generic-password"), false);
  }
});

Deno.test("otel: a failed get is marked ERROR with a type and no message", async () => {
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await assertRejects(() => provider.get("missing"), Error);
    })
  );

  const span = spanNamed(spans, "Keychain get");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  // The message here is `security` stderr. The host already publishes it; this
  // extension will not publish it a second time.
  assertEquals(span.status.message, undefined);
  assertEquals(span.attributes["error.type"], "Error");
  assertEquals(span.events.length, 0);
});

Deno.test("otel: stderr echoing the -i line does not leak the secret", async () => {
  const secret = "SECRET-ECHOED-BY-SECURITY-7c4d";
  let thrown: Error | undefined;
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      addEchoesValueOnFailure = true;
      const provider = vault.createProvider("v", {});
      thrown = await assertRejects(() => provider.put("k", secret), Error);
    })
  );

  // This message is what the host writes into swamp.cli as a status
  // description, an exception.message, and a stack trace. The mock echoed the
  // whole -i line, so the hex encoding is the value that must be gone.
  assertEquals(thrown?.message.includes(secret), false);
  assertEquals(thrown?.message.includes(toLowerHex(secret)), false);
  assertEquals(thrown?.message.includes("[redacted]"), true);
  for (const s of spans) {
    const text = spanText(s);
    assertEquals(
      text.includes(secret),
      false,
      `secret present in span "${s.name}"`,
    );
    assertEquals(
      text.includes(toLowerHex(secret)),
      false,
      `hex-encoded secret present in span "${s.name}"`,
    );
  }
});

Deno.test("otel: the unsupported list reports as a failed span", async () => {
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await assertRejects(() => provider.list(), Error);
    })
  );

  // A caller asked for a listing and did not get one. Recording that as a
  // failure is honest, and it makes the unsupported operation discoverable in a
  // trace rather than only in a thrown message.
  const span = spanNamed(spans, "Keychain list");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  assertEquals(span.attributes["error.type"], "Error");
  assertEquals(span.attributes["vault.secret_key"], undefined);
});
