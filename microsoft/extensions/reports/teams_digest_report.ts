// Teams Digest Report
// Surfaces active threads, unread @mentions, and recent activity across chats.
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

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

interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

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

interface TeamsMessage {
  id: string;
  messageType: string;
  createdDateTime: string;
  subject?: string | null;
  importance: string;
  body: { contentType: string; content: string };
  from?: {
    user?: {
      id: string;
      displayName?: string | null;
    } | null;
  } | null;
  mentions?: Array<{
    id: number;
    mentionText: string;
    mentioned?: {
      user?: { id: string; displayName?: string | null };
    };
  }>;
  webUrl?: string | null;
  chatId?: string;
  channelIdentity?: { teamId: string; channelId: string };
}

interface ChatData {
  chatId: string;
  messages: TeamsMessage[];
  totalFetched: number;
  fetchedAt: string;
}

interface ChannelData {
  teamId: string;
  channelId: string;
  channelName: string;
  messages: TeamsMessage[];
  totalFetched: number;
  fetchedAt: string;
}

interface MentionsData {
  messages: TeamsMessage[];
  totalFetched: number;
  fetchedAt: string;
}

export const report = {
  name: "@webframp/teams-digest-report",
  description:
    "Surfaces Teams @mentions, active chat threads, and recent channel activity into a digest view for daily review",
  scope: "workflow" as const,
  labels: ["microsoft", "teams", "digest", "mentions", "productivity"],

  execute: async (context: WorkflowReportContext) => {
    const lines: string[] = [];
    const jsonData: Record<string, unknown> = {
      workflowName: context.workflowName,
      reportedAt: new Date().toISOString(),
    };

    // ---------------------------------------------------------------------------
    // Data loading helper
    // ---------------------------------------------------------------------------

    async function getStepData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        const raw = await context.dataRepository.getContent(
          modelType,
          modelId,
          dataName,
          version,
        );
        if (raw) return JSON.parse(new TextDecoder().decode(raw));
      } catch {
        try {
          const typeArg = { raw: modelType, toDirectoryPath: () => modelType };
          const raw2 = await context.dataRepository.getContent(
            typeArg,
            modelId,
            dataName,
            version,
          );
          if (raw2) return JSON.parse(new TextDecoder().decode(raw2));
        } catch {
          // Data not available — skip.
        }
      }
      return null;
    }

    // Separate buckets by data type based on presence of discriminating fields.
    const mentions: TeamsMessage[] = [];
    const chatMessages: Map<string, TeamsMessage[]> = new Map();
    const channelSummaries: ChannelData[] = [];

    for (const step of context.stepExecutions) {
      if (step.status !== "success") continue;
      for (const handle of step.dataHandles) {
        const data = await getStepData(
          step.modelType,
          step.modelId,
          handle.name,
          handle.version,
        );
        if (!data) continue;

        const dataRecord = data as unknown as MentionsData;
        if (
          Array.isArray(dataRecord.messages) && !("chatId" in data) &&
          !("channelId" in data)
        ) {
          // Mentions resource.
          mentions.push(...dataRecord.messages);
        } else if ("chatId" in data) {
          // Chat messages resource.
          const chat = data as unknown as ChatData;
          const existing = chatMessages.get(chat.chatId) ?? [];
          existing.push(...chat.messages);
          chatMessages.set(chat.chatId, existing);
        } else if ("channelId" in data) {
          // Channel messages resource.
          channelSummaries.push(data as unknown as ChannelData);
        }
      }
    }

    // De-duplicate mentions by message ID.
    const seenMentions = new Set<string>();
    const uniqueMentions = mentions.filter((m) => {
      if (seenMentions.has(m.id)) return false;
      seenMentions.add(m.id);
      return true;
    });

    // Sort mentions by recency.
    uniqueMentions.sort(
      (a, b) =>
        new Date(b.createdDateTime).getTime() -
        new Date(a.createdDateTime).getTime(),
    );

    const totalChatMessages = [...chatMessages.values()].reduce(
      (sum, msgs) => sum + msgs.length,
      0,
    );
    const totalChannelMessages = channelSummaries.reduce(
      (sum, c) => sum + c.messages.length,
      0,
    );

    // ---------------------------------------------------------------------------
    // Build report
    // ---------------------------------------------------------------------------

    lines.push("# Teams Digest Report");
    lines.push("");
    lines.push(
      `Generated: ${
        new Date().toISOString()
      } | Workflow: **${context.workflowName}**`,
    );
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Count |");
    lines.push("|--------|-------|");
    lines.push(`| @Mentions | ${uniqueMentions.length} |`);
    lines.push(`| Active chats | ${chatMessages.size} |`);
    lines.push(`| Chat messages fetched | ${totalChatMessages} |`);
    lines.push(`| Channel threads fetched | ${totalChannelMessages} |`);
    lines.push("");

    // --- @Mentions ---

    if (uniqueMentions.length > 0) {
      lines.push("## @Mentions");
      lines.push("");
      lines.push("| When | From | Preview |");
      lines.push("|------|------|---------|");
      for (const m of uniqueMentions.slice(0, 20)) {
        const from = m.from?.user?.displayName ?? "(unknown)";
        const when = m.createdDateTime.slice(0, 16).replace("T", " ");
        // Strip HTML tags from body content.
        const preview = m.body.content
          .replace(/<[^>]+>/g, "")
          .trim()
          .slice(0, 80);
        lines.push(`| ${when} | ${from} | ${preview} |`);
      }
      lines.push("");
    } else {
      lines.push("## @Mentions");
      lines.push("");
      lines.push("_No @mentions found in the fetched data._");
      lines.push("");
    }

    // --- Active Chats ---

    if (chatMessages.size > 0) {
      lines.push("## Active Chats");
      lines.push("");
      lines.push("| Chat ID | Messages | Most Recent |");
      lines.push("|---------|----------|-------------|");
      for (const [chatId, msgs] of chatMessages) {
        const sorted = [...msgs].sort(
          (a, b) =>
            new Date(b.createdDateTime).getTime() -
            new Date(a.createdDateTime).getTime(),
        );
        const latest = sorted[0]?.createdDateTime.slice(0, 16).replace(
          "T",
          " ",
        ) ?? "—";
        const shortId = chatId.slice(0, 24) + "...";
        lines.push(`| ${shortId} | ${msgs.length} | ${latest} |`);
      }
      lines.push("");
    }

    // --- Channel Activity ---

    if (channelSummaries.length > 0) {
      lines.push("## Channel Activity");
      lines.push("");
      lines.push("| Channel | Messages | Most Recent |");
      lines.push("|---------|----------|-------------|");
      for (const ch of channelSummaries) {
        const sorted = [...ch.messages].sort(
          (a, b) =>
            new Date(b.createdDateTime).getTime() -
            new Date(a.createdDateTime).getTime(),
        );
        const latest = sorted[0]?.createdDateTime.slice(0, 16).replace(
          "T",
          " ",
        ) ?? "—";
        lines.push(
          `| ${ch.channelName} | ${ch.messages.length} | ${latest} |`,
        );
      }
      lines.push("");
    }

    // --- Recommendations ---

    const recommendations: string[] = [];
    if (uniqueMentions.length > 10) {
      recommendations.push(
        `${uniqueMentions.length} @mentions pending — prioritize responses today`,
      );
    }
    if (chatMessages.size > 5) {
      recommendations.push(
        `${chatMessages.size} active chat threads — consider muting low-priority chats`,
      );
    }

    if (recommendations.length > 0) {
      lines.push("## Recommendations");
      lines.push("");
      for (let i = 0; i < recommendations.length; i++) {
        lines.push(`${i + 1}. ${recommendations[i]}`);
      }
      lines.push("");
    }

    jsonData.mentionsCount = uniqueMentions.length;
    jsonData.activeChatCount = chatMessages.size;
    jsonData.totalChatMessages = totalChatMessages;
    jsonData.totalChannelMessages = totalChannelMessages;
    jsonData.topMentions = uniqueMentions.slice(0, 10).map((m) => ({
      id: m.id,
      from: m.from?.user?.displayName,
      createdDateTime: m.createdDateTime,
      preview: m.body.content.replace(/<[^>]+>/g, "").trim().slice(0, 100),
    }));

    context.logger.info(
      "Teams digest: {mentions} mentions, {chats} active chats",
      {
        mentions: uniqueMentions.length,
        chats: chatMessages.size,
      },
    );

    return {
      markdown: lines.join("\n"),
      json: jsonData,
    };
  },
};
