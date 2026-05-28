// SPDX-License-Identifier: Apache-2.0

/** A reference to data produced by a workflow step execution. */
interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

/** Metadata and outcome for a single workflow step execution. */
interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
  error?: string;
}

/** Unified data repository for reading model data. */
interface DataRepository {
  getContent(
    modelType: string | { raw: string; toDirectoryPath: () => string },
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/** Context provided to the report by the swamp workflow runtime. */
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

// =============================================================================
// Types
// =============================================================================

interface FieldDiff {
  field: string;
  stored: unknown;
  live: unknown;
}

interface ResourceDrift {
  modelName: string;
  logicalId: string;
  cfnType: string;
  status: "unchanged" | "drifted" | "missing" | "sync-failed";
  diffs: FieldDiff[];
  error?: string;
}

interface DriftSummary {
  timestamp: string;
  stackName: string;
  total: number;
  unchanged: number;
  drifted: number;
  missing: number;
  syncFailed: number;
  orphans: number;
  newResources: number;
}

interface ReportResult {
  markdown: string;
  json: { summary: DriftSummary; resources: ResourceDrift[] };
}

// =============================================================================
// Helpers
// =============================================================================

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function truncateValue(value: unknown, maxLen = 40): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "null";
  } catch {
    s = "[unserializable]";
  }
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Deep-diff two plain objects. Returns a list of field paths that differ.
 * Only compares top-level and one level deep (sufficient for AWS resource state).
 */
function diffObjects(
  stored: Record<string, unknown>,
  live: Record<string, unknown>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allKeys = new Set([...Object.keys(stored), ...Object.keys(live)]);

  for (const key of allKeys) {
    const a = stored[key];
    const b = live[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({ field: key, stored: a, live: b });
    }
  }
  return diffs;
}

/**
 * Read data from a model via the data repository. Handles both string-based
 * and object-based type arguments for compatibility across swamp versions.
 */
async function readModelData(
  repo: DataRepository,
  modelType: string,
  modelId: string,
  dataName: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await repo.getContent(modelType, modelId, dataName, version);
    if (raw) return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    try {
      const typeArg = {
        raw: modelType,
        toDirectoryPath: () => modelType,
        toString: () => modelType,
      };
      const raw = await repo.getContent(typeArg, modelId, dataName, version);
      if (raw) return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // Cannot read data
    }
  }
  return null;
}

// =============================================================================
// Report
// =============================================================================

/**
 * Drift detection report for adopted CloudFormation stack resources.
 * Compares stored state (previous get/sync) against fresh sync output
 * and surfaces field-level differences, missing resources, and orphans.
 */
export const report = {
  name: "@webframp/adopt-drift-report",
  description:
    "Compares stored state vs live state for adopted CloudFormation stack resources and surfaces drift",
  scope: "workflow" as const,
  labels: ["aws", "adoption", "drift", "cloudformation"],

  execute: async (
    context: WorkflowReportContext,
  ): Promise<ReportResult> => {
    const sections: string[] = [];
    const resources: ResourceDrift[] = [];
    const timestamp = new Date().toISOString();

    // Find the plan step to get the mapped resources list.
    const planStep = context.stepExecutions.find(
      (s) => s.methodName === "plan_stack_adoption",
    );

    if (
      !planStep || planStep.status !== "succeeded" ||
      !planStep.dataHandles?.length
    ) {
      sections.push(
        "# Drift Report\n\n⚠️ Plan step did not succeed — cannot generate drift report.",
      );
      return {
        markdown: sections.join("\n"),
        json: {
          summary: {
            timestamp,
            stackName: "unknown",
            total: 0,
            unchanged: 0,
            drifted: 0,
            missing: 0,
            syncFailed: 0,
            orphans: 0,
            newResources: 0,
          },
          resources: [],
        },
      };
    }

    // Read the plan data.
    const planData = await readModelData(
      context.dataRepository,
      planStep.modelType,
      planStep.modelId,
      planStep.dataHandles[0].name,
      planStep.dataHandles[0].version,
    );

    const stackName = (planData?.stackName as string) ?? "unknown";
    const mapped = (planData?.mapped ?? []) as Array<{
      logicalId: string;
      modelName: string;
      cfnType: string;
      physicalId: string;
    }>;
    const orphans = (planData?.orphans ?? []) as Array<{ modelName: string }>;

    // Process each sync step to detect drift.
    const syncSteps = context.stepExecutions.filter(
      (s) => s.jobName === "sync-all",
    );

    for (const resource of mapped) {
      const syncStep = syncSteps.find(
        (s) => s.modelName === resource.modelName,
      );

      if (!syncStep) {
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: "sync-failed",
          diffs: [],
          error: "No sync step found — model may not exist",
        });
        continue;
      }

      if (syncStep.status !== "succeeded") {
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: syncStep.error?.includes("not found") ||
              syncStep.error?.includes("NotFound")
            ? "missing"
            : "sync-failed",
          diffs: [],
          error: syncStep.error,
        });
        continue;
      }

      // Read the current (post-sync) and previous (pre-sync) versions.
      if (!syncStep.dataHandles?.length) {
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: "unchanged",
          diffs: [],
        });
        continue;
      }

      const handle = syncStep.dataHandles[0];
      const currentVersion = handle.version;
      // NOTE: This assumes sequential version numbering where version N-1
      // is the pre-sync state. If concurrent operations write intermediate
      // versions, this comparison may produce false drift. A future
      // improvement would store the pre-run version explicitly in the
      // workflow's plan data. In practice, the per-model lock prevents
      // concurrent writes during a single workflow run.
      const previousVersion = currentVersion > 1 ? currentVersion - 1 : null;

      const liveData = await readModelData(
        context.dataRepository,
        syncStep.modelType,
        syncStep.modelId,
        handle.name,
        currentVersion,
      );

      if (!liveData) {
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: "missing",
          diffs: [],
          error: "Sync produced no data — resource may have been deleted",
        });
        continue;
      }

      if (!previousVersion) {
        // First sync ever — no previous to compare against.
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: "unchanged",
          diffs: [],
        });
        continue;
      }

      const storedData = await readModelData(
        context.dataRepository,
        syncStep.modelType,
        syncStep.modelId,
        handle.name,
        previousVersion,
      );

      if (!storedData) {
        resources.push({
          modelName: resource.modelName,
          logicalId: resource.logicalId,
          cfnType: resource.cfnType,
          status: "unchanged",
          diffs: [],
        });
        continue;
      }

      const diffs = diffObjects(storedData, liveData);
      resources.push({
        modelName: resource.modelName,
        logicalId: resource.logicalId,
        cfnType: resource.cfnType,
        status: diffs.length > 0 ? "drifted" : "unchanged",
        diffs,
      });
    }

    // Build summary.
    const summary: DriftSummary = {
      timestamp,
      stackName,
      total: resources.length,
      unchanged: resources.filter((r) => r.status === "unchanged").length,
      drifted: resources.filter((r) => r.status === "drifted").length,
      missing: resources.filter((r) => r.status === "missing").length,
      syncFailed: resources.filter((r) => r.status === "sync-failed").length,
      orphans: orphans.length,
      newResources: 0,
    };

    // Render markdown.
    sections.push(`# Drift Report: ${stackName}`);
    sections.push(`\n*Generated: ${timestamp}*\n`);

    // Summary table.
    sections.push("## Summary\n");
    sections.push("| Status | Count |");
    sections.push("|--------|-------|");
    sections.push(`| ✅ Unchanged | ${summary.unchanged} |`);
    sections.push(`| ⚠️ Drifted | ${summary.drifted} |`);
    sections.push(`| ❌ Missing | ${summary.missing} |`);
    sections.push(`| 🔄 Sync Failed | ${summary.syncFailed} |`);
    sections.push(`| 👻 Orphans | ${summary.orphans} |`);
    sections.push(`| **Total** | **${summary.total}** |`);

    // Drift details.
    const drifted = resources.filter((r) => r.status === "drifted");
    if (drifted.length > 0) {
      sections.push("\n## Drifted Resources\n");
      for (const r of drifted) {
        sections.push(`### ${escapeCell(r.logicalId)} (${r.cfnType})\n`);
        sections.push(`Model: \`${r.modelName}\`\n`);
        sections.push("| Field | Stored | Live |");
        sections.push("|-------|--------|------|");
        for (const d of r.diffs) {
          sections.push(
            `| ${escapeCell(d.field)} | ${
              escapeCell(truncateValue(d.stored))
            } | ${escapeCell(truncateValue(d.live))} |`,
          );
        }
        sections.push("");
      }
    }

    // Missing resources.
    const missing = resources.filter((r) => r.status === "missing");
    if (missing.length > 0) {
      sections.push("\n## Missing Resources\n");
      sections.push(
        "These resources were in the adoption plan but could not be synced:\n",
      );
      for (const r of missing) {
        sections.push(
          `- **${r.logicalId}** (\`${r.modelName}\`): ${
            r.error ?? "resource not found in AWS"
          }`,
        );
      }
    }

    // Sync failures.
    const failed = resources.filter((r) => r.status === "sync-failed");
    if (failed.length > 0) {
      sections.push("\n## Sync Failures\n");
      for (const r of failed) {
        sections.push(
          `- **${r.logicalId}** (\`${r.modelName}\`): ${
            r.error ?? "unknown error"
          }`,
        );
      }
    }

    // Orphans.
    if (orphans.length > 0) {
      sections.push("\n## Orphaned Resources\n");
      sections.push(
        "These models were previously adopted but are no longer in the stack:\n",
      );
      for (const o of orphans) {
        sections.push(`- \`${(o as { modelName: string }).modelName}\``);
      }
    }

    // No drift message.
    if (
      summary.drifted === 0 && summary.missing === 0 && summary.syncFailed === 0
    ) {
      sections.push(
        "\n---\n✅ **No drift detected.** All adopted resources match live state.",
      );
    }

    context.logger.info(
      "Drift report: {drifted} drifted, {unchanged} unchanged, {missing} missing",
      {
        drifted: summary.drifted,
        unchanged: summary.unchanged,
        missing: summary.missing,
      },
    );

    return {
      markdown: sections.join("\n"),
      json: { summary, resources },
    };
  },
};
