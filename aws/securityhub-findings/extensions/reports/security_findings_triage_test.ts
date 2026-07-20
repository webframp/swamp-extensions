/**
 * Tests for @webframp/securityhub-triage-report.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { report } from "./security_findings_triage.ts";

function createMockContext(
  steps: Array<{
    stepName: string;
    methodName: string;
    data: unknown;
  }> = [],
) {
  const stepExecutions = steps.map((s) => ({
    jobName: "collect",
    stepName: s.stepName,
    modelName: "sh-findings",
    modelType: "@webframp/aws/securityhub-findings",
    modelId: "test-id",
    methodName: s.methodName,
    status: "succeeded",
    dataHandles: [{ name: s.stepName, dataId: "d-1", version: 1 }],
  }));

  const dataStore: Record<string, Uint8Array> = {};
  for (const s of steps) {
    dataStore[s.stepName] = new TextEncoder().encode(JSON.stringify(s.data));
  }

  return {
    workflowId: "wf-1",
    workflowRunId: "run-1",
    workflowName: "securityhub-triage",
    workflowStatus: "succeeded",
    stepExecutions,
    repoDir: "/tmp",
    dataRepository: {
      getContent: (
        _modelType: unknown,
        _modelId: string,
        dataName: string,
        _version?: number,
      ) => Promise.resolve(dataStore[dataName] ?? null),
    },
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

Deno.test("report has correct metadata", () => {
  assertEquals(report.name, "@webframp/securityhub-triage-report");
  assertEquals(report.scope, "workflow");
  assertEquals(report.labels.includes("security"), true);
});

Deno.test("report produces No Data section when all steps are empty", async () => {
  const ctx = createMockContext();
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## No Data"), true);
  assertEquals(result.json.summary, null);
  assertEquals(result.json.diff, null);
});

Deno.test("report renders severity dashboard from summary step", async () => {
  const ctx = createMockContext([
    {
      stepName: "severity_summary",
      methodName: "get_severity_summary",
      data: {
        critical: 3,
        high: 7,
        medium: 20,
        low: 50,
        informational: 2,
        total: 82,
        truncated: false,
        accountBreakdown: [
          {
            accountId: "111",
            critical: 2,
            high: 3,
            medium: 10,
            low: 20,
            informational: 1,
          },
          {
            accountId: "222",
            critical: 1,
            high: 4,
            medium: 10,
            low: 30,
            informational: 1,
          },
        ],
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## Severity Dashboard"), true);
  assertEquals(result.markdown.includes("| 3 | 7 | 20 | 50 | 2 | 82 |"), true);
  assertEquals(result.markdown.includes("111"), true);
  assertEquals(result.json.summary?.critical, 3);
  assertEquals(result.json.summary?.total, 82);
});

Deno.test("report renders truncation warning for summary", async () => {
  const ctx = createMockContext([
    {
      stepName: "severity_summary",
      methodName: "get_severity_summary",
      data: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        informational: 0,
        total: 500,
        truncated: true,
        accountBreakdown: [],
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("⚠️"), true);
});

Deno.test("report merges critical and high findings", async () => {
  const ctx = createMockContext([
    {
      stepName: "critical_findings",
      methodName: "list_findings",
      data: {
        findings: [{
          severity: "CRITICAL",
          title: "Crit1",
          accountId: "111",
          region: "us-east-1",
          productName: "GuardDuty",
          type: "TTPs/Impact",
        }],
        count: 1,
        truncated: false,
      },
    },
    {
      stepName: "high_findings",
      methodName: "list_findings",
      data: {
        findings: [{
          severity: "HIGH",
          title: "High1",
          accountId: "222",
          region: "eu-west-1",
          productName: "Inspector",
          type: "TTPs/Recon",
        }],
        count: 1,
        truncated: false,
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## Critical & High Findings"), true);
  assertEquals(result.markdown.includes("Crit1"), true);
  assertEquals(result.markdown.includes("High1"), true);
  assertEquals(result.json.criticalHighCount, 2);
});

Deno.test("report renders diff with truncation warning", async () => {
  const ctx = createMockContext([
    {
      stepName: "diff_findings",
      methodName: "diff_findings",
      data: {
        newFindings: [{
          severity: "HIGH",
          title: "New one",
          accountId: "111",
          type: "TTPs/New",
        }],
        resolvedFindings: [],
        newCount: 1,
        resolvedCount: 3,
        truncated: true,
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## Changes Since Last Run"), true);
  assertEquals(result.markdown.includes("New one"), true);
  assertEquals(result.markdown.includes("⚠️"), true); // truncation warning
  assertEquals(result.json.diff?.newCount, 1);
});

Deno.test("report renders top finding types", async () => {
  const ctx = createMockContext([
    {
      stepName: "by_type",
      methodName: "list_findings_by_type",
      data: {
        groups: [
          {
            type: "TTPs/Impact/IAMUser",
            count: 5,
            severities: {
              critical: 1,
              high: 2,
              medium: 2,
              low: 0,
              informational: 0,
            },
            accounts: ["111", "222"],
          },
        ],
        totalTypes: 1,
        totalFindings: 5,
        truncated: false,
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## Top Finding Types"), true);
  assertEquals(result.markdown.includes("IAMUser"), true);
  assertEquals(result.json.topTypes?.length, 1);
});

Deno.test("report escapes pipe characters in titles", async () => {
  const ctx = createMockContext([
    {
      stepName: "critical_findings",
      methodName: "list_findings",
      data: {
        findings: [{
          severity: "CRITICAL",
          title: "foo | bar",
          accountId: "111",
          region: "us-east-1",
          productName: "Hub",
          type: "Test",
        }],
        count: 1,
        truncated: false,
      },
    },
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("foo \\| bar"), true);
  assertEquals(
    result.markdown.includes("foo | bar") &&
      !result.markdown.includes("foo \\| bar"),
    false,
  );
});

Deno.test("report handles malformed step data gracefully", async () => {
  const ctx = createMockContext();
  // Inject a step with corrupt data
  ctx.stepExecutions.push({
    jobName: "collect",
    stepName: "severity_summary",
    modelName: "sh-findings",
    modelType: "@webframp/aws/securityhub-findings",
    modelId: "test-id",
    methodName: "get_severity_summary",
    status: "succeeded",
    dataHandles: [{ name: "severity_summary", dataId: "d-1", version: 1 }],
  });
  ctx.dataRepository.getContent = () =>
    Promise.resolve(new TextEncoder().encode("not valid json{{{"));
  const result = await report.execute(ctx);
  // Should not throw, should produce No Data
  assertEquals(result.markdown.includes("## No Data"), true);
});
