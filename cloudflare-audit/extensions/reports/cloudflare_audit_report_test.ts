// Cloudflare Audit Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@systeminit/swamp-testing";
import {
  CACHE_HIT_RATE_WARN,
  checkCache,
  checkDns,
  checkWaf,
  checkWorkers,
  checkZone,
  DANGLING_CNAME_PATTERNS,
  report,
} from "./cloudflare_audit_report.ts";

// --- Test helpers ---

const MODEL_TYPES: Record<string, string> = {
  "cf-zone": "@webframp/cloudflare/zone",
  "cf-dns": "@webframp/cloudflare/dns",
  "cf-waf": "@webframp/cloudflare/waf",
  "cf-worker": "@webframp/cloudflare/worker",
  "cf-cache": "@webframp/cloudflare/cache",
};

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
    jobName: "audit-job",
    stepName: `${methodName}-step`,
    modelName,
    modelType: MODEL_TYPES[modelName] ?? modelName,
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
  const modelType = MODEL_TYPES[modelName] ?? modelName;
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
    workflowName: "@webframp/cloudflare-audit",
    workflowStatus: "succeeded",
    // deno-lint-ignore no-explicit-any
    stepExecutions: stepExecutions as any,
    dataArtifacts: artifacts,
  });
  return context;
}

// ============================================================
// Unit tests: checkZone
// ============================================================

Deno.test("checkZone: SSL strict produces ok", () => {
  const findings = checkZone([], { ssl: "strict" });
  const sslFinding = findings.find((f) => f.message.includes("SSL"));
  assertEquals(sslFinding?.severity, "ok");
  assertStringIncludes(sslFinding!.message, "strict");
});

Deno.test("checkZone: SSL flexible produces warn", () => {
  const findings = checkZone([], { ssl: "flexible" });
  const sslFinding = findings.find((f) => f.message.includes("SSL"));
  assertEquals(sslFinding?.severity, "warn");
  assertStringIncludes(sslFinding!.message, "flexible");
});

Deno.test("checkZone: SSL off produces critical", () => {
  const findings = checkZone([], { ssl: "off" });
  const sslFinding = findings.find((f) => f.message.includes("SSL"));
  assertEquals(sslFinding?.severity, "critical");
});

Deno.test("checkZone: always_use_https off produces warn", () => {
  const findings = checkZone([], { always_use_https: "off" });
  const finding = findings.find((f) => f.message.includes("Always Use HTTPS"));
  assertEquals(finding?.severity, "warn");
});

Deno.test("checkZone: development_mode on (value=1) produces critical", () => {
  const findings = checkZone([], { development_mode: 1 });
  const finding = findings.find((f) => f.message.includes("Development mode"));
  assertEquals(finding?.severity, "critical");
});

Deno.test("checkZone: zone paused produces critical", () => {
  const findings = checkZone(
    [{ name: "example.com", paused: true, status: "active" }],
    null,
  );
  const finding = findings.find((f) => f.message.includes("paused"));
  assertEquals(finding?.severity, "critical");
});

Deno.test("checkZone: zone status pending produces warn", () => {
  const findings = checkZone(
    [{ name: "example.com", paused: false, status: "pending" }],
    null,
  );
  const finding = findings.find((f) => f.message.includes("pending"));
  assertEquals(finding?.severity, "warn");
});

Deno.test("checkZone: null data produces error", () => {
  const findings = checkZone(null, null);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "error");
  assertStringIncludes(findings[0].message, "No zone data");
});

// ============================================================
// Unit tests: checkWaf
// ============================================================

Deno.test("checkWaf: active rules + packages produce ok", () => {
  const findings = checkWaf(
    [{ id: "r1", paused: false }, { id: "r2", paused: false }],
    [{ id: "p1" }],
    null,
  );
  const ruleFinding = findings.find((f) =>
    f.message.includes("WAF rules active")
  );
  assertEquals(ruleFinding?.severity, "ok");
  const pkgFinding = findings.find((f) => f.message.includes("WAF package(s)"));
  assertEquals(pkgFinding?.severity, "ok");
});

Deno.test("checkWaf: no rules produces warn", () => {
  const findings = checkWaf([], null, null);
  const finding = findings.find((f) =>
    f.message.includes("No WAF rules configured")
  );
  assertEquals(finding?.severity, "warn");
});

Deno.test("checkWaf: all rules paused produces warn + individual paused findings", () => {
  const findings = checkWaf(
    [
      { id: "r1", paused: true, description: "Rule A" },
      { id: "r2", paused: true, description: "Rule B" },
    ],
    null,
    null,
  );
  const allPaused = findings.find((f) =>
    f.message.includes("All WAF rules are paused")
  );
  assertEquals(allPaused?.severity, "warn");
  const pausedRules = findings.filter((f) =>
    f.message.includes("WAF rule paused")
  );
  assertEquals(pausedRules.length, 2);
  assertEquals(pausedRules[0].severity, "warn");
});

Deno.test("checkWaf: no packages produces warn", () => {
  const findings = checkWaf(
    [{ id: "r1", paused: false }],
    [],
    null,
  );
  const finding = findings.find((f) => f.message.includes("No WAF packages"));
  assertEquals(finding?.severity, "warn");
});

Deno.test("checkWaf: null rules produces error", () => {
  const findings = checkWaf(null, null, null);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "error");
  assertStringIncludes(findings[0].message, "No WAF rules data");
});

// ============================================================
// Unit tests: checkDns
// ============================================================

Deno.test("checkDns: all proxied + CAA produces ok", () => {
  const findings = checkDns([
    { type: "A", name: "example.com", proxied: true },
    { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"' },
  ]);
  const proxiedFinding = findings.find((f) =>
    f.message.includes("All proxyable records are proxied")
  );
  assertEquals(proxiedFinding?.severity, "ok");
  const caaFinding = findings.find((f) => f.message.includes("CAA record"));
  assertEquals(caaFinding?.severity, "ok");
});

Deno.test("checkDns: unproxied A record produces warn", () => {
  const findings = checkDns([
    { type: "A", name: "api.example.com", proxied: false },
    { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"' },
  ]);
  const finding = findings.find((f) => f.message.includes("unproxied"));
  assertEquals(finding?.severity, "warn");
  assertStringIncludes(finding!.message, "api.example.com");
});

Deno.test("checkDns: dangling CNAME (herokuapp.com) produces critical", () => {
  const findings = checkDns([
    {
      type: "CNAME",
      name: "old.example.com",
      content: "old-app.herokuapp.com",
      proxied: true,
    },
    { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"' },
  ]);
  const finding = findings.find((f) =>
    f.message.includes("subdomain takeover")
  );
  assertEquals(finding?.severity, "critical");
  assertStringIncludes(finding!.message, "herokuapp.com");
});

Deno.test("checkDns: no CAA produces warn", () => {
  const findings = checkDns([
    { type: "A", name: "example.com", proxied: true },
  ]);
  const finding = findings.find((f) => f.message.includes("CAA"));
  assertEquals(finding?.severity, "warn");
  assertStringIncludes(finding!.message, "No CAA records");
});

Deno.test("checkDns: null data produces error", () => {
  const findings = checkDns(null);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "error");
  assertStringIncludes(findings[0].message, "No DNS record data");
});

Deno.test("DANGLING_CNAME_PATTERNS matches known takeover targets", () => {
  const targets = [
    "app.herokuapp.com",
    "app.herokudns.com",
    "bucket.s3.amazonaws.com",
    "site.s3-website-us-east-1.amazonaws.com",
    "d123.cloudfront.net",
    "app.azurewebsites.net",
    "store.blob.core.windows.net",
    "app.trafficmanager.net",
    "vm.cloudapp.net",
    "user.github.io",
    "shop.shopify.com",
    "site.pantheonsite.io",
    "blog.ghost.io",
    "app.netlify.app",
    "app.fly.dev",
    "app.vercel.app",
  ];
  for (const target of targets) {
    const matched = DANGLING_CNAME_PATTERNS.some((p) => p.test(target));
    assertEquals(matched, true, `Expected pattern to match "${target}"`);
  }
});

// ============================================================
// Unit tests: checkWorkers
// ============================================================

Deno.test("checkWorkers: all routed produces ok", () => {
  const findings = checkWorkers(
    [{ id: "worker-a" }],
    [{ script: "worker-a", pattern: "*.example.com/*" }],
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "ok");
  assertStringIncludes(
    findings[0].message,
    "All 1 worker script(s) have routes",
  );
});

Deno.test("checkWorkers: orphaned script produces warn", () => {
  const findings = checkWorkers(
    [{ id: "worker-a" }, { id: "worker-b" }],
    [{ script: "worker-a", pattern: "*.example.com/*" }],
  );
  const orphaned = findings.find((f) => f.message.includes("Orphaned"));
  assertEquals(orphaned?.severity, "warn");
  assertStringIncludes(orphaned!.message, "worker-b");
});

Deno.test("checkWorkers: no scripts produces empty", () => {
  const findings = checkWorkers([], []);
  assertEquals(findings.length, 0);
});

Deno.test("checkWorkers: null produces empty", () => {
  const findings = checkWorkers(null, null);
  assertEquals(findings.length, 0);
});

// ============================================================
// Unit tests: checkCache
// ============================================================

Deno.test("checkCache: aggressive level produces ok", () => {
  const findings = checkCache({ cacheLevel: "aggressive" }, null);
  const finding = findings.find((f) => f.message.includes("aggressive"));
  assertEquals(finding?.severity, "ok");
});

Deno.test("checkCache: bypass level produces warn", () => {
  const findings = checkCache({ cacheLevel: "bypass" }, null);
  const finding = findings.find((f) => f.message.includes("bypass"));
  assertEquals(finding?.severity, "warn");
});

Deno.test("checkCache: high hit rate produces ok", () => {
  const findings = checkCache(null, { cacheHitRate: 85.5 });
  const finding = findings.find((f) => f.message.includes("hit rate"));
  assertEquals(finding?.severity, "ok");
  assertStringIncludes(finding!.message, "85.5%");
});

Deno.test("checkCache: low hit rate produces warn", () => {
  const findings = checkCache(null, {
    cacheHitRate: CACHE_HIT_RATE_WARN - 10,
  });
  const finding = findings.find((f) => f.message.includes("hit rate"));
  assertEquals(finding?.severity, "warn");
  assertStringIncludes(finding!.message, `below ${CACHE_HIT_RATE_WARN}%`);
});

// ============================================================
// Integration tests: report.execute
// ============================================================

Deno.test("integration: healthy zone produces HEALTHY status", async () => {
  const steps = [
    makeStep("cf-zone", "list", "zone-list"),
    makeStep("cf-zone", "get_settings", "zone-settings"),
    makeStep("cf-zone", "get", "zone-detail"),
    makeStep("cf-waf", "list_rules", "waf-rules"),
    makeStep("cf-waf", "list_packages", "waf-packages"),
    makeStep("cf-waf", "get_security_events", "waf-events"),
    makeStep("cf-dns", "list", "dns-records"),
    makeStep("cf-worker", "list_scripts", "worker-scripts"),
    makeStep("cf-worker", "list_routes", "worker-routes"),
    makeStep("cf-cache", "get_settings", "cache-settings"),
    makeStep("cf-cache", "get_analytics", "cache-analytics"),
  ];
  const artifacts = [
    makeArtifact("cf-zone", "zone-list", {
      zones: [{ name: "example.com", status: "active", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-zone", "zone-settings", {
      zoneId: "z1",
      zoneName: "example.com",
      settings: {
        ssl: "strict",
        always_use_https: "on",
        development_mode: 0,
      },
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-zone", "zone-detail", {
      id: "z1",
      name: "example.com",
      status: "active",
      paused: false,
    }),
    makeArtifact("cf-waf", "waf-rules", {
      zoneId: "z1",
      rules: [{ id: "r1", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-waf", "waf-packages", {
      zoneId: "z1",
      packages: [{ id: "p1" }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-waf", "waf-events", {
      zoneId: "z1",
      events: [],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-dns", "dns-records", {
      zoneId: "z1",
      records: [
        { type: "A", name: "example.com", proxied: true },
        {
          type: "CAA",
          name: "example.com",
          content: '0 issue "letsencrypt.org"',
        },
      ],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-worker", "worker-scripts", {
      accountId: "a1",
      scripts: [{ id: "my-worker" }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-worker", "worker-routes", {
      zoneId: "z1",
      routes: [{ script: "my-worker", pattern: "*.example.com/*" }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-cache", "cache-settings", {
      zoneId: "z1",
      cacheLevel: "aggressive",
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-cache", "cache-analytics", {
      zoneId: "z1",
      requests: { all: 1000, cached: 800, uncached: 200, cacheHitRate: 80 },
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "[HEALTHY] HEALTHY");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "HEALTHY");
  assertEquals((json.recommendations as string[]).length, 0);
});

Deno.test("integration: critical issues produce CRITICAL status with recommendations", async () => {
  const steps = [
    makeStep("cf-zone", "list", "zone-list"),
    makeStep("cf-zone", "get_settings", "zone-settings"),
    makeStep("cf-waf", "list_rules", "waf-rules"),
    makeStep("cf-dns", "list", "dns-records"),
  ];
  const artifacts = [
    makeArtifact("cf-zone", "zone-list", {
      zones: [{ name: "example.com", status: "active", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-zone", "zone-settings", {
      zoneId: "z1",
      zoneName: "example.com",
      settings: {
        ssl: "off",
        development_mode: 1,
      },
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-waf", "waf-rules", {
      zoneId: "z1",
      rules: [{ id: "r1", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-dns", "dns-records", {
      zoneId: "z1",
      records: [
        {
          type: "CNAME",
          name: "old.example.com",
          content: "old-app.herokuapp.com",
          proxied: true,
        },
        {
          type: "CAA",
          name: "example.com",
          content: '0 issue "letsencrypt.org"',
        },
      ],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "CRITICAL");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "CRITICAL");
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, "Enable SSL immediately");
  assertStringIncludes(result.markdown, "Disable development mode");
  assertStringIncludes(result.markdown, "dangling CNAME");
});

Deno.test("integration: no data produces DEGRADED status", async () => {
  const context = createContext();
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "DEGRADED");
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "DEGRADED");
  assertStringIncludes(result.markdown, "No zone data available");
  assertStringIncludes(result.markdown, "No WAF rules data available");
  assertStringIncludes(result.markdown, "No DNS record data available");
});

Deno.test("integration: warnings only produce WARNING status", async () => {
  const steps = [
    makeStep("cf-zone", "list", "zone-list"),
    makeStep("cf-zone", "get_settings", "zone-settings"),
    makeStep("cf-waf", "list_rules", "waf-rules"),
    makeStep("cf-dns", "list", "dns-records"),
  ];
  const artifacts = [
    makeArtifact("cf-zone", "zone-list", {
      zones: [{ name: "example.com", status: "active", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-zone", "zone-settings", {
      zoneId: "z1",
      zoneName: "example.com",
      settings: {
        ssl: "flexible",
        always_use_https: "on",
        development_mode: 0,
      },
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-waf", "waf-rules", {
      zoneId: "z1",
      rules: [],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-dns", "dns-records", {
      zoneId: "z1",
      records: [
        { type: "A", name: "api.example.com", proxied: false },
        {
          type: "CAA",
          name: "example.com",
          content: '0 issue "letsencrypt.org"',
        },
      ],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  const json = result.json as Record<string, unknown>;
  assertEquals(json.overallStatus, "WARNING");
  assertStringIncludes(result.markdown, "## Recommendations");
  assertStringIncludes(result.markdown, 'Upgrade SSL mode from "flexible"');
  assertStringIncludes(result.markdown, "Configure WAF rules");
  assertStringIncludes(result.markdown, "Enable Cloudflare proxy");
});

// ============================================================
// Export structure
// ============================================================

Deno.test("report has correct name", () => {
  assertEquals(report.name, "@webframp/cloudflare-audit-report");
});

Deno.test("report has workflow scope", () => {
  assertEquals(report.scope, "workflow");
});

Deno.test("report has labels", () => {
  assertEquals(report.labels, ["cloudflare", "security", "audit"]);
});

// ============================================================
// Markdown structure
// ============================================================

Deno.test("report markdown contains all expected sections", async () => {
  const steps = [
    makeStep("cf-zone", "list", "zone-list"),
    makeStep("cf-zone", "get_settings", "zone-settings"),
  ];
  const artifacts = [
    makeArtifact("cf-zone", "zone-list", {
      zones: [{ name: "example.com", status: "active", paused: false }],
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
    makeArtifact("cf-zone", "zone-settings", {
      zoneId: "z1",
      zoneName: "example.com",
      settings: { ssl: "flexible" },
      fetchedAt: "2026-04-13T00:00:00Z",
    }),
  ];
  const context = createContext(steps, artifacts);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertStringIncludes(result.markdown, "# Cloudflare Audit Report");
  assertStringIncludes(result.markdown, "**Status:**");
  assertStringIncludes(result.markdown, "**Timestamp:**");
  assertStringIncludes(result.markdown, "**Checks:**");
  assertStringIncludes(result.markdown, "## All Checks");
  assertStringIncludes(result.markdown, "| Check | Status | Detail |");
});
