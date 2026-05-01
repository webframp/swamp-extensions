// Tests for flow metrics report
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./flow_metrics_report.ts";

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

async function writeMockData(
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
    workflowId: "wf-flow",
    workflowRunId: "run-flow-1",
    workflowName: "redmine-flow-metrics",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

Deno.test({
  name: "report has correct name and scope",
  fn() {
    assertEquals(report.name, "@webframp/flow-metrics-report");
    assertEquals(report.scope, "workflow");
    assertStringIncludes(report.labels.join(","), "flow-metrics");
    assertStringIncludes(report.labels.join(","), "redmine");
  },
});

Deno.test({
  name: "report handles no data gracefully",
  sanitizeResources: false, // async file operations in temp dirs
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = makeContext(tmpDir, []);
      const result = await report.execute(context);

      assertEquals(typeof result.markdown, "string");
      assertStringIncludes(result.markdown, "No issue data");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report computes cycle time from journal status transitions",
  sanitizeResources: false, // async file operations in temp dirs
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/redmine";
      const modelId = "tracker";

      // Issue list with one closed issue
      const issueListData = {
        issues: [
          {
            id: 101,
            subject: "Fix login bug",
            status: { id: 5, name: "Closed" },
            created_on: "2026-04-01T00:00:00Z",
            updated_on: "2026-04-10T00:00:00Z",
            closed_on: "2026-04-10T00:00:00Z",
          },
        ],
      };

      // Issue detail with journals showing status transitions
      const issueDetailData = {
        issue: {
          id: 101,
          subject: "Fix login bug",
          status: { id: 5, name: "Closed" },
          created_on: "2026-04-01T00:00:00Z",
          updated_on: "2026-04-10T00:00:00Z",
          closed_on: "2026-04-10T00:00:00Z",
          journals: [
            {
              id: 1,
              created_on: "2026-04-03T00:00:00Z",
              details: [
                {
                  property: "attr",
                  name: "status_id",
                  old_value: "1",
                  new_value: "2",
                },
              ],
            },
            {
              id: 2,
              created_on: "2026-04-08T00:00:00Z",
              details: [
                {
                  property: "attr",
                  name: "status_id",
                  old_value: "2",
                  new_value: "4",
                },
              ],
            },
            {
              id: 3,
              created_on: "2026-04-10T00:00:00Z",
              details: [
                {
                  property: "attr",
                  name: "status_id",
                  old_value: "4",
                  new_value: "5",
                },
              ],
            },
          ],
        },
      };

      await writeMockData(
        tmpDir,
        modelType,
        modelId,
        "issues",
        1,
        issueListData,
      );
      await writeMockData(
        tmpDir,
        modelType,
        modelId,
        "issue-101",
        1,
        issueDetailData,
      );

      const steps = [
        makeStep(
          "redmine",
          modelType,
          modelId,
          "list_issues",
          "issues",
        ),
        makeStep(
          "redmine",
          modelType,
          modelId,
          "get_issue",
          "issue-101",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      // Lead time: Apr 1 to Apr 10 = 9 days
      assertStringIncludes(result.markdown, "9");
      // Cycle time: Apr 3 (first status transition) to Apr 10 = 7 days
      assertStringIncludes(result.markdown, "7");
      // Throughput
      assertStringIncludes(result.markdown, "Closed issues in dataset: 1");
      // Issue details table
      assertStringIncludes(result.markdown, "Fix login bug");
      assertStringIncludes(result.markdown, "9 days");
      assertStringIncludes(result.markdown, "7 days");

      // Verify JSON structure
      const json = result.json as {
        leadTime: { average: number; sampleSize: number };
        cycleTime: { average: number; sampleSize: number };
        throughput: number;
      };
      assertEquals(json.leadTime.average, 9);
      assertEquals(json.cycleTime.average, 7);
      assertEquals(json.throughput, 1);
      assertEquals(json.leadTime.sampleSize, 1);
      assertEquals(json.cycleTime.sampleSize, 1);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report computes WIP age for in-progress items",
  sanitizeResources: false, // async file operations in temp dirs
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/redmine";
      const modelId = "tracker";

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 3);

      const issueListData = {
        issues: [
          {
            id: 201,
            subject: "Add dashboard widget",
            status: { id: 2, name: "In Progress" },
            created_on: "2026-04-01T00:00:00Z",
            updated_on: yesterday.toISOString(),
          },
        ],
      };

      await writeMockData(
        tmpDir,
        modelType,
        modelId,
        "issues",
        1,
        issueListData,
      );

      const steps = [
        makeStep(
          "redmine",
          modelType,
          modelId,
          "list_issues",
          "issues",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "Add dashboard widget");
      assertStringIncludes(result.markdown, "#201");
      // WIP age should be approximately 3 days
      assertStringIncludes(result.markdown, "3");

      const json = result.json as {
        wipItems: Array<{ id: number; ageDays: number }>;
      };
      assertEquals(json.wipItems.length, 1);
      assertEquals(json.wipItems[0].id, 201);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report computes statistics for multiple closed issues",
  sanitizeResources: false, // async file operations in temp dirs
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/redmine";
      const modelId = "tracker";

      const issueListData = {
        issues: [
          {
            id: 301,
            subject: "Issue A",
            status: { id: 5, name: "Closed" },
            created_on: "2026-04-01T00:00:00Z",
            updated_on: "2026-04-06T00:00:00Z",
            closed_on: "2026-04-06T00:00:00Z",
          },
          {
            id: 302,
            subject: "Issue B",
            status: { id: 5, name: "Closed" },
            created_on: "2026-04-01T00:00:00Z",
            updated_on: "2026-04-11T00:00:00Z",
            closed_on: "2026-04-11T00:00:00Z",
          },
          {
            id: 303,
            subject: "Issue C",
            status: { id: 5, name: "Closed" },
            created_on: "2026-04-01T00:00:00Z",
            updated_on: "2026-04-21T00:00:00Z",
            closed_on: "2026-04-21T00:00:00Z",
          },
        ],
      };

      await writeMockData(
        tmpDir,
        modelType,
        modelId,
        "issues",
        1,
        issueListData,
      );

      const steps = [
        makeStep(
          "redmine",
          modelType,
          modelId,
          "list_issues",
          "issues",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "Closed issues in dataset: 3");

      const json = result.json as {
        leadTime: { average: number; median: number; p90: number };
        throughput: number;
      };
      assertEquals(json.throughput, 3);
      // Lead times: 5, 10, 20 days
      // Average: (5+10+20)/3 = 11.7
      assertEquals(json.leadTime.average, 11.7);
      // Median: 10
      assertEquals(json.leadTime.median, 10);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
