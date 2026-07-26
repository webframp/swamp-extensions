// gopass Vault Provider Tests
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
} from "npm:@opentelemetry/api@1.9.0";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@2.10.0";
import { AsyncLocalStorageContextManager } from "npm:@opentelemetry/context-async-hooks@2.10.0";
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

/**
 * When set, `insert` fails and quotes the submitted value back on stderr.
 *
 * That is the shape that turns a CLI error into a secret disclosure, since the
 * swamp host publishes thrown error messages to the trace backend.
 */
let insertEchoesValueOnFailure = false;

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
        if (insertEchoesValueOnFailure) {
          return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(`gopass: rejected value: ${value}`),
          };
        }
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
  insertEchoesValueOnFailure = false;
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

// ---------------------------------------------------------------------------
// Hardening: byte fidelity and key validation
// ---------------------------------------------------------------------------

Deno.test("get preserves leading and trailing whitespace in a secret", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("v", { passwordOnly: false });
    // The old `.trim()` returned "padded" for every one of these.
    for (const secret of ["  padded  ", "\tleading tab", "trailing space "]) {
      mockSecrets.set("ws", secret);
      assertEquals(await provider.get("ws"), secret);
    }
  });
});

Deno.test("get strips exactly one trailing newline, not a run of them", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("v", { passwordOnly: false });
    mockSecrets.set("nl", "line\n\n");
    assertEquals(await provider.get("nl"), "line\n");
    mockSecrets.set("crlf", "line\r\n");
    assertEquals(await provider.get("crlf"), "line");
    mockSecrets.set("none", "line");
    assertEquals(await provider.get("none"), "line");
  });
});

Deno.test("keys containing .. are rejected before reaching the CLI", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("v", { store: "team" });
    for (const key of ["../escape", "a/../../b", ".."]) {
      await assertRejects(() => provider.get(key), Error, "path segments");
      await assertRejects(() => provider.put(key, "x"), Error, "path segments");
    }
  });
});

Deno.test("absolute, empty, and flag-like keys are rejected", async () => {
  await withMockedGopass(async () => {
    const provider = vault.createProvider("v", {});
    await assertRejects(() => provider.get("/etc/passwd"), Error, "relative");
    await assertRejects(() => provider.get(""), Error, "empty");
    // A leading dash would be read as a flag by gopass itself.
    await assertRejects(
      () => provider.get("-c"),
      Error,
      "must not start with",
    );
    for (const key of ["a//b", "trailing/"]) {
      await assertRejects(() => provider.get(key), Error, "empty path segment");
    }
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
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("work-secrets", { store: "work" });
      mockSecrets.set("work/db/password", "s3cret");
      assertEquals(await provider.get("db/password"), "s3cret");
    })
  );

  const span = spanNamed(spans, "gopass get");
  assertEquals(span.instrumentationScope.name, "@webframp/gopass");
  assertEquals(attrKeys(span), [
    "rpc.method",
    "rpc.service",
    "rpc.system",
    "vault.name",
    "vault.secret_key",
    "vault.store",
  ]);
  assertEquals(span.attributes["vault.name"], "work-secrets");
  assertEquals(span.attributes["vault.store"], "work");
  assertEquals(span.attributes["vault.secret_key"], "db/password");
  assertEquals(span.attributes["rpc.system"], "gopass");
  assertEquals(span.status.code, SpanStatusCode.UNSET);
});

Deno.test("otel: put and list emit spans, list reports the key count", async () => {
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await provider.put("a", "SECRET-CANARY-9b31");
      await provider.put("b", "another");
      assertEquals(await provider.list(), ["a", "b"]);
    })
  );

  assertEquals(spanNamed(spans, "gopass put").attributes["rpc.method"], "put");
  const list = spanNamed(spans, "gopass list");
  assertEquals(list.attributes["vault.keys_returned"], 2);
  // No key on a listing — there isn't one.
  assertEquals(list.attributes["vault.secret_key"], undefined);

  for (const s of spans) {
    assertEquals(
      spanText(s).includes("SECRET-CANARY-9b31"),
      false,
      `secret value present in span "${s.name}"`,
    );
  }
});

Deno.test("otel: an empty store records a zero count, not a missing one", async () => {
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      assertEquals(await provider.list(), []);
    })
  );

  assertEquals(
    spanNamed(spans, "gopass list").attributes["vault.keys_returned"],
    0,
  );
});

Deno.test("otel: a failed get is marked ERROR with a type and no message", async () => {
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      await assertRejects(() => provider.get("missing"), Error);
    })
  );

  const span = spanNamed(spans, "gopass get");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  // No description: the host already publishes the thrown message, and this
  // message is the CLI's stderr.
  assertEquals(span.status.message, undefined);
  assertEquals(span.attributes["error.type"], "Error");
  // recordException would publish exception.message and a stack trace.
  assertEquals(span.events.length, 0);
});

Deno.test("otel: stderr echoing the submitted value does not leak it", async () => {
  const secret = "SECRET-ECHOED-BY-CLI-7c4d";
  let thrown: Error | undefined;
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      insertEchoesValueOnFailure = true;
      const provider = vault.createProvider("v", {});
      thrown = await assertRejects(() => provider.put("k", secret), Error);
    })
  );

  // The message is what the host publishes to the trace backend.
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
  const spans = await withMockedGopass(() =>
    withSpans(async () => {
      const provider = vault.createProvider("v", {});
      // Key validation happens inside the span, so a traversal attempt shows up
      // as a failure rather than vanishing.
      await assertRejects(() => provider.get("../escape"), Error);
    })
  );

  const span = spanNamed(spans, "gopass get");
  assertEquals(span.status.code, SpanStatusCode.ERROR);
  assertEquals(span.attributes["vault.secret_key"], "../escape");
});
