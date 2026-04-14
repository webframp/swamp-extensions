// Cloudflare Audit Report
// SPDX-License-Identifier: Apache-2.0

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

type Severity = "ok" | "warn" | "critical" | "error";

interface Finding {
  check: string;
  severity: Severity;
  message: string;
  detail?: string;
}

// Thresholds
export const CACHE_HIT_RATE_WARN = 50;

// Known subdomain takeover targets
export const DANGLING_CNAME_PATTERNS: RegExp[] = [
  /\.herokuapp\.com$/i,
  /\.herokudns\.com$/i,
  /\.s3\.amazonaws\.com$/i,
  /\.s3-website[^.]*\.amazonaws\.com$/i,
  /\.cloudfront\.net$/i,
  /\.azurewebsites\.net$/i,
  /\.blob\.core\.windows\.net$/i,
  /\.trafficmanager\.net$/i,
  /\.cloudapp\.net$/i,
  /\.github\.io$/i,
  /\.shopify\.com$/i,
  /\.pantheonsite\.io$/i,
  /\.ghost\.io$/i,
  /\.netlify\.app$/i,
  /\.fly\.dev$/i,
  /\.vercel\.app$/i,
];

// deno-lint-ignore no-explicit-any
type AnyRecord = Record<string, any>;

export function checkZone(
  zoneListData: AnyRecord[] | null,
  settingsData: AnyRecord | null,
): Finding[] {
  const findings: Finding[] = [];

  if (!zoneListData && !settingsData) {
    findings.push({
      check: "Zone",
      severity: "error",
      message: "No zone data available",
    });
    return findings;
  }

  if (zoneListData) {
    for (const zone of zoneListData) {
      const name = zone.name ?? "unknown";

      if (zone.paused) {
        findings.push({
          check: "Zone",
          severity: "critical",
          message: `Zone "${name}" is paused`,
        });
      }

      if (zone.status !== "active") {
        findings.push({
          check: "Zone",
          severity: "warn",
          message: `Zone "${name}" status is "${zone.status}"`,
        });
      }
    }
  }

  if (settingsData) {
    const ssl = settingsData.ssl;
    if (ssl === "off") {
      findings.push({
        check: "Zone",
        severity: "critical",
        message: "SSL is disabled",
      });
    } else if (ssl === "flexible") {
      findings.push({
        check: "Zone",
        severity: "warn",
        message:
          'SSL mode is "flexible" — traffic between Cloudflare and origin is unencrypted',
      });
    } else if (ssl === "full" || ssl === "strict") {
      findings.push({
        check: "Zone",
        severity: "ok",
        message: `SSL mode is "${ssl}"`,
      });
    }

    const alwaysHttps = settingsData.always_use_https;
    if (alwaysHttps === "off") {
      findings.push({
        check: "Zone",
        severity: "warn",
        message: "Always Use HTTPS is disabled",
      });
    } else if (alwaysHttps === "on") {
      findings.push({
        check: "Zone",
        severity: "ok",
        message: "Always Use HTTPS is enabled",
      });
    }

    const devMode = settingsData.development_mode;
    if (devMode !== undefined && devMode !== 0 && devMode !== "off") {
      findings.push({
        check: "Zone",
        severity: "critical",
        message:
          "Development mode is active — caching is bypassed and performance is degraded",
      });
    }
  }

  return findings;
}

export function checkWaf(
  rulesData: AnyRecord[] | null,
  packagesData: AnyRecord[] | null,
  _eventsData: AnyRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];

  if (rulesData === null) {
    findings.push({
      check: "WAF",
      severity: "error",
      message: "No WAF rules data available",
    });
    return findings;
  }

  if (rulesData.length === 0) {
    findings.push({
      check: "WAF",
      severity: "warn",
      message: "No WAF rules configured",
    });
  } else {
    const paused = rulesData.filter((r) => r.paused === true);
    if (paused.length === rulesData.length) {
      findings.push({
        check: "WAF",
        severity: "warn",
        message: "All WAF rules are paused",
      });
    } else {
      findings.push({
        check: "WAF",
        severity: "ok",
        message: `${
          rulesData.length - paused.length
        } of ${rulesData.length} WAF rules active`,
      });
    }

    for (const rule of paused) {
      findings.push({
        check: "WAF",
        severity: "warn",
        message: `WAF rule paused: ${rule.description ?? rule.id ?? "unknown"}`,
      });
    }
  }

  if (packagesData !== null) {
    if (packagesData.length === 0) {
      findings.push({
        check: "WAF",
        severity: "warn",
        message: "No WAF packages available",
      });
    } else {
      findings.push({
        check: "WAF",
        severity: "ok",
        message: `${packagesData.length} WAF package(s) available`,
      });
    }
  }

  return findings;
}

export function checkDns(recordsData: AnyRecord[] | null): Finding[] {
  const findings: Finding[] = [];

  if (recordsData === null) {
    findings.push({
      check: "DNS",
      severity: "error",
      message: "No DNS record data available",
    });
    return findings;
  }

  // Check for unproxied proxyable records
  const proxyableTypes = ["A", "AAAA", "CNAME"];
  const unproxied = recordsData.filter(
    (r) => proxyableTypes.includes(r.type) && r.proxied === false,
  );

  if (unproxied.length > 0) {
    const displayNames = unproxied.slice(0, 5).map((r) => r.name);
    const suffix = unproxied.length > 5 ? ` +${unproxied.length - 5} more` : "";
    findings.push({
      check: "DNS",
      severity: "warn",
      message: `${unproxied.length} unproxied record(s): ${
        displayNames.join(", ")
      }${suffix}`,
    });
  } else {
    const proxyable = recordsData.filter((r) =>
      proxyableTypes.includes(r.type)
    );
    if (proxyable.length > 0) {
      findings.push({
        check: "DNS",
        severity: "ok",
        message: "All proxyable records are proxied",
      });
    }
  }

  // Check for dangling CNAMEs
  const cnameRecords = recordsData.filter((r) => r.type === "CNAME");
  for (const record of cnameRecords) {
    const content = record.content as string;
    if (content) {
      for (const pattern of DANGLING_CNAME_PATTERNS) {
        if (pattern.test(content)) {
          findings.push({
            check: "DNS",
            severity: "critical",
            message:
              `Potential subdomain takeover: "${record.name}" points to "${content}"`,
          });
          break;
        }
      }
    }
  }

  // Check for CAA records
  const caaRecords = recordsData.filter((r) => r.type === "CAA");
  if (caaRecords.length === 0) {
    findings.push({
      check: "DNS",
      severity: "warn",
      message: "No CAA records found — any CA can issue certificates",
    });
  } else {
    findings.push({
      check: "DNS",
      severity: "ok",
      message: `${caaRecords.length} CAA record(s) present`,
    });
  }

  return findings;
}

export function checkWorkers(
  scriptsData: AnyRecord[] | null,
  routesData: AnyRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];

  if (scriptsData === null) {
    return findings;
  }

  if (scriptsData.length === 0) {
    return findings;
  }

  const routedScripts = new Set<string>();
  if (routesData) {
    for (const route of routesData) {
      if (route.script) {
        routedScripts.add(route.script);
      }
    }
  }

  const orphaned = scriptsData.filter((s) => !routedScripts.has(s.id));
  if (orphaned.length > 0) {
    for (const script of orphaned) {
      findings.push({
        check: "Workers",
        severity: "warn",
        message: `Orphaned worker script: "${script.id}" has no route`,
      });
    }
  } else {
    findings.push({
      check: "Workers",
      severity: "ok",
      message: `All ${scriptsData.length} worker script(s) have routes`,
    });
  }

  return findings;
}

export function checkCache(
  settingsData: AnyRecord | null,
  analyticsData: AnyRecord | null,
): Finding[] {
  const findings: Finding[] = [];

  if (settingsData) {
    const cacheLevel = settingsData.cacheLevel;
    if (cacheLevel === "bypass" || cacheLevel === "basic") {
      findings.push({
        check: "Cache",
        severity: "warn",
        message:
          `Cache level is "${cacheLevel}" — consider upgrading for better performance`,
      });
    } else if (cacheLevel) {
      findings.push({
        check: "Cache",
        severity: "ok",
        message: `Cache level is "${cacheLevel}"`,
      });
    }
  }

  if (analyticsData) {
    const cacheHitRate = analyticsData.cacheHitRate as number | undefined;
    if (cacheHitRate !== undefined) {
      if (cacheHitRate < CACHE_HIT_RATE_WARN) {
        findings.push({
          check: "Cache",
          severity: "warn",
          message: `Cache hit rate is ${
            cacheHitRate.toFixed(1)
          }% — below ${CACHE_HIT_RATE_WARN}% threshold`,
        });
      } else {
        findings.push({
          check: "Cache",
          severity: "ok",
          message: `Cache hit rate is ${cacheHitRate.toFixed(1)}%`,
        });
      }
    }
  }

  return findings;
}

export const report = {
  name: "@webframp/cloudflare-audit-report",
  description:
    "Analyzes Cloudflare zone configuration for security, DNS hygiene, WAF coverage, worker health, and cache performance",
  scope: "workflow" as const,
  labels: ["cloudflare", "security", "audit"],

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

    async function loadStep(
      modelName: string,
      methodName: string,
    ): Promise<Record<string, unknown> | null> {
      const loc = findStepData(modelName, methodName);
      if (!loc) return null;
      return await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
    }

    // --- Load all step data ---
    // Model instance names and method names must match the workflow YAML steps.

    const zoneListRaw = await loadStep("cf-zone", "list");
    const zoneSettingsRaw = await loadStep("cf-zone", "get_settings");
    const wafRulesRaw = await loadStep("cf-waf", "list_rules");
    const wafPackagesRaw = await loadStep("cf-waf", "list_packages");
    const wafEventsRaw = await loadStep("cf-waf", "get_security_events");
    const dnsRecordsRaw = await loadStep("cf-dns", "list");
    const workerScriptsRaw = await loadStep("cf-worker", "list_scripts");
    const workerRoutesRaw = await loadStep("cf-worker", "list_routes");
    const cacheSettingsRaw = await loadStep("cf-cache", "get_settings");
    const cacheAnalyticsRaw = await loadStep("cf-cache", "get_analytics");
    const zoneDetailRaw = await loadStep("cf-zone", "get");

    jsonData.zoneList = zoneListRaw;
    jsonData.zoneDetail = zoneDetailRaw;
    jsonData.zoneSettings = zoneSettingsRaw;
    jsonData.wafRules = wafRulesRaw;
    jsonData.wafPackages = wafPackagesRaw;
    jsonData.wafEvents = wafEventsRaw;
    jsonData.dnsRecords = dnsRecordsRaw;
    jsonData.workerScripts = workerScriptsRaw;
    jsonData.workerRoutes = workerRoutesRaw;
    jsonData.cacheSettings = cacheSettingsRaw;
    jsonData.cacheAnalytics = cacheAnalyticsRaw;

    // --- Extract arrays from model output shapes ---
    // Cloudflare models wrap arrays in objects: { zones: [...] }, { rules: [...] }, etc.
    // The settings/analytics models return flat objects.

    const zoneList = zoneListRaw
      ? (zoneListRaw.zones as AnyRecord[] ?? [])
      : null;
    const zoneSettings = zoneSettingsRaw
      ? (zoneSettingsRaw.settings as AnyRecord ?? zoneSettingsRaw)
      : null;
    const wafRules = wafRulesRaw
      ? (wafRulesRaw.rules as AnyRecord[] ?? [])
      : null;
    const wafPackages = wafPackagesRaw
      ? (wafPackagesRaw.packages as AnyRecord[] ?? [])
      : null;
    const wafEvents = wafEventsRaw
      ? (wafEventsRaw.events as AnyRecord[] ?? [])
      : null;
    const dnsRecords = dnsRecordsRaw
      ? (dnsRecordsRaw.records as AnyRecord[] ?? [])
      : null;
    const workerScripts = workerScriptsRaw
      ? (workerScriptsRaw.scripts as AnyRecord[] ?? [])
      : null;
    const workerRoutes = workerRoutesRaw
      ? (workerRoutesRaw.routes as AnyRecord[] ?? [])
      : null;
    const cacheSettings = cacheSettingsRaw as AnyRecord | null;
    const cacheAnalytics = cacheAnalyticsRaw
      ? (cacheAnalyticsRaw.requests as AnyRecord ?? null)
      : null;

    findings.push(...checkZone(zoneList, zoneSettings));
    findings.push(...checkWaf(wafRules, wafPackages, wafEvents));
    findings.push(...checkDns(dnsRecords));
    findings.push(...checkWorkers(workerScripts, workerRoutes));
    findings.push(...checkCache(cacheSettings, cacheAnalytics));

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

    const statusBanner = {
      CRITICAL: "[CRITICAL]",
      WARNING: "[WARNING]",
      DEGRADED: "[DEGRADED]",
      HEALTHY: "[HEALTHY]",
    }[overallStatus];

    // Derive zone name for header
    const zoneName = zoneDetailRaw
      ? (zoneDetailRaw.name as string)
      : zoneList && zoneList.length > 0
      ? (zoneList[0].name as string)
      : "Unknown Zone";
    jsonData.zone = zoneName;

    const lines: string[] = [];
    lines.push(`# Cloudflare Audit Report: ${zoneName}`);
    lines.push("");
    lines.push(`**Status:** ${statusBanner} ${overallStatus}`);
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
      lines.push("## Data Collection Errors");
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
      if (f.check === "Zone" && f.message.includes("paused")) {
        recommendations.push(
          "Unpause the zone to restore Cloudflare proxy and security features",
        );
      }
      if (f.check === "Zone" && f.message.includes("SSL is disabled")) {
        recommendations.push(
          'Enable SSL immediately — set mode to "full" or "strict" to encrypt traffic end-to-end',
        );
      }
      if (f.check === "Zone" && f.message.includes("Development mode")) {
        recommendations.push(
          "Disable development mode — it bypasses caching and degrades performance",
        );
      }
      if (f.check === "DNS" && f.message.includes("subdomain takeover")) {
        recommendations.push(
          "Remove or update dangling CNAME records to prevent subdomain takeover attacks",
        );
      }
    }

    for (const f of warnings) {
      if (f.check === "Zone" && f.message.includes("flexible")) {
        recommendations.push(
          'Upgrade SSL mode from "flexible" to "full" or "strict" to encrypt origin traffic',
        );
      }
      if (f.check === "Zone" && f.message.includes("Always Use HTTPS")) {
        recommendations.push(
          "Enable Always Use HTTPS to redirect all HTTP requests to HTTPS",
        );
      }
      if (f.check === "WAF" && f.message.includes("No WAF rules")) {
        recommendations.push(
          "Configure WAF rules to protect against common web attacks",
        );
      }
      if (f.check === "WAF" && f.message.includes("paused")) {
        recommendations.push(
          "Review and re-enable paused WAF rules to maintain security coverage",
        );
      }
      if (f.check === "DNS" && f.message.includes("unproxied")) {
        recommendations.push(
          "Enable Cloudflare proxy on exposed records to hide origin IP addresses",
        );
      }
      if (f.check === "DNS" && f.message.includes("CAA")) {
        recommendations.push(
          "Add CAA records to restrict which certificate authorities can issue certificates for your domain",
        );
      }
      if (f.check === "Workers" && f.message.includes("Orphaned")) {
        recommendations.push(
          "Remove orphaned worker scripts or create routes to activate them",
        );
      }
      if (f.check === "Cache" && f.message.includes("hit rate")) {
        recommendations.push(
          "Review cache rules and page rules to improve cache hit rate",
        );
      }
      if (f.check === "Cache" && f.message.includes("cache level")) {
        recommendations.push(
          "Upgrade cache level for better performance and reduced origin load",
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
      "Cloudflare audit report: {status}, {critical} critical, {warn} warnings",
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
