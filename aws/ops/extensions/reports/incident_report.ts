// AWS Incident Investigation Report
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

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

export const report = {
  name: "@webframp/incident-report",
  description:
    "Summarizes findings from the investigate-outage workflow into an actionable incident report",
  scope: "workflow" as const,
  labels: ["aws", "incident-response", "ops", "observability"],

  execute: async (context: WorkflowReportContext) => {
    const findings: string[] = [];
    const jsonFindings: Record<string, unknown> = {
      workflowName: context.workflowName,
      workflowStatus: context.workflowStatus,
      timestamp: new Date().toISOString(),
    };

    // Helper to get data from filesystem
    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        // Data path: .swamp/data/{modelType}/{modelId}/{dataName}/{version}/raw
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    interface DataLocation {
      modelType: string;
      modelId: string;
      dataName: string;
      version: number;
    }

    // Helper to find step data by model and method
    function findStepData(
      modelName: string,
      methodName: string,
    ): DataLocation | null {
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName && step.methodName === methodName) {
          // Return first non-report data handle
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

    // Helper to find all data for a model/method
    function findAllStepData(
      modelName: string,
      methodName?: string,
    ): Array<{ stepName: string; loc: DataLocation }> {
      const results: Array<{ stepName: string; loc: DataLocation }> = [];
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName) {
          if (methodName && step.methodName !== methodName) continue;
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              results.push({
                stepName: step.stepName,
                loc: {
                  modelType: step.modelType,
                  modelId: step.modelId,
                  dataName: handle.name,
                  version: handle.version,
                },
              });
            }
          }
        }
      }
      return results;
    }

    // Convenience: get data for a model/method
    async function getStepData(
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

    // === ALARMS SECTION ===
    findings.push("## Alarm Status\n");

    const alarmSummaryData = await getStepData("aws-alarms", "get_summary");
    if (alarmSummaryData) {
      if (alarmSummaryData) {
        const summary = alarmSummaryData as {
          total: number;
          inAlarm: number;
          ok: number;
          insufficientData: number;
          byNamespace: Record<string, number>;
          recentStateChanges: Array<{
            alarmName: string;
            previousState: string;
            currentState: string;
            timestamp: string;
          }>;
        };

        if (summary.inAlarm > 0) {
          findings.push(
            `**${summary.inAlarm} alarm(s) currently in ALARM state** out of ${summary.total} total alarms.\n`,
          );
        } else if (summary.total > 0) {
          findings.push(
            `All ${summary.total} alarms are healthy (${summary.ok} OK, ${summary.insufficientData} insufficient data).\n`,
          );
        } else {
          findings.push("No CloudWatch alarms configured in this region.\n");
        }

        if (
          summary.recentStateChanges && summary.recentStateChanges.length > 0
        ) {
          findings.push("\n### Recent State Changes\n");
          findings.push("| Alarm | Previous | Current | Time |");
          findings.push("| ----- | -------- | ------- | ---- |");
          for (const change of summary.recentStateChanges.slice(0, 10)) {
            findings.push(
              `| ${change.alarmName} | ${change.previousState} | ${change.currentState} | ${change.timestamp} |`,
            );
          }
          findings.push("");
        }

        jsonFindings.alarms = {
          total: summary.total,
          inAlarm: summary.inAlarm,
          ok: summary.ok,
          insufficientData: summary.insufficientData,
          recentStateChanges: summary.recentStateChanges?.slice(0, 10) || [],
        };
      } else {
        findings.push("No alarm summary data available.\n");
      }

      // Active alarms detail
      const activeAlarmsData = await getStepData("aws-alarms", "get_active");

      if (activeAlarmsData) {
        const active = activeAlarmsData as {
          alarms: Array<{
            alarmName: string;
            stateReason: string | null;
            metricName: string | null;
            namespace: string | null;
          }>;
          count: number;
        };

        if (active.count > 0) {
          findings.push("\n### Active Alarms Detail\n");
          for (const alarm of active.alarms.slice(0, 10)) {
            findings.push(
              `- **${alarm.alarmName}** (${alarm.namespace || "unknown"}/${
                alarm.metricName || "unknown"
              })`,
            );
            if (alarm.stateReason) {
              findings.push(
                `  - Reason: ${alarm.stateReason.substring(0, 200)}`,
              );
            }
          }
          findings.push("");
        }
      }
    }

    // === METRICS SECTION ===
    findings.push("\n## Metric Analysis\n");

    const metricFindings: Array<{
      metric: string;
      trend: string;
      anomalyCount: number;
      summary: Record<string, number>;
    }> = [];

    // Find all metric analysis data
    const metricStepData = findAllStepData("aws-metrics", "analyze");

    for (const { loc } of metricStepData) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;

      const analysis = data as {
        metric: { metricName: string; namespace: string };
        trend: string;
        anomalies: Array<{
          timestamp: string;
          value: number;
          deviation: number;
        }>;
        summary: {
          min: number;
          max: number;
          avg: number;
          sum: number;
          count: number;
        };
      };

      const metricLabel =
        `${analysis.metric.namespace}/${analysis.metric.metricName}`;
      findings.push(`### ${metricLabel}\n`);
      findings.push(`- **Trend**: ${analysis.trend}`);

      if (analysis.metric.metricName === "Duration") {
        findings.push(
          `- **Range**: ${analysis.summary.min.toFixed(2)}ms - ${
            analysis.summary.max.toFixed(2)
          }ms (avg: ${analysis.summary.avg.toFixed(2)}ms)`,
        );
      } else if (analysis.metric.metricName === "Errors") {
        findings.push(`- **Total errors**: ${analysis.summary.sum.toFixed(0)}`);
      } else {
        findings.push(
          `- **Range**: ${analysis.summary.min.toFixed(2)} - ${
            analysis.summary.max.toFixed(2)
          } (avg: ${analysis.summary.avg.toFixed(2)})`,
        );
      }

      if (analysis.anomalies && analysis.anomalies.length > 0) {
        findings.push(
          `- **Anomalies detected**: ${analysis.anomalies.length} data points`,
        );
        findings.push("\n| Timestamp | Value | Deviation |");
        findings.push("| --------- | ----- | --------- |");
        for (const anomaly of analysis.anomalies.slice(0, 5)) {
          findings.push(
            `| ${anomaly.timestamp} | ${anomaly.value.toFixed(2)} | ${
              anomaly.deviation.toFixed(2)
            }σ |`,
          );
        }
      } else {
        findings.push("- **No anomalies detected**");
      }
      findings.push("");

      metricFindings.push({
        metric: metricLabel,
        trend: analysis.trend,
        anomalyCount: analysis.anomalies?.length || 0,
        summary: analysis.summary,
      });
    }

    if (metricStepData.length === 0) {
      findings.push("No metric analysis data available.\n");
    }

    jsonFindings.metrics = metricFindings;

    // === TRACES SECTION ===
    findings.push("\n## Distributed Tracing\n");

    const traceData = await getStepData("aws-traces", "analyze_errors");
    if (traceData) {
      const analysis = traceData as {
        totalTraces: number;
        faultCount: number;
        errorCount: number;
        throttleCount: number;
        faultRate: number;
        errorRate: number;
        throttleRate: number;
        topFaultyServices: Array<{
          serviceName: string;
          faultCount: number;
        }>;
        topFaultyUrls: Array<{ url: string; faultCount: number }>;
      };

      findings.push("### Error Analysis\n");
      findings.push(`- **Total traces analyzed**: ${analysis.totalTraces}`);
      findings.push(
        `- **Faults**: ${analysis.faultCount} (${
          (analysis.faultRate * 100).toFixed(1)
        }%)`,
      );
      findings.push(
        `- **Errors**: ${analysis.errorCount} (${
          (analysis.errorRate * 100).toFixed(1)
        }%)`,
      );
      findings.push(`- **Throttles**: ${analysis.throttleCount}`);

      if (
        analysis.topFaultyServices && analysis.topFaultyServices.length > 0
      ) {
        findings.push("\n### Top Faulty Services\n");
        findings.push("| Service | Fault Count |");
        findings.push("| ------- | ----------- |");
        for (const svc of analysis.topFaultyServices.slice(0, 5)) {
          findings.push(`| ${svc.serviceName} | ${svc.faultCount} |`);
        }
      }

      if (analysis.topFaultyUrls && analysis.topFaultyUrls.length > 0) {
        findings.push("\n### Top Faulty URLs\n");
        findings.push("| URL | Fault Count |");
        findings.push("| --- | ----------- |");
        for (const url of analysis.topFaultyUrls.slice(0, 5)) {
          findings.push(`| ${url.url} | ${url.faultCount} |`);
        }
      }
      findings.push("");

      jsonFindings.traces = {
        totalTraces: analysis.totalTraces,
        faultCount: analysis.faultCount,
        errorCount: analysis.errorCount,
        throttleCount: analysis.throttleCount,
        faultRate: analysis.faultRate,
        errorRate: analysis.errorRate,
        topFaultyServices: analysis.topFaultyServices?.slice(0, 5) || [],
        topFaultyUrls: analysis.topFaultyUrls?.slice(0, 5) || [],
      };
    } else {
      findings.push("No trace analysis data available.\n");
      jsonFindings.traces = { totalTraces: 0 };
    }

    // === LOGS SECTION ===
    const logGroupsData = await getStepData("aws-logs", "list_log_groups");
    if (logGroupsData) {
      const logs = logGroupsData as {
        logGroups: Array<{
          name: string;
          storedBytes: number | null;
          retentionDays: number | null;
        }>;
        count: number;
      };

      findings.push("\n## Log Groups\n");
      findings.push(`Found ${logs.count} log groups in the region.\n`);

      // List groups with largest storage (potential high activity)
      const sortedBySize = [...logs.logGroups]
        .filter((lg) => lg.storedBytes !== null)
        .sort((a, b) => (b.storedBytes || 0) - (a.storedBytes || 0))
        .slice(0, 5);

      if (sortedBySize.length > 0) {
        findings.push("### Largest Log Groups (by storage)\n");
        findings.push("| Log Group | Size |");
        findings.push("| --------- | ---- |");
        for (const lg of sortedBySize) {
          const sizeGB = ((lg.storedBytes || 0) / 1024 / 1024 / 1024).toFixed(
            2,
          );
          findings.push(`| ${lg.name} | ${sizeGB} GB |`);
        }
        findings.push("");
      }

      jsonFindings.logGroups = {
        count: logs.count,
        largestGroups: sortedBySize.map((lg) => ({
          name: lg.name,
          storedBytes: lg.storedBytes,
        })),
      };
    }

    // === LOG ERROR ANALYSIS SECTION ===
    const logErrorsData = await getStepData("aws-logs", "find_errors");
    if (logErrorsData) {
      const errors = logErrorsData as {
        logGroupName: string;
        timeRange: { start: string; end: string };
        totalErrors: number;
        patterns: Array<{
          pattern: string;
          count: number;
          firstOccurrence: string | null;
          lastOccurrence: string | null;
          sampleMessages: string[];
        }>;
        fetchedAt: string;
      };

      findings.push("\n## Log Error Analysis\n");
      findings.push(
        `Found **${errors.totalErrors} error(s)** across **${errors.patterns.length} pattern(s)** in \`${errors.logGroupName}\`.\n`,
      );

      if (errors.patterns.length > 0) {
        findings.push("### Error Patterns\n");
        findings.push("| Pattern | Count | Last Occurrence |");
        findings.push("| ------- | ----- | --------------- |");
        for (const p of errors.patterns) {
          findings.push(
            `| ${p.pattern} | ${p.count} | ${p.lastOccurrence || "N/A"} |`,
          );
        }
        findings.push("");

        // Show sample messages from the first pattern
        const firstPattern = errors.patterns[0];
        if (
          firstPattern.sampleMessages &&
          firstPattern.sampleMessages.length > 0
        ) {
          findings.push("### Sample Messages\n");
          for (const msg of firstPattern.sampleMessages.slice(0, 3)) {
            const sanitized = msg.replace(/\n/g, " ").substring(0, 300);
            findings.push(`> ${sanitized}\n`);
          }
          findings.push("");
        }
      }

      jsonFindings.logErrors = {
        totalErrors: errors.totalErrors,
        patternCount: errors.patterns.length,
        patterns: errors.patterns,
        logGroupName: errors.logGroupName,
      };
    }

    // === RECOMMENDATIONS ===
    findings.push("\n## Recommendations\n");

    const recommendations: string[] = [];

    // Check for active alarms
    const alarmsJson = jsonFindings.alarms as { inAlarm?: number } | undefined;
    if (alarmsJson && alarmsJson.inAlarm && alarmsJson.inAlarm > 0) {
      recommendations.push(
        "- **Investigate active alarms** - Review the alarm details above and correlate with metric anomalies",
      );
    }

    // Check for metric anomalies
    for (const mf of metricFindings) {
      if (mf.anomalyCount > 0) {
        if (mf.metric.includes("Duration")) {
          recommendations.push(
            "- **Review Lambda duration spikes** - High latency detected, check for cold starts or downstream dependencies",
          );
        }
        if (mf.metric.includes("Errors")) {
          recommendations.push(
            "- **Investigate Lambda errors** - Error spikes detected, check function logs for details",
          );
        }
      }
      if (mf.trend === "increasing" && mf.metric.includes("Duration")) {
        recommendations.push(
          "- **Monitor increasing latency trend** - Duration is trending upward, may indicate degradation",
        );
      }
    }

    // Check for trace faults
    const tracesJson = jsonFindings.traces as
      | { faultRate?: number; totalTraces?: number }
      | undefined;
    if (
      tracesJson &&
      tracesJson.totalTraces &&
      tracesJson.totalTraces > 0 &&
      tracesJson.faultRate &&
      tracesJson.faultRate > 0.01
    ) {
      recommendations.push(
        "- **Address service faults** - Fault rate above 1%, investigate the top faulty services listed above",
      );
    }

    // Check for log errors
    const logErrorsJson = jsonFindings.logErrors as
      | { totalErrors?: number; patternCount?: number }
      | undefined;
    if (
      logErrorsJson &&
      logErrorsJson.totalErrors &&
      logErrorsJson.totalErrors > 0
    ) {
      recommendations.push(
        `- **Investigate ${logErrorsJson.totalErrors} error(s) found in Lambda logs** — ${logErrorsJson.patternCount} distinct pattern(s) detected`,
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        "- No critical issues detected. Continue monitoring.",
      );
    }

    findings.push(recommendations.join("\n"));
    findings.push("");

    jsonFindings.recommendations = recommendations;

    // === BUILD FINAL REPORT ===
    const markdown = `# Incident Investigation Report

**Workflow**: ${context.workflowName}
**Status**: ${context.workflowStatus}
**Generated**: ${new Date().toISOString()}

---

${findings.join("\n")}

---

*Report generated by @webframp/incident-report*
`;

    context.logger.info("Generated incident report", {
      workflowName: context.workflowName,
      findingsCount: findings.length,
    });

    return {
      markdown,
      json: jsonFindings,
    };
  },
};
