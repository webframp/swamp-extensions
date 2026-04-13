# Network & System Model Foundations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the network and system models with error-as-data handling and full test coverage, preparing a solid foundation for the SRE health check workflow + report.

**Architecture:** Add `error` fields to `HttpCheckSchema` and `CertInfoSchema` so probe failures produce structured data instead of throwing. Mock `Deno.Command`, `fetch`, and `Deno.connect` in tests to cover all methods without hitting real services. Both extensions need `deno.json` created for task runner support.

**Tech Stack:** Deno, Zod 4, `@systeminit/swamp-testing` (`createModelTestContext`), `jsr:@std/assert@1`

---

## Task 1: Create deno.json for network extension

**Files:**
- Create: `network/deno.json`

**Step 1: Create the file**

```json
{
  "tasks": {
    "check": "deno check extensions/models/network/probe.ts extensions/models/network/probe_test.ts",
    "lint": "deno lint extensions/models/",
    "fmt": "deno fmt extensions/models/",
    "fmt:check": "deno fmt --check extensions/models/",
    "test": "deno test --allow-env --allow-net=0.0.0.0 --allow-read extensions/models/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

Note: `--allow-net=0.0.0.0` is needed for the local mock HTTP server in http_check tests. No `--allow-run` needed since we mock `Deno.Command`.

**Step 2: Verify**

Run: `cd network && deno task check`
Expected: Should pass (test file doesn't exist yet, but probe.ts should type-check)

---

## Task 2: Add error-as-data to HttpCheckSchema

**Files:**
- Modify: `network/extensions/models/network/probe.ts`

**Step 1: Write the failing test**

Create the test file with the http_check error test first (along with structure tests that already pass). The key test: when fetch throws (e.g., DNS resolution failure), `http_check` should return a resource with `error` set, not throw an exception.

Add to `network/extensions/models/network/probe_test.ts`:

```typescript
Deno.test("http_check: returns error-as-data when fetch fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new TypeError("DNS resolution failed");
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
    });

    const result = await model.methods.http_check.execute(
      { url: "https://unreachable.invalid", method: "HEAD" },
      context as any,
    );

    assertEquals(result.dataHandles.length, 1);
    const resources = getWrittenResources();
    const data = resources[0].data as Record<string, unknown>;
    assertEquals(data.error !== null, true);
    assertEquals(data.statusCode, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

**Step 2: Run test to verify it fails**

Run: `cd network && deno task test`
Expected: FAIL — current code throws TypeError instead of catching it.

**Step 3: Add error field to HttpCheckSchema and wrap execute in try-catch**

In `probe.ts`, modify `HttpCheckSchema` (line 43-56):

```typescript
const HttpCheckSchema = z.object({
  url: z.string(),
  method: z.string(),
  statusCode: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  redirectChain: z.array(z.object({
    url: z.string(),
    statusCode: z.number(),
  })),
  timingMs: z.number(),
  tlsProtocol: z.string().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});
```

Then wrap the `http_check.execute` body (lines 465-547) in try-catch:

```typescript
execute: async (
  args: { url: string; method: string },
  context: ModelContext,
) => {
  const startTime = performance.now();

  try {
    // ... existing redirect-following logic unchanged ...

    const data = {
      // ... existing fields ...
      error: null,
      fetchedAt: new Date().toISOString(),
    };

    // ... existing writeResource + logging ...
  } catch (err: unknown) {
    const timingMs = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : String(err);

    const data = {
      url: args.url,
      method: args.method,
      statusCode: 0,
      statusText: "",
      headers: {},
      redirectChain: [],
      timingMs,
      tlsProtocol: null,
      error: errorMessage,
      fetchedAt: new Date().toISOString(),
    };

    let instance: string;
    try {
      instance = new URL(args.url).hostname;
    } catch {
      instance = args.url;
    }

    const handle = await context.writeResource("http_checks", instance, data);

    context.logger.info("HTTP {method} {url}: ERROR {error}", {
      method: args.method,
      url: args.url,
      error: errorMessage,
    });

    return { dataHandles: [handle] };
  }
},
```

Also move `startTime` before the try block and convert the "Too many redirects" throw (line 504) into an error-as-data return using the same pattern.

**Step 4: Run test to verify it passes**

Run: `cd network && deno task test`
Expected: PASS

**Step 5: Commit**

```bash
git add network/deno.json network/extensions/models/network/probe.ts network/extensions/models/network/probe_test.ts
git commit -m "feat(network): add error-as-data handling to http_check"
```

---

## Task 3: Add error-as-data to CertInfoSchema

**Files:**
- Modify: `network/extensions/models/network/probe.ts`
- Modify: `network/extensions/models/network/probe_test.ts`

**Step 1: Write the failing test**

```typescript
Deno.test("cert_check: returns error-as-data when command fails", async () => {
  const OriginalCommand = Deno.Command;
  (Deno as any).Command = class {
    constructor() {}
    spawn() {
      return {
        output: () => Promise.resolve({
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("connect: Connection refused"),
        }),
        kill: () => {},
      };
    }
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
    });

    const result = await model.methods.cert_check.execute(
      { host: "unreachable.invalid", port: 443 },
      context as any,
    );

    assertEquals(result.dataHandles.length, 1);
    const resources = getWrittenResources();
    const data = resources[0].data as Record<string, unknown>;
    assertEquals(data.error !== null, true);
    assertEquals(data.subject, null);
  } finally {
    (Deno as any).Command = OriginalCommand;
  }
});
```

**Step 2: Run test to verify it fails**

Run: `cd network && deno task test`
Expected: FAIL — current code doesn't check `result.success` and tries to parse empty stdout.

**Step 3: Add error field to CertInfoSchema and handle failures**

In `probe.ts`, modify `CertInfoSchema` (line 70-80):

```typescript
const CertInfoSchema = z.object({
  host: z.string(),
  port: z.number(),
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  notBefore: z.string().nullable(),
  notAfter: z.string().nullable(),
  daysUntilExpiry: z.number().nullable(),
  serialNumber: z.string().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});
```

Then wrap `cert_check.execute` (lines 597-632):

```typescript
execute: async (
  args: { host: string; port: number },
  context: ModelContext,
) => {
  const result = await runCommand([
    "bash",
    "-c",
    `echo | openssl s_client -connect ${args.host}:${args.port} -servername ${args.host} 2>/dev/null | openssl x509 -noout -dates -subject -issuer -serial`,
  ]);

  if (!result.success) {
    const errorMessage = result.stderr.trim() || `openssl exited with error for ${args.host}:${args.port}`;

    const data = {
      host: args.host,
      port: args.port,
      subject: null,
      issuer: null,
      notBefore: null,
      notAfter: null,
      daysUntilExpiry: null,
      serialNumber: null,
      error: errorMessage,
      fetchedAt: new Date().toISOString(),
    };

    const instance = `${args.host}-${args.port}`;
    const handle = await context.writeResource("cert_info", instance, data);

    context.logger.info("Cert {host}:{port}: ERROR {error}", {
      host: args.host,
      port: args.port,
      error: errorMessage,
    });

    return { dataHandles: [handle] };
  }

  const parsed = parseCertOutput(result.stdout);
  const daysUntilExpiry = computeDaysUntilExpiry(parsed.notAfter);

  const data = {
    host: args.host,
    port: args.port,
    subject: parsed.subject,
    issuer: parsed.issuer,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    daysUntilExpiry,
    serialNumber: parsed.serialNumber,
    error: null,
    fetchedAt: new Date().toISOString(),
  };

  // ... rest unchanged ...
},
```

**Step 4: Run test to verify it passes**

Run: `cd network && deno task test`
Expected: PASS

**Step 5: Commit**

```bash
git add network/extensions/models/network/probe.ts network/extensions/models/network/probe_test.ts
git commit -m "feat(network): add error-as-data handling to cert_check"
```

---

## Task 4: Network model — export structure and parser unit tests

**Files:**
- Modify: `network/extensions/models/network/probe_test.ts`

These tests validate the model export shape and the pure parser functions. They all pass against existing code — no implementation changes needed.

**Step 1: Write structure tests**

```typescript
// --- Model export structure ---
Deno.test("network model: has correct type", () => {
  assertEquals(model.type, "@webframp/network");
});

Deno.test("network model: has valid version format", () => {
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
});

Deno.test("network model: has all 6 resource specs", () => {
  const names = Object.keys(model.resources);
  assertEquals(names.sort(), [
    "cert_info", "dns_records", "http_checks", "port_scan", "traceroute", "whois_info",
  ]);
});

Deno.test("network model: has all 6 methods", () => {
  const names = Object.keys(model.methods);
  assertEquals(names.sort(), [
    "cert_check", "dns_lookup", "http_check", "port_check", "traceroute", "whois_lookup",
  ]);
});

Deno.test("network model: each method has arguments and execute", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assertExists((method as any).arguments, `${name} missing arguments`);
    assertExists((method as any).execute, `${name} missing execute`);
  }
});
```

**Step 2: Write parser unit tests**

The parsers (`parseDigJson`, `parseWhoisText`, `parseTracerouteOutput`, `parseCertOutput`, `computeDaysUntilExpiry`) are not exported. To test them, we need to either:
- (a) Export them (preferred — they're pure functions)
- (b) Test them indirectly through method execution

**Choose (a):** Add a named export at the bottom of `probe.ts`:

```typescript
// Exported for testing
export const _internals = {
  parseDigJson,
  parseWhoisText,
  parseTracerouteOutput,
  parseCertOutput,
  computeDaysUntilExpiry,
};
```

Then write tests:

```typescript
import { _internals } from "./probe.ts";
const { parseDigJson, parseWhoisText, parseTracerouteOutput, parseCertOutput, computeDaysUntilExpiry } = _internals;

Deno.test("parseDigJson: parses valid dig +json output", () => {
  const input = JSON.stringify([{
    message: {
      response_message_data: {
        ANSWER: [
          { name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" },
        ],
        status: "NOERROR",
      },
      response_address: "8.8.8.8",
      query_time: 12,
    },
  }]);
  const result = parseDigJson(input);
  assertEquals(result.status, "NOERROR");
  assertEquals(result.records.length, 1);
  assertEquals(result.records[0].data, "93.184.216.34");
  assertEquals(result.server, "8.8.8.8");
  assertEquals(result.queryTime, "12ms");
});

Deno.test("parseDigJson: returns PARSE_ERROR for invalid JSON", () => {
  const result = parseDigJson("not json");
  assertEquals(result.status, "PARSE_ERROR");
  assertEquals(result.records.length, 0);
});

Deno.test("parseWhoisText: extracts registrar and dates", () => {
  const text = [
    "Registrar: Example Registrar, Inc.",
    "Creation Date: 2020-01-15T00:00:00Z",
    "Registry Expiry Date: 2025-01-15T00:00:00Z",
    "Updated Date: 2024-06-01T00:00:00Z",
    "Name Server: ns1.example.com",
    "Name Server: ns2.example.com",
    "Domain Status: clientTransferProhibited",
  ].join("\n");

  const result = parseWhoisText(text);
  assertEquals(result.registrar, "Example Registrar, Inc.");
  assertEquals(result.nameservers.length, 2);
  assertEquals(result.status.length, 1);
  assertExists(result.creationDate);
  assertExists(result.expiryDate);
});

Deno.test("parseWhoisText: handles empty input", () => {
  const result = parseWhoisText("");
  assertEquals(result.registrar, null);
  assertEquals(result.nameservers.length, 0);
});

Deno.test("parseTracerouteOutput: parses hop lines", () => {
  const output = [
    "traceroute to example.com (93.184.216.34), 15 hops max",
    " 1  gateway (192.168.1.1)  1.234 ms  1.456 ms  1.789 ms",
    " 2  * * *",
    " 3  target (93.184.216.34)  10.123 ms  10.456 ms  10.789 ms",
  ].join("\n");

  const result = parseTracerouteOutput(output);
  assertEquals(result.hops.length, 3);
  assertEquals(result.hops[0].hop, 1);
  assertEquals(result.hops[0].ip, "192.168.1.1");
  assertEquals(result.hops[1].host, null); // timeout hop
  assertEquals(result.reachedTarget, true);
});

Deno.test("parseTracerouteOutput: handles empty output", () => {
  const result = parseTracerouteOutput("");
  assertEquals(result.hops.length, 0);
  assertEquals(result.reachedTarget, false);
});

Deno.test("parseCertOutput: extracts certificate fields", () => {
  const output = [
    "subject=CN = example.com",
    "issuer=C = US, O = Let's Encrypt, CN = R3",
    "notBefore=Jan  1 00:00:00 2024 GMT",
    "notAfter=Apr  1 00:00:00 2025 GMT",
    "serial=0123456789ABCDEF",
  ].join("\n");

  const result = parseCertOutput(output);
  assertEquals(result.subject, "CN = example.com");
  assertEquals(result.issuer, "C = US, O = Let's Encrypt, CN = R3");
  assertExists(result.notBefore);
  assertExists(result.notAfter);
  assertEquals(result.serialNumber, "0123456789ABCDEF");
});

Deno.test("parseCertOutput: handles empty output", () => {
  const result = parseCertOutput("");
  assertEquals(result.subject, null);
  assertEquals(result.issuer, null);
});

Deno.test("computeDaysUntilExpiry: returns positive for future date", () => {
  const future = new Date();
  future.setDate(future.getDate() + 30);
  const result = computeDaysUntilExpiry(future.toISOString());
  assertEquals(result !== null, true);
  assertEquals(result! >= 29 && result! <= 30, true);
});

Deno.test("computeDaysUntilExpiry: returns negative for past date", () => {
  const past = new Date();
  past.setDate(past.getDate() - 10);
  const result = computeDaysUntilExpiry(past.toISOString());
  assertEquals(result !== null, true);
  assertEquals(result! < 0, true);
});

Deno.test("computeDaysUntilExpiry: returns null for invalid date", () => {
  assertEquals(computeDaysUntilExpiry("not-a-date"), null);
  assertEquals(computeDaysUntilExpiry(null), null);
});
```

**Step 3: Run all tests**

Run: `cd network && deno task test`
Expected: PASS (all parser tests exercise existing working code)

**Step 4: Commit**

```bash
git add network/extensions/models/network/probe.ts network/extensions/models/network/probe_test.ts
git commit -m "test(network): add export structure and parser unit tests"
```

---

## Task 5: Network model — mocked method execution tests

**Files:**
- Modify: `network/extensions/models/network/probe_test.ts`

These tests mock `Deno.Command` (for CLI methods), `globalThis.fetch` (for http_check), and `Deno.connect` (for port_check) to test method execution end-to-end.

**Step 1: Create mock helpers**

```typescript
// --- Mock helpers ---

const OriginalCommand = Deno.Command;

type MockCommandResponse = {
  success: boolean;
  stdout: string;
  stderr: string;
};

function createCommandMock(handler: (cmd: string, args: string[]) => MockCommandResponse) {
  const encoder = new TextEncoder();
  return class MockCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    spawn() {
      const response = handler(this.#cmd, this.#args);
      return {
        output: () => Promise.resolve({
          success: response.success,
          stdout: encoder.encode(response.stdout),
          stderr: encoder.encode(response.stderr),
        }),
        kill: () => {},
      };
    }
  };
}

function withMockedCommand(
  handler: (cmd: string, args: string[]) => MockCommandResponse,
  fn: () => Promise<void>,
): Promise<void> {
  (Deno as any).Command = createCommandMock(handler);
  return fn().finally(() => {
    (Deno as any).Command = OriginalCommand;
  });
}
```

**Step 2: Write dns_lookup execution test**

```typescript
Deno.test("dns_lookup: writes resource with parsed dig output", async () => {
  const digJson = JSON.stringify([{
    message: {
      response_message_data: {
        ANSWER: [{ name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" }],
        status: "NOERROR",
      },
      response_address: "8.8.8.8",
      query_time: 12,
    },
  }]);

  await withMockedCommand(
    () => ({ success: true, stdout: digJson, stderr: "" }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.dns_lookup.execute(
        { domain: "example.com", recordType: "A" },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "dns_records");
      const data = resources[0].data as Record<string, unknown>;
      assertEquals(data.domain, "example.com");
      assertEquals(data.status, "NOERROR");
    },
  );
});

Deno.test("dns_lookup: returns COMMAND_FAILED when dig fails", async () => {
  await withMockedCommand(
    () => ({ success: false, stdout: "", stderr: "dig: command not found" }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.dns_lookup.execute(
        { domain: "example.com", recordType: "A" },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as Record<string, unknown>;
      assertEquals(data.status, "COMMAND_FAILED");
    },
  );
});
```

**Step 3: Write whois_lookup execution test**

```typescript
Deno.test("whois_lookup: writes resource with parsed whois output", async () => {
  const whoisOutput = [
    "Registrar: Test Registrar",
    "Creation Date: 2020-01-01T00:00:00Z",
    "Name Server: ns1.example.com",
  ].join("\n");

  await withMockedCommand(
    () => ({ success: true, stdout: whoisOutput, stderr: "" }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.whois_lookup.execute(
        { domain: "example.com" },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as Record<string, unknown>;
      assertEquals(data.domain, "example.com");
      assertEquals(data.registrar, "Test Registrar");
    },
  );
});
```

**Step 4: Write cert_check success execution test**

```typescript
Deno.test("cert_check: writes resource with parsed cert output", async () => {
  const certOutput = [
    "subject=CN = example.com",
    "issuer=C = US, O = Let's Encrypt, CN = R3",
    "notBefore=Jan  1 00:00:00 2024 GMT",
    "notAfter=Dec 31 23:59:59 2099 GMT",
    "serial=ABCDEF0123456789",
  ].join("\n");

  await withMockedCommand(
    () => ({ success: true, stdout: certOutput, stderr: "" }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.cert_check.execute(
        { host: "example.com", port: 443 },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as Record<string, unknown>;
      assertEquals(data.host, "example.com");
      assertEquals(data.error, null);
      assertEquals(data.subject, "CN = example.com");
      assertEquals((data.daysUntilExpiry as number) > 0, true);
    },
  );
});
```

**Step 5: Write traceroute execution test**

```typescript
Deno.test("traceroute: writes resource with parsed hops", async () => {
  const traceOutput = [
    "traceroute to example.com (93.184.216.34), 15 hops max",
    " 1  gw (192.168.1.1)  1.0 ms  1.1 ms  1.2 ms",
    " 2  target (93.184.216.34)  10.0 ms  10.1 ms  10.2 ms",
  ].join("\n");

  await withMockedCommand(
    () => ({ success: true, stdout: traceOutput, stderr: "" }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.traceroute.execute(
        { host: "example.com", maxHops: 15 },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as Record<string, unknown>;
      assertEquals(data.host, "example.com");
      assertEquals(data.reachedTarget, true);
    },
  );
});
```

**Step 6: Write http_check success test (with mock server)**

```typescript
Deno.test({
  name: "http_check: writes resource with status and timing",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, () =>
      new Response("ok", { status: 200, headers: { "x-test": "yes" } })
    );
    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}/health`;

    try {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

      const result = await model.methods.http_check.execute(
        { url, method: "GET" },
        context as any,
      );

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as Record<string, unknown>;
      assertEquals(data.statusCode, 200);
      assertEquals(data.error, null);
      assertEquals((data.timingMs as number) >= 0, true);
    } finally {
      await server.shutdown();
    }
  },
});
```

**Step 7: Write port_check test (mock Deno.connect)**

```typescript
Deno.test("port_check: reports open and closed ports", async () => {
  const originalConnect = Deno.connect;
  (Deno as any).connect = (opts: { hostname: string; port: number }) => {
    if (opts.port === 80) {
      return Promise.resolve({ close: () => {} });
    }
    return Promise.reject(new Error("Connection refused"));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });

    const result = await model.methods.port_check.execute(
      { host: "example.com", ports: [80, 9999] },
      context as any,
    );

    assertEquals(result.dataHandles.length, 1);
    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.openPorts, [80]);
    assertEquals(data.closedPorts, [9999]);
  } finally {
    (Deno as any).connect = originalConnect;
  }
});
```

**Step 8: Run all tests and verify**

Run: `cd network && deno task test`
Expected: ALL PASS

Run: `cd network && deno task check`
Expected: No type errors

Run: `cd network && deno task lint`
Expected: No lint errors

**Step 9: Commit**

```bash
git add network/extensions/models/network/probe_test.ts
git commit -m "test(network): add mocked method execution tests for all 6 methods"
```

---

## Task 6: Create deno.json for system extension

**Files:**
- Create: `system/deno.json`

**Step 1: Create the file**

```json
{
  "tasks": {
    "check": "deno check extensions/models/system/diagnostics.ts extensions/models/system/diagnostics_test.ts",
    "lint": "deno lint extensions/models/",
    "fmt": "deno fmt extensions/models/",
    "fmt:check": "deno fmt --check extensions/models/",
    "test": "deno test --allow-env --allow-read extensions/models/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

No `--allow-run` or `--allow-net` needed since we mock all commands.

---

## Task 7: System model — full test coverage

**Files:**
- Create: `system/extensions/models/system/diagnostics_test.ts`

The system model's `runCommand` throws on failure. This is actually OK for the SRE workflow because the system model runs against the local host — if `df` or `free` is missing, that's a real error, not a probe result. The report can handle null data handles from `allowFailure: true` steps. So we test the existing behavior without changing it.

**Step 1: Write all tests**

```typescript
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./diagnostics.ts";

// --- Model export structure ---

Deno.test("system model: has correct type", () => {
  assertEquals(model.type, "@webframp/system");
});

Deno.test("system model: has valid version format", () => {
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
});

Deno.test("system model: has all 6 resource specs", () => {
  const names = Object.keys(model.resources);
  assertEquals(names.sort(), [
    "disk_usage", "memory", "network_interfaces", "os_info", "processes", "uptime",
  ]);
});

Deno.test("system model: has all 6 methods", () => {
  const names = Object.keys(model.methods);
  assertEquals(names.sort(), [
    "get_disk_usage", "get_memory", "get_network_interfaces", "get_os_info", "get_processes", "get_uptime",
  ]);
});

Deno.test("system model: each method has arguments and execute", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assertExists((method as any).arguments, `${name} missing arguments`);
    assertExists((method as any).execute, `${name} missing execute`);
  }
});

// --- Mock helpers ---

const OriginalCommand = Deno.Command;

function withMockedCommand(
  handler: (cmd: string, args: string[]) => { stdout: string; success: boolean },
  fn: () => Promise<void>,
): Promise<void> {
  const encoder = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[]; stdout?: string; stderr?: string }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    output() {
      const response = handler(this.#cmd, this.#args);
      return Promise.resolve({
        success: response.success,
        stdout: encoder.encode(response.stdout),
        stderr: new Uint8Array(),
      });
    }
  };
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

// --- Method execution tests ---

Deno.test("get_disk_usage: writes resource with parsed df output", async () => {
  const dfOutput = [
    "Filesystem     Type  Size  Used Avail Use% Mounted on",
    "/dev/sda1      ext4  100G   60G   40G  60% /",
    "tmpfs          tmpfs 8.0G  100M  7.9G   2% /tmp",
  ].join("\n");

  await withMockedCommand(
    () => ({ stdout: dfOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_disk_usage.execute({} as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.count, 2);
      assertEquals(data.filesystems[0].source, "/dev/sda1");
      assertEquals(data.filesystems[0].usePercent, "60%");
      assertEquals(data.filesystems[1].target, "/tmp");
    },
  );
});

Deno.test("get_memory: writes resource with parsed free output", async () => {
  const freeOutput = [
    "               total        used        free      shared  buff/cache   available",
    "Mem:           15Gi       8.0Gi       2.0Gi       500Mi       5.0Gi       6.5Gi",
    "Swap:          4.0Gi       1.0Gi       3.0Gi",
  ].join("\n");

  await withMockedCommand(
    () => ({ stdout: freeOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_memory.execute({} as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.mem.total, "15Gi");
      assertEquals(data.mem.used, "8.0Gi");
      assertEquals(data.swap.total, "4.0Gi");
    },
  );
});

Deno.test("get_uptime: writes resource with parsed uptime output", async () => {
  // runCommand is called twice: once for "uptime -s", once for "uptime"
  let callCount = 0;
  await withMockedCommand(
    (cmd, args) => {
      callCount++;
      if (args.includes("-s")) {
        return { stdout: "2026-04-01 08:00:00", success: true };
      }
      return {
        stdout: " 14:30:00 up 12 days,  6:30,  2 users,  load average: 0.50, 0.75, 0.60",
        success: true,
      };
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_uptime.execute({} as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.bootTime, "2026-04-01 08:00:00");
      assertEquals(data.loadAverage1m, "0.50");
      assertEquals(data.loadAverage5m, "0.75");
      assertEquals(data.loadAverage15m, "0.60");
    },
  );
});

Deno.test("get_processes: writes resource with top N processes", async () => {
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1 25.0  1.5 123456 15000 ?        Ss   08:00   1:00 /usr/bin/node server.js",
    "user      1234  5.0  2.0 234567 20000 ?        Sl   09:00   0:30 /usr/bin/python app.py",
  ].join("\n");

  await withMockedCommand(
    () => ({ stdout: psOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_processes.execute({ count: 10 } as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.count, 2);
      assertEquals(data.processes[0].cpu, 25.0);
      assertEquals(data.processes[0].command, "server.js");
      assertEquals(data.processes[1].pid, 1234);
    },
  );
});

Deno.test("get_network_interfaces: writes resource with parsed ip output", async () => {
  const ipJson = JSON.stringify([
    { ifname: "lo", addr_info: [{ local: "127.0.0.1" }] },
    { ifname: "eth0", addr_info: [{ local: "192.168.1.100" }] },
  ]);

  await withMockedCommand(
    () => ({ stdout: ipJson, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_network_interfaces.execute({} as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.count, 2);
      assertEquals(data.interfaces[0].ifname, "lo");
      assertEquals(data.interfaces[1].ifname, "eth0");
    },
  );
});

Deno.test("get_os_info: writes resource with uname and os-release", async () => {
  // Note: get_os_info reads /etc/os-release directly (not via runCommand),
  // so we only need to mock the uname command.
  await withMockedCommand(
    () => ({
      stdout: "Linux hostname 6.6.87 #1 SMP x86_64 GNU/Linux",
      success: true,
    }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
      const result = await model.methods.get_os_info.execute({} as any, context as any);

      assertEquals(result.dataHandles.length, 1);
      const data = getWrittenResources()[0].data as any;
      assertEquals(data.uname, "Linux hostname 6.6.87 #1 SMP x86_64 GNU/Linux");
      assertExists(data.osRelease);
    },
  );
});
```

**Important notes for the implementer:**
- The system model's `runCommand` calls `command.output()` directly (not `command.spawn().output()`), so the mock class needs an `output()` method on the class itself, not on a spawned process. This differs from the network model mock.
- `get_os_info` reads `/etc/os-release` via `Deno.readTextFile`, which will work in the test environment (Linux). The test only mocks the `uname` command.
- `get_uptime` calls `runCommand` twice (for `uptime -s` and `uptime`), so the mock handler must differentiate by args.
- `get_processes` parsing takes `parts.slice(10).join(" ")` for the command — test data must have enough whitespace-separated columns.

**Step 2: Run all tests**

Run: `cd system && deno task test`
Expected: ALL PASS

Run: `cd system && deno task check && deno task lint`
Expected: Clean

**Step 3: Commit**

```bash
git add system/deno.json system/extensions/models/system/diagnostics_test.ts
git commit -m "test(system): add full test coverage for diagnostics model"
```

---

## Task 8: Final verification and CI integration

**Files:**
- Modify: `.github/workflows/ci.yml` (if network and system aren't in the test matrix)

**Step 1: Verify both extensions pass all checks**

```bash
cd network && deno task check && deno task lint && deno task fmt:check && deno task test
cd ../system && deno task check && deno task lint && deno task fmt:check && deno task test
```

Expected: All green for both.

**Step 2: Check CI matrix includes these extensions**

Read `.github/workflows/ci.yml` and verify both `network` and `system` are in the test matrix. If not, add them.

**Step 3: Commit and push**

```bash
git add -A
git commit -m "ci: add network and system extensions to test matrix"
git push
```

---

## Summary of Changes

| Extension | Change | Files |
|-----------|--------|-------|
| network | Add `error` field to `HttpCheckSchema` | `probe.ts` |
| network | Wrap `http_check` in try-catch for error-as-data | `probe.ts` |
| network | Add `error` field to `CertInfoSchema` | `probe.ts` |
| Handle `cert_check` command failure as data | `probe.ts` |
| network | Export `_internals` for parser testing | `probe.ts` |
| network | Create `deno.json` | `deno.json` |
| network | Full test suite (structure + parsers + methods) | `probe_test.ts` |
| system | Create `deno.json` | `deno.json` |
| system | Full test suite (structure + methods) | `diagnostics_test.ts` |

**Total: ~3 files modified, ~3 files created**

After this work, both models are hardened and tested, ready for the SRE health check workflow + report to be built on top.
