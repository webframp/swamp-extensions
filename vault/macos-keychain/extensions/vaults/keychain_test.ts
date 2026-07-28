// ABOUTME: Tests for macOS Keychain vault provider
// ABOUTME: Uses Deno.Command stubbing to mock the security CLI

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

/**
 * When set, `add-generic-password` fails and quotes the `-w` value back on
 * stderr.
 *
 * `put` passes the secret as that argument, and the swamp host publishes thrown
 * error messages to the trace backend, so this is the disclosure path worth
 * having a test for.
 */
let addEchoesValueOnFailure = false;

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

        if (addEchoesValueOnFailure) {
          // The failure mode that matters: a CLI quoting a rejected argument
          // back on stderr, where `put` passed the secret as that argument.
          return Promise.resolve({
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(
              `security: invalid value for -w: ${password}`,
            ),
          });
        }

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
  addEchoesValueOnFailure = false;
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

// ---------------------------------------------------------------------------
// Hardening: byte fidelity and key validation
// ---------------------------------------------------------------------------

Deno.test("get preserves leading and trailing whitespace in a secret", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    // The old `.trim()` returned "padded" for every one of these.
    for (const secret of ["  padded  ", "\tleading tab", "trailing space "]) {
      mockKeychain.set("swamp/ws", secret);
      assertEquals(await provider.get("ws"), secret);
    }
  });
});

Deno.test("get strips exactly one trailing newline, not a run of them", async () => {
  await withMockedSecurity(async () => {
    const provider = vault.createProvider("v", {});
    mockKeychain.set("swamp/nl", "line\n\n");
    assertEquals(await provider.get("nl"), "line\n");
    mockKeychain.set("swamp/crlf", "line\r\n");
    assertEquals(await provider.get("crlf"), "line");
    mockKeychain.set("swamp/none", "line");
    assertEquals(await provider.get("none"), "line");
  });
});

Deno.test("empty and flag-like keys are rejected", async () => {
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
  });
});

// ---------------------------------------------------------------------------
// OpenTelemetry spans
//
// `put` hands the secret to `security` as a command-line argument, so the
// absence assertions here are the ones that matter: argv must never reach a
// span, and neither must an error message built from the CLI's stderr.
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

Deno.test("otel: the secret passed in argv never reaches a span", async () => {
  const secret = "SECRET-IN-ARGV-9b31";
  let argvAtPut: string[] = [];
  const spans = await withMockedSecurity(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await provider.put("k", secret);
      argvAtPut = [...lastSecurityArgs];
      await provider.get("k");
    })
  );

  // The secret really is in the argument vector — that is the exposure #275
  // tracks, and it is exactly what a span must not mirror.
  assertEquals(argvAtPut.includes(secret), true);
  assertEquals(spans.length > 0, true);
  for (const s of spans) {
    const text = spanText(s);
    assertEquals(
      text.includes(secret),
      false,
      `secret present in span "${s.name}"`,
    );
    // No attribute may carry the argument vector in any form.
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

Deno.test("otel: stderr quoting the -w argument does not leak the secret", async () => {
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
  // description, an exception.message, and a stack trace.
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
