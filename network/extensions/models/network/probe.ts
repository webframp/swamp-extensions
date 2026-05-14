/**
 * Network probing operations model for swamp.
 *
 * Wraps standard network utilities (dig, whois, openssl, traceroute) and
 * native Deno APIs to produce structured diagnostic resources for DNS
 * lookups, HTTP checks, WHOIS queries, TLS certificate inspection,
 * traceroute, and TCP port scanning.
 *
 * @module
 */

// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Context Type
// =============================================================================

interface ModelContext {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

// =============================================================================
// Schemas
// =============================================================================

const DnsRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  ttl: z.number().nullable(),
  data: z.string(),
});

const DnsLookupSchema = z.object({
  domain: z.string(),
  recordType: z.string(),
  records: z.array(DnsRecordSchema),
  server: z.string().nullable(),
  queryTime: z.string().nullable(),
  status: z.string(),
  fetchedAt: z.string(),
});

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

const WhoisInfoSchema = z.object({
  domain: z.string(),
  registrar: z.string().nullable(),
  creationDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  updatedDate: z.string().nullable(),
  nameservers: z.array(z.string()),
  status: z.array(z.string()),
  rawText: z.string(),
  fetchedAt: z.string(),
});

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

const TracerouteHopSchema = z.object({
  hop: z.number(),
  host: z.string().nullable(),
  ip: z.string().nullable(),
  rttMs: z.array(z.number().nullable()),
});

const TracerouteSchema = z.object({
  host: z.string(),
  maxHops: z.number(),
  hops: z.array(TracerouteHopSchema),
  reachedTarget: z.boolean(),
  fetchedAt: z.string(),
});

const PortResultSchema = z.object({
  port: z.number(),
  open: z.boolean(),
  error: z.string().nullable(),
});

const PortScanSchema = z.object({
  host: z.string(),
  results: z.array(PortResultSchema),
  openPorts: z.array(z.number()),
  closedPorts: z.array(z.number()),
  fetchedAt: z.string(),
});

// =============================================================================
// Helper: Run a shell command
// =============================================================================

/** Execute a shell command with an optional timeout and return its output. */
async function runCommand(
  cmd: string[],
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // process may have already exited
    }
  }, timeoutMs);

  const output = await child.output();
  clearTimeout(timer);

  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    success: output.success,
  };
}

// =============================================================================
// Parsers
// =============================================================================

interface DigAnswer {
  name?: string;
  type?: number | string;
  TTL?: number;
  data?: string;
}

/** Parse dig JSON output into structured DNS records. */
function parseDigJson(
  stdout: string,
): {
  records: z.infer<typeof DnsRecordSchema>[];
  server: string | null;
  queryTime: string | null;
  status: string;
} {
  try {
    const json = JSON.parse(stdout);
    const answers: DigAnswer[] =
      json[0]?.message?.response_message_data?.ANSWER ?? [];
    const status: string = json[0]?.message?.response_message_data?.status ??
      "NOERROR";

    const records = answers.map((a: DigAnswer) => ({
      name: a.name ?? "",
      type: String(a.type ?? ""),
      ttl: a.TTL ?? null,
      data: a.data ?? "",
    }));

    const server = json[0]?.message?.response_address ?? null;
    const queryTime = json[0]?.message?.query_time != null
      ? `${json[0].message.query_time}ms`
      : null;

    return { records, server, queryTime, status };
  } catch {
    // Fallback: try line-based parsing of standard dig text output
    return parseDigText(stdout);
  }
}

/** Parse standard dig text output as a fallback when JSON is unavailable. */
function parseDigText(
  stdout: string,
): {
  records: z.infer<typeof DnsRecordSchema>[];
  server: string | null;
  queryTime: string | null;
  status: string;
} {
  const records: z.infer<typeof DnsRecordSchema>[] = [];
  let server: string | null = null;
  let queryTime: string | null = null;
  let status = "NOERROR";

  const lines = stdout.split("\n");
  let inAnswer = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Extract status from header
    const statusMatch = trimmed.match(/status:\s*(\w+)/);
    if (statusMatch) {
      status = statusMatch[1];
    }

    // Detect ANSWER SECTION
    if (trimmed === ";; ANSWER SECTION:") {
      inAnswer = true;
      continue;
    }

    // End of ANSWER SECTION (next section header or blank line)
    if (inAnswer && (trimmed.startsWith(";;") || trimmed === "")) {
      inAnswer = false;
      continue;
    }

    // Parse answer records: "example.com. 300 IN A 172.66.147.243"
    if (inAnswer && !trimmed.startsWith(";")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 5) {
        records.push({
          name: parts[0].replace(/\.$/, ""),
          type: parts[3],
          ttl: parseInt(parts[1], 10) || null,
          data: parts.slice(4).join(" "),
        });
      }
    }

    // Extract server
    const serverMatch = trimmed.match(/;;\s*SERVER:\s*([^#(]+)/);
    if (serverMatch) {
      server = serverMatch[1].trim();
    }

    // Extract query time
    const timeMatch = trimmed.match(/;;\s*Query time:\s*(\d+\s*msec)/);
    if (timeMatch) {
      queryTime = timeMatch[1].replace(" ", "");
    }
  }

  return { records, server, queryTime, status };
}

/** Extract structured registration fields from raw WHOIS text. */
function parseWhoisText(
  text: string,
): {
  registrar: string | null;
  creationDate: string | null;
  expiryDate: string | null;
  updatedDate: string | null;
  nameservers: string[];
  status: string[];
} {
  const lines = text.split("\n");
  let registrar: string | null = null;
  let creationDate: string | null = null;
  let expiryDate: string | null = null;
  let updatedDate: string | null = null;
  const nameservers: string[] = [];
  const status: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith("registrar:")) {
      registrar = trimmed.split(":").slice(1).join(":").trim() || registrar;
    } else if (
      lower.startsWith("creation date:") ||
      lower.startsWith("created:")
    ) {
      creationDate = trimmed.split(":").slice(1).join(":").trim() ||
        creationDate;
    } else if (
      lower.startsWith("registry expiry date:") ||
      lower.startsWith("expiry date:") ||
      lower.startsWith("expires:")
    ) {
      expiryDate = trimmed.split(":").slice(1).join(":").trim() || expiryDate;
    } else if (
      lower.startsWith("updated date:") ||
      lower.startsWith("last updated:")
    ) {
      updatedDate = trimmed.split(":").slice(1).join(":").trim() || updatedDate;
    } else if (
      lower.startsWith("name server:") || lower.startsWith("nserver:")
    ) {
      const ns = trimmed.split(":").slice(1).join(":").trim();
      if (ns) nameservers.push(ns.toLowerCase());
    } else if (
      lower.startsWith("domain status:") || lower.startsWith("status:")
    ) {
      const s = trimmed.split(":").slice(1).join(":").trim();
      if (s) status.push(s);
    }
  }

  return {
    registrar,
    creationDate,
    expiryDate,
    updatedDate,
    nameservers,
    status,
  };
}

/** Parse traceroute text output into structured hop entries. */
function parseTracerouteOutput(
  stdout: string,
): { hops: z.infer<typeof TracerouteHopSchema>[]; reachedTarget: boolean } {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const hops: z.infer<typeof TracerouteHopSchema>[] = [];
  let reachedTarget = false;

  // Skip the header line ("traceroute to ...")
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    const hopMatch = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1], 10);
    const rest = hopMatch[2];

    if (rest.includes("* * *")) {
      hops.push({
        hop: hopNum,
        host: null,
        ip: null,
        rttMs: [null, null, null],
      });
      continue;
    }

    // Parse host and IP
    const hostMatch = rest.match(/^(\S+)\s+\(([^)]+)\)/);
    const host = hostMatch ? hostMatch[1] : null;
    const ip = hostMatch ? hostMatch[2] : null;

    // Parse RTT values
    const rttMatches = [...rest.matchAll(/([\d.]+)\s*ms/g)];
    const rttMs = rttMatches.map((m) => parseFloat(m[1]));

    hops.push({
      hop: hopNum,
      host,
      ip,
      rttMs: rttMs.length > 0 ? rttMs : [null],
    });

    if (ip || host) {
      reachedTarget = true; // The last hop with a host likely reached the target
    }
  }

  return { hops, reachedTarget };
}

/** Extract certificate fields from openssl x509 text output. */
function parseCertOutput(
  stdout: string,
): {
  subject: string | null;
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
  serialNumber: string | null;
} {
  let subject: string | null = null;
  let issuer: string | null = null;
  let notBefore: string | null = null;
  let notAfter: string | null = null;
  let serialNumber: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("subject=")) {
      subject = trimmed.slice("subject=".length).trim();
    } else if (trimmed.startsWith("issuer=")) {
      issuer = trimmed.slice("issuer=".length).trim();
    } else if (trimmed.startsWith("notBefore=")) {
      notBefore = trimmed.slice("notBefore=".length).trim();
    } else if (trimmed.startsWith("notAfter=")) {
      notAfter = trimmed.slice("notAfter=".length).trim();
    } else if (trimmed.startsWith("serial=")) {
      serialNumber = trimmed.slice("serial=".length).trim();
    }
  }

  return { subject, issuer, notBefore, notAfter, serialNumber };
}

/** Compute the number of days between now and a certificate expiry date. */
function computeDaysUntilExpiry(notAfter: string | null): number | null {
  if (!notAfter) return null;
  try {
    const expiry = new Date(notAfter);
    if (isNaN(expiry.getTime())) return null;
    const now = new Date();
    return Math.floor(
      (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );
  } catch {
    return null;
  }
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * Network probing model definition.
 *
 * Exposes six diagnostic methods -- dns_lookup, http_check, whois_lookup,
 * cert_check, traceroute, and port_check -- each of which writes a typed
 * resource with structured results.
 */
export const model = {
  type: "@webframp/network",
  version: "2026.04.12.1",
  globalArguments: z.object({}),

  resources: {
    dns_records: {
      description: "DNS lookup results for a domain",
      schema: DnsLookupSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    http_checks: {
      description: "HTTP endpoint check results",
      schema: HttpCheckSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
    whois_info: {
      description: "WHOIS registration data for a domain",
      schema: WhoisInfoSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    cert_info: {
      description: "TLS certificate details for a host",
      schema: CertInfoSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    traceroute: {
      description: "Network path trace to a host",
      schema: TracerouteSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    port_scan: {
      description: "TCP port connectivity results",
      schema: PortScanSchema,
      lifetime: "10m" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    dns_lookup: {
      description: "Run dig to resolve DNS records for a domain",
      arguments: z.object({
        domain: z.string().describe("Domain name to look up"),
        recordType: z
          .enum(["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA"])
          .default("A")
          .describe("DNS record type to query"),
      }),
      execute: async (
        args: { domain: string; recordType: string },
        context: ModelContext,
      ) => {
        // Try dig +json first; if unsupported, fall back to standard text output
        let result = await runCommand([
          "dig",
          "+json",
          args.domain,
          args.recordType,
        ]);

        let parsed;
        if (
          result.success ||
          !result.stderr.includes("Invalid option: +json")
        ) {
          parsed = parseDigJson(result.stdout);
        } else {
          // +json not supported, retry with standard text output
          result = await runCommand([
            "dig",
            args.domain,
            args.recordType,
          ]);
          parsed = parseDigText(result.stdout);
        }

        const data = {
          domain: args.domain,
          recordType: args.recordType,
          records: parsed.records,
          server: parsed.server,
          queryTime: parsed.queryTime,
          status: result.success ? parsed.status : "COMMAND_FAILED",
          fetchedAt: new Date().toISOString(),
        };

        const instance = `${args.domain}-${args.recordType}`;
        const handle = await context.writeResource(
          "dns_records",
          instance,
          data,
        );

        context.logger.info("DNS lookup {domain} {type}: {count} records", {
          domain: args.domain,
          type: args.recordType,
          count: parsed.records.length,
        });

        return { dataHandles: [handle] };
      },
    },

    http_check: {
      description:
        "Fetch a URL and record status code, headers, timing, and redirect chain",
      arguments: z.object({
        url: z.string().describe("URL to check"),
        method: z
          .enum(["GET", "HEAD"])
          .default("HEAD")
          .describe("HTTP method to use"),
      }),
      execute: async (
        args: { url: string; method: string },
        context: ModelContext,
      ) => {
        const startTime = performance.now();

        try {
          const redirectChain: Array<{ url: string; statusCode: number }> = [];
          let currentUrl = args.url;
          let finalResponse: Response | null = null;

          // Follow redirects manually to capture the chain
          for (let i = 0; i < 10; i++) {
            const response = await fetch(currentUrl, {
              method: args.method,
              redirect: "manual",
            });

            if (
              [301, 302, 303, 307, 308].includes(response.status) &&
              response.headers.get("location")
            ) {
              redirectChain.push({
                url: currentUrl,
                statusCode: response.status,
              });
              const location = response.headers.get("location")!;
              currentUrl = new URL(location, currentUrl).toString();
              // Consume and discard body to free resources
              await response.body?.cancel();
              continue;
            }

            finalResponse = response;
            break;
          }

          const timingMs = Math.round(performance.now() - startTime);

          if (!finalResponse) {
            const errorData = {
              url: args.url,
              method: args.method,
              statusCode: 0,
              statusText: "",
              headers: {},
              redirectChain,
              timingMs,
              tlsProtocol: null,
              error: `Too many redirects for ${args.url}`,
              fetchedAt: new Date().toISOString(),
            };

            const instance = `http-${new URL(args.url).hostname}`;
            const handle = await context.writeResource(
              "http_checks",
              instance,
              errorData,
            );

            context.logger.info(
              "HTTP {method} {url}: too many redirects in {ms}ms",
              { method: args.method, url: args.url, ms: timingMs },
            );

            return { dataHandles: [handle] };
          }

          // Convert headers to a plain object
          const headers: Record<string, string> = {};
          finalResponse.headers.forEach((value, key) => {
            headers[key] = value;
          });

          // Consume body to release resources
          await finalResponse.body?.cancel();

          // Attempt to determine TLS protocol from the URL scheme
          const urlObj = new URL(currentUrl);
          const tlsProtocol = urlObj.protocol === "https:" ? "TLS" : null;

          const data = {
            url: args.url,
            method: args.method,
            statusCode: finalResponse.status,
            statusText: finalResponse.statusText,
            headers,
            redirectChain,
            timingMs,
            tlsProtocol,
            error: null,
            fetchedAt: new Date().toISOString(),
          };

          const instance = `http-${new URL(args.url).hostname}`;
          const handle = await context.writeResource(
            "http_checks",
            instance,
            data,
          );

          context.logger.info("HTTP {method} {url}: {status} in {ms}ms", {
            method: args.method,
            url: args.url,
            status: finalResponse.status,
            ms: timingMs,
          });

          return { dataHandles: [handle] };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const timingMs = Math.round(performance.now() - startTime);

          const errorData = {
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
            instance = `http-${new URL(args.url).hostname}`;
          } catch {
            instance = `http-${args.url}`;
          }

          const handle = await context.writeResource(
            "http_checks",
            instance,
            errorData,
          );

          context.logger.info("HTTP {method} {url}: error {error} in {ms}ms", {
            method: args.method,
            url: args.url,
            error: errorMessage,
            ms: timingMs,
          });

          return { dataHandles: [handle] };
        }
      },
    },

    whois_lookup: {
      description: "Query WHOIS for domain registration details",
      arguments: z.object({
        domain: z.string().describe("Domain name to look up"),
      }),
      execute: async (
        args: { domain: string },
        context: ModelContext,
      ) => {
        const result = await runCommand(["whois", args.domain]);

        const parsed = parseWhoisText(result.stdout);

        const data = {
          domain: args.domain,
          registrar: parsed.registrar,
          creationDate: parsed.creationDate,
          expiryDate: parsed.expiryDate,
          updatedDate: parsed.updatedDate,
          nameservers: parsed.nameservers,
          status: parsed.status,
          rawText: result.stdout.slice(0, 4000),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "whois_info",
          `whois-${args.domain}`,
          data,
        );

        context.logger.info("WHOIS {domain}: registrar={registrar}", {
          domain: args.domain,
          registrar: parsed.registrar ?? "unknown",
        });

        return { dataHandles: [handle] };
      },
    },

    cert_check: {
      description:
        "Inspect TLS certificate subject, issuer, and validity dates",
      arguments: z.object({
        host: z.string().describe("Hostname to check"),
        port: z.number().default(443).describe("TLS port to connect to"),
      }),
      execute: async (
        args: { host: string; port: number },
        context: ModelContext,
      ) => {
        const result = await runCommand([
          "bash",
          "-c",
          `echo | openssl s_client -connect ${args.host}:${args.port} -servername ${args.host} 2>/dev/null | openssl x509 -noout -dates -subject -issuer -serial`,
        ]);

        const instance = `${args.host}-${args.port}`;

        if (!result.success) {
          const errorMessage = result.stderr.trim() || "openssl command failed";
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

          const handle = await context.writeResource(
            "cert_info",
            instance,
            data,
          );

          context.logger.info("Cert {host}:{port}: error {error}", {
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

        const handle = await context.writeResource("cert_info", instance, data);

        context.logger.info("Cert {host}:{port}: expires in {days} days", {
          host: args.host,
          port: args.port,
          days: daysUntilExpiry ?? "unknown",
        });

        return { dataHandles: [handle] };
      },
    },

    traceroute: {
      description: "Trace network path to a host",
      arguments: z.object({
        host: z.string().describe("Target host to trace"),
        maxHops: z
          .number()
          .default(15)
          .describe("Maximum number of hops"),
      }),
      execute: async (
        args: { host: string; maxHops: number },
        context: ModelContext,
      ) => {
        const result = await runCommand(
          ["traceroute", "-m", String(args.maxHops), "-w", "2", args.host],
          60000,
        );

        const parsed = parseTracerouteOutput(result.stdout);

        const data = {
          host: args.host,
          maxHops: args.maxHops,
          hops: parsed.hops,
          reachedTarget: parsed.reachedTarget,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "traceroute",
          `trace-${args.host}`,
          data,
        );

        context.logger.info(
          "Traceroute {host}: {hopCount} hops, reached={reached}",
          {
            host: args.host,
            hopCount: parsed.hops.length,
            reached: parsed.reachedTarget,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    port_check: {
      description: "Test TCP connectivity on specific ports",
      arguments: z.object({
        host: z.string().describe("Target host to scan"),
        ports: z
          .array(z.number())
          .default([80, 443])
          .describe("List of TCP ports to check (defaults to 80, 443)"),
      }),
      execute: async (
        args: { host: string; ports: number[] },
        context: ModelContext,
      ) => {
        const results: z.infer<typeof PortResultSchema>[] = [];

        for (const port of args.ports) {
          try {
            const conn = await Deno.connect({ hostname: args.host, port });
            conn.close();
            results.push({ port, open: true, error: null });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push({ port, open: false, error: message });
          }
        }

        const openPorts = results.filter((r) => r.open).map((r) => r.port);
        const closedPorts = results.filter((r) => !r.open).map((r) => r.port);

        const data = {
          host: args.host,
          results,
          openPorts,
          closedPorts,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "port_scan",
          `ports-${args.host}`,
          data,
        );

        context.logger.info("Port check {host}: {open} open, {closed} closed", {
          host: args.host,
          open: openPorts.length,
          closed: closedPorts.length,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};

// Exported for testing
export const _internals = {
  parseDigJson,
  parseDigText,
  parseWhoisText,
  parseTracerouteOutput,
  parseCertOutput,
  computeDaysUntilExpiry,
};
