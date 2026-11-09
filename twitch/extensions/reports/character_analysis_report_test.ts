import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./character_analysis_report.ts";

Deno.test("character analysis report has workflow scope", () => {
  assertEquals(report.name, "@webframp/twitch-character-analysis-report");
  assertEquals(report.scope, "workflow");
});

Deno.test({
  name: "character analysis report degrades when workflow data is unavailable",
  fn: async () => {
    const result = await report.execute({
      workflowName: "@webframp/twitch-character-analysis",
      workflowStatus: "failed",
      stepExecutions: [],
      repoDir: "/tmp/does-not-exist",
      logger: { info: () => {} },
    });

    assertStringIncludes(result.markdown, "@unknown");
    assertStringIncludes(result.markdown, "unavailable");
    assertEquals(result.json.username, "unknown");
  },
});

async function withRepoData<T>(
  files: Record<string, unknown | string>,
  fn: (repoDir: string) => Promise<T>,
): Promise<T> {
  const repoDir = await Deno.makeTempDir();
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = `${repoDir}/.swamp/data/${rel}/1/raw`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(
        path,
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }
    return await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
}

function stepExecutions() {
  return [
    {
      methodName: "get_user_context",
      modelType: "@webframp/twitch",
      modelId: "tw",
      dataHandles: [
        { name: "user-moderation-context-target", dataId: "a", version: 1 },
      ],
    },
    {
      methodName: "ask",
      modelType: "@swamp/typesafe-ai",
      modelId: "jev",
      dataHandles: [
        { name: "evaluation-character-target", dataId: "b", version: 1 },
      ],
    },
  ];
}

const CONTEXT_FILE = "@webframp/twitch/tw/user-moderation-context-target";
const EVALUATION_FILE = "@swamp/typesafe-ai/jev/evaluation-character-target";

function evaluation(humanReview: number) {
  return {
    state: { targetUsername: "target" },
    answers: {
      moderationRisk: { score: 3.256, confidence: 0.8 },
      ruleAdherence: { score: 1, confidence: 0.5 },
      disruption: { score: 2, confidence: 0.25 },
      recommendedAction: { choice: "engage" },
      humanReview: { noul: humanReview },
    },
    evaluatedAt: "2026-11-09T00:00:00Z",
  };
}

function run(
  repoDir: string,
  warn: (msg: string, props: Record<string, unknown>) => void = () => {},
) {
  return report.execute({
    workflowName: "@webframp/twitch-character-analysis",
    workflowStatus: "succeeded",
    stepExecutions: stepExecutions(),
    repoDir,
    logger: { info: () => {}, warn },
  });
}

Deno.test({
  name:
    "character analysis report renders scores, confidence, and an active ban",
  fn: async () => {
    await withRepoData({
      [CONTEXT_FILE]: {
        channel: "testchannel",
        user: { login: "target", accountAgeDays: 42 },
        isCurrentChatter: true,
        ban: { reason: "repeated spam", expiresAt: null },
        availability: { banStatus: true },
      },
      [EVALUATION_FILE]: evaluation(0.9),
    }, async (repoDir) => {
      const result = await run(repoDir);
      assertStringIncludes(result.markdown, "@target");
      assertStringIncludes(result.markdown, "Account age: 42 days");
      assertStringIncludes(result.markdown, "Current chatter: yes");
      assertStringIncludes(
        result.markdown,
        "Current channel ban: active (repeated spam)",
      );
      assertStringIncludes(
        result.markdown,
        "| Moderation risk | 3.26 / 4 | 0.80 |",
      );
      assertStringIncludes(result.markdown, "Recommended posture: **engage**");
      assertStringIncludes(
        result.markdown,
        "Human review before punitive action: **yes**",
      );
    });
  },
});

Deno.test({
  name:
    "character analysis report labels ban status unavailable without broadcaster auth and applies the human-review threshold",
  fn: async () => {
    await withRepoData({
      [CONTEXT_FILE]: {
        channel: "testchannel",
        user: { login: "target", accountAgeDays: 1 },
        isCurrentChatter: null,
        ban: null,
        availability: { banStatus: false },
      },
      [EVALUATION_FILE]: evaluation(0.5),
    }, async (repoDir) => {
      const result = await run(repoDir);
      assertStringIncludes(result.markdown, "Current chatter: unavailable");
      assertStringIncludes(result.markdown, "Current channel ban: unavailable");
      // 0.5 is not above the 0.5 threshold.
      assertStringIncludes(
        result.markdown,
        "Human review before punitive action: **no**",
      );
    });
  },
});

Deno.test({
  name: "character analysis report reports no ban when ban status is available",
  fn: async () => {
    await withRepoData({
      [CONTEXT_FILE]: {
        user: { login: "target" },
        isCurrentChatter: false,
        ban: null,
        availability: { banStatus: true },
      },
      [EVALUATION_FILE]: evaluation(0.1),
    }, async (repoDir) => {
      const result = await run(repoDir);
      assertStringIncludes(result.markdown, "Current chatter: no");
      assertStringIncludes(
        result.markdown,
        "Current channel ban: none observed",
      );
    });
  },
});

Deno.test({
  name: "character analysis report logs a warning when stored data is corrupt",
  fn: async () => {
    await withRepoData({
      [CONTEXT_FILE]: "{ truncated",
      [EVALUATION_FILE]: evaluation(0.9),
    }, async (repoDir) => {
      const warnings: string[] = [];
      const result = await run(repoDir, (_msg, props) => {
        warnings.push(String(props.dataName));
      });
      assertEquals(warnings, ["user-moderation-context-target"]);
      assertStringIncludes(result.markdown, "Account age: unavailable days");
      assertStringIncludes(result.markdown, "| Moderation risk | 3.26 / 4 |");
    });
  },
});
