// SRE Health Check Report Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSizeToMB, report } from "./sre_health_report.ts";

// --- Test helpers ---

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: { name: string; dataId: string; version: number }[];
}

function createContext(
  stepExecutions: StepExecution[] = [],
  dataFiles: Record<string, Record<string, unknown>> = {},
) {
  const tmpDir = Deno.makeTempDirSync();
  const logs: { msg: string; props: Record<string, unknown> }[] = [];

  // Write data files to temp dir
  for (const [path, data] of Object.entries(dataFiles)) {
    const fullPath = `${tmpDir}/.swamp/data/${path}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(fullPath, JSON.stringify(data));
  }

  return {
    context: {
      workflowId: "test-wf-id",
      workflowRunId: "test-run-id",
      workflowName: "@webframp/sre-health-check",
      workflowStatus: "succeeded",
      stepExecutions,
      repoDir: tmpDir,
      logger: {
        info: (msg: string, props: Record<string, unknown>) => {
          logs.push({ msg, props });
        },
      },
    },
    logs,
    cleanup: () => {
      try {
        Deno.removeSync(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    },
  };
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
  };
}

function dataPath(modelName: string, _methodName: string, dataName: string) {
  const modelType = modelName === "net-probe"
    ? "@webframp/network"
    : "@webframp/system";
  const modelId = `${modelName}-id`;
  return `${modelType}/${modelId}/${dataName}/1/raw`;
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
  const { context, cleanup } = createContext();
  try {
    const result = await report.execute(context);
    assertStringIncludes(result.markdown, "DEGRADED");
    assertStringIncludes(result.markdown, "No HTTP check data available");
    assertStringIncludes(
      result.markdown,
      "No certificate check data available",
    );
    assertStringIncludes(result.markdown, "No DNS check data available");
    const json = result.json as Record<string, unknown>;
    assertEquals(json.overallStatus, "DEGRADED");
  } finally {
    cleanup();
  }
});

// --- HTTP check scenarios ---

Deno.test("report: HTTP 200 produces ok finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: null,
      statusCode: 200,
      timingMs: 150,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const httpFinding = findings.find((f) => f.check === "HTTP");
    assertEquals(httpFinding?.severity, "ok");
    assertStringIncludes(httpFinding?.message as string, "200");
  } finally {
    cleanup();
  }
});

Deno.test("report: HTTP 500 produces critical finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: null,
      statusCode: 503,
      timingMs: 50,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const httpFinding = findings.find((f) => f.check === "HTTP");
    assertEquals(httpFinding?.severity, "critical");
    assertStringIncludes(httpFinding?.message as string, "503");
  } finally {
    cleanup();
  }
});

Deno.test("report: HTTP 404 produces warn finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: null,
      statusCode: 404,
      timingMs: 30,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const httpFinding = findings.find((f) => f.check === "HTTP");
    assertEquals(httpFinding?.severity, "warn");
  } finally {
    cleanup();
  }
});

Deno.test("report: HTTP error produces critical finding", async () => {
  const steps = [makeStep("net-probe", "http_check", "http-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: "Connection refused",
      statusCode: 0,
      timingMs: 0,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const httpFinding = findings.find((f) => f.check === "HTTP");
    assertEquals(httpFinding?.severity, "critical");
    assertStringIncludes(httpFinding?.message as string, "Connection refused");
  } finally {
    cleanup();
  }
});

// --- TLS Certificate scenarios ---

Deno.test("report: cert valid for 90 days produces ok finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "cert_check", "cert-output")]: {
      error: null,
      daysUntilExpiry: 90,
      subject: "CN=example.com",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const certFinding = findings.find((f) => f.check === "TLS Certificate");
    assertEquals(certFinding?.severity, "ok");
    assertStringIncludes(certFinding?.message as string, "90 days");
  } finally {
    cleanup();
  }
});

Deno.test("report: cert expiring in 15 days produces warn finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "cert_check", "cert-output")]: {
      error: null,
      daysUntilExpiry: 15,
      subject: "CN=example.com",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const certFinding = findings.find((f) => f.check === "TLS Certificate");
    assertEquals(certFinding?.severity, "warn");
  } finally {
    cleanup();
  }
});

Deno.test("report: cert expiring in 3 days produces critical finding", async () => {
  const steps = [makeStep("net-probe", "cert_check", "cert-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "cert_check", "cert-output")]: {
      error: null,
      daysUntilExpiry: 3,
      subject: "CN=example.com",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const certFinding = findings.find((f) => f.check === "TLS Certificate");
    assertEquals(certFinding?.severity, "critical");
    assertStringIncludes(result.markdown, "Renew TLS certificate immediately");
  } finally {
    cleanup();
  }
});

// --- DNS scenarios ---

Deno.test("report: DNS resolves produces ok finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "dns_lookup", "dns-output")]: {
      status: "NOERROR",
      records: [{ data: "93.184.216.34" }, { data: "93.184.216.35" }],
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const dnsFinding = findings.find((f) => f.check === "DNS");
    assertEquals(dnsFinding?.severity, "ok");
    assertStringIncludes(dnsFinding?.message as string, "2 record(s)");
  } finally {
    cleanup();
  }
});

Deno.test("report: DNS NXDOMAIN produces critical finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "dns_lookup", "dns-output")]: {
      status: "NXDOMAIN",
      records: [],
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const dnsFinding = findings.find((f) => f.check === "DNS");
    assertEquals(dnsFinding?.severity, "critical");
  } finally {
    cleanup();
  }
});

// --- Disk scenarios ---

Deno.test("report: disk at 95% produces critical finding", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_disk_usage", "disk-output")]: {
      filesystems: [{
        target: "/",
        usePercent: "95%",
        used: "47G",
        size: "50G",
      }],
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const diskFinding = findings.find((f) => f.check === "Disk");
    assertEquals(diskFinding?.severity, "critical");
    assertStringIncludes(diskFinding?.message as string, "95%");
  } finally {
    cleanup();
  }
});

Deno.test("report: disk at 50% produces ok finding", async () => {
  const steps = [makeStep("sys-diag", "get_disk_usage", "disk-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_disk_usage", "disk-output")]: {
      filesystems: [{
        target: "/",
        usePercent: "50%",
        used: "25G",
        size: "50G",
      }],
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const diskFinding = findings.find((f) => f.check === "Disk");
    assertEquals(diskFinding?.severity, "ok");
  } finally {
    cleanup();
  }
});

// --- Load scenarios ---

Deno.test("report: high load produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_uptime", "uptime-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_uptime", "uptime-output")]: {
      loadAverage1m: "8.5",
      loadAverage5m: "6.2",
      loadAverage15m: "4.1",
      uptimeString: "up 5 days",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const loadFinding = findings.find((f) => f.check === "Load");
    assertEquals(loadFinding?.severity, "warn");
    assertStringIncludes(
      result.markdown,
      "Investigate high system load",
    );
  } finally {
    cleanup();
  }
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
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: null,
      statusCode: 200,
      timingMs: 100,
    },
    [dataPath("net-probe", "cert_check", "cert-output")]: {
      error: null,
      daysUntilExpiry: 365,
      subject: "CN=example.com",
    },
    [dataPath("net-probe", "dns_lookup", "dns-output")]: {
      status: "NOERROR",
      records: [{ data: "93.184.216.34" }],
    },
    [dataPath("net-probe", "port_check", "port-output")]: {
      openPorts: [80, 443],
      closedPorts: [],
    },
    [dataPath("sys-diag", "get_disk_usage", "disk-output")]: {
      filesystems: [{
        target: "/",
        usePercent: "40%",
        used: "20G",
        size: "50G",
      }],
    },
    [dataPath("sys-diag", "get_memory", "mem-output")]: {
      mem: { used: "4Gi", total: "16Gi", available: "12Gi" },
      swap: { total: "8Gi", used: "100Mi", free: "7.9Gi" },
    },
    [dataPath("sys-diag", "get_uptime", "uptime-output")]: {
      loadAverage1m: "0.5",
      loadAverage5m: "0.3",
      loadAverage15m: "0.2",
      uptimeString: "up 10 days",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    assertStringIncludes(result.markdown, "[HEALTHY] HEALTHY");
    const json = result.json as Record<string, unknown>;
    assertEquals(json.overallStatus, "HEALTHY");
    // No recommendations section when everything is healthy
    assertEquals(
      (json.recommendations as string[]).length,
      0,
    );
  } finally {
    cleanup();
  }
});

Deno.test("report: critical finding produces CRITICAL overall status", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
  ];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: "Connection timeout",
      statusCode: 0,
      timingMs: 0,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    assertStringIncludes(result.markdown, "CRITICAL");
    const json = result.json as Record<string, unknown>;
    assertEquals(json.overallStatus, "CRITICAL");
    assertStringIncludes(result.markdown, "## Recommendations");
    assertStringIncludes(result.markdown, "Investigate endpoint availability");
  } finally {
    cleanup();
  }
});

// --- Markdown structure ---

Deno.test("report markdown contains all expected sections", async () => {
  const steps = [
    makeStep("net-probe", "http_check", "http-output"),
    makeStep("net-probe", "cert_check", "cert-output"),
  ];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "http_check", "http-output")]: {
      error: null,
      statusCode: 200,
      timingMs: 100,
    },
    [dataPath("net-probe", "cert_check", "cert-output")]: {
      error: null,
      daysUntilExpiry: 15,
      subject: "CN=example.com",
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    assertStringIncludes(result.markdown, "# SRE Health Check Report");
    assertStringIncludes(result.markdown, "**Status:**");
    assertStringIncludes(result.markdown, "**Timestamp:**");
    assertStringIncludes(result.markdown, "**Checks:**");
    assertStringIncludes(result.markdown, "## All Checks");
    assertStringIncludes(result.markdown, "| Check | Status | Detail |");
  } finally {
    cleanup();
  }
});

// --- Logger ---

Deno.test("report logs summary", async () => {
  const { context, logs, cleanup } = createContext();
  try {
    await report.execute(context);
    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0].msg, "SRE health report");
  } finally {
    cleanup();
  }
});

// --- findStepData skips report handles ---

// --- parseSizeToMB ---

Deno.test("parseSizeToMB: Gi values", () => {
  assertEquals(parseSizeToMB("31Gi"), 31 * 1024);
  assertEquals(parseSizeToMB("3.2Gi"), 3.2 * 1024);
});

Deno.test("parseSizeToMB: Mi values", () => {
  assertEquals(parseSizeToMB("456Mi"), 456);
  assertEquals(parseSizeToMB("1.5Mi"), 1.5);
});

Deno.test("parseSizeToMB: returns null for unparseable", () => {
  assertEquals(parseSizeToMB(""), null);
  assertEquals(parseSizeToMB("abc"), null);
});

// --- DNS tool failure ---

Deno.test("report: DNS COMMAND_FAILED produces error (not critical) finding", async () => {
  const steps = [makeStep("net-probe", "dns_lookup", "dns-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("net-probe", "dns_lookup", "dns-output")]: {
      status: "COMMAND_FAILED",
      records: [],
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const dnsFinding = findings.find((f) => f.check === "DNS");
    assertEquals(dnsFinding?.severity, "error");
    assertStringIncludes(
      dnsFinding?.message as string,
      "dig not installed",
    );
  } finally {
    cleanup();
  }
});

// --- Memory threshold scenarios ---

Deno.test("report: memory at 90% produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_memory", "mem-output")]: {
      mem: { total: "16Gi", used: "14.4Gi", free: "0.4Gi", available: "1.6Gi" },
      swap: { total: "0B", used: "0B", free: "0B" },
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const memFinding = findings.find((f) => f.check === "Memory");
    assertEquals(memFinding?.severity, "warn");
  } finally {
    cleanup();
  }
});

Deno.test("report: memory at 96% produces critical finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_memory", "mem-output")]: {
      mem: { total: "16Gi", used: "15.4Gi", free: "0.1Gi", available: "0.6Gi" },
      swap: { total: "0B", used: "0B", free: "0B" },
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const memFinding = findings.find((f) => f.check === "Memory");
    assertEquals(memFinding?.severity, "critical");
    assertStringIncludes(result.markdown, "Investigate memory pressure");
  } finally {
    cleanup();
  }
});

Deno.test("report: low memory usage produces ok finding with percentage", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_memory", "mem-output")]: {
      mem: { total: "16Gi", used: "4Gi", free: "8Gi", available: "12Gi" },
      swap: { total: "8Gi", used: "100Mi", free: "7.9Gi" },
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const memFinding = findings.find((f) => f.check === "Memory");
    assertEquals(memFinding?.severity, "ok");
    assertStringIncludes(memFinding?.message as string, "(25%)");
    // Low swap usage should not produce a finding
    const swapFinding = findings.find((f) => f.check === "Swap");
    assertEquals(swapFinding, undefined);
  } finally {
    cleanup();
  }
});

// --- Swap scenarios ---

Deno.test("report: high swap usage produces warn finding", async () => {
  const steps = [makeStep("sys-diag", "get_memory", "mem-output")];
  const data: Record<string, Record<string, unknown>> = {
    [dataPath("sys-diag", "get_memory", "mem-output")]: {
      mem: { total: "16Gi", used: "4Gi", free: "8Gi", available: "12Gi" },
      swap: { total: "8Gi", used: "5Gi", free: "3Gi" },
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const swapFinding = findings.find((f) => f.check === "Swap");
    assertEquals(swapFinding?.severity, "warn");
    assertStringIncludes(
      result.markdown,
      "swap usage indicates memory pressure",
    );
  } finally {
    cleanup();
  }
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
  }];
  const data: Record<string, Record<string, unknown>> = {
    ["@webframp/network/net-probe-id/http-output/1/raw"]: {
      error: null,
      statusCode: 200,
      timingMs: 50,
    },
  };
  const { context, cleanup } = createContext(steps, data);
  try {
    const result = await report.execute(context);
    const findings = (result.json as Record<string, unknown>)
      .findings as Array<Record<string, unknown>>;
    const httpFinding = findings.find((f) => f.check === "HTTP");
    assertEquals(httpFinding?.severity, "ok");
  } finally {
    cleanup();
  }
});
