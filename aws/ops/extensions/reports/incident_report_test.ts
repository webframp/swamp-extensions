// Tests for incident report
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./incident_report.ts";

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

async function writeStepData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir =
    `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function makeStep(
  modelName: string,
  modelType: string,
  modelId: string,
  methodName: string,
  dataName: string,
  version: number = 1,
): StepExecution {
  return {
    jobName: "test-job",
    stepName: `${modelName}-${methodName}`,
    modelName,
    modelType,
    modelId,
    methodName,
    status: "completed",
    dataHandles: [{ name: dataName, dataId: `data-${dataName}`, version }],
  };
}

function makeContext(
  tmpDir: string,
  stepExecutions: StepExecution[] = [],
) {
  return {
    workflowId: "wf-test",
    workflowRunId: "run-test",
    workflowName: "investigate-outage",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

Deno.test({
  name: "report structure has correct name, scope, and labels",
  fn() {
    assertEquals(report.name, "@webframp/incident-report");
    assertEquals(report.scope, "workflow");
    assertStringIncludes(report.labels.join(","), "aws");
    assertStringIncludes(report.labels.join(","), "incident-response");
  },
});

Deno.test({
  name: "report with no step data returns markdown and json without errors",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = makeContext(tmpDir, []);
      const result = await report.execute(context);

      assertEquals(typeof result.markdown, "string");
      assertEquals(typeof result.json, "object");
      assertStringIncludes(result.markdown, "investigate-outage");
      // With no alarm summary data, the report still renders the alarm section header
      assertStringIncludes(result.markdown, "## Alarm Status");
      assertStringIncludes(
        result.markdown,
        "No trace analysis data available.",
      );
      assertStringIncludes(
        result.markdown,
        "No metric analysis data available.",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with alarm data shows alarm summary and active alarms",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const alarmSummary = {
        total: 5,
        inAlarm: 2,
        ok: 2,
        insufficientData: 1,
        byNamespace: { "AWS/EC2": 3, "AWS/RDS": 2 },
        recentStateChanges: [{
          alarmName: "high-cpu",
          previousState: "OK",
          currentState: "ALARM",
          timestamp: "2026-01-01T00:00:00Z",
        }],
      };
      const activeAlarms = {
        alarms: [{
          alarmName: "high-cpu",
          stateReason: "Threshold crossed",
          metricName: "CPUUtilization",
          namespace: "AWS/EC2",
        }],
        count: 1,
      };

      const modelType = "@webframp/aws/alarms";
      const modelId = "aws-alarms";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "alarm-summary",
        1,
        alarmSummary,
      );
      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "active-alarms",
        1,
        activeAlarms,
      );

      const steps = [
        makeStep(
          "aws-alarms",
          modelType,
          modelId,
          "get_summary",
          "alarm-summary",
        ),
        makeStep(
          "aws-alarms",
          modelType,
          modelId,
          "get_active",
          "active-alarms",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(
        result.markdown,
        "2 alarm(s) currently in ALARM state",
      );
      assertStringIncludes(result.markdown, "high-cpu");
      assertStringIncludes(result.markdown, "Threshold crossed");

      const json = result.json as Record<string, unknown>;
      const alarms = json.alarms as { inAlarm: number };
      assertEquals(alarms.inAlarm, 2);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with trace data shows trace analysis",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const traceAnalysis = {
        totalTraces: 100,
        faultCount: 5,
        errorCount: 10,
        throttleCount: 2,
        faultRate: 0.05,
        errorRate: 0.10,
        throttleRate: 0.02,
        topFaultyServices: [{ serviceName: "api-gateway", faultCount: 3 }],
        topFaultyUrls: [{
          url: "https://api.example.com/users",
          faultCount: 2,
        }],
      };

      const modelType = "@webframp/aws/traces";
      const modelId = "aws-traces";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "trace-errors",
        1,
        traceAnalysis,
      );

      const steps = [
        makeStep(
          "aws-traces",
          modelType,
          modelId,
          "analyze_errors",
          "trace-errors",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(
        result.markdown,
        "Total traces analyzed**: 100",
      );
      assertStringIncludes(result.markdown, "api-gateway");
      assertStringIncludes(
        result.markdown,
        "https://api.example.com/users",
      );

      const json = result.json as Record<string, unknown>;
      const traces = json.traces as { faultRate: number };
      assertEquals(traces.faultRate, 0.05);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "report recommendations include alarm and trace entries when both have issues",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const alarmSummary = {
        total: 5,
        inAlarm: 2,
        ok: 2,
        insufficientData: 1,
        byNamespace: { "AWS/EC2": 3 },
        recentStateChanges: [],
      };

      const traceAnalysis = {
        totalTraces: 100,
        faultCount: 5,
        errorCount: 10,
        throttleCount: 2,
        faultRate: 0.05,
        errorRate: 0.10,
        throttleRate: 0.02,
        topFaultyServices: [{ serviceName: "api-gateway", faultCount: 3 }],
        topFaultyUrls: [],
      };

      const alarmModelType = "@webframp/aws/alarms";
      const traceModelType = "@webframp/aws/traces";

      await writeStepData(
        tmpDir,
        alarmModelType,
        "aws-alarms",
        "alarm-summary",
        1,
        alarmSummary,
      );
      await writeStepData(
        tmpDir,
        traceModelType,
        "aws-traces",
        "trace-errors",
        1,
        traceAnalysis,
      );

      const steps = [
        makeStep(
          "aws-alarms",
          alarmModelType,
          "aws-alarms",
          "get_summary",
          "alarm-summary",
        ),
        makeStep(
          "aws-traces",
          traceModelType,
          "aws-traces",
          "analyze_errors",
          "trace-errors",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      const json = result.json as { recommendations: string[] };
      const recs = json.recommendations.join("\n");
      assertStringIncludes(recs, "Investigate active alarms");
      assertStringIncludes(recs, "Address service faults");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "report with log error data shows error patterns and sanitized messages",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const logErrors = {
        logGroupName: "/aws/lambda/my-func",
        timeRange: { start: "2026-01-01", end: "2026-01-02" },
        totalErrors: 15,
        patterns: [{
          pattern: "NullPointerException",
          count: 10,
          firstOccurrence: "2026-01-01T01:00:00Z",
          lastOccurrence: "2026-01-01T23:00:00Z",
          sampleMessages: [
            "Error: NullPointerException at line 42\nStack trace here",
          ],
        }],
        fetchedAt: "2026-01-02T00:00:00Z",
      };

      const modelType = "@webframp/aws/logs";
      const modelId = "aws-logs";

      await writeStepData(
        tmpDir,
        modelType,
        modelId,
        "log-errors",
        1,
        logErrors,
      );

      const steps = [
        makeStep(
          "aws-logs",
          modelType,
          modelId,
          "find_errors",
          "log-errors",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "15 error(s)");
      assertStringIncludes(result.markdown, "NullPointerException");
      // Verify newlines are sanitized in sample messages (replaced with spaces)
      assertStringIncludes(
        result.markdown,
        "NullPointerException at line 42 Stack trace here",
      );

      const json = result.json as Record<string, unknown>;
      const logErrorsJson = json.logErrors as { totalErrors: number };
      assertEquals(logErrorsJson.totalErrors, 15);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
