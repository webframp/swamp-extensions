/**
 * Report: prioritized action items from @webframp/gitlab dashboard data.
 *
 * Renders a triage-ready view of MRs needing attention (overdue reviews,
 * stale assignments, aging authored MRs) plus pending todos from GitLab.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

export const report = {
  name: "@webframp/review-dashboard",
  description: "Prioritized action items dashboard from cross-project MR data",
  scope: "method" as const,
  labels: ["gitlab", "reviews", "dashboard"],

  async execute(
    context: any,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    let data: any = null;

    const handle = (context.dataHandles ?? [])[0];
    if (handle) {
      try {
        const typeArg = {
          raw: context.modelType,
          toDirectoryPath: () => String(context.modelType),
          toString: () => String(context.modelType),
        };
        const raw = await context.dataRepository.getContent(
          typeArg,
          context.modelId,
          handle.name,
          handle.version,
        );
        if (raw) data = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        try {
          const raw = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            handle.name,
            handle.version,
          );
          if (raw) data = JSON.parse(new TextDecoder().decode(raw));
        } catch { /* fall through */ }
      }
    }

    if (!data) {
      return { markdown: "No dashboard data available.", json: { items: [] } };
    }

    const now = Date.now();
    const DAY = 86400000;

    function age(updatedAt: string): number {
      if (!updatedAt) return 0;
      const ms = new Date(updatedAt).getTime();
      if (isNaN(ms)) return 0;
      return Math.floor((now - ms) / DAY);
    }

    function priority(
      mr: any,
      role: string,
    ): { level: string; reason: string } {
      const days = age(mr.updatedAt);
      if (role === "reviewer" && days > 7) {
        return { level: "🔴", reason: "overdue review" };
      }
      if (role === "reviewer" && days > 3) {
        return { level: "🟡", reason: "aging review" };
      }
      if (role === "reviewer") return { level: "🟢", reason: "recent" };
      if (role === "assigned" && days > 14) {
        return { level: "🔴", reason: "stale assignment" };
      }
      if (role === "assigned" && days > 7) {
        return { level: "🟡", reason: "aging" };
      }
      if (role === "authored" && days > 30) {
        return { level: "🔴", reason: "consider closing" };
      }
      if (role === "authored" && days > 14) {
        return { level: "🟡", reason: "stale" };
      }
      return { level: "🟢", reason: "active" };
    }

    type ActionItem = {
      level: string;
      reason: string;
      role: string;
      project: string;
      title: string;
      author: string;
      days: number;
      draft: boolean;
    };

    const items: ActionItem[] = [];

    for (const mr of data.reviewing ?? []) {
      const p = priority(mr, "reviewer");
      items.push({
        ...p,
        role: "review",
        project: mr.project,
        title: mr.title,
        author: mr.author,
        days: age(mr.updatedAt),
        draft: mr.draft,
      });
    }
    for (const mr of data.assigned ?? []) {
      const p = priority(mr, "assigned");
      items.push({
        ...p,
        role: "assigned",
        project: mr.project,
        title: mr.title,
        author: mr.author,
        days: age(mr.updatedAt),
        draft: mr.draft,
      });
    }
    for (const mr of data.authored ?? []) {
      const p = priority(mr, "authored");
      items.push({
        ...p,
        role: "my MR",
        project: mr.project,
        title: mr.title,
        author: mr.author,
        days: age(mr.updatedAt),
        draft: mr.draft,
      });
    }

    const order = { "🔴": 0, "🟡": 1, "🟢": 2 };
    items.sort((a, b) => {
      const lo = (order[a.level as keyof typeof order] ?? 3) -
        (order[b.level as keyof typeof order] ?? 3);
      return lo !== 0 ? lo : b.days - a.days;
    });

    /** Escape pipe characters to prevent markdown table corruption. */
    const esc = (s: string) => s.replace(/\|/g, "\\|");

    const lines: string[] = [];
    lines.push(`# Review Dashboard — ${data.username}`);
    lines.push("");
    lines.push(
      `**${data.totalCount}** open MRs across ${
        data.reviewing?.length ?? 0
      } reviews, ` +
        `${data.assigned?.length ?? 0} assigned, ${
          data.authored?.length ?? 0
        } authored` +
        (data.todos?.length
          ? `  |  **${data.todos.length}** pending todos`
          : ""),
    );
    lines.push("");

    const overdue = items.filter((i) => i.level === "🔴");
    const aging = items.filter((i) => i.level === "🟡");
    const active = items.filter((i) => i.level === "🟢");

    if (overdue.length > 0) {
      lines.push(`## Action Required (${overdue.length})`);
      lines.push("");
      lines.push("| | Role | MR | Title | Age | Reason |");
      lines.push("|---|------|-----|-------|-----|--------|");
      for (const i of overdue) {
        const draft = i.draft ? " 🚧" : "";
        lines.push(
          `| ${i.level} | ${i.role} | ${esc(i.project)} | ${
            esc(i.title)
          }${draft} | ${i.days}d | ${i.reason} |`,
        );
      }
      lines.push("");
    }

    if (aging.length > 0) {
      lines.push(`## Aging (${aging.length})`);
      lines.push("");
      lines.push("| | Role | MR | Title | Age | Reason |");
      lines.push("|---|------|-----|-------|-----|--------|");
      for (const i of aging) {
        const draft = i.draft ? " 🚧" : "";
        lines.push(
          `| ${i.level} | ${i.role} | ${esc(i.project)} | ${
            esc(i.title)
          }${draft} | ${i.days}d | ${i.reason} |`,
        );
      }
      lines.push("");
    }

    if (active.length > 0) {
      lines.push(`## Active (${active.length})`);
      lines.push("");
      lines.push("| Role | MR | Title | Age |");
      lines.push("|------|-----|-------|-----|");
      for (const i of active) {
        const draft = i.draft ? " 🚧" : "";
        lines.push(
          `| ${i.role} | ${esc(i.project)} | ${
            esc(i.title)
          }${draft} | ${i.days}d |`,
        );
      }
      lines.push("");
    }

    if (data.truncated) {
      lines.push(
        "*Results truncated — more MRs exist beyond the page limit.*",
      );
      lines.push("");
    }

    if (data.todos?.length) {
      lines.push(`## Todos (${data.todos.length})`);
      lines.push("");
      lines.push("| Action | Target | Author | Age |");
      lines.push("|--------|--------|--------|-----|");
      for (const todo of data.todos) {
        const days = age(todo.createdAt);
        lines.push(
          `| ${todo.action} | ${todo.targetType} | ${
            esc(todo.author)
          } | ${days}d |`,
        );
      }
      lines.push("");
    }

    const markdown = lines.join("\n");
    const json = {
      username: data.username,
      totalCount: data.totalCount,
      overdue: overdue.length,
      aging: aging.length,
      active: active.length,
      todos: data.todos?.length ?? 0,
      items,
    };

    return { markdown, json };
  },
};
