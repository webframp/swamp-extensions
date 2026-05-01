// Tests for sprint summary report
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./sprint_summary_report.ts";

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
    workflowId: "wf-sprint",
    workflowRunId: "run-sprint-1",
    workflowName: "redmine-sprint-summary",
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
    assertEquals(report.name, "@webframp/sprint-summary-report");
    assertEquals(report.scope, "workflow");
    assertStringIncludes(report.labels.join(","), "sprint");
    assertStringIncludes(report.labels.join(","), "redmine");
  },
});

Deno.test({
  name: "report summarizes issues by status, tracker, and assignee",
  sanitizeResources: false, // async file operations in temp dirs
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelType = "@webframp/redmine";
      const modelId = "tracker";

      const issueListData = {
        issues: [
          {
            id: 1,
            subject: "Story A",
            tracker: { id: 1, name: "Story" },
            status: { id: 2, name: "In Progress", is_closed: false },
            assignedTo: { id: 10, name: "Alice" },
            createdOn: "2026-04-01T00:00:00Z",
            closedOn: null,
            customFields: [],
          },
          {
            id: 2,
            subject: "[blocked] Story B needs API access",
            tracker: { id: 1, name: "Story" },
            status: { id: 2, name: "In Progress", is_closed: false },
            assignedTo: { id: 11, name: "Bob" },
            createdOn: "2026-04-02T00:00:00Z",
            closedOn: null,
            customFields: [],
          },
          {
            id: 3,
            subject: "Task C",
            tracker: { id: 2, name: "Task" },
            status: { id: 5, name: "Closed", is_closed: true },
            assignedTo: { id: 10, name: "Alice" },
            createdOn: "2026-04-01T00:00:00Z",
            closedOn: "2026-04-10T00:00:00Z",
            customFields: [],
          },
          {
            id: 4,
            subject: "Task D",
            tracker: { id: 2, name: "Task" },
            status: { id: 1, name: "New", is_closed: false },
            assignedTo: null,
            createdOn: "2026-04-05T00:00:00Z",
            closedOn: null,
            customFields: [],
          },
        ],
        totalCount: 4,
        filters: {},
        fetchedAt: "2026-04-14T00:00:00Z",
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

      // Verify markdown contains expected sections
      assertStringIncludes(result.markdown, "Sprint Summary Report");
      assertStringIncludes(result.markdown, "Total issues");
      assertStringIncludes(result.markdown, "By Status");
      assertStringIncludes(result.markdown, "By Tracker");
      assertStringIncludes(result.markdown, "Assignee Workload");
      assertStringIncludes(result.markdown, "Blocked Items");
      assertStringIncludes(result.markdown, "Recently Completed");

      // Verify JSON
      const json = result.json as {
        total: number;
        completed: number;
        blocked: number;
        byStatus: Record<string, number>;
        byTracker: Record<string, number>;
        byAssignee: Array<{
          name: string;
          total: number;
          inProgress: number;
          completed: number;
        }>;
      };

      assertEquals(json.total, 4);
      assertEquals(json.completed, 1);
      assertEquals(json.blocked, 1);

      // By tracker
      assertEquals(json.byTracker["Story"], 2);
      assertEquals(json.byTracker["Task"], 2);

      // By status
      assertEquals(json.byStatus["In Progress"], 2);
      assertEquals(json.byStatus["Closed"], 1);
      assertEquals(json.byStatus["New"], 1);

      // By assignee - Alice has 2 total (1 in progress, 1 completed)
      const alice = json.byAssignee.find((a) => a.name === "Alice");
      assertEquals(alice?.total, 2);
      assertEquals(alice?.inProgress, 1);
      assertEquals(alice?.completed, 1);

      // Bob has 1 total (1 in progress)
      const bob = json.byAssignee.find((a) => a.name === "Bob");
      assertEquals(bob?.total, 1);
      assertEquals(bob?.inProgress, 1);
      assertEquals(bob?.completed, 0);

      // Unassigned has 1 total
      const unassigned = json.byAssignee.find((a) => a.name === "Unassigned");
      assertEquals(unassigned?.total, 1);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
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
      assertStringIncludes(result.markdown, "No issue data available");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
