// SRE Health Check Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { parseSizeToMB, report } from "./sre_health_report.ts";

// --- Test helpers ---

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: { name: string; dataId: string; version: number }[];
  methodArgs: Record<string, unknown>;
  globalArgs: Record<string, unknown>;
}

function makeStep(
  modelName: string,
  methodName: string,
  dataName: string,
): StepExecution {
  return {
    jobName: "test-job",
    stepName: `${methodName}-step`,
    modelName,
    modelType: modelName === "net-probe"
      ? "@webframp/network"
      : "@webframp/system",
    modelId: `${modelName}-id`,
    methodName,
    status: "succeeded",
    dataHandles: [{
      name: dataName,
      dataId: `data-${methodName}`,
      version: 1,
    }],
    methodArgs: {},
    globalArgs: {},
  };
}

function makeArtifact(
  modelName: string,
  dataName: string,
  data: Record<string, unknown>,
) {
  const modelType = modelName === "net-probe"
    ? "@webframp/network"
    : "@webframp/system";
  const modelId = `${modelName}-id`;
  const content = new TextEncoder().encode(JSON.stringify(data));
  return {
    modelType,
    modelId,
    data: {
      name: dataName,
      kind: "resource" as const,
      dataId: `data-${dataName}`,
      version: 1,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

function createContext(
  stepExecutions: StepExecution[] = [],
  artifacts: ReturnType<typeof makeArtifact>[] = [],
) {
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "@webframp/sre-health-check",
    workflowStatus: "succeeded",
    // deno-lint-ignore no-explicit-any
    stepExecutions: stepExecutions as any,
    dataArtifacts: artifacts,
  });
  return context;
}

// --- Export structure ---

Deno.test("report has correct name", () => {
  assertEquals(report.name, "@webframp/sre-health-report");
});

Deno.test("report has workflow scope", () => {
  assertEquals(report.scope, "workflow");
});

Deno.test("report has labels", () => {
  assertEquals(report.labels, ["sre", "ops", "health-check"]);
});

// --- No data scenario ---

Deno.test("report with no step data produces DEGRADED status with error findings", async () => {
  const context = createContext();
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "DEGRADED");
  assertStringIncludes(result.markdown, "No HTTP check data available");
  assertStringIncludes(
    result.markdown,
    "No certificate check data available",
  );
  assertStringIncludes(result.markdown, "No DNS check data available");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "DEGRADED");
});

// --- HTTP check scenarios ---

Deno.test("report: HTTP 200 produces ok finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 200,
      timingMs: 150,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  assertEquals(httpFinding?.severity, "ok");
  assertStringIncludes(httpFinding?.message as string, "200");
});

Deno.test("report: HTTP 500 produces critical finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 503,
      timingMs: 50,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  assertEquals(httpFinding?.severity, "critical");
  assertStringIncludes(httpFinding?.message as string, "503");
});

Deno.test("report: HTTP 404 produces warn finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 404,
      timingMs: 30,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  assertEquals(httpFinding?.severity, "warn");
});

Deno.test("report: HTTP error produces critical finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: "Connection refused",
      statusCode: 0,
      timingMs: 0,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  assertEquals(httpFinding?.severity, "critical");
  assertStringIncludes(httpFinding?.message as string, "Connection refused");
});

// --- TLS Certificate scenarios ---

Deno.test("report: cert valid for 90 days produces ok finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const artifacts = [
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 90,
      subject: "CN=example.com",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const certFinding = findings.find((f) => f.check === "TLS Certificate");
  assertEquals(certFinding?.severity, "ok");
  assertStringIncludes(certFinding?.message as string, "90 days");
});

Deno.test("report: cert expiring in 15 days produces warn finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const artifacts = [
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 15,
      subject: "CN=example.com",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const certFinding = findings.find((f) => f.check === "TLS Certificate");
  assertEquals(certFinding?.severity, "warn");
});

Deno.test("report: cert expiring in 3 days produces critical finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const artifacts = [
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 3,
      subject: "CN=example.com",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const certFinding = findings.find((f) => f.check === "TLS Certificate");
  assertEquals(certFinding?.severity, "critical");
  assertStringIncludes(result.markdown, "Renew TLS certificate immediately");
});

Deno.test("report: cert error produces critical finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const artifacts = [
    makeArtifact("net-probe", "cert-output", {
      error: "openssl command failed",
      daysUntilExpiry: null,
      subject: null,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const certFinding = findings.find((f) => f.check === "TLS Certificate");
  assertEquals(certFinding?.severity, "critical");
  assertStringIncludes(
    certFinding?.message as string,
    "Certificate check failed",
  );
});

Deno.test("report: cert with null daysUntilExpiry and no error produces ok", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const artifacts = [
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: null,
      subject: "CN=example.com",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const certFinding = findings.find((f) => f.check === "TLS Certificate");
  assertEquals(certFinding?.severity, "ok");
  assertStringIncludes(certFinding?.message as string, "Certificate present");
});

// --- DNS scenarios ---

Deno.test("report: DNS resolves produces ok finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const artifacts = [
    makeArtifact("net-probe", "dns-output", {
      status: "NOERROR",
      records: [{ data: "93.184.216.34" }, { data: "93.184.216.35" }],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const dnsFinding = findings.find((f) => f.check === "DNS");
  assertEquals(dnsFinding?.severity, "ok");
  assertStringIncludes(dnsFinding?.message as string, "2 record(s)");
});

Deno.test("report: DNS NXDOMAIN produces critical finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const artifacts = [
    makeArtifact("net-probe", "dns-output", {
      status: "NXDOMAIN",
      records: [],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const dnsFinding = findings.find((f) => f.check === "DNS");
  assertEquals(dnsFinding?.severity, "critical");
});

Deno.test("report: DNS NOERROR with empty records produces warn finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const artifacts = [
    makeArtifact("net-probe", "dns-output", {
      status: "NOERROR",
      records: [],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const dnsFinding = findings.find((f) => f.check === "DNS");
  assertEquals(dnsFinding?.severity, "warn");
  assertStringIncludes(
    dnsFinding?.message as string,
    "returned no records",
  );
});

Deno.test("report: DNS COMMAND_FAILED produces error (not critical) finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const artifacts = [
    makeArtifact("net-probe", "dns-output", {
      status: "COMMAND_FAILED",
      records: [],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const dnsFinding = findings.find((f) => f.check === "DNS");
  assertEquals(dnsFinding?.severity, "error");
  assertStringIncludes(
    dnsFinding?.message as string,
    "dig not installed",
  );
});

// --- Port check scenarios ---

Deno.test("report: all ports open produces ok finding", async () => {
  const steps = [makeStep("net-probe", "port_check", "port-output")];
  const artifacts = [
    makeArtifact("net-probe", "port-output", {
      openPorts: [80, 443],
      closedPorts: [],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const portFinding = findings.find((f) => f.check === "Ports");
  assertEquals(portFinding?.severity, "ok");
  assertStringIncludes(portFinding?.message as string, "All 2 port(s) open");
});

Deno.test("report: closed ports produce warn finding", async () => {
  const steps = [makeStep("net-probe", "port_check", "port-output")];
  const artifacts = [
    makeArtifact("net-probe", "port-output", {
      openPorts: [80],
      closedPorts: [443],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const portFinding = findings.find((f) => f.check === "Ports");
  assertEquals(portFinding?.severity, "warn");
  assertStringIncludes(portFinding?.message as string, "1 port(s) closed");
  assertStringIncludes(result.markdown, "Verify closed ports are expected");
});

// --- Disk scenarios ---

Deno.test("report: disk at 95% produces critical finding", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const artifacts = [
    makeArtifact("sys-diag", "disk-output", {
      filesystems: [{
        target: "/",
        usePercent: "95%",
        used: "47G",
        size: "50G",
      }],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const diskFinding = findings.find((f) => f.check === "Disk");
  assertEquals(diskFinding?.severity, "critical");
  assertStringIncludes(diskFinding?.message as string, "95%");
  assertStringIncludes(result.markdown, "Free disk space");
});

Deno.test("report: disk at 85% produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const artifacts = [
    makeArtifact("sys-diag", "disk-output", {
      filesystems: [{
        target: "/data",
        usePercent: "85%",
        used: "42G",
        size: "50G",
      }],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const diskFinding = findings.find((f) => f.check === "Disk");
  assertEquals(diskFinding?.severity, "warn");
  assertStringIncludes(result.markdown, "Monitor disk usage");
});

Deno.test("report: disk at 50% produces ok finding", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const artifacts = [
    makeArtifact("sys-diag", "disk-output", {
      filesystems: [{
        target: "/",
        usePercent: "50%",
        used: "25G",
        size: "50G",
      }],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const diskFinding = findings.find((f) => f.check === "Disk");
  assertEquals(diskFinding?.severity, "ok");
});

// --- Load scenarios ---

Deno.test("report: high load produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_uptime", "uptime-output")];
  const artifacts = [
    makeArtifact("sys-diag", "uptime-output", {
      loadAverage1m: "8.5",
      loadAverage5m: "6.2",
      loadAverage15m: "4.1",
      uptimeString: "up 5 days",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const loadFinding = findings.find((f) => f.check === "Load");
  assertEquals(loadFinding?.severity, "warn");
  assertStringIncludes(
    result.markdown,
    "Investigate high system load",
  );
});

Deno.test("report: normal load produces ok finding", async () => {
  const steps = [makeStep("sys-diag", "get_uptime", "uptime-output")];
  const artifacts = [
    makeArtifact("sys-diag", "uptime-output", {
      loadAverage1m: "0.5",
      loadAverage5m: "0.3",
      loadAverage15m: "0.2",
      uptimeString: "up 10 days",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const loadFinding = findings.find((f) => f.check === "Load");
  assertEquals(loadFinding?.severity, "ok");
  assertStringIncludes(loadFinding?.message as string, "0.5 (1m)");
});

// --- Memory threshold scenarios ---

Deno.test("report: memory at 90% produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const artifacts = [
    makeArtifact("sys-diag", "mem-output", {
      mem: {
        total: "16Gi",
        used: "14.4Gi",
        free: "0.4Gi",
        available: "1.6Gi",
      },
      swap: { total: "0B", used: "0B", free: "0B" },
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const memFinding = findings.find((f) => f.check === "Memory");
  assertEquals(memFinding?.severity, "warn");
  assertStringIncludes(result.markdown, "Monitor memory usage");
});

Deno.test("report: memory at 96% produces critical finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const artifacts = [
    makeArtifact("sys-diag", "mem-output", {
      mem: {
        total: "16Gi",
        used: "15.4Gi",
        free: "0.1Gi",
        available: "0.6Gi",
      },
      swap: { total: "0B", used: "0B", free: "0B" },
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const memFinding = findings.find((f) => f.check === "Memory");
  assertEquals(memFinding?.severity, "critical");
  assertStringIncludes(result.markdown, "Investigate memory pressure");
});

Deno.test("report: low memory usage produces ok finding with percentage", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const artifacts = [
    makeArtifact("sys-diag", "mem-output", {
      mem: {
        total: "16Gi",
        used: "4Gi",
        free: "8Gi",
        available: "12Gi",
      },
      swap: { total: "8Gi", used: "100Mi", free: "7.9Gi" },
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const memFinding = findings.find((f) => f.check === "Memory");
  assertEquals(memFinding?.severity, "ok");
  assertStringIncludes(memFinding?.message as string, "(25%)");
  // Low swap usage should not produce a finding
  const swapFinding = findings.find((f) => f.check === "Swap");
  assertEquals(swapFinding, undefined);
});

// --- Swap scenarios ---

Deno.test("report: high swap usage produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const artifacts = [
    makeArtifact("sys-diag", "mem-output", {
      mem: {
        total: "16Gi",
        used: "4Gi",
        free: "8Gi",
        available: "12Gi",
      },
      swap: { total: "8Gi", used: "5Gi", free: "3Gi" },
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const swapFinding = findings.find((f) => f.check === "Swap");
  assertEquals(swapFinding?.severity, "warn");
  assertStringIncludes(
    result.markdown,
    "swap usage indicates memory pressure",
  );
});

// --- Overall status ---

Deno.test("report: all healthy checks produce HEALTHY status", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
    makeStep("net-probe", "cert_check", "cert-output"),
    makeStep("net-probe", "dns_lookup", "dns-output"),
    makeStep("net-probe", "port_check", "port-output"),
    makeStep("sys-diag", "get_disk_usage", "disk-output"),
    makeStep("sys-diag", "get_memory", "mem-output"),
    makeStep("sys-diag", "get_uptime", "uptime-output"),
  ];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 200,
      timingMs: 100,
    }),
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 365,
      subject: "CN=example.com",
    }),
    makeArtifact("net-probe", "dns-output", {
      status: "NOERROR",
      records: [{ data: "93.184.216.34" }],
    }),
    makeArtifact("net-probe", "port-output", {
      openPorts: [80, 443],
      closedPorts: [],
    }),
    makeArtifact("sys-diag", "disk-output", {
      filesystems: [{
        target: "/",
        usePercent: "40%",
        used: "20G",
        size: "50G",
      }],
    }),
    makeArtifact("sys-diag", "mem-output", {
      mem: { used: "4Gi", total: "16Gi", available: "12Gi" },
      swap: { total: "8Gi", used: "100Mi", free: "7.9Gi" },
    }),
    makeArtifact("sys-diag", "uptime-output", {
      loadAverage1m: "0.5",
      loadAverage5m: "0.3",
      loadAverage15m: "0.2",
      uptimeString: "up 10 days",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "[HEALTHY] HEALTHY");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "HEALTHY");
  assertEquals(
    (json.recommendations as string[]).length,
    0,
  );
});

Deno.test("report: critical finding produces CRITICAL overall status", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
  ];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: "Connection timeout",
      statusCode: 0,
      timingMs: 0,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "CRITICAL");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "CRITICAL");
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "Investigate endpoint availability");
});

Deno.test("report: warn-only findings produce WARNING overall status", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
    makeStep("net-probe", "cert_check", "cert-output"),
    makeStep("net-probe", "dns_lookup", "dns-output"),
  ];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 200,
      timingMs: 100,
    }),
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 20,
      subject: "CN=example.com",
    }),
    makeArtifact("net-probe", "dns-output", {
      status: "NOERROR",
      records: [{ data: "1.2.3.4" }],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "WARNING");
  assertStringIncludes(
    result.markdown,
    "Schedule TLS certificate renewal",
  );
});

// --- Markdown structure ---

Deno.test("report markdown contains all expected sections", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
    makeStep("net-probe", "cert_check", "cert-output"),
  ];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 200,
      timingMs: 100,
    }),
    makeArtifact("net-probe", "cert-output", {
      error: null,
      daysUntilExpiry: 15,
      subject: "CN=example.com",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "# SRE Health Check Report");
  assertStringIncludes(result.markdown, "**Status:**");
  assertStringIncludes(result.markdown, "**Timestamp:**");
  assertStringIncludes(result.markdown, "**Checks:**");
  assertStringIncludes(result.markdown, "## All Checks");
  assertStringIncludes(result.markdown, "| Check | Status | Detail |");
});

// --- Logger ---

Deno.test("report logs summary", async () => {
  const context = createContext();
  // deno-lint-ignore no-explicit-any
  await report.execute(context as any);
  // Logger is part of the context; we verify the report completes without error
  // The createReportTestContext captures logs internally
});

// --- findStepData skips report handles ---

Deno.test("report skips report- prefixed data handles", async () => {
  const steps: StepExecution[] = [{
    jobName: "test",
    stepName: "http-step",
    modelName: "net-probe",
    modelType: "@webframp/network",
    modelId: "net-probe-id",
    methodName: "http_check",
    status: "succeeded",
    dataHandles: [
      { name: "report-summary", dataId: "rpt-1", version: 1 },
      { name: "http-output", dataId: "data-1", version: 1 },
    ],
    methodArgs: {},
    globalArgs: {},
  }];
  const artifacts = [
    makeArtifact("net-probe", "http-output", {
      error: null,
      statusCode: 200,
      timingMs: 50,
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  assertEquals(httpFinding?.severity, "ok");
});

// --- parseSizeToMB ---

Deno.test("parseSizeToMB: Gi values", () => {
  assertEquals(parseSizeToMB("31Gi"), 31 * 1024);
  assertEquals(parseSizeToMB("3.2Gi"), 3.2 * 1024);
});

Deno.test("parseSizeToMB: Mi values", () => {
  assertEquals(parseSizeToMB("456Mi"), 456);
  assertEquals(parseSizeToMB("1.5Mi"), 1.5);
});

Deno.test("parseSizeToMB: Ti values", () => {
  assertEquals(parseSizeToMB("2Ti"), 2 * 1024 * 1024);
});

Deno.test("parseSizeToMB: Ki values", () => {
  assertEquals(parseSizeToMB("1024Ki"), 1);
});

Deno.test("parseSizeToMB: plain byte values", () => {
  const result = parseSizeToMB("1048576B");
  assertEquals(result, 1);
});

Deno.test("parseSizeToMB: short unit forms (G, M, K)", () => {
  assertEquals(parseSizeToMB("4G"), 4 * 1024);
  assertEquals(parseSizeToMB("512M"), 512);
  assertEquals(parseSizeToMB("2048K"), 2);
});

Deno.test("parseSizeToMB: returns null for unparseable", () => {
  assertEquals(parseSizeToMB(""), null);
  assertEquals(parseSizeToMB("abc"), null);
});

// --- Edge cases ---

Deno.test("report: step data exists but getContent returns null", async () => {
  // Steps reference data that doesn't exist in the repository
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  // No artifacts provided — getContent returns null
  const context = createContext(steps, []);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  // HTTP finding should not appear (data was null, no finding pushed for that case)
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const httpFinding = findings.find((f) => f.check === "HTTP");
  // When step exists but data is null, no HTTP finding is generated
  assertEquals(httpFinding, undefined);
});

Deno.test("report: disk with unparseable percent is skipped", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const artifacts = [
    makeArtifact("sys-diag", "disk-output", {
      filesystems: [
        {
          target: "/dev",
          usePercent: "-",
          used: "0",
          size: "0",
        },
        {
          target: "/",
          usePercent: "50%",
          used: "25G",
          size: "50G",
        },
      ],
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const findings = (result.json as Record<string, unknown>)
    .findings as Array<Record<string, unknown>>;
  const diskFinding = findings.find((f) => f.check === "Disk");
  // The unparseable /dev entry is skipped; / at 50% produces ok
  assertEquals(diskFinding?.severity, "ok");
});
