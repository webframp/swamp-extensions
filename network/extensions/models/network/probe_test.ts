// Network Probe Model Tests — http_check error-as-data
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { _internals, model } from "./probe.ts";

// ---------------------------------------------------------------------------
// http_check: fetch failure returns error-as-data
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "http_check: DNS resolution failure returns error field instead of throwing",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new TypeError("DNS resolution failed: no-such-host.invalid");
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "test-probe", version: 1, tags: {} },
      });

      const result = await model.methods.http_check.execute(
        { url: "https://no-such-host.invalid", method: "HEAD" },
        context as unknown as Parameters<
          typeof model.methods.http_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        url: string;
        statusCode: number;
        statusText: string;
        headers: Record<string, string>;
        redirectChain: unknown[];
        error: string | null;
      };

      assertEquals(data.statusCode, 0);
      assertEquals(data.statusText, "");
      assertEquals(data.headers, {});
      assertEquals(data.redirectChain, []);
      assertEquals(typeof data.error, "string");
      assertEquals(
        data.error!.includes("DNS resolution failed"),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// ---------------------------------------------------------------------------
// http_check: too many redirects returns error-as-data
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "http_check: too many redirects returns error field instead of throwing",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      callCount++;
      // Always return a redirect, never a final response
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: `https://example.com/redirect-${callCount}` },
        }),
      );
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "test-probe", version: 1, tags: {} },
      });

      const result = await model.methods.http_check.execute(
        { url: "https://example.com/loop", method: "GET" },
        context as unknown as Parameters<
          typeof model.methods.http_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        url: string;
        statusCode: number;
        statusText: string;
        headers: Record<string, string>;
        redirectChain: unknown[];
        error: string | null;
      };

      assertEquals(data.statusCode, 0);
      assertEquals(data.statusText, "");
      assertEquals(data.headers, {});
      assertEquals(typeof data.error, "string");
      assertEquals(
        data.error!.includes("Too many redirects"),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// ---------------------------------------------------------------------------
// http_check: success path has error set to null
// ---------------------------------------------------------------------------

Deno.test({
  name: "http_check: successful fetch sets error to null",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return Promise.resolve(
        new Response("OK", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        }),
      );
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "test-probe", version: 1, tags: {} },
      });

      const result = await model.methods.http_check.execute(
        { url: "https://example.com", method: "HEAD" },
        context as unknown as Parameters<
          typeof model.methods.http_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as { error: string | null };

      assertEquals(data.error, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// ---------------------------------------------------------------------------
// cert_check: openssl failure returns error-as-data
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "cert_check: openssl failure returns error field instead of undefined behavior",
  sanitizeResources: false,
  fn: async () => {
    const OriginalCommand = Deno.Command;
    const encoder = new TextEncoder();

    // @ts-ignore: mock Deno.Command for testing
    Deno.Command = class MockCommand {
      constructor(_cmd: string, _opts?: Deno.CommandOptions) {}
      spawn() {
        return {
          output: () =>
            Promise.resolve({
              success: false,
              stdout: encoder.encode(""),
              stderr: encoder.encode("unable to load certificate"),
            }),
          kill: () => {},
        };
      }
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: {
          id: "test-id",
          name: "test-probe",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.cert_check.execute(
        { host: "expired.badssl.com", port: 443 },
        context as unknown as Parameters<
          typeof model.methods.cert_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        host: string;
        port: number;
        subject: string | null;
        issuer: string | null;
        notBefore: string | null;
        notAfter: string | null;
        daysUntilExpiry: number | null;
        serialNumber: string | null;
        error: string | null;
      };

      assertEquals(data.host, "expired.badssl.com");
      assertEquals(data.port, 443);
      assertEquals(data.subject, null);
      assertEquals(data.issuer, null);
      assertEquals(data.notBefore, null);
      assertEquals(data.notAfter, null);
      assertEquals(data.daysUntilExpiry, null);
      assertEquals(data.serialNumber, null);
      assertEquals(typeof data.error, "string");
      assertEquals(data.error!.includes("unable to load certificate"), true);
    } finally {
      // @ts-ignore: restore original Deno.Command
      Deno.Command = OriginalCommand;
    }
  },
});

// ---------------------------------------------------------------------------
// cert_check: success path has error set to null
// ---------------------------------------------------------------------------

Deno.test({
  name: "cert_check: successful openssl sets error to null",
  sanitizeResources: false,
  fn: async () => {
    const OriginalCommand = Deno.Command;
    const encoder = new TextEncoder();

    const certOutput = [
      "notBefore=Jan  1 00:00:00 2025 GMT",
      "notAfter=Dec 31 23:59:59 2026 GMT",
      "subject=CN = example.com",
      "issuer=C = US, O = Let's Encrypt, CN = R3",
      "serial=0123456789ABCDEF",
    ].join("\n");

    // @ts-ignore: mock Deno.Command for testing
    Deno.Command = class MockCommand {
      constructor(_cmd: string, _opts?: Deno.CommandOptions) {}
      spawn() {
        return {
          output: () =>
            Promise.resolve({
              success: true,
              stdout: encoder.encode(certOutput),
              stderr: encoder.encode(""),
            }),
          kill: () => {},
        };
      }
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: {
          id: "test-id",
          name: "test-probe",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.cert_check.execute(
        { host: "example.com", port: 443 },
        context as unknown as Parameters<
          typeof model.methods.cert_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        host: string;
        port: number;
        subject: string | null;
        issuer: string | null;
        error: string | null;
      };

      assertEquals(data.host, "example.com");
      assertEquals(data.error, null);
      assertEquals(typeof data.subject, "string");
      assertEquals(typeof data.issuer, "string");
    } finally {
      // @ts-ignore: restore original Deno.Command
      Deno.Command = OriginalCommand;
    }
  },
});

// ===========================================================================
// Model export structure tests
// ===========================================================================

Deno.test("network model: has correct type", () => {
  assertEquals(model.type, "@webframp/network");
});

Deno.test("network model: has valid version format", () => {
  const calverRegex = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(calverRegex.test(model.version), true);
});

Deno.test("network model: has all 6 resource specs", () => {
  const expected = [
    "cert_info",
    "dns_records",
    "http_checks",
    "port_scan",
    "traceroute",
    "whois_info",
  ];
  const actual = Object.keys(model.resources).sort();
  assertEquals(actual, expected);
});

Deno.test("network model: has all 6 methods", () => {
  const expected = [
    "cert_check",
    "dns_lookup",
    "http_check",
    "port_check",
    "traceroute",
    "whois_lookup",
  ];
  const actual = Object.keys(model.methods).sort();
  assertEquals(actual, expected);
});

Deno.test("network model: each method has arguments and execute", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    const m = method as { arguments?: unknown; execute?: unknown };
    assertExists(m.arguments, `${name} should have arguments`);
    assertExists(m.execute, `${name} should have execute`);
    assertEquals(
      typeof m.execute,
      "function",
      `${name}.execute should be a function`,
    );
  }
});

// ===========================================================================
// Parser unit tests
// ===========================================================================

const {
  parseDigJson,
  parseDigText,
  parseWhoisText,
  parseTracerouteOutput,
  parseCertOutput,
  computeDaysUntilExpiry,
} = _internals;

// ---------------------------------------------------------------------------
// parseDigJson
// ---------------------------------------------------------------------------

Deno.test("parseDigJson: valid dig +json output parses records, server, queryTime, status", () => {
  const digOutput = JSON.stringify([
    {
      message: {
        response_message_data: {
          status: "NOERROR",
          ANSWER: [
            {
              name: "example.com.",
              type: 1,
              TTL: 300,
              data: "93.184.216.34",
            },
            {
              name: "example.com.",
              type: 28,
              TTL: 300,
              data: "2606:2800:220:1:248:1893:25c8:1946",
            },
          ],
        },
        response_address: "8.8.8.8",
        query_time: 42,
      },
    },
  ]);

  const result = parseDigJson(digOutput);
  assertEquals(result.status, "NOERROR");
  assertEquals(result.records.length, 2);
  assertEquals(result.records[0].name, "example.com.");
  assertEquals(result.records[0].type, "1");
  assertEquals(result.records[0].ttl, 300);
  assertEquals(result.records[0].data, "93.184.216.34");
  assertEquals(result.server, "8.8.8.8");
  assertEquals(result.queryTime, "42ms");
});

Deno.test("parseDigJson: invalid JSON falls through to text parser", () => {
  const result = parseDigJson("this is not json at all");
  // Falls through to parseDigText which returns NOERROR with empty records
  assertEquals(result.status, "NOERROR");
  assertEquals(result.records, []);
  assertEquals(result.server, null);
  assertEquals(result.queryTime, null);
});

Deno.test("parseDigText: standard dig output parses records and metadata", () => {
  const output = [
    "; <<>> DiG 9.20.18 <<>> example.com A",
    ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 8653",
    ";; ANSWER SECTION:",
    "example.com.\t\t300\tIN\tA\t93.184.216.34",
    "",
    ";; Query time: 23 msec",
    ";; SERVER: 10.255.255.254#53(10.255.255.254) (UDP)",
  ].join("\n");
  const result = parseDigText(output);
  assertEquals(result.status, "NOERROR");
  assertEquals(result.records.length, 1);
  assertEquals(result.records[0].name, "example.com");
  assertEquals(result.records[0].type, "A");
  assertEquals(result.records[0].ttl, 300);
  assertEquals(result.records[0].data, "93.184.216.34");
  assertEquals(result.server, "10.255.255.254");
  assertEquals(result.queryTime, "23msec");
});

Deno.test("parseDigText: NXDOMAIN returns correct status", () => {
  const output = [
    ";; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1234",
    "",
  ].join("\n");
  const result = parseDigText(output);
  assertEquals(result.status, "NXDOMAIN");
  assertEquals(result.records, []);
});

// ---------------------------------------------------------------------------
// parseWhoisText
// ---------------------------------------------------------------------------

Deno.test("parseWhoisText: full whois output extracts registrar, dates, nameservers, status", () => {
  const whoisText = [
    "Domain Name: EXAMPLE.COM",
    "Registrar: Example Registrar, Inc.",
    "Creation Date: 1995-08-14T04:00:00Z",
    "Registry Expiry Date: 2025-08-13T04:00:00Z",
    "Updated Date: 2024-08-14T07:01:44Z",
    "Name Server: ns1.example.com",
    "Name Server: ns2.example.com",
    "Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited",
    "Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited",
  ].join("\n");

  const result = parseWhoisText(whoisText);
  assertEquals(result.registrar, "Example Registrar, Inc.");
  assertEquals(result.creationDate, "1995-08-14T04:00:00Z");
  assertEquals(result.expiryDate, "2025-08-13T04:00:00Z");
  assertEquals(result.updatedDate, "2024-08-14T07:01:44Z");
  assertEquals(result.nameservers.length, 2);
  assertEquals(result.nameservers[0], "ns1.example.com");
  assertEquals(result.nameservers[1], "ns2.example.com");
  assertEquals(result.status.length, 2);
});

Deno.test("parseWhoisText: empty input returns all null, empty arrays", () => {
  const result = parseWhoisText("");
  assertEquals(result.registrar, null);
  assertEquals(result.creationDate, null);
  assertEquals(result.expiryDate, null);
  assertEquals(result.updatedDate, null);
  assertEquals(result.nameservers, []);
  assertEquals(result.status, []);
});

// ---------------------------------------------------------------------------
// parseTracerouteOutput
// ---------------------------------------------------------------------------

Deno.test("parseTracerouteOutput: normal output with header and hops parses correctly", () => {
  const output = [
    "traceroute to example.com (93.184.216.34), 30 hops max, 60 byte packets",
    " 1  gateway (192.168.1.1)  1.234 ms  1.456 ms  1.678 ms",
    " 2  isp-router (10.0.0.1)  5.123 ms  5.456 ms  5.789 ms",
    " 3  target (93.184.216.34)  10.111 ms  10.222 ms  10.333 ms",
  ].join("\n");

  const result = parseTracerouteOutput(output);
  assertEquals(result.hops.length, 3);
  assertEquals(result.hops[0].hop, 1);
  assertEquals(result.hops[0].host, "gateway");
  assertEquals(result.hops[0].ip, "192.168.1.1");
  assertEquals(result.hops[0].rttMs.length, 3);
  assertEquals(result.reachedTarget, true);
});

Deno.test("parseTracerouteOutput: timeout hops (* * *) have null host and ip", () => {
  const output = [
    "traceroute to example.com (93.184.216.34), 30 hops max, 60 byte packets",
    " 1  gateway (192.168.1.1)  1.234 ms  1.456 ms  1.678 ms",
    " 2  * * *",
    " 3  * * *",
  ].join("\n");

  const result = parseTracerouteOutput(output);
  assertEquals(result.hops.length, 3);
  assertEquals(result.hops[1].host, null);
  assertEquals(result.hops[1].ip, null);
  assertEquals(result.hops[2].host, null);
  assertEquals(result.hops[2].ip, null);
});

Deno.test("parseTracerouteOutput: empty output returns empty hops, reachedTarget false", () => {
  const result = parseTracerouteOutput("");
  assertEquals(result.hops, []);
  assertEquals(result.reachedTarget, false);
});

// ---------------------------------------------------------------------------
// parseCertOutput
// ---------------------------------------------------------------------------

Deno.test("parseCertOutput: full openssl output extracts all fields", () => {
  const output = [
    "notBefore=Jan  1 00:00:00 2025 GMT",
    "notAfter=Dec 31 23:59:59 2026 GMT",
    "subject=CN = example.com",
    "issuer=C = US, O = Let's Encrypt, CN = R3",
    "serial=0123456789ABCDEF",
  ].join("\n");

  const result = parseCertOutput(output);
  assertEquals(result.subject, "CN = example.com");
  assertEquals(result.issuer, "C = US, O = Let's Encrypt, CN = R3");
  assertEquals(result.notBefore, "Jan  1 00:00:00 2025 GMT");
  assertEquals(result.notAfter, "Dec 31 23:59:59 2026 GMT");
  assertEquals(result.serialNumber, "0123456789ABCDEF");
});

Deno.test("parseCertOutput: empty output returns all null", () => {
  const result = parseCertOutput("");
  assertEquals(result.subject, null);
  assertEquals(result.issuer, null);
  assertEquals(result.notBefore, null);
  assertEquals(result.notAfter, null);
  assertEquals(result.serialNumber, null);
});

// ---------------------------------------------------------------------------
// computeDaysUntilExpiry
// ---------------------------------------------------------------------------

Deno.test("computeDaysUntilExpiry: future date returns positive number", () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 30);
  const result = computeDaysUntilExpiry(futureDate.toISOString());
  assertExists(result);
  assertEquals(result! >= 29 && result! <= 30, true);
});

Deno.test("computeDaysUntilExpiry: past date returns negative number", () => {
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 10);
  const result = computeDaysUntilExpiry(pastDate.toISOString());
  assertExists(result);
  assertEquals(result! < 0, true);
});

Deno.test("computeDaysUntilExpiry: invalid date string returns null", () => {
  const result = computeDaysUntilExpiry("not-a-date");
  assertEquals(result, null);
});

Deno.test("computeDaysUntilExpiry: null input returns null", () => {
  const result = computeDaysUntilExpiry(null);
  assertEquals(result, null);
});

// ===========================================================================
// Method execution tests (mocked)
// ===========================================================================

// ---------------------------------------------------------------------------
// Command mock helper
// ---------------------------------------------------------------------------

const OriginalCommand = Deno.Command;

function withMockedCommand(
  handler: (
    cmd: string,
    args: string[],
  ) => { stdout: string; stderr: string; success: boolean },
  fn: () => Promise<void>,
): Promise<void> {
  const encoder = new TextEncoder();
  // @ts-ignore: mock Deno.Command for testing
  Deno.Command = class {
    #cmd: string;
    #args: string[];
    constructor(
      cmd: string,
      opts?: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    spawn() {
      const result = handler(this.#cmd, this.#args);
      return {
        output: () =>
          Promise.resolve({
            success: result.success,
            stdout: encoder.encode(result.stdout),
            stderr: encoder.encode(result.stderr),
          }),
        kill: () => {},
      };
    }
  };
  return fn().finally(() => {
    // @ts-ignore: restore original Deno.Command
    Deno.Command = OriginalCommand;
  });
}

// ---------------------------------------------------------------------------
// dns_lookup: mocked execution
// ---------------------------------------------------------------------------

Deno.test({
  name: "dns_lookup: mocked dig returns parsed DNS records",
  sanitizeResources: false,
  fn: async () => {
    const digJson = JSON.stringify([
      {
        message: {
          response_message_data: {
            status: "NOERROR",
            ANSWER: [
              {
                name: "example.com.",
                type: 1,
                TTL: 300,
                data: "93.184.216.34",
              },
            ],
          },
          response_address: "8.8.8.8",
          query_time: 25,
        },
      },
    ]);

    await withMockedCommand(
      (_cmd, _args) => ({ stdout: digJson, stderr: "", success: true }),
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {},
          definition: {
            id: "test-id",
            name: "test-probe",
            version: 1,
            tags: {},
          },
        });

        const result = await model.methods.dns_lookup.execute(
          { domain: "example.com", recordType: "A" },
          context as unknown as Parameters<
            typeof model.methods.dns_lookup.execute
          >[1],
        );

        assertEquals(result.dataHandles.length, 1);
        const resources = getWrittenResources();
        assertEquals(resources.length, 1);
        assertEquals(resources[0].specName, "dns_records");

        const data = resources[0].data as {
          domain: string;
          recordType: string;
          records: Array<{
            name: string;
            type: string;
            ttl: number | null;
            data: string;
          }>;
          status: string;
          server: string | null;
        };

        assertEquals(data.domain, "example.com");
        assertEquals(data.status, "NOERROR");
        assertEquals(data.records.length, 1);
        assertEquals(data.records[0].data, "93.184.216.34");
        assertEquals(data.server, "8.8.8.8");
      },
    );
  },
});

// ---------------------------------------------------------------------------
// whois_lookup: mocked execution
// ---------------------------------------------------------------------------

Deno.test({
  name: "whois_lookup: mocked whois returns parsed registration data",
  sanitizeResources: false,
  fn: async () => {
    const whoisText = [
      "Domain Name: EXAMPLE.COM",
      "Registrar: Example Registrar, Inc.",
      "Creation Date: 1995-08-14T04:00:00Z",
      "Registry Expiry Date: 2025-08-13T04:00:00Z",
      "Updated Date: 2024-08-14T07:01:44Z",
      "Name Server: ns1.example.com",
      "Name Server: ns2.example.com",
      "Domain Status: clientDeleteProhibited",
    ].join("\n");

    await withMockedCommand(
      (_cmd, _args) => ({ stdout: whoisText, stderr: "", success: true }),
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {},
          definition: {
            id: "test-id",
            name: "test-probe",
            version: 1,
            tags: {},
          },
        });

        const result = await model.methods.whois_lookup.execute(
          { domain: "example.com" },
          context as unknown as Parameters<
            typeof model.methods.whois_lookup.execute
          >[1],
        );

        assertEquals(result.dataHandles.length, 1);
        const resources = getWrittenResources();
        assertEquals(resources.length, 1);
        assertEquals(resources[0].specName, "whois_info");

        const data = resources[0].data as {
          domain: string;
          registrar: string | null;
          nameservers: string[];
        };

        assertEquals(data.domain, "example.com");
        assertEquals(data.registrar, "Example Registrar, Inc.");
        assertEquals(data.nameservers.length, 2);
      },
    );
  },
});

// ---------------------------------------------------------------------------
// traceroute: mocked execution
// ---------------------------------------------------------------------------

Deno.test({
  name: "traceroute: mocked traceroute returns parsed hops",
  sanitizeResources: false,
  fn: async () => {
    const traceOutput = [
      "traceroute to example.com (93.184.216.34), 15 hops max, 60 byte packets",
      " 1  gateway (192.168.1.1)  1.234 ms  1.456 ms  1.678 ms",
      " 2  isp-router (10.0.0.1)  5.123 ms  5.456 ms  5.789 ms",
      " 3  target (93.184.216.34)  10.111 ms  10.222 ms  10.333 ms",
    ].join("\n");

    await withMockedCommand(
      (_cmd, _args) => ({ stdout: traceOutput, stderr: "", success: true }),
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {},
          definition: {
            id: "test-id",
            name: "test-probe",
            version: 1,
            tags: {},
          },
        });

        const result = await model.methods.traceroute.execute(
          { host: "example.com", maxHops: 15 },
          context as unknown as Parameters<
            typeof model.methods.traceroute.execute
          >[1],
        );

        assertEquals(result.dataHandles.length, 1);
        const resources = getWrittenResources();
        assertEquals(resources.length, 1);
        assertEquals(resources[0].specName, "traceroute");

        const data = resources[0].data as {
          host: string;
          maxHops: number;
          hops: Array<{
            hop: number;
            host: string | null;
            ip: string | null;
          }>;
          reachedTarget: boolean;
        };

        assertEquals(data.host, "example.com");
        assertEquals(data.reachedTarget, true);
        assertEquals(data.hops.length, 3);
        assertEquals(data.hops[0].hop, 1);
        assertEquals(data.hops[0].host, "gateway");
      },
    );
  },
});

// ---------------------------------------------------------------------------
// http_check: mocked fetch execution with status and timing
// ---------------------------------------------------------------------------

Deno.test({
  name: "http_check: mocked fetch returns status 200 with timing",
  sanitizeResources: false,
  fn: async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return Promise.resolve(
        new Response("OK", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain", "x-test": "yes" },
        }),
      );
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: {
          id: "test-id",
          name: "test-probe",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.http_check.execute(
        { url: "https://example.com/health", method: "GET" },
        context as unknown as Parameters<
          typeof model.methods.http_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);

      const data = resources[0].data as {
        url: string;
        statusCode: number;
        error: string | null;
        timingMs: number;
        headers: Record<string, string>;
      };

      assertEquals(data.statusCode, 200);
      assertEquals(data.error, null);
      assertEquals(data.timingMs >= 0, true);
      assertEquals(data.headers["x-test"], "yes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// ---------------------------------------------------------------------------
// port_check: mocked Deno.connect execution
// ---------------------------------------------------------------------------

Deno.test({
  name: "port_check: mocked connect reports open and closed ports",
  sanitizeResources: false,
  fn: async () => {
    const originalConnect = Deno.connect;

    // @ts-ignore: mock Deno.connect for testing
    Deno.connect = (
      opts: { hostname: string; port: number },
    ): Promise<Deno.TcpConn> => {
      if (opts.port === 80) {
        return Promise.resolve({ close: () => {} } as unknown as Deno.TcpConn);
      }
      return Promise.reject(new Error("Connection refused"));
    };

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: {
          id: "test-id",
          name: "test-probe",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.port_check.execute(
        { host: "example.com", ports: [80, 9999] },
        context as unknown as Parameters<
          typeof model.methods.port_check.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "port_scan");

      const data = resources[0].data as {
        host: string;
        openPorts: number[];
        closedPorts: number[];
        results: Array<{ port: number; open: boolean; error: string | null }>;
      };

      assertEquals(data.host, "example.com");
      assertEquals(data.openPorts, [80]);
      assertEquals(data.closedPorts, [9999]);
      assertEquals(data.results.length, 2);
      assertEquals(data.results[0].open, true);
      assertEquals(data.results[0].error, null);
      assertEquals(data.results[1].open, false);
      assertEquals(typeof data.results[1].error, "string");
    } finally {
      // @ts-ignore: restore original Deno.connect
      Deno.connect = originalConnect;
    }
  },
});
