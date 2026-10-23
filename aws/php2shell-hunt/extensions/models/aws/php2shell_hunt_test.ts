/**
 * Unit tests for @webframp/aws/php2shell-hunt model.
 *
 * @module
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { Inspector2Client } from "npm:@aws-sdk/client-inspector2@3.1139.0";
import { GuardDutyClient } from "npm:@aws-sdk/client-guardduty@3.1139.0";
import { SecurityHubClient } from "npm:@aws-sdk/client-securityhub@3.1139.0";
import { CloudWatchLogsClient } from "npm:@aws-sdk/client-cloudwatch-logs@3.1139.0";
import {
  classifyLogGroup,
  emptyEvidence,
  extractFindingIps,
  model,
  parseTime,
  PHP2SHELL_IOCS,
  verdictFor,
} from "./php2shell_hunt.ts";

// =============================================================================
// Mock helpers
// =============================================================================

function mockClient(
  ClientCtor: {
    // deno-lint-ignore no-explicit-any
    prototype: { send: any };
  },
  // deno-lint-ignore no-explicit-any
  handler: (command: any) => unknown,
): () => void {
  const original = ClientCtor.prototype.send;
  // deno-lint-ignore no-explicit-any
  ClientCtor.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  };
  return () => {
    ClientCtor.prototype.send = original;
  };
}

function mockInspector(
  // deno-lint-ignore no-explicit-any
  handler: (command: any) => unknown,
): () => void {
  return mockClient(Inspector2Client, handler);
}

function createMockContext(
  globalArgs: Record<string, unknown>,
  jev?: {
    runModel: (opts: Record<string, unknown>) => Promise<unknown>;
    readModelData: (
      name: string,
      spec?: string,
    ) => Promise<Array<{ name: string; attributes: Record<string, unknown> }>>;
  },
) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    globalArgs,
    logger: {
      info: (msg: string, _props?: Record<string, unknown>) => {
        logs.push(msg);
      },
      warning: (msg: string, _props?: Record<string, unknown>) => {
        logs.push(msg);
      },
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    ...(jev
      ? { runModel: jev.runModel, readModelData: jev.readModelData }
      : {}),
    written,
    logs,
  };
}

// =============================================================================
// IoC dataset
// =============================================================================

Deno.test("IoC dataset carries both CVEs and all six indicator IPs", () => {
  assertEquals(PHP2SHELL_IOCS.cves.length, 2);
  assert(PHP2SHELL_IOCS.cves.includes("CVE-2026-109618"));
  assert(PHP2SHELL_IOCS.cves.includes("CVE-2026-109619"));
  assertEquals(PHP2SHELL_IOCS.ipIndicators.length, 6);
  assert(PHP2SHELL_IOCS.ipIndicators.includes("103.216.220.92"));
  assertEquals(
    PHP2SHELL_IOCS.payloadStrings[0],
    "PHP_SESSION_UPLOAD_PROGRESS",
  );
});

Deno.test("earliestKnownExploitation predates the Oct-21 disclosure", () => {
  const exploit = new Date(PHP2SHELL_IOCS.earliestKnownExploitation);
  const disclosure = new Date("2026-10-21T14:00:00Z");
  assert(exploit < disclosure, "IoC start must precede public disclosure");
  assertEquals(
    PHP2SHELL_IOCS.earliestKnownExploitation,
    "2026-10-17T00:00:00Z",
  );
});

// =============================================================================
// Model shape
// =============================================================================

Deno.test("model declares all methods and resources", () => {
  assertEquals(model.type, "@webframp/aws/php2shell-hunt");
  for (
    const m of [
      "show_iocs",
      "discover_log_groups",
      "scan_inspector",
      "scan_guardduty",
      "scan_logs",
      "scan_securityhub",
      "hunt",
    ]
  ) {
    assert(m in model.methods, `missing method ${m}`);
  }
  for (
    const r of [
      "ioc_set",
      "inspector_scan",
      "guardduty_scan",
      "log_scan",
      "log_group_candidates",
      "securityhub_scan",
      "exposure_report",
    ]
  ) {
    assert(r in model.resources, `missing resource ${r}`);
  }
});

Deno.test("global args default to four US regions and self scope", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.scope, "self");
  assertEquals(parsed.regions, [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
  ]);
  assertEquals(parsed.accountIds, []);
});

// =============================================================================
// Verdict logic — the heart of the hunt
// =============================================================================

Deno.test("confirmed_exposure when Inspector finds a CVE hit", () => {
  const ev = emptyEvidence();
  ev.inspectorHitCount = 1;
  ev.inspectorCves = ["CVE-2026-109618"];
  const { verdict, summary } = verdictFor(ev, ["inspector"]);
  assertEquals(verdict, "confirmed_exposure");
  assertMatch(summary, /CVE-2026-109618/);
});

Deno.test("active_targeting when an IOC IP is seen but no vulnerable install", () => {
  const ev = emptyEvidence();
  ev.guardDutyIocIpMatches = ["103.216.220.92"];
  const { verdict } = verdictFor(ev, ["guardduty"]);
  assertEquals(verdict, "active_targeting");
});

Deno.test("possible_probe for upload marker without CVE or IOC IP", () => {
  const ev = emptyEvidence();
  ev.logUploadMarkerCount = 3;
  const { verdict } = verdictFor(ev, ["logs"]);
  assertEquals(verdict, "possible_probe");
});

Deno.test("confirmed outranks targeting when both present", () => {
  const ev = emptyEvidence();
  ev.inspectorHitCount = 1;
  ev.guardDutyIocIpMatches = ["37.19.200.5"];
  ev.logUploadMarkerCount = 9;
  assertEquals(
    verdictFor(ev, ["inspector", "guardduty", "logs"]).verdict,
    "confirmed_exposure",
  );
});

Deno.test("HONESTY: no lanes run => inconclusive, never no_signal", () => {
  const { verdict, summary } = verdictFor(emptyEvidence(), []);
  assertEquals(verdict, "inconclusive");
  assertMatch(summary, /NOT a clean result/);
});

Deno.test("no_signal only when a lane actually ran and found nothing", () => {
  const { verdict, summary } = verdictFor(emptyEvidence(), ["guardduty"]);
  assertEquals(verdict, "no_signal");
  assertMatch(summary, /Inspector only covers SSM\/ECR-scanned resources/i);
});

// =============================================================================
// Helpers
// =============================================================================

Deno.test("parseTime handles relative and ISO inputs", () => {
  const iso = parseTime("2026-10-17T00:00:00Z");
  assertEquals(iso.toISOString(), "2026-10-17T00:00:00.000Z");
  const rel = parseTime("7d");
  const delta = Date.now() - rel.getTime();
  assert(delta > 6.5 * 86_400_000 && delta < 7.5 * 86_400_000);
});

Deno.test("extractFindingIps pulls remote IPs from action blocks", () => {
  const ips = extractFindingIps({
    Service: {
      Action: {
        NetworkConnectionAction: {
          RemoteIpDetails: { IpAddressV4: "103.216.220.92" },
        },
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(ips, ["103.216.220.92"]);
});

// =============================================================================
// Methods with mock context / mocked SDK
// =============================================================================

Deno.test("show_iocs writes the indicator set with no AWS calls", async () => {
  const ctx = createMockContext(model.globalArguments.parse({}));
  await model.methods.show_iocs.execute(
    {},
    ctx as unknown as Parameters<typeof model.methods.show_iocs.execute>[1],
  );
  assertEquals(ctx.written.length, 1);
  assertEquals(ctx.written[0].spec, "ioc_set");
  const data = ctx.written[0].data as {
    cves: string[];
    ipIndicators: string[];
  };
  assertEquals(data.cves.length, 2);
  assertEquals(data.ipIndicators.length, 6);
});

Deno.test("scan_inspector maps CVE hits from mocked Inspector findings", async () => {
  const restore = mockInspector((cmd) => {
    if (cmd.constructor.name === "ListFindingsCommand") {
      return {
        findings: [
          {
            findingArn: "arn:aws:inspector2:us-east-1:111122223333:finding/x",
            awsAccountId: "111122223333",
            severity: "CRITICAL",
            title: "CVE-2026-109618 - php",
            fixAvailable: "YES",
            packageVulnerabilityDetails: {
              vulnerabilityId: "CVE-2026-109618",
            },
            resources: [{ type: "AWS_EC2_INSTANCE", id: "i-0abc" }],
          },
        ],
        nextToken: undefined,
      };
    }
    return {};
  });
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"] }),
    );
    await model.methods.scan_inspector.execute(
      { cves: [...PHP2SHELL_IOCS.cves] },
      ctx as unknown as Parameters<
        typeof model.methods.scan_inspector.execute
      >[1],
    );
    assertEquals(ctx.written.length, 1);
    const data = ctx.written[0].data as {
      count: number;
      hits: Array<
        { cve: string; accountId: string; resourceId: string | null }
      >;
    };
    assertEquals(data.count, 1);
    assertEquals(data.hits[0].cve, "CVE-2026-109618");
    assertEquals(data.hits[0].accountId, "111122223333");
    assertEquals(data.hits[0].resourceId, "i-0abc");
  } finally {
    restore();
  }
});

Deno.test("scan_inspector drops hits for out-of-scope accounts (client-side filter)", async () => {
  const restore = mockInspector((cmd) => {
    if (cmd.constructor.name === "ListFindingsCommand") {
      return {
        findings: [
          {
            findingArn: "arn:a",
            awsAccountId: "111111111111",
            severity: "HIGH",
            title: "CVE-2026-109618",
            packageVulnerabilityDetails: { vulnerabilityId: "CVE-2026-109618" },
            resources: [{ type: "AWS_EC2_INSTANCE", id: "i-keep" }],
          },
          {
            findingArn: "arn:b",
            awsAccountId: "999999999999",
            severity: "HIGH",
            title: "CVE-2026-109618",
            packageVulnerabilityDetails: { vulnerabilityId: "CVE-2026-109618" },
            resources: [{ type: "AWS_EC2_INSTANCE", id: "i-drop" }],
          },
        ],
      };
    }
    return {};
  });
  try {
    // scope=accounts with only one of the two accounts in the allow-list.
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "accounts",
        accountIds: ["111111111111"],
      }),
    );
    await model.methods.scan_inspector.execute(
      { cves: [...PHP2SHELL_IOCS.cves] },
      ctx as unknown as Parameters<
        typeof model.methods.scan_inspector.execute
      >[1],
    );
    const data = ctx.written[0].data as {
      count: number;
      hits: Array<{ accountId: string }>;
    };
    assertEquals(data.count, 1);
    assertEquals(data.hits[0].accountId, "111111111111");
  } finally {
    restore();
  }
});

Deno.test("HONESTY through hunt: all lanes failing yields inconclusive, not no_signal", async () => {
  // Every SDK client throws, so no lane records a completed region.
  const restores = [
    mockInspector(() => {
      throw new Error("AccessDenied");
    }),
    mockClient(GuardDutyClient, () => {
      throw new Error("AccessDenied");
    }),
    mockClient(SecurityHubClient, () => {
      throw new Error("not aggregating");
    }),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"], scope: "self" }),
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        orgVerdict: string;
        accounts: Array<{ verdict: string; lanesRun: string[] }>;
      };
    assertEquals(report.orgVerdict, "inconclusive");
    assertEquals(report.accounts[0].verdict, "inconclusive");
    assertEquals(report.accounts[0].lanesRun.length, 0);
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("Security Hub product findings without a CVE match do NOT confirm exposure", async () => {
  // A GuardDuty finding surfaced via Security Hub but with no PHP2Shell CVE
  // must land at possible_probe, never confirmed_exposure.
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockClient(GuardDutyClient, (cmd) => {
      if (cmd.constructor.name === "ListDetectorsCommand") {
        return { DetectorIds: ["d-1"] };
      }
      if (cmd.constructor.name === "ListFindingsCommand") {
        return { FindingIds: [] };
      }
      return { Findings: [] };
    }),
    mockClient(SecurityHubClient, () => ({
      Findings: [
        {
          Id: "arn:sh:1",
          AwsAccountId: "222233334444",
          Region: "us-east-1",
          ProductName: "GuardDuty",
          Types: ["TTPs/Impact"],
          Severity: { Label: "HIGH" },
          Title: "Some unrelated impact finding",
          // no Vulnerabilities, no CVE in title/description
        },
      ],
      // no NextToken -> single page
    })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"], scope: "self" }),
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        orgVerdict: string;
        accounts: Array<
          { verdict: string; evidence: { securityHubHitCount: number } }
        >;
      };
    assert(
      report.orgVerdict !== "confirmed_exposure",
      `non-CVE Security Hub finding wrongly confirmed exposure: ${report.orgVerdict}`,
    );
    const acct = report.accounts.find((a) =>
      a.evidence.securityHubHitCount > 0
    );
    assertEquals(
      acct,
      undefined,
      "no account should have a CVE-confirmed SH hit",
    );
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev find-miss does NOT borrow a foreign/stale noul score", async () => {
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        // runModel succeeds, but readModelData returns a DIFFERENT instance
        // name (a stale/foreign score). The code must NOT attribute it.
        runModel: () => Promise.resolve({ ok: true, resources: [] }),
        readModelData: () =>
          Promise.resolve([
            { name: "noul-someone-else", attributes: { noul: 0.99 } },
          ]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        jevEnriched: boolean;
        accounts: Array<{ evidence: { jevConfirmedCount: number } }>;
      };
    assertEquals(report.jevEnriched, true);
    // The foreign 0.99 must never be attributed to our signal.
    const confirmed = report.accounts.some((a) =>
      a.evidence.jevConfirmedCount > 0
    );
    assertEquals(confirmed, false);
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev cap: un-scored signals fall back to the raw heuristic, not silently cleared", async () => {
  // Two RCE-hint findings, jevMaxCalls=1 -> jev scores only the first (low,
  // cleared); the second is un-scored and must still raise possible_probe.
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockClient(GuardDutyClient, (cmd) => {
      const n = cmd.constructor.name;
      if (n === "ListDetectorsCommand") return { DetectorIds: ["d-1"] };
      if (n === "ListFindingsCommand") return { FindingIds: ["f-1", "f-2"] };
      return {
        Findings: [
          {
            Id: "f-1",
            Type: "Backdoor:EC2/C&CActivity.B",
            Severity: 5,
            Title: "finding one",
            AccountId: "111111111111",
            Region: "us-east-1",
            CreatedAt: "2026-10-18T00:00:00Z",
            UpdatedAt: "2026-10-18T00:00:00Z",
          },
          {
            Id: "f-2",
            Type: "Execution:EC2/SuspiciousFile",
            Severity: 5,
            Title: "finding two",
            AccountId: "111111111111",
            Region: "us-east-1",
            CreatedAt: "2026-10-18T00:00:00Z",
            UpdatedAt: "2026-10-18T00:00:00Z",
          },
        ],
      };
    }),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () => Promise.resolve({ ok: true, resources: [] }),
        // jev clears the one signal it scores (0.1 < 0.5).
        readModelData: () =>
          Promise.resolve([
            { name: "noul-p2s-0", attributes: { noul: 0.1 } },
          ]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 1,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        orgVerdict: string;
        accounts: Array<
          {
            accountId: string;
            verdict: string;
            evidence: {
              guardDutyRceHintCount: number;
              jevConfirmedCount: number;
            };
          }
        >;
      };
    // Signal 1 scored+cleared (jevConfirmedCount 0), signal 2 un-scored ->
    // retained as a raw rce-hint -> possible_probe, never silently no_signal.
    assertEquals(report.orgVerdict, "possible_probe");
    const acct = report.accounts.find((a) => a.accountId === "111111111111");
    assert(acct, "account present");
    assertEquals(acct!.evidence.jevConfirmedCount, 0);
    assertEquals(acct!.evidence.guardDutyRceHintCount, 1);
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("no method writes to the reserved 'latest' instance name", async () => {
  // 'latest' is reserved by the swamp runtime; a unit mock won't catch it, so
  // assert it directly against every scan method's written instance name.
  const restoreAll = [
    mockInspector(() => ({ findings: [] })),
    mockClient(GuardDutyClient, (cmd) => {
      if (cmd.constructor.name === "ListDetectorsCommand") {
        return { DetectorIds: ["d-1"] };
      }
      if (cmd.constructor.name === "ListFindingsCommand") {
        return { FindingIds: [] };
      }
      return { Findings: [] };
    }),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    for (
      const [method, args] of [
        ["scan_inspector", { cves: [...PHP2SHELL_IOCS.cves] }],
        ["scan_guardduty", {
          since: PHP2SHELL_IOCS.earliestKnownExploitation,
          iocIps: [...PHP2SHELL_IOCS.ipIndicators],
        }],
        ["scan_securityhub", {
          since: PHP2SHELL_IOCS.earliestKnownExploitation,
        }],
      ] as const
    ) {
      const ctx = createMockContext(
        model.globalArguments.parse({ regions: ["us-east-1"] }),
      );
      // deno-lint-ignore no-explicit-any
      await (model.methods as any)[method].execute(args, ctx);
      for (const w of ctx.written) {
        assert(
          w.name !== "latest",
          `${method} wrote reserved instance name 'latest'`,
        );
      }
    }
  } finally {
    for (const r of restoreAll) r();
  }
});

Deno.test("scan_inspector records a skip when the API errors", async () => {
  const restore = mockInspector(() => {
    throw new Error("AccessDenied: inspector2:ListFindings");
  });
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"] }),
    );
    await model.methods.scan_inspector.execute(
      { cves: [...PHP2SHELL_IOCS.cves] },
      ctx as unknown as Parameters<
        typeof model.methods.scan_inspector.execute
      >[1],
    );
    const data = ctx.written[0].data as {
      count: number;
      skipped: Array<{ lane: string; reason: string }>;
    };
    assertEquals(data.count, 0);
    assertEquals(data.skipped.length, 1);
    assertMatch(data.skipped[0].reason, /NOT proof of safety/);
  } finally {
    restore();
  }
});

// =============================================================================
// Log group discovery
// =============================================================================

Deno.test("classifyLogGroup ranks flow/waf/alb/app ahead of noise", () => {
  assertEquals(classifyLogGroup("/vpc/flowlogs").classification, "flow_log");
  assertEquals(classifyLogGroup("/aws/waf/php-app").classification, "waf_log");
  assertEquals(classifyLogGroup("my-alb-access").classification, "alb_log");
  assertEquals(classifyLogGroup("/ecs/php-fpm").classification, "app_log");
  assertEquals(
    classifyLogGroup("/aws/lambda/unrelated").classification,
    "other",
  );
  // ordering: flow > waf > alb > app > other
  assert(
    classifyLogGroup("/vpc/flowlogs").relevance >
      classifyLogGroup("waf").relevance,
  );
  assert(
    classifyLogGroup("app-nginx").relevance >
      classifyLogGroup("random").relevance,
  );
});

Deno.test("discover_log_groups classifies and recommends relevant groups", async () => {
  const restore = mockClient(CloudWatchLogsClient, (cmd) => {
    if (cmd.constructor.name === "DescribeLogGroupsCommand") {
      return {
        logGroups: [
          { logGroupName: "/vpc/flowlogs", storedBytes: 1000 },
          { logGroupName: "/aws/waf/php", storedBytes: 500 },
          { logGroupName: "/aws/lambda/worker", storedBytes: 9999 },
        ],
      };
    }
    return {};
  });
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"] }),
    );
    await model.methods.discover_log_groups.execute(
      { maxPerRegion: 200 },
      ctx as unknown as Parameters<
        typeof model.methods.discover_log_groups.execute
      >[1],
    );
    const data = ctx.written[0].data as {
      count: number;
      recommended: string[];
      candidates: Array<{ name: string; classification: string }>;
    };
    assertEquals(data.count, 3);
    // flow + waf are recommended (relevance >= 60); the lambda group is not.
    assertEquals(data.recommended.includes("/vpc/flowlogs"), true);
    assertEquals(data.recommended.includes("/aws/waf/php"), true);
    assertEquals(data.recommended.includes("/aws/lambda/worker"), false);
    // highest relevance (flow_log) sorts first
    assertEquals(data.candidates[0].classification, "flow_log");
  } finally {
    restore();
  }
});

// =============================================================================
// jev enrichment
// =============================================================================

/** A GuardDuty mock that yields one RCE-hint finding for the hunt to enrich. */
function mockGuardDutyWithRceFinding(): () => void {
  return mockClient(GuardDutyClient, (cmd) => {
    const n = cmd.constructor.name;
    if (n === "ListDetectorsCommand") return { DetectorIds: ["d-1"] };
    if (n === "ListFindingsCommand") return { FindingIds: ["f-1"] };
    return {
      Findings: [
        {
          Id: "f-1",
          Type: "Backdoor:EC2/C&CActivity.B",
          Severity: 5,
          Title: "Backdoor-shaped finding",
          AccountId: "111111111111",
          Region: "us-east-1",
          CreatedAt: "2026-10-18T00:00:00Z",
          UpdatedAt: "2026-10-18T00:00:00Z",
        },
      ],
    };
  });
}

Deno.test("jev enrichment: high noul confirms a signal as possible_probe", async () => {
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () => Promise.resolve({ ok: true, resources: [] }),
        readModelData: () =>
          Promise.resolve([
            { name: "noul-p2s-0", attributes: { noul: 0.9 } },
          ]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        jevEnriched: boolean;
        accounts: Array<
          { verdict: string; evidence: { jevConfirmedCount: number } }
        >;
      };
    assertEquals(report.jevEnriched, true);
    const confirmed = report.accounts.find((a) =>
      a.evidence.jevConfirmedCount > 0
    );
    assert(confirmed, "a signal jev scored 0.9 should be confirmed");
    assertEquals(confirmed!.verdict, "possible_probe");
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev enrichment: low noul clears the RCE-hint noise to no_signal", async () => {
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () => Promise.resolve({ ok: true, resources: [] }),
        readModelData: () =>
          Promise.resolve([
            { name: "noul-p2s-0", attributes: { noul: 0.05 } },
          ]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as { jevEnriched: boolean; orgVerdict: string };
    assertEquals(report.jevEnriched, true);
    // The lone RCE-hint finding was cleared by jev -> no probe-worthy signal.
    assertEquals(report.orgVerdict, "no_signal");
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev clearance holds when Security Hub mirrors the same GuardDuty finding", async () => {
  // Regression for the CI-caught HIGH: with Security Hub enabled (the default),
  // the same GuardDuty RCE-hint finding the direct lane feeds to jev ALSO
  // re-appears as a non-CVE Security Hub hit. If the SH fold credited it to
  // guardDutyRceHintCount unconditionally, it would undo jev's clearance and
  // force possible_probe. jev cleared it (0.05), so the verdict must stay
  // no_signal even though SH surfaced the mirror.
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({
      Findings: [
        {
          Id: "arn:sh:mirror",
          AwsAccountId: "111111111111",
          Region: "us-east-1",
          ProductName: "GuardDuty",
          Types: ["TTPs/Impact"],
          Severity: { Label: "MEDIUM" },
          Title: "Backdoor-shaped finding (mirrored from GuardDuty)",
          // no Vulnerabilities / no CVE -> non-CVE hit, the else branch
        },
      ],
    })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () => Promise.resolve({ ok: true, resources: [] }),
        readModelData: () =>
          Promise.resolve([
            { name: "noul-p2s-0", attributes: { noul: 0.05 } },
          ]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        jevEnriched: boolean;
        orgVerdict: string;
        accounts: Array<{ evidence: { guardDutyRceHintCount: number } }>;
      };
    assertEquals(report.jevEnriched, true);
    // The Security Hub mirror must NOT re-inflate the raw heuristic.
    const totalRce = report.accounts.reduce(
      (n, a) => n + a.evidence.guardDutyRceHintCount,
      0,
    );
    assertEquals(totalRce, 0);
    assertEquals(report.orgVerdict, "no_signal");
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev runModel ok:false => not enriched, honest skip, heuristic fallback", async () => {
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () =>
          Promise.resolve({ ok: false, error: { message: "jev unreachable" } }),
        readModelData: () => Promise.resolve([]),
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        jevEnriched: boolean;
        jevSkipReason: string | null;
        orgVerdict: string;
        accounts: Array<{ lanesSkipped: Array<{ lane: string }> }>;
      };
    // jev failed -> not enriched, recorded honestly, and the raw heuristic
    // still fires on the RCE-hint finding (possible_probe), never silently clean.
    assertEquals(report.jevEnriched, false);
    assert(report.jevSkipReason !== null);
    assertEquals(report.orgVerdict, "possible_probe");
    assert(
      report.accounts.some((a) => a.lanesSkipped.some((s) => s.lane === "jev")),
      "a jev skip must be recorded",
    );
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("jev PARTIAL failure: a scored-confirmed signal is never silently dropped", async () => {
  // Regression for the CI-caught HIGH: jev scores signal #0 (low, cleared) and
  // #1 (high, confirmed), then THROWS on #2. If enrichWithJev returned its
  // partial scoredKeys with enriched=false, signal #1 would be suppressed from
  // the raw fold (it's in scoredKeys) yet excluded from jevConfirmedCount
  // (enriched is false) — silently dropping a jev-confirmed exploitation
  // signal. The fix returns EMPTY scoredKeys on any failure, so all three
  // findings fall back to the raw heuristic -> possible_probe, never a false
  // no_signal.
  let call = 0;
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockClient(GuardDutyClient, (cmd) => {
      const n = cmd.constructor.name;
      if (n === "ListDetectorsCommand") return { DetectorIds: ["d-1"] };
      if (n === "ListFindingsCommand") {
        return { FindingIds: ["f-0", "f-1", "f-2"] };
      }
      return {
        Findings: ["f-0", "f-1", "f-2"].map((id, i) => ({
          Id: id,
          Type: "Backdoor:EC2/C&CActivity.B",
          Severity: 5,
          Title: `rce-hint finding ${i}`,
          AccountId: "111111111111",
          Region: "us-east-1",
          CreatedAt: "2026-10-18T00:00:00Z",
          UpdatedAt: "2026-10-18T00:00:00Z",
        })),
      };
    }),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  // noul scores: call 0 -> 0.1, call 1 -> 0.9, call 2 -> throw.
  const scores = [0.1, 0.9];
  try {
    const ctx = createMockContext(
      model.globalArguments.parse({
        regions: ["us-east-1"],
        scope: "self",
        jevBehavior: "jev-test",
      }),
      {
        runModel: () => {
          const i = call++;
          if (i >= 2) throw new Error("jev threw mid-batch");
          return Promise.resolve({ ok: true, resources: [] });
        },
        readModelData: () => {
          // Return the score for the most recent successful call index.
          const i = call - 1;
          return Promise.resolve([
            { name: `noul-p2s-${i}`, attributes: { noul: scores[i] } },
          ]);
        },
      },
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as {
        jevEnriched: boolean;
        orgVerdict: string;
        accounts: Array<
          {
            accountId: string;
            evidence: {
              guardDutyRceHintCount: number;
              jevConfirmedCount: number;
            };
          }
        >;
      };
    // Partial failure => enriched false, no confirmed credits, all three
    // findings retained by the raw heuristic.
    assertEquals(report.jevEnriched, false);
    const acct = report.accounts.find((a) => a.accountId === "111111111111");
    assert(acct, "account present");
    assertEquals(acct!.evidence.jevConfirmedCount, 0);
    assertEquals(acct!.evidence.guardDutyRceHintCount, 3);
    assertEquals(report.orgVerdict, "possible_probe");
  } finally {
    for (const r of restores) r();
  }
});

Deno.test("no jevBehavior => enrichment never runs, behavior unchanged", async () => {
  const restores = [
    mockInspector(() => ({ findings: [] })),
    mockGuardDutyWithRceFinding(),
    mockClient(SecurityHubClient, () => ({ Findings: [] })),
  ];
  try {
    // No jev in context at all, and no jevBehavior global.
    const ctx = createMockContext(
      model.globalArguments.parse({ regions: ["us-east-1"], scope: "self" }),
    );
    await model.methods.hunt.execute(
      {
        since: PHP2SHELL_IOCS.earliestKnownExploitation,
        logGroupNames: [],
        useSecurityHub: true,
        jevMaxCalls: 15,
      },
      ctx as unknown as Parameters<typeof model.methods.hunt.execute>[1],
    );
    const report = ctx.written.find((w) => w.spec === "exposure_report")!
      .data as { jevEnriched: boolean; orgVerdict: string };
    assertEquals(report.jevEnriched, false);
    // Raw heuristic fires on the RCE-hint finding, exactly as before jev existed.
    assertEquals(report.orgVerdict, "possible_probe");
  } finally {
    for (const r of restores) r();
  }
});
