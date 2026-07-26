// HashiCorp Vault Provider Tests
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
import { vault } from "./hashicorp.ts";

// ---------------------------------------------------------------------------
// Export conformance tests
// ---------------------------------------------------------------------------

Deno.test("vault export conforms to VaultProvider contract", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      { address: "https://vault.example.com:8200", token: "hvs.xxx" },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        mount: "kv",
      },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        kvVersion: "1",
      },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        namespace: "admin",
      },
    ],
    invalidConfigs: [
      {}, // Missing required fields
      { token: "hvs.xxx" }, // Missing address
      { address: "not-a-url", token: "hvs.xxx" }, // Invalid URL
    ],
  });
});

Deno.test("createProvider throws on missing address", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { token: "hvs.xxx" }),
    Error,
  );
});

Deno.test("createProvider throws on missing token when no env or file", () => {
  const originalToken = Deno.env.get("VAULT_TOKEN");
  const originalHome = Deno.env.get("HOME");
  Deno.env.delete("VAULT_TOKEN");
  // Point HOME to a nonexistent dir so ~/.vault-token won't be found
  Deno.env.set("HOME", "/tmp/nonexistent-vault-test-dir");
  try {
    assertThrows(
      () =>
        vault.createProvider("bad-vault", {
          address: "https://vault.example.com",
        }),
      Error,
      "No Vault token found",
    );
  } finally {
    if (originalToken) Deno.env.set("VAULT_TOKEN", originalToken);
    if (originalHome) Deno.env.set("HOME", originalHome);
  }
});

Deno.test("createProvider accepts valid config", () => {
  const provider = vault.createProvider("test-vault", {
    address: "https://vault.example.com:8200",
    token: "hvs.test-token",
  });
  assertEquals(provider.getName(), "test-vault");
});

// ---------------------------------------------------------------------------
// Mock Vault Server
// ---------------------------------------------------------------------------

interface MockVaultServer {
  url: string;
  server: Deno.HttpServer;
  secrets: Map<string, Record<string, unknown>>;
  lastHeaders: Headers | null;
}

function startMockVaultServer(kvVersion: "1" | "2" = "2"): MockVaultServer {
  const secrets = new Map<string, Record<string, unknown>>();
  let lastHeaders: Headers | null = null;

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    lastHeaders = req.headers;
    const url = new URL(req.url);
    const path = url.pathname;

    // Verify token is present
    const token = req.headers.get("X-Vault-Token");
    if (!token) {
      return Response.json({ errors: ["missing client token"] }, {
        status: 403,
      });
    }

    // KV v2 paths: /v1/secret/data/<key> and /v1/secret/metadata/<key>
    // KV v1 paths: /v1/secret/<key>
    const dataMatch = path.match(/^\/v1\/secret\/data\/(.+)$/);
    const metadataMatch = path.match(/^\/v1\/secret\/metadata(?:\/(.*))?$/);
    const v1Match = path.match(/^\/v1\/secret\/([^/]+.*)$/);

    // Handle KV v2 data operations
    if (kvVersion === "2" && dataMatch) {
      const key = dataMatch[1];

      if (req.method === "GET") {
        const data = secrets.get(key);
        if (!data) {
          return Response.json({ errors: ["secret not found"] }, {
            status: 404,
          });
        }
        return Response.json({ data: { data } });
      }

      if (req.method === "POST") {
        const body = await req.json();
        secrets.set(key, body.data);
        return Response.json({ data: { version: 1 } });
      }
    }

    // Handle KV v2 list operations
    if (kvVersion === "2" && metadataMatch && req.method === "LIST") {
      const prefix = metadataMatch[1] || "";
      const keys: string[] = [];
      // Real Vault returns decoded names in a LIST response while matching on
      // the request path, which is encoded. Mirroring that is what makes the
      // recursion-encoding test meaningful.
      const decodeSegment = (segment: string): string => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      };

      for (const key of secrets.keys()) {
        if (prefix) {
          if (key.startsWith(prefix + "/")) {
            const remainder = key.slice(prefix.length + 1);
            const parts = remainder.split("/").map(decodeSegment);
            if (parts.length > 1) {
              const folder = parts[0] + "/";
              if (!keys.includes(folder)) keys.push(folder);
            } else {
              keys.push(parts[0]);
            }
          }
        } else {
          const parts = key.split("/").map(decodeSegment);
          if (parts.length > 1) {
            const folder = parts[0] + "/";
            if (!keys.includes(folder)) keys.push(folder);
          } else {
            keys.push(parts[0]);
          }
        }
      }

      if (keys.length === 0) {
        return Response.json({ errors: ["no secrets found"] }, { status: 404 });
      }

      return Response.json({ data: { keys } });
    }

    // Handle KV v1 operations
    if (kvVersion === "1" && v1Match) {
      const key = v1Match[1];

      if (req.method === "GET") {
        const data = secrets.get(key);
        if (!data) {
          return Response.json({ errors: ["secret not found"] }, {
            status: 404,
          });
        }
        return Response.json({ data });
      }

      if (req.method === "POST") {
        const body = await req.json();
        secrets.set(key, body);
        return Response.json({});
      }

      if (req.method === "LIST") {
        const keys = [...secrets.keys()].filter((k) =>
          k === key || k.startsWith(key + "/")
        );
        if (keys.length === 0) {
          return Response.json({ errors: ["no secrets found"] }, {
            status: 404,
          });
        }
        return Response.json({ data: { keys } });
      }
    }

    return Response.json({ errors: ["not found"] }, { status: 404 });
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://localhost:${addr.port}`,
    server,
    secrets,
    lastHeaders,
  };
}

// ---------------------------------------------------------------------------
// Behavioral tests - KV v2
// ---------------------------------------------------------------------------

Deno.test({
  name: "hashicorp vault: get returns stored secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("my-key", { value: "my-secret-value" });
      const result = await provider.get("my-key");
      assertEquals(result, "my-secret-value");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: get rejects for missing secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await assertRejects(
        () => provider.get("nonexistent"),
        Error,
        "failed",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await provider.put("new-key", "new-value");
      assertEquals(secrets.get("new-key"), { value: "new-value" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores JSON object (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await provider.put("json-key", '{"user":"admin","pass":"secret"}');
      assertEquals(secrets.get("json-key"), { user: "admin", pass: "secret" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: get returns JSON for multi-field secrets (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("multi-key", { user: "admin", pass: "secret" });
      const result = await provider.get("multi-key");
      assertEquals(JSON.parse(result), { user: "admin", pass: "secret" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: list returns stored keys (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("key-a", { value: "a" });
      secrets.set("key-b", { value: "b" });

      const keys = await provider.list();
      assertEquals(keys.includes("key-a"), true);
      assertEquals(keys.includes("key-b"), true);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: list returns empty array for empty KV v2 mount",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      const keys = await provider.list();
      assertEquals(keys, []);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: list handles 200 with missing keys field (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    // Simulates Vault returning 200 with {"data":{}} when ?list=true is used
    // on an empty KV v2 mount (Vault 1.19+ behavior)
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      if (req.method === "LIST") {
        return Response.json({
          request_id: "test",
          data: {},
          warnings: ["Endpoint ignored these unrecognized parameters: [list]"],
        });
      }
      return Response.json({ errors: ["not found"] }, { status: 404 });
    });

    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}`;

    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        mount: "secret",
        kvVersion: "2",
      });

      const keys = await provider.list();
      assertEquals(keys, []);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: custom mount path is used",
  sanitizeResources: false,
  fn: async () => {
    // Create a server that checks the path includes the custom mount
    let requestedPath = "";
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      requestedPath = new URL(req.url).pathname;
      return Response.json({ data: { data: { value: "test" } } });
    });

    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}`;

    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        mount: "custom-kv",
        kvVersion: "2",
      });

      await provider.get("test-key");
      assertEquals(requestedPath.includes("custom-kv"), true);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: namespace header is sent when configured",
  sanitizeResources: false,
  fn: async () => {
    let capturedHeaders: Headers | null = null;
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      capturedHeaders = req.headers;
      return Response.json({ data: { data: { value: "test" } } });
    });

    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}`;

    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        namespace: "admin/team-a",
      });

      await provider.get("test-key");
      assertEquals(capturedHeaders!.get("X-Vault-Namespace"), "admin/team-a");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: getName returns vault name",
  fn: () => {
    const provider = vault.createProvider("my-hashi-vault", {
      address: "https://vault.example.com",
      token: "test",
    });
    assertEquals(provider.getName(), "my-hashi-vault");
  },
});

// ---------------------------------------------------------------------------
// Behavioral tests - KV v1
// ---------------------------------------------------------------------------

Deno.test({
  name: "hashicorp vault: get returns stored secret (KV v1)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("1");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "1",
      });

      secrets.set("my-key", { value: "my-v1-secret" });
      const result = await provider.get("my-key");
      assertEquals(result, "my-v1-secret");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores secret (KV v1)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("1");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "1",
      });

      await provider.put("v1-key", "v1-value");
      assertEquals(secrets.get("v1-key"), { value: "v1-value" });
    } finally {
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Hardening: key validation and path encoding
// ---------------------------------------------------------------------------

Deno.test({
  name: "hashicorp vault: keys containing .. are rejected",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      // Without validation these reach a different mount, or a different
      // Vault API entirely: secret/data/../../sys is not a secret.
      for (const key of ["../../sys/health", "a/../../b", ".."]) {
        await assertRejects(() => provider.get(key), Error, "path segments");
        await assertRejects(
          () => provider.put(key, "x"),
          Error,
          "path segments",
        );
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: absolute and empty keys are rejected",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });
      await assertRejects(() => provider.get("/absolute"), Error, "relative");
      await assertRejects(() => provider.get(""), Error, "empty");
      for (const key of ["a//b", "trailing/"]) {
        await assertRejects(
          () => provider.get(key),
          Error,
          "empty path segment",
        );
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: list encodes directory names when recursing",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      // A `?` in a directory name ends the path and starts a query string when
      // it is interpolated raw, so everything under that directory goes
      // missing from the listing.
      await provider.put("dir?x/inner", "v");
      assertEquals(await provider.list(), ["dir?x/inner"]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: key segments are percent-encoded, separators kept",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      // A space and a question mark would otherwise change the request path
      // or start a query string. The nested path must still nest.
      const key = "team a/db?prod";
      await provider.put(key, "encoded-secret");
      assertEquals(await provider.get(key), "encoded-secret");
      // The mock keys off the raw request path, so this shows the segments
      // were percent-encoded while the separator stayed a separator.
      assertEquals(secrets.has("team%20a/db%3Fprod"), true);
      assertEquals(secrets.has(key), false);
    } finally {
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// OpenTelemetry spans
//
// These tests assert two things that matter equally: the spans carry enough to
// be useful, and they carry nothing that could expose a secret. The absence
// assertions are the point — a span that reports success while leaking a token
// is worse than no span.
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

/** Attribute keys on a span, sorted, for exact-set comparison. */
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

const OTEL_VAULT_CONFIG = { token: "hvs.canary-token-4f21", kvVersion: "2" };

Deno.test({
  name: "otel: get emits a span with the documented attribute set",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        secrets.set("db/password", { value: "s3cret" });
        assertEquals(await provider.get("db/password"), "s3cret");
      });

      const span = spanNamed(spans, "Vault get");
      assertEquals(span.instrumentationScope.name, "@webframp/hashicorp-vault");
      assertEquals(attrKeys(span), [
        "rpc.method",
        "rpc.service",
        "rpc.system",
        "vault.kv_version",
        "vault.name",
        "vault.secret_key",
      ]);
      assertEquals(span.attributes["vault.name"], "prod-secrets");
      assertEquals(span.attributes["vault.secret_key"], "db/password");
      assertEquals(span.attributes["rpc.method"], "get");
      assertEquals(span.attributes["rpc.system"], "vault");
      assertEquals(span.status.code, SpanStatusCode.UNSET);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: put emits a span and never carries the value",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        await provider.put("db/password", "SECRET-CANARY-9b31");
      });

      const span = spanNamed(spans, "Vault put");
      assertEquals(span.attributes["rpc.method"], "put");
      assertEquals(span.attributes["vault.secret_key"], "db/password");
      for (const s of spans) {
        assertEquals(
          spanText(s).includes("SECRET-CANARY-9b31"),
          false,
          `secret value present in span "${s.name}"`,
        );
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: list reports keys returned and emits one child span per request",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        secrets.set("top", { value: "a" });
        secrets.set("nested/inner", { value: "b" });
        assertEquals(await provider.list(), ["nested/inner", "top"]);
      });

      const parent = spanNamed(spans, "Vault list");
      assertEquals(parent.attributes["vault.keys_returned"], 2);
      assertEquals(attrKeys(parent), [
        "rpc.method",
        "rpc.service",
        "rpc.system",
        "vault.keys_returned",
        "vault.kv_version",
        "vault.name",
        "vault.truncated",
      ]);
      assertEquals(parent.attributes["vault.truncated"], false);

      // One request at the root, one for the nested directory.
      const children = spans.filter((s) => s.name === "Vault LIST");
      assertEquals(children.length, 2);
      for (const child of children) {
        assertEquals(
          child.parentSpanContext?.spanId,
          parent.spanContext().spanId,
        );
      }
      assertEquals(
        children.map((c) => c.attributes["vault.list_depth"]).sort(),
        [0, 1],
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: a failed get is marked ERROR with a type and no message",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        await assertRejects(() => provider.get("missing"), Error);
      });

      const span = spanNamed(spans, "Vault get");
      assertEquals(span.status.code, SpanStatusCode.ERROR);
      // No description: the host already publishes the thrown message, and a
      // vault error message is built from output this extension does not
      // control.
      assertEquals(span.status.message, undefined);
      assertEquals(span.attributes["error.type"], "Error");
      // recordException would publish exception.message and a stack trace.
      assertEquals(span.events.length, 0);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: a Vault error echoing the submitted value does not leak it",
  sanitizeResources: false,
  fn: async () => {
    // A server that rejects the write and quotes the value back, which is the
    // shape that turns an error message into a secret disclosure.
    const secret = "SECRET-ECHOED-BY-SERVER-7c4d";
    const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const body = await req.text();
      const echoed = JSON.parse(body).data.value;
      return Response.json(
        { errors: [`rejected value: ${echoed}`] },
        { status: 400 },
      );
    });
    const url = `http://localhost:${(server.addr as Deno.NetAddr).port}`;

    try {
      let thrown: Error | undefined;
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        thrown = await assertRejects(
          () => provider.put("db/password", secret),
          Error,
        );
      });

      // The message the host will publish must not contain the secret.
      assertEquals(thrown?.message.includes(secret), false);
      assertEquals(thrown?.message.includes("[redacted]"), true);
      for (const s of spans) {
        assertEquals(
          spanText(s).includes(secret),
          false,
          `secret present in span "${s.name}"`,
        );
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: no span field carries the Vault token",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        secrets.set("k", { value: "v" });
        await provider.get("k");
        await provider.put("k2", "another");
        await provider.list();
        await assertRejects(() => provider.get("nope"), Error);
      });

      assertEquals(spans.length > 0, true);
      for (const s of spans) {
        const text = spanText(s);
        assertEquals(
          text.includes("hvs.canary-token-4f21"),
          false,
          `token present in span "${s.name}"`,
        );
        assertEquals(
          text.includes("X-Vault-Token"),
          false,
          `header name present in span "${s.name}"`,
        );
        // The address is fine to record, the full URL is not — it would carry
        // the key path in a second, unaudited place.
        assertEquals(text.includes("/v1/secret/"), false);
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: a JSON secret's field values are redacted, not just the wrapper",
  sanitizeResources: false,
  fn: async () => {
    // A JSON value is stored field by field, so a server that quotes a rejected
    // field back never mentions the string the caller passed.
    const fieldSecret = "FIELD-LEVEL-CANARY-5e88";
    const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const body = await req.json();
      return Response.json(
        { errors: [`rejected password: ${body.data.password}`] },
        { status: 400 },
      );
    });
    const url = `http://localhost:${(server.addr as Deno.NetAddr).port}`;

    try {
      let thrown: Error | undefined;
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        thrown = await assertRejects(
          () =>
            provider.put(
              "db/creds",
              JSON.stringify({ user: "svc", password: fieldSecret }),
            ),
          Error,
        );
      });

      assertEquals(thrown?.message.includes(fieldSecret), false);
      assertEquals(thrown?.message.includes("[redacted]"), true);
      for (const s of spans) {
        assertEquals(
          spanText(s).includes(fieldSecret),
          false,
          `secret present in span "${s.name}"`,
        );
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "otel: a listing cut short by the depth cap is marked truncated",
  sanitizeResources: false,
  fn: async () => {
    // A server that always reports one more directory, so the walk can only end
    // by hitting MAX_DEPTH.
    let requests = 0;
    const server = Deno.serve({ port: 0, onListen() {} }, () => {
      requests++;
      return Response.json({ data: { keys: ["deeper/"] } });
    });
    const url = `http://localhost:${(server.addr as Deno.NetAddr).port}`;

    try {
      const spans = await withSpans(async () => {
        const provider = vault.createProvider("prod-secrets", {
          address: url,
          ...OTEL_VAULT_CONFIG,
        });
        assertEquals(await provider.list(), []);
      });

      const parent = spanNamed(spans, "Vault list");
      // Without the flag this span would report zero keys and look like an
      // empty mount rather than a walk that gave up.
      assertEquals(parent.attributes["vault.truncated"], true);
      assertEquals(parent.attributes["vault.keys_returned"], 0);
      // Ten levels of recursion, ten requests — the cap held.
      assertEquals(requests, 10);
    } finally {
      await server.shutdown();
    }
  },
});
