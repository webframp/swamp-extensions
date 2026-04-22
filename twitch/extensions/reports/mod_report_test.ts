// Tests for Twitch cross-channel moderation report
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./mod_report.ts";

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
    workflowName: "twitch-mod-audit",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

const MODEL_TYPE = "@webframp/twitch";

Deno.test({
  name: "report structure has correct name, scope, and labels",
  fn() {
    assertEquals(report.name, "@webframp/twitch-mod-report");
    assertEquals(report.scope, "workflow");
    assertEquals(report.labels, ["twitch", "moderation", "audit"]);
  },
});

Deno.test({
  name: "report with no step data returns fallback messages",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = makeContext(tmpDir, []);
      const result = await report.execute(context);

      assertEquals(typeof result.markdown, "string");
      assertEquals(typeof result.json, "object");
      assertStringIncludes(result.markdown, "Channel Overview");
      assertStringIncludes(result.markdown, "No channel data available.");
      assertStringIncludes(result.markdown, "No suspicious users detected.");
      assertStringIncludes(
        result.markdown,
        "No users banned across multiple channels.",
      );
      assertStringIncludes(
        result.markdown,
        "No moderator change data available.",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report with channel data shows channel overview",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modelId = "mod-drongo";

      const channelData = {
        broadcasterId: "123",
        broadcasterLogin: "drongo",
        broadcasterName: "Drongo",
        gameName: "Dota 2",
        gameId: "29595",
        title: "Ranked grind",
        tags: ["English"],
        fetchedAt: "2026-04-22T00:00:00Z",
      };
      const chattersData = {
        channel: "drongo",
        chatters: [
          { userId: "1", login: "viewer1", displayName: "Viewer1" },
          { userId: "2", login: "viewer2", displayName: "Viewer2" },
        ],
        count: 2,
        fetchedAt: "2026-04-22T00:00:00Z",
      };
      const bannedData = {
        channel: "drongo",
        bans: [
          {
            userId: "99",
            login: "troll",
            reason: "spam",
            moderatorLogin: "mod1",
            createdAt: "2026-04-21T00:00:00Z",
            expiresAt: null,
          },
        ],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      };

      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        modelId,
        "channel",
        1,
        channelData,
      );
      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        modelId,
        "chatters",
        1,
        chattersData,
      );
      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        modelId,
        "banned-users",
        1,
        bannedData,
      );

      const steps = [
        makeStep(
          "mod-drongo",
          MODEL_TYPE,
          modelId,
          "get_channel",
          "channel",
        ),
        makeStep(
          "mod-drongo",
          MODEL_TYPE,
          modelId,
          "get_chatters",
          "chatters",
        ),
        makeStep(
          "mod-drongo",
          MODEL_TYPE,
          modelId,
          "get_banned_users",
          "banned-users",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "drongo");
      assertStringIncludes(result.markdown, "Dota 2");
      assertStringIncludes(result.markdown, "Ranked grind");

      const json = result.json as {
        channels: Array<{ channel: string }>;
      };
      assertEquals(json.channels.length, 1);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report detects ban overlap across channels",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const bannedCh1 = {
        channel: "ch1",
        bans: [
          {
            userId: "666",
            login: "serial_offender",
            reason: "toxic",
            moderatorLogin: "mod1",
            createdAt: "2026-04-21T00:00:00Z",
            expiresAt: null,
          },
        ],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      };
      const bannedCh2 = {
        channel: "ch2",
        bans: [
          {
            userId: "666",
            login: "serial_offender",
            reason: "harassment",
            moderatorLogin: "mod2",
            createdAt: "2026-04-21T00:00:00Z",
            expiresAt: null,
          },
        ],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      };

      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        "mod-ch1",
        "banned-users",
        1,
        bannedCh1,
      );
      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        "mod-ch2",
        "banned-users",
        1,
        bannedCh2,
      );

      const steps = [
        makeStep(
          "mod-ch1",
          MODEL_TYPE,
          "mod-ch1",
          "get_banned_users",
          "banned-users",
        ),
        makeStep(
          "mod-ch2",
          MODEL_TYPE,
          "mod-ch2",
          "get_banned_users",
          "banned-users",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "serial_offender");
      assertStringIncludes(result.markdown, "Ban Overlap");

      const json = result.json as {
        banOverlap: Array<{ userId: string; channels: string[] }>;
      };
      assertEquals(json.banOverlap.length, 1);
      assertEquals(json.banOverlap[0].channels.length, 2);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "report detects suspicious user chatting in one channel but banned in another",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const chattersCh1 = {
        channel: "ch1",
        chatters: [
          { userId: "777", login: "sneaky", displayName: "Sneaky" },
        ],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      };
      const bannedCh2 = {
        channel: "ch2",
        bans: [
          {
            userId: "777",
            login: "sneaky",
            reason: "ban evasion",
            moderatorLogin: "mod2",
            createdAt: "2026-04-21T00:00:00Z",
            expiresAt: null,
          },
        ],
        count: 1,
        fetchedAt: "2026-04-22T00:00:00Z",
      };

      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        "mod-ch1",
        "chatters",
        1,
        chattersCh1,
      );
      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        "mod-ch2",
        "banned-users",
        1,
        bannedCh2,
      );

      const steps = [
        makeStep(
          "mod-ch1",
          MODEL_TYPE,
          "mod-ch1",
          "get_chatters",
          "chatters",
        ),
        makeStep(
          "mod-ch2",
          MODEL_TYPE,
          "mod-ch2",
          "get_banned_users",
          "banned-users",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "sneaky");
      assertStringIncludes(result.markdown, "Suspicious Users");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report shows mod events timeline sorted by timestamp",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    try {
      const modEvents = {
        channel: "ch1",
        events: [
          {
            eventType: "moderation.user.ban",
            eventTimestamp: "2026-04-22T10:00:00Z",
            userId: "888",
            userLogin: "bad_user",
            channelLogin: "mod1",
          },
          {
            eventType: "moderation.user.timeout",
            eventTimestamp: "2026-04-22T09:00:00Z",
            userId: "889",
            userLogin: "annoying_user",
            channelLogin: "mod1",
          },
        ],
        count: 2,
        fetchedAt: "2026-04-22T00:00:00Z",
      };

      await writeStepData(
        tmpDir,
        MODEL_TYPE,
        "mod-ch1",
        "mod-events",
        1,
        modEvents,
      );

      const steps = [
        makeStep(
          "mod-ch1",
          MODEL_TYPE,
          "mod-ch1",
          "get_mod_events",
          "mod-events",
        ),
      ];

      const context = makeContext(tmpDir, steps);
      const result = await report.execute(context);

      assertStringIncludes(result.markdown, "bad_user");
      assertStringIncludes(result.markdown, "moderation.user.ban");
      // Verify descending sort: 10:00 event appears before 09:00 event
      const banIdx = result.markdown.indexOf("bad_user");
      const timeoutIdx = result.markdown.indexOf("annoying_user");
      assertEquals(banIdx < timeoutIdx, true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
