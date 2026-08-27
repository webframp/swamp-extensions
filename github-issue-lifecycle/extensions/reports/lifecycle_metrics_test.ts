import { assertEquals } from "@std/assert";
import { report } from "./lifecycle_metrics.ts";

// NOTE: This report test keeps a hand-rolled dataRepository rather than using
// createReportTestContext. The report matches stored artifacts via
// `entry.tags?.specName`, but the factory's TestData type exposes `attributes`
// and carries no `tags` field, so a factory-backed repository cannot drive this
// report's filtering path. Migrating would require fabricating a field the
// factory does not model — see PR discussion. Revisit if swamp-testing's
// TestData gains a `tags` field.

interface DataEntry {
  name: string;
  version: number;
  tags?: Record<string, string>;
}

/** Build a mock dataRepository backed by an in-memory (specName, issueNumber) map. */
function makeDataRepository(
  records: Array<{ specName: string; data: Record<string, unknown> }>,
) {
  const entries: DataEntry[] = [];
  const content = new Map<string, Uint8Array>();
  records.forEach((r, i) => {
    const name = `${r.specName}-${i}`;
    entries.push({ name, version: 1, tags: { specName: r.specName } });
    content.set(name, new TextEncoder().encode(JSON.stringify(r.data)));
  });
  return {
    findAllForModel: (_type: string, _modelId: string) =>
      Promise.resolve(entries),
    getContent: (_type: string, _modelId: string, name: string) =>
      Promise.resolve(content.get(name) ?? null),
  };
}

function makeContext(
  records: Array<{ specName: string; data: Record<string, unknown> }>,
) {
  return {
    modelType: "@webframp/github-issue-lifecycle",
    modelId: "tracker",
    definition: { id: "tracker", name: "tracker", version: 1 },
    dataRepository: makeDataRepository(records),
    logger: { info: () => {} },
  };
}

Deno.test("lifecycle-metrics: reads retryCount from pullRequest resource directly", async () => {
  const result = await report.execute(
    makeContext([
      {
        specName: "state",
        data: {
          issueNumber: 7,
          phase: "pr_failed",
          transitionedAt: "2026-08-01T00:00:00Z",
          startedAt: "2026-07-30T00:00:00Z",
          iteration: 2,
        },
      },
      {
        specName: "pullRequest",
        data: {
          issueNumber: 7,
          prNumber: 42,
          prUrl: "https://github.com/webframp/swamp-extensions/pull/42",
          status: "failed",
          retryCount: 3,
        },
      },
    ]),
  );

  const issue = result.json.issues.find((i: { issueNumber: number }) =>
    i.issueNumber === 7
  );
  assertEquals(issue!.retryCount, 3);
  assertEquals(result.json.totalRetries, 3);
});

Deno.test("lifecycle-metrics: defaults retryCount to 0 when pullRequest has none", async () => {
  const result = await report.execute(
    makeContext([
      {
        specName: "state",
        data: {
          issueNumber: 10,
          phase: "done",
          transitionedAt: "2026-08-01T00:00:00Z",
          startedAt: "2026-07-30T00:00:00Z",
          iteration: 1,
        },
      },
    ]),
  );

  const issue = result.json.issues.find((i: { issueNumber: number }) =>
    i.issueNumber === 10
  );
  assertEquals(issue!.retryCount, 0);
  assertEquals(result.json.totalRetries, 0);
});

Deno.test("lifecycle-metrics: distinguishes issues via specName tag, not instance name shape", async () => {
  // Two issues, each with a state and a pullRequest entry — proves matching
  // is driven by the specName tag + issueNumber field, not by any assumption
  // about instance naming.
  const result = await report.execute(
    makeContext([
      {
        specName: "state",
        data: {
          issueNumber: 1,
          phase: "implementing",
          transitionedAt: "2026-08-01T00:00:00Z",
          startedAt: "2026-07-30T00:00:00Z",
          iteration: 0,
        },
      },
      {
        specName: "state",
        data: {
          issueNumber: 2,
          phase: "done",
          transitionedAt: "2026-08-02T00:00:00Z",
          startedAt: "2026-07-31T00:00:00Z",
          iteration: 0,
        },
      },
      {
        specName: "pullRequest",
        data: {
          issueNumber: 2,
          prNumber: 5,
          prUrl: "https://github.com/webframp/swamp-extensions/pull/5",
          status: "merged",
          retryCount: 1,
        },
      },
    ]),
  );

  assertEquals(result.json.totalIssues, 2);
  const issue1 = result.json.issues.find((i: { issueNumber: number }) =>
    i.issueNumber === 1
  );
  const issue2 = result.json.issues.find((i: { issueNumber: number }) =>
    i.issueNumber === 2
  );
  assertEquals(issue1!.prUrl, null);
  assertEquals(
    issue2!.prUrl,
    "https://github.com/webframp/swamp-extensions/pull/5",
  );
  assertEquals(issue2!.retryCount, 1);
});
