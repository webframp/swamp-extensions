// Twitch Cross-Channel Moderation Report
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

interface DataLocation {
  modelType: string;
  modelId: string;
  dataName: string;
  version: number;
}

interface ChannelData {
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  gameName: string;
  gameId: string;
  title: string;
  tags: string[];
  fetchedAt: string;
}

interface ChatterEntry {
  userId: string;
  login: string;
  displayName: string;
}

interface ChattersData {
  channel: string;
  chatters: ChatterEntry[];
  count: number;
  fetchedAt: string;
}

interface BanEntry {
  userId: string;
  login: string;
  reason: string;
  moderatorLogin: string;
  createdAt: string;
  expiresAt: string | null;
}

interface BannedUsersData {
  channel: string;
  bans: BanEntry[];
  count: number;
  fetchedAt: string;
}

interface ModEvent {
  eventType: string;
  eventTimestamp: string;
  userId: string;
  userLogin: string;
  channelLogin: string;
}

interface ModEventsData {
  channel: string;
  events: ModEvent[];
  count: number;
  fetchedAt: string;
}

export const report = {
  name: "@webframp/twitch-mod-report",
  description:
    "Cross-channel moderation report highlighting suspicious users, ban overlap, and recent mod activity",
  scope: "workflow" as const,
  labels: ["twitch", "moderation", "audit"],

  execute: async (context: WorkflowReportContext) => {
    const findings: string[] = [];

    // Helper to read data from filesystem
    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        if ([modelType, modelId, dataName].some((s) => s.includes(".."))) {
          return null;
        }
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    // Escape values for safe markdown table rendering
    function escMd(val: string): string {
      return val.replace(/\|/g, "\\|").replace(/\n/g, " ");
    }

    // Find all step execution data locations for a given method name
    function findAllStepData(
      methodName: string,
    ): Array<{ stepName: string; loc: DataLocation }> {
      const results: Array<{ stepName: string; loc: DataLocation }> = [];
      for (const step of context.stepExecutions) {
        if (step.methodName === methodName) {
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

    // Collect all data across channels
    const allChannels: Array<{
      channel: string;
      title: string;
      game: string;
      chatterCount: number;
      banCount: number;
    }> = [];
    const allChatters: Map<string, { login: string; channels: string[] }> =
      new Map();
    const allBans: Map<
      string,
      { login: string; channels: string[]; reasons: Record<string, string> }
    > = new Map();
    const allModEvents: Array<ModEvent & { channel: string }> = [];

    // Gather channel data
    const channelSteps = findAllStepData("get_channel");
    const chatterSteps = findAllStepData("get_chatters");
    const banSteps = findAllStepData("get_banned_users");
    const modEventSteps = findAllStepData("get_mod_events");

    // Build a map of modelId -> channel info from chatters/bans (to get channel name)
    const modelIdToChannel: Map<string, string> = new Map();

    // Process chatters
    for (const { loc } of chatterSteps) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;
      const chatters = data as unknown as ChattersData;
      modelIdToChannel.set(loc.modelId, chatters.channel);

      for (const chatter of chatters.chatters) {
        const existing = allChatters.get(chatter.userId);
        if (existing) {
          existing.channels.push(chatters.channel);
        } else {
          allChatters.set(chatter.userId, {
            login: chatter.login,
            channels: [chatters.channel],
          });
        }
      }
    }

    // Process bans
    for (const { loc } of banSteps) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;
      const banned = data as unknown as BannedUsersData;
      modelIdToChannel.set(loc.modelId, banned.channel);

      for (const ban of banned.bans) {
        const existing = allBans.get(ban.userId);
        if (existing) {
          existing.channels.push(banned.channel);
          existing.reasons[banned.channel] = ban.reason;
        } else {
          allBans.set(ban.userId, {
            login: ban.login,
            channels: [banned.channel],
            reasons: { [banned.channel]: ban.reason },
          });
        }
      }
    }

    // Process channel info and build overview rows
    for (const { loc } of channelSteps) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;
      const ch = data as unknown as ChannelData;
      modelIdToChannel.set(loc.modelId, ch.broadcasterLogin);

      // Count chatters and bans for this channel
      let chatterCount = 0;
      let banCount = 0;

      for (const { loc: cLoc } of chatterSteps) {
        if (cLoc.modelId === loc.modelId) {
          const cData = await getData(
            cLoc.modelType,
            cLoc.modelId,
            cLoc.dataName,
            cLoc.version,
          );
          if (cData) {
            chatterCount = (cData as unknown as ChattersData).count;
          }
        }
      }

      for (const { loc: bLoc } of banSteps) {
        if (bLoc.modelId === loc.modelId) {
          const bData = await getData(
            bLoc.modelType,
            bLoc.modelId,
            bLoc.dataName,
            bLoc.version,
          );
          if (bData) {
            banCount = (bData as unknown as BannedUsersData).count;
          }
        }
      }

      allChannels.push({
        channel: ch.broadcasterLogin,
        title: ch.title,
        game: ch.gameName,
        chatterCount,
        banCount,
      });
    }

    // Process mod events
    for (const { loc } of modEventSteps) {
      const data = await getData(
        loc.modelType,
        loc.modelId,
        loc.dataName,
        loc.version,
      );
      if (!data) continue;
      const events = data as unknown as ModEventsData;
      for (const event of events.events) {
        allModEvents.push({ ...event, channel: events.channel });
      }
    }

    // === SECTION 1: Channel Overview ===
    findings.push("## Channel Overview\n");

    if (allChannels.length > 0) {
      findings.push("| Channel | Title | Game | Chatters | Bans |");
      findings.push("| ------- | ----- | ---- | -------- | ---- |");
      for (const ch of allChannels) {
        findings.push(
          `| ${escMd(ch.channel)} | ${escMd(ch.title)} | ${
            escMd(ch.game)
          } | ${ch.chatterCount} | ${ch.banCount} |`,
        );
      }
      findings.push("");
    } else {
      findings.push("No channel data available.\n");
    }

    // === SECTION 2: Suspicious Users ===
    findings.push("## Suspicious Users\n");

    interface SuspiciousUser {
      userId: string;
      login: string;
      reasons: string[];
      chattingIn: string[];
      bannedIn: string[];
    }

    const suspiciousUsers: SuspiciousUser[] = [];

    for (const [userId, chatterInfo] of allChatters) {
      const banInfo = allBans.get(userId);
      const reasons: string[] = [];
      const bannedIn: string[] = [];

      if (banInfo) {
        // Chatting in one channel but banned in another
        const bannedChannels = banInfo.channels.filter(
          (ch) => !chatterInfo.channels.includes(ch),
        );
        if (bannedChannels.length > 0) {
          reasons.push(
            `Chatting in ${chatterInfo.channels.join(", ")} but banned in ${
              bannedChannels.join(", ")
            }`,
          );
          bannedIn.push(...bannedChannels);
        }
      }

      if (chatterInfo.channels.length > 1) {
        reasons.push(
          `Active in ${chatterInfo.channels.length} channels simultaneously`,
        );
      }

      if (reasons.length > 0) {
        suspiciousUsers.push({
          userId,
          login: chatterInfo.login,
          reasons,
          chattingIn: chatterInfo.channels,
          bannedIn,
        });
      }
    }

    if (suspiciousUsers.length > 0) {
      findings.push("| User | Reasons | Chatting In | Banned In |");
      findings.push("| ---- | ------- | ----------- | --------- |");
      for (const user of suspiciousUsers) {
        findings.push(
          `| ${escMd(user.login)} | ${escMd(user.reasons.join("; "))} | ${
            escMd(user.chattingIn.join(", "))
          } | ${escMd(user.bannedIn.join(", ") || "N/A")} |`,
        );
      }
      findings.push("");
    } else {
      findings.push("No suspicious users detected.\n");
    }

    // === SECTION 3: Ban Overlap ===
    findings.push("## Ban Overlap\n");

    const banOverlap: Array<{
      userId: string;
      login: string;
      channels: string[];
      reasons: Record<string, string>;
    }> = [];

    for (const [userId, banInfo] of allBans) {
      if (banInfo.channels.length >= 2) {
        banOverlap.push({
          userId,
          login: banInfo.login,
          channels: banInfo.channels,
          reasons: banInfo.reasons,
        });
      }
    }

    if (banOverlap.length > 0) {
      findings.push(
        `${banOverlap.length} user(s) banned across multiple channels.\n`,
      );
      findings.push("| User | Channels | Reasons |");
      findings.push("| ---- | -------- | ------- |");
      for (const entry of banOverlap) {
        const reasonsList = entry.channels
          .map((ch) => `${ch}: ${entry.reasons[ch] || "N/A"}`)
          .join("; ");
        findings.push(
          `| ${escMd(entry.login)} | ${escMd(entry.channels.join(", "))} | ${
            escMd(reasonsList)
          } |`,
        );
      }
      findings.push("");
    } else {
      findings.push("No users banned across multiple channels.\n");
    }

    // === SECTION 4: Moderator Changes ===
    findings.push("## Moderator Changes\n");

    if (allModEvents.length > 0) {
      // Sort by timestamp descending
      allModEvents.sort((a, b) =>
        b.eventTimestamp.localeCompare(a.eventTimestamp)
      );

      const capped = allModEvents.slice(0, 50);
      findings.push(
        "| Channel | Event | User | Timestamp |",
      );
      findings.push(
        "| ------- | ----- | ---- | --------- |",
      );
      for (const event of capped) {
        findings.push(
          `| ${escMd(event.channel)} | ${escMd(event.eventType)} | ${
            escMd(event.userLogin)
          } | ${escMd(event.eventTimestamp)} |`,
        );
      }
      findings.push("");
    } else {
      findings.push("No moderator change data available.\n");
    }

    // === BUILD JSON OUTPUT ===
    const jsonOutput = {
      workflowName: context.workflowName,
      workflowStatus: context.workflowStatus,
      timestamp: new Date().toISOString(),
      channels: allChannels,
      suspiciousUsers,
      banOverlap,
      modEvents: allModEvents.slice(0, 50),
    };

    // === BUILD FINAL REPORT ===
    const markdown = `# Twitch Cross-Channel Moderation Report

**Workflow**: ${context.workflowName}
**Status**: ${context.workflowStatus}
**Generated**: ${new Date().toISOString()}

---

${findings.join("\n")}

---

*Report generated by @webframp/twitch-mod-report*
`;

    context.logger.info("Generated moderation report", {
      workflowName: context.workflowName,
      channelCount: allChannels.length,
      suspiciousUserCount: suspiciousUsers.length,
      banOverlapCount: banOverlap.length,
    });

    return {
      markdown,
      json: jsonOutput,
    };
  },
};
