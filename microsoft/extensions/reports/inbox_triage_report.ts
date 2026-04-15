// Inbox Triage Report
// Summarizes unread mail by sender and category and surfaces actionable items.
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

interface MailMessage {
  id: string;
  subject: string | null;
  bodyPreview: string;
  isRead: boolean;
  isDraft: boolean;
  importance: string;
  hasAttachments: boolean;
  receivedDateTime: string;
  from?: {
    emailAddress: { name: string; address: string };
  };
  categories?: string[];
  flag?: { flagStatus: string };
  webLink?: string;
}

interface InboxData {
  messages: MailMessage[];
  totalFetched: number;
  fetchedAt: string;
  filter?: string;
}

export const report = {
  name: "@webframp/inbox-triage-report",
  description:
    "Summarizes unread mail by sender and category, surfaces flagged and high-importance messages, and provides an actionable triage list",
  scope: "workflow" as const,
  labels: ["microsoft", "outlook", "mail", "triage", "productivity"],

  execute: async (context: WorkflowReportContext) => {
    const lines: string[] = [];
    const jsonData: Record<string, unknown> = {
      workflowName: context.workflowName,
      reportedAt: new Date().toISOString(),
    };

    // ---------------------------------------------------------------------------
    // Load inbox data from workflow step executions
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

    // Gather all inbox-type resources from step executions.
    const allMessages: MailMessage[] = [];
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
        const inboxData = data as unknown as InboxData;
        if (!Array.isArray(inboxData.messages)) continue;
        allMessages.push(...inboxData.messages);
      }
    }

    // De-duplicate by message ID.
    const seen = new Set<string>();
    const messages = allMessages.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // ---------------------------------------------------------------------------
    // Compute summary statistics
    // ---------------------------------------------------------------------------

    const unread = messages.filter((m) => !m.isRead && !m.isDraft);
    const flagged = messages.filter(
      (m) => m.flag?.flagStatus === "flagged",
    );
    const highImportance = messages.filter(
      (m) => m.importance === "high" && !m.isRead,
    );
    const withAttachments = messages.filter(
      (m) => m.hasAttachments && !m.isRead,
    );

    // Unread count by sender.
    const bySender: Record<string, number> = {};
    for (const m of unread) {
      const sender = m.from?.emailAddress.address ?? "(unknown)";
      bySender[sender] = (bySender[sender] ?? 0) + 1;
    }
    const topSenders = Object.entries(bySender)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // Unread count by category.
    const byCategory: Record<string, number> = {};
    for (const m of unread) {
      const cats = m.categories ?? [];
      if (cats.length === 0) {
        byCategory["(uncategorized)"] = (byCategory["(uncategorized)"] ?? 0) +
          1;
      }
      for (const cat of cats) {
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      }
    }

    // ---------------------------------------------------------------------------
    // Build report
    // ---------------------------------------------------------------------------

    lines.push(`# Inbox Triage Report`);
    lines.push("");
    lines.push(
      `Generated: ${
        new Date().toISOString()
      } | Workflow: **${context.workflowName}**`,
    );
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total messages fetched | ${messages.length} |`);
    lines.push(`| Unread | ${unread.length} |`);
    lines.push(`| Flagged (follow-up) | ${flagged.length} |`);
    lines.push(`| High importance + unread | ${highImportance.length} |`);
    lines.push(`| Has attachments + unread | ${withAttachments.length} |`);
    lines.push("");

    // --- Actionable list ---

    const actionable = [
      ...highImportance.map((m) => ({ reason: "High importance", msg: m })),
      ...flagged
        .filter((m) => !highImportance.includes(m))
        .map((m) => ({ reason: "Flagged", msg: m })),
    ].slice(0, 20);

    if (actionable.length > 0) {
      lines.push("## Actionable Items");
      lines.push("");
      lines.push(
        "| Priority | From | Subject | Received | Reason |",
      );
      lines.push("|----------|------|---------|----------|--------|");
      for (const { reason, msg } of actionable) {
        const from = msg.from?.emailAddress.name ||
          msg.from?.emailAddress.address || "(unknown)";
        const subject = (msg.subject ?? "(no subject)").slice(0, 60);
        const received = msg.receivedDateTime.slice(0, 10);
        lines.push(
          `| ${msg.importance} | ${from} | ${subject} | ${received} | ${reason} |`,
        );
      }
      lines.push("");
    }

    // --- Top senders ---

    if (topSenders.length > 0) {
      lines.push("## Top Senders (Unread)");
      lines.push("");
      lines.push("| Sender | Unread Messages |");
      lines.push("|--------|-----------------|");
      for (const [sender, count] of topSenders) {
        lines.push(`| ${sender} | ${count} |`);
      }
      lines.push("");
    }

    // --- By category ---

    if (Object.keys(byCategory).length > 0) {
      lines.push("## Unread by Category");
      lines.push("");
      lines.push("| Category | Unread |");
      lines.push("|----------|--------|");
      for (
        const [cat, count] of Object.entries(byCategory).sort(
          (a, b) => b[1] - a[1],
        )
      ) {
        lines.push(`| ${cat} | ${count} |`);
      }
      lines.push("");
    }

    // --- Recommendations ---

    const recommendations: string[] = [];
    if (highImportance.length > 5) {
      recommendations.push(
        `${highImportance.length} high-importance messages await attention — review and respond today`,
      );
    }
    if (flagged.length > 10) {
      recommendations.push(
        `${flagged.length} flagged messages — consider archiving or completing resolved items`,
      );
    }
    if (unread.length > 100) {
      recommendations.push(
        `Large unread count (${unread.length}) — consider inbox zero session or triage rules`,
      );
    }
    const topSenderMax = topSenders[0]?.[1] ?? 0;
    if (topSenderMax > 20) {
      recommendations.push(
        `Top sender has ${topSenderMax} unread messages — consider a folder rule or unsubscribe`,
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

    // Store structured data for downstream consumption.
    jsonData.totalMessages = messages.length;
    jsonData.unreadCount = unread.length;
    jsonData.flaggedCount = flagged.length;
    jsonData.highImportanceCount = highImportance.length;
    jsonData.topSenders = topSenders;
    jsonData.byCategory = byCategory;
    jsonData.actionable = actionable.map(({ reason, msg }) => ({
      reason,
      id: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress.address,
      receivedDateTime: msg.receivedDateTime,
    }));

    context.logger.info(
      "Inbox triage: {total} messages, {unread} unread, {flagged} flagged",
      {
        total: messages.length,
        unread: unread.length,
        flagged: flagged.length,
      },
    );

    return {
      markdown: lines.join("\n"),
      json: jsonData,
    };
  },
};
