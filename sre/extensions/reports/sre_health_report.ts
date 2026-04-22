/**
 * SRE Health Check Report
 *
 * Aggregates network probe and system health data produced by the
 * `@webframp/sre-health-check` workflow into a unified health report.
 * Each check is assigned a severity (ok, warn, critical, error) and
 * the report derives an overall status with actionable recommendations.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
}

interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  dataRepository: DataRepository;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

// Thresholds for health assessment
const CERT_EXPIRY_WARN_DAYS = 30;
const CERT_EXPIRY_CRITICAL_DAYS = 7;
const DISK_WARN_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 90;
const MEMORY_WARN_PERCENT = 80;
const MEMORY_CRITICAL_PERCENT = 95;
const SWAP_WARN_PERCENT = 50;
const LOAD_WARN_ABSOLUTE = 4.0;

// DNS status values that indicate the dig command itself failed (tool not installed, etc.)
// vs actual DNS resolution failures (NXDOMAIN, SERVFAIL, REFUSED)
const DNS_TOOL_FAILURE_STATUSES = ["COMMAND_FAILED"];

/**
 * Parse a human-readable size string (e.g., "3.2Gi", "456Mi", "27Gi") into
 * megabytes for comparison. Supports binary (Ki, Mi, Gi, Ti) and decimal
 * (K, M, G, T) suffixes. Returns `null` if the input cannot be parsed.
 */
export function parseSizeToMB(size: string): number | null {
  const match = size.match(/^([\d.]+)\s*(B|Ki|Mi|Gi|Ti|K|M|G|T)?/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return null;
  const unit = (match[2] ?? "B").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1 / (1024 * 1024),
    ki: 1 / 1024,
    k: 1 / 1024,
    mi: 1,
    m: 1,
    gi: 1024,
    g: 1024,
    ti: 1024 * 1024,
    t: 1024 * 1024,
  };
  const mult = multipliers[unit];
  return mult !== undefined ? value * mult : null;
}

type Severity = "ok" | "warn" | "critical" | "error";

interface Finding {
  check: string;
  severity: Severity;
  message: string;
  detail?: string;
}

/**
 * Workflow-scoped report that processes step execution data from the
 * SRE health check workflow and produces a Markdown summary with a
 * structured JSON payload of all findings and recommendations.
 */
export const report = {
  name: "@webframp/sre-health-report",
  description:
    "Aggregates network probe and system health data into an SRE health check report with actionable findings",
  scope: "workflow" as const,
  labels: ["sre", "ops", "health-check"],

  execute: async (context: WorkflowReportContext) => {
    const findings: Finding[] = [];
    const jsonData: Record<string, unknown> = {
      workflowName: context.workflowName,
      workflowStatus: context.workflowStatus,
      timestamp: new Date().toISOString(),
    };

    // --- Data access helpers ---

    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      const repo = context.dataRepository;
      // First try string-based getContent (works with mock test context).
      // If the real runtime rejects it (type.toDirectoryPath is not a function),
      // retry with a type-like object that satisfies the internal API.
      try {
        const raw = await repo.getContent(
          modelType,
          modelId,
          dataName,
          version,
        );
        if (raw) return JSON.parse(new TextDecoder().decode(raw));
      } catch {
        try {
          const typeArg = {
            raw: modelType,
            toDirectoryPath: () => modelType,
            toString: () => modelType,
          };
          const raw = await repo.getContent(
            typeArg,
            modelId,
            dataName,
            version,
          );
          if (raw) return JSON.parse(new TextDecoder().decode(raw));
        } catch {
          // both approaches failed
        }
      }
      return null;
    }

    function findStepData(
      modelName: string,
      methodName: string,
    ): {
      modelType: string;
      modelId: string;
      dataName: string;
      version: number;
    } | null {
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName && step.methodName === methodName) {
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              return {
                modelType: step.modelType,
                modelId: step.modelId,
                dataName: handle.name,
                version: handle.version,
              };
            }
          }
        }
      }
      return null;
    }

    // --- HTTP Check ---

    const httpLoc = findStepData("net-probe", "http_check");
    if (httpLoc) {
      const data = await getData(
        httpLoc.modelType,
        httpLoc.modelId,
        httpLoc.dataName,
        httpLoc.version,
      );
      if (data) {
        jsonData.httpCheck = data;
        const error = data.error as string | null;
        const statusCode = data.statusCode as number;
        const timingMs = data.timingMs as number;

        if (error) {
          findings.push({
            check: "HTTP",
            severity: "critical",
            message: `Endpoint unreachable: ${error}`,
          });
        } else if (statusCode >= 500) {
          findings.push({
            check: "HTTP",
            severity: "critical",
            message: `Server error: HTTP ${statusCode}`,
            detail: `Response time: ${timingMs}ms`,
          });
        } else if (statusCode >= 400) {
          findings.push({
            check: "HTTP",
            severity: "warn",
            message: `Client error: HTTP ${statusCode}`,
            detail: `Response time: ${timingMs}ms`,
          });
        } else {
          findings.push({
            check: "HTTP",
            severity: "ok",
            message: `HTTP ${statusCode} in ${timingMs}ms`,
          });
        }
      }
    } else {
      findings.push({
        check: "HTTP",
        severity: "error",
        message: "No HTTP check data available",
      });
    }

    // --- TLS Certificate Check ---

    const certLoc = findStepData("net-probe", "cert_check");
    if (certLoc) {
      const data = await getData(
        certLoc.modelType,
        certLoc.modelId,
        certLoc.dataName,
        certLoc.version,
      );
      if (data) {
        jsonData.certCheck = data;
        const error = data.error as string | null;
        const days = data.daysUntilExpiry as number | null;
        const subject = data.subject as string | null;

        if (error) {
          findings.push({
            check: "TLS Certificate",
            severity: "critical",
            message: `Certificate check failed: ${error}`,
          });
        } else if (days !== null && days <= CERT_EXPIRY_CRITICAL_DAYS) {
          findings.push({
            check: "TLS Certificate",
            severity: "critical",
            message: `Certificate expires in ${days} days`,
            detail: subject ?? undefined,
          });
        } else if (days !== null && days <= CERT_EXPIRY_WARN_DAYS) {
          findings.push({
            check: "TLS Certificate",
            severity: "warn",
            message: `Certificate expires in ${days} days`,
            detail: subject ?? undefined,
          });
        } else {
          findings.push({
            check: "TLS Certificate",
            severity: "ok",
            message: days !== null
              ? `Valid for ${days} days`
              : "Certificate present",
            detail: subject ?? undefined,
          });
        }
      }
    } else {
      findings.push({
        check: "TLS Certificate",
        severity: "error",
        message: "No certificate check data available",
      });
    }

    // --- DNS Check ---

    const dnsLoc = findStepData("net-probe", "dns_lookup");
    if (dnsLoc) {
      const data = await getData(
        dnsLoc.modelType,
        dnsLoc.modelId,
        dnsLoc.dataName,
        dnsLoc.version,
      );
      if (data) {
        jsonData.dnsCheck = data;
        const status = data.status as string;
        const records = data.records as Array<Record<string, unknown>>;

        if (DNS_TOOL_FAILURE_STATUSES.includes(status)) {
          findings.push({
            check: "DNS",
            severity: "error",
            message:
              "DNS probe unavailable (dig not installed or not executable)",
          });
        } else if (status === "NOERROR" && records.length > 0) {
          findings.push({
            check: "DNS",
            severity: "ok",
            message: `Resolves to ${records.length} record(s): ${
              records.map((r) => r.data).join(", ")
            }`,
          });
        } else if (status === "NOERROR" && records.length === 0) {
          findings.push({
            check: "DNS",
            severity: "warn",
            message: "DNS query succeeded but returned no records",
          });
        } else {
          findings.push({
            check: "DNS",
            severity: "critical",
            message: `DNS resolution failed: ${status}`,
          });
        }
      }
    } else {
      findings.push({
        check: "DNS",
        severity: "error",
        message: "No DNS check data available",
      });
    }

    // --- Port Check ---

    const portLoc = findStepData("net-probe", "port_check");
    if (portLoc) {
      const data = await getData(
        portLoc.modelType,
        portLoc.modelId,
        portLoc.dataName,
        portLoc.version,
      );
      if (data) {
        jsonData.portCheck = data;
        const openPorts = data.openPorts as number[];
        const closedPorts = data.closedPorts as number[];

        if (closedPorts.length > 0) {
          findings.push({
            check: "Ports",
            severity: "warn",
            message: `${closedPorts.length} port(s) closed: ${
              closedPorts.join(", ")
            }`,
            detail: openPorts.length > 0
              ? `Open: ${openPorts.join(", ")}`
              : undefined,
          });
        } else if (openPorts.length > 0) {
          findings.push({
            check: "Ports",
            severity: "ok",
            message: `All ${openPorts.length} port(s) open: ${
              openPorts.join(", ")
            }`,
          });
        }
      }
    }

    // --- Disk Usage ---

    const diskLoc = findStepData("sys-diag", "get_disk_usage");
    if (diskLoc) {
      const data = await getData(
        diskLoc.modelType,
        diskLoc.modelId,
        diskLoc.dataName,
        diskLoc.version,
      );
      if (data) {
        jsonData.diskUsage = data;
        const filesystems = data.filesystems as Array<
          Record<string, unknown>
        >;

        for (const fs of filesystems) {
          const target = fs.target as string;
          const percentStr = fs.usePercent as string;
          const percent = parseInt(percentStr.replace("%", ""), 10);

          if (isNaN(percent)) continue;

          if (percent >= DISK_CRITICAL_PERCENT) {
            findings.push({
              check: "Disk",
              severity: "critical",
              message: `${target} at ${percent}% capacity`,
              detail: `${fs.used} of ${fs.size} used`,
            });
          } else if (percent >= DISK_WARN_PERCENT) {
            findings.push({
              check: "Disk",
              severity: "warn",
              message: `${target} at ${percent}% capacity`,
              detail: `${fs.used} of ${fs.size} used`,
            });
          }
        }

        // If no disk findings, all is well
        const hasDiskFinding = findings.some((f) => f.check === "Disk");
        if (!hasDiskFinding) {
          findings.push({
            check: "Disk",
            severity: "ok",
            message:
              `All ${filesystems.length} filesystem(s) below ${DISK_WARN_PERCENT}%`,
          });
        }
      }
    }

    // --- Memory ---

    const memLoc = findStepData("sys-diag", "get_memory");
    if (memLoc) {
      const data = await getData(
        memLoc.modelType,
        memLoc.modelId,
        memLoc.dataName,
        memLoc.version,
      );
      if (data) {
        jsonData.memory = data;
        const mem = data.mem as Record<string, string>;
        const totalMB = parseSizeToMB(mem.total);
        const usedMB = parseSizeToMB(mem.used);
        const usedPercent = totalMB && usedMB
          ? Math.round((usedMB / totalMB) * 100)
          : null;

        let memSeverity: Severity = "ok";
        if (usedPercent !== null && usedPercent >= MEMORY_CRITICAL_PERCENT) {
          memSeverity = "critical";
        } else if (
          usedPercent !== null && usedPercent >= MEMORY_WARN_PERCENT
        ) {
          memSeverity = "warn";
        }

        const pctStr = usedPercent !== null ? ` (${usedPercent}%)` : "";
        findings.push({
          check: "Memory",
          severity: memSeverity,
          message:
            `${mem.used} used of ${mem.total} total${pctStr}, ${mem.available} available`,
        });

        // Swap check
        const swap = data.swap as Record<string, string> | undefined;
        if (swap && swap.total && swap.total !== "0B") {
          const swapTotalMB = parseSizeToMB(swap.total);
          const swapUsedMB = parseSizeToMB(swap.used);
          const swapPercent = swapTotalMB && swapUsedMB
            ? Math.round((swapUsedMB / swapTotalMB) * 100)
            : null;

          if (swapPercent !== null && swapPercent >= SWAP_WARN_PERCENT) {
            findings.push({
              check: "Swap",
              severity: "warn",
              message: `${swap.used} used of ${swap.total} (${swapPercent}%)`,
            });
          }
        }
      }
    }

    // --- Load Averages ---

    const loadLoc = findStepData("sys-diag", "get_uptime");
    if (loadLoc) {
      const data = await getData(
        loadLoc.modelType,
        loadLoc.modelId,
        loadLoc.dataName,
        loadLoc.version,
      );
      if (data) {
        jsonData.uptime = data;
        const load1m = parseFloat(data.loadAverage1m as string);
        const load5m = parseFloat(data.loadAverage5m as string);
        const load15m = parseFloat(data.loadAverage15m as string);

        if (!isNaN(load1m)) {
          const severity: Severity = load1m >= LOAD_WARN_ABSOLUTE
            ? "warn"
            : "ok";
          findings.push({
            check: "Load",
            severity,
            message:
              `Load averages: ${load1m} (1m), ${load5m} (5m), ${load15m} (15m)`,
            detail: data.uptimeString as string,
          });
        }
      }
    }

    // --- Build Markdown Report ---

    const criticals = findings.filter((f) => f.severity === "critical");
    const warnings = findings.filter((f) => f.severity === "warn");
    const errors = findings.filter((f) => f.severity === "error");
    const oks = findings.filter((f) => f.severity === "ok");

    const overallStatus = criticals.length > 0
      ? "CRITICAL"
      : warnings.length > 0
      ? "WARNING"
      : errors.length > 0
      ? "DEGRADED"
      : "HEALTHY";

    const statusEmoji = {
      CRITICAL: "[CRITICAL]",
      WARNING: "[WARNING]",
      DEGRADED: "[DEGRADED]",
      HEALTHY: "[HEALTHY]",
    }[overallStatus];

    const lines: string[] = [];
    lines.push(`# SRE Health Check Report`);
    lines.push("");
    lines.push(`**Status:** ${statusEmoji} ${overallStatus}`);
    lines.push(`**Timestamp:** ${new Date().toISOString()}`);
    lines.push(
      `**Checks:** ${findings.length} total | ${criticals.length} critical | ${warnings.length} warning | ${oks.length} ok`,
    );
    lines.push("");

    if (criticals.length > 0) {
      lines.push("## Critical Issues");
      lines.push("");
      for (const f of criticals) {
        lines.push(`- **${f.check}**: ${f.message}`);
        if (f.detail) lines.push(`  - ${f.detail}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push("## Warnings");
      lines.push("");
      for (const f of warnings) {
        lines.push(`- **${f.check}**: ${f.message}`);
        if (f.detail) lines.push(`  - ${f.detail}`);
      }
      lines.push("");
    }

    if (errors.length > 0) {
      lines.push("## Probe Errors");
      lines.push("");
      for (const f of errors) {
        lines.push(`- **${f.check}**: ${f.message}`);
      }
      lines.push("");
    }

    lines.push("## All Checks");
    lines.push("");
    lines.push("| Check | Status | Detail |");
    lines.push("|-------|--------|--------|");
    for (const f of findings) {
      const badge = { ok: "OK", warn: "WARN", critical: "CRIT", error: "ERR" }[
        f.severity
      ];
      lines.push(`| ${f.check} | ${badge} | ${f.message} |`);
    }
    lines.push("");

    // --- Recommendations ---

    const recommendations: string[] = [];

    for (const f of criticals) {
      if (f.check === "TLS Certificate") {
        recommendations.push("Renew TLS certificate immediately");
      }
      if (f.check === "HTTP") {
        recommendations.push(
          "Investigate endpoint availability — check service health and upstream dependencies",
        );
      }
      if (f.check === "DNS") {
        recommendations.push(
          "Verify DNS configuration and nameserver health",
        );
      }
      if (f.check === "Disk") {
        recommendations.push(
          `Free disk space on ${
            f.detail?.split(" of ")[0] ?? "affected"
          } filesystem — clean logs, temp files, or expand volume`,
        );
      }
      if (f.check === "Memory") {
        recommendations.push(
          "Investigate memory pressure — identify high-memory processes and consider adding RAM",
        );
      }
    }

    for (const f of warnings) {
      if (f.check === "TLS Certificate") {
        recommendations.push(
          "Schedule TLS certificate renewal within the next 30 days",
        );
      }
      if (f.check === "Ports") {
        recommendations.push(
          `Verify closed ports are expected: ${f.message}`,
        );
      }
      if (f.check === "Disk") {
        recommendations.push(
          `Monitor disk usage on ${
            f.message.split(" at ")[0]
          } — approaching capacity`,
        );
      }
      if (f.check === "Load") {
        recommendations.push(
          "Investigate high system load — check for runaway processes or increased traffic",
        );
      }
      if (f.check === "Memory") {
        recommendations.push(
          "Monitor memory usage — approaching capacity",
        );
      }
      if (f.check === "Swap") {
        recommendations.push(
          "High swap usage indicates memory pressure — investigate and consider adding RAM",
        );
      }
    }

    if (recommendations.length > 0) {
      lines.push("## Recommendations");
      lines.push("");
      for (let i = 0; i < recommendations.length; i++) {
        lines.push(`${i + 1}. ${recommendations[i]}`);
      }
      lines.push("");
    }

    jsonData.findings = findings;
    jsonData.overallStatus = overallStatus;
    jsonData.recommendations = recommendations;

    context.logger.info(
      "SRE health report: {status}, {critical} critical, {warn} warnings",
      {
        status: overallStatus,
        critical: criticals.length,
        warn: warnings.length,
      },
    );

    return {
      markdown: lines.join("\n"),
      json: jsonData,
    };
  },
};
