/**
 * Journal Writer — reads swamp research data and writes org-mode journal entries.
 *
 * Consumes data from research-collector and materializes it as org-mode
 * files in ~/org/journal/. The org files are the living knowledge store —
 * this model is a data consumer + formatter, not a storage layer.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

const GlobalArgsSchema = z.object({
  orgDir: z.string().default("/home/exedev/org")
    .describe("Root directory of the org repo"),
  jrnlSubdir: z.string().default("journal")
    .describe("Subdirectory under orgDir for journal entries"),
  swampBin: z.string().default("/home/exedev/.local/bin/swamp")
    .describe("Path to the swamp binary"),
  repoDir: z.string().default("/tmp/swamp-fresh")
    .describe("Path to the swamp repo directory"),
  gitUserName: z.string().default("Hermes Research")
    .describe("Git commit user name"),
  gitUserEmail: z.string().default("hermes@tide-wind.exe.xyz")
    .describe("Git commit user email"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string; spec: string; instance: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

async function runCommand(
  cmd: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd,
  });
  const child = command.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch { /* empty */ }
  }, timeoutMs);
  const output = await child.output();
  clearTimeout(timer);
  return {
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
    success: output.success,
  };
}

function _makeHeading(text: string, level: number): string {
  return `${"*".repeat(level)} ${text}`;
}

function formatAsOrgDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${date.getFullYear()}-${
    String(date.getMonth() + 1).padStart(2, "0")
  }-${String(date.getDate()).padStart(2, "0")} ${days[date.getDay()]}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function sanitizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// =============================================================================
// Research data reader
// =============================================================================

async function readResearchData(
  swampBin: string,
  repoDir: string,
): Promise<Record<string, unknown> | null> {
  const result = await runCommand(
    [swampBin, "data", "get", "research-collector", "brief", "--json"],
    repoDir,
    15000,
  );
  if (!result.success) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const content = parsed.content;
    if (typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    }
    if (content && typeof content === "object") {
      return content as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Org entry builder
// =============================================================================

function buildDailyEntry(data: Record<string, unknown>): string {
  const now = new Date();
  const orgDate = formatAsOrgDate(now);
  const ts = formatTimestamp(now);

  const allTags: Set<string> = new Set(["research"]);
  const allSources: string[] = [];

  const hnStories =
    ((data["hnFrontPage"] as Record<string, unknown>)?.stories ?? []) as Array<
      Record<string, unknown>
    >;
  const lobStories =
    ((data["lobstersHottest"] as Record<string, unknown>)?.stories ??
      []) as Array<Record<string, unknown>>;
  const sreItems =
    ((data["sreWeekly"] as Record<string, unknown>)?.items ?? []) as Array<
      Record<string, unknown>
    >;
  const ifinTopics =
    ((data["ifin"] as Record<string, unknown>)?.topics ?? []) as Array<
      Record<string, unknown>
    >;
  const redmonkItems =
    ((data["redmonk"] as Record<string, unknown>)?.items ?? []) as Array<
      Record<string, unknown>
    >;

  for (const s of lobStories) {
    const t = s["tags"] as string[] | undefined;
    if (t) { for (const tag of t) allTags.add(sanitizeTag(tag)); }
  }
  for (const t of ifinTopics) {
    const tags = t["tags"] as string[] | undefined;
    if (tags) { for (const tag of tags) allTags.add(sanitizeTag(String(tag))); }
  }

  for (const s of hnStories) {
    const u = s["url"] as string | null;
    if (u) allSources.push(u);
  }
  for (const s of lobStories) {
    const u = s["url"] as string | null;
    if (u) allSources.push(u);
  }
  for (const item of sreItems) {
    const l = item["link"] as string;
    if (l) allSources.push(l);
  }
  for (const t of ifinTopics) {
    const slug = t["slug"] as string;
    if (slug) {
      allSources.push(`https://discourse.ifin.network/t/${slug}/${t["id"]}`);
    }
  }
  for (const item of redmonkItems) {
    const l = item["link"] as string;
    if (l) allSources.push(l);
  }

  const tagList = Array.from(allTags).sort().join(" ");

  let entry = `*** ${orgDate}\n`;
  entry += ":PROPERTIES:\n";
  entry += `:SOURCE: research-brief\n`;
  entry += `:TAGS: ${tagList}\n`;
  entry += `:SOURCES: ${allSources.slice(0, 10).join(", ")}\n`;
  entry += `:UPDATED: ${ts}\n`;
  entry += ":END:\n\n";
  entry +=
    `Research brief — ${hnStories.length} HN, ${lobStories.length} Lobste.rs, ${sreItems.length} SRE Weekly, ${ifinTopics.length} IFIN, ${redmonkItems.length} RedMonk\n\n`;

  if (hnStories.length > 0) {
    entry += `** Hacker News\n`;
    for (const s of hnStories.slice(0, 10)) {
      const title = s["title"] as string;
      const url = s["url"] as string | null;
      entry += `- **${title}** (${s["score"]}pts by ${s["by"]})\n`;
      if (url) entry += `  ${url}\n`;
    }
    entry += "\n";
  }

  if (lobStories.length > 0) {
    entry += `** Lobste.rs\n`;
    for (const s of lobStories.slice(0, 10)) {
      const title = s["title"] as string;
      const tags = (s["tags"] as string[]) ?? [];
      const url = s["url"] as string | null;
      entry += `- **${title}** (${s["score"]}pts)\n`;
      if (tags.length > 0) entry += `  tags: ${tags.join(", ")}\n`;
      if (url) entry += `  ${url}\n`;
    }
    entry += "\n";
  }

  if (sreItems.length > 0) {
    entry += `** SRE Weekly\n`;
    for (const item of sreItems) {
      const title = item["title"] as string;
      const link = item["link"] as string;
      const desc = (item["description"] as string ?? "").slice(0, 150);
      entry += `- **${title}**\n`;
      if (desc) entry += `  ${desc}\n`;
      if (link) entry += `  ${link}\n`;
    }
    entry += "\n";
  }

  if (ifinTopics.length > 0) {
    entry += `** IFIN Security Topics\n`;
    for (const t of ifinTopics.slice(0, 8)) {
      const title = t["title"] as string;
      const tags = (t["tags"] as string[]) ?? [];
      const slug = t["slug"] as string;
      const excerpt = (t["excerpt"] as string ?? "").slice(0, 200);
      entry += `- **${title}** (${t["views"]} views, ${
        t["posts_count"]
      } posts)\n`;
      if (tags.length > 0) entry += `  tags: ${tags.join(", ")}\n`;
      if (excerpt) entry += `  ${excerpt}\n`;
      if (slug) {
        entry += `  https://discourse.ifin.network/t/${slug}/${t["id"]}\n`;
      }
    }
    entry += "\n";
  }

  if (redmonkItems.length > 0) {
    entry += `** RedMonk\n`;
    for (const item of redmonkItems) {
      const title = item["title"] as string;
      const author = item["author"] as string;
      const link = item["link"] as string;
      entry += `- **${title}** by ${author}\n`;
      if (link) entry += `  ${link}\n`;
    }
    entry += "\n";
  }

  if (allSources.length > 0) {
    entry += `** Sources\n`;
    for (const url of allSources.slice(0, 30)) entry += `- ${url}\n`;
    entry += "\n";
  }

  return entry;
}

async function gitCommit(
  orgDir: string,
  filePath: string,
  userName: string,
  userEmail: string,
  message: string,
): Promise<void> {
  await runCommand(["git", "add", filePath], orgDir);
  const status = await runCommand(["git", "status", "--porcelain"], orgDir);
  if (!status.stdout) return;
  await runCommand([
    "git",
    "-c",
    `user.name=${userName}`,
    "-c",
    `user.email=${userEmail}`,
    "commit",
    "-m",
    message,
  ], orgDir);
}

// =============================================================================
// Methods
// =============================================================================

async function writeDailyEntry(
  _args: Record<string, never>,
  ctx: MethodContext,
): Promise<
  { dataHandles: { spec: string; instance: string; name: string }[] }
> {
  const cfg = ctx.globalArgs;
  const now = new Date();
  ctx.logger.info("Writing daily journal entry");

  const data = await readResearchData(cfg.swampBin, cfg.repoDir);
  if (!data) {
    ctx.logger.warn(
      "No research data available — run research-brief workflow first",
    );
  }

  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const journalDir = `${cfg.orgDir}/${cfg.jrnlSubdir}`;
  const journalFile = `${journalDir}/${year}-${month}.org`;

  await new Deno.Command("mkdir", { args: ["-p", journalDir] }).output();

  const entry = data
    ? buildDailyEntry(data)
    : `*** ${formatAsOrgDate(now)}\n:PROPERTIES:\n:UPDATED: ${
      formatTimestamp(now)
    }\n:END:\n\nNo research data available. Run \`swamp workflow run research-brief\` first.\n\n`;

  let fileExists = true;
  try {
    await Deno.stat(journalFile);
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    await Deno.writeTextFile(
      journalFile,
      `#+TITLE: Research Journal ${year}-${month}\n#+FILETAGS: :research:journal:\n\n${entry}`,
    );
  } else {
    const existing = await Deno.readTextFile(journalFile);
    const todayHeading = `*** ${formatAsOrgDate(now)}`;
    if (existing.includes(todayHeading)) {
      ctx.logger.info("Entry for today already exists, skipping");
      const handle = await ctx.writeResource(
        "journalEntry",
        `daily-${year}-${month}`,
        {
          date: formatAsOrgDate(now),
          file: journalFile,
          status: "already-exists",
          createdAt: formatTimestamp(now),
        },
      );
      return { dataHandles: [handle] };
    }
    await Deno.writeTextFile(journalFile, existing + "\n" + entry);
  }

  try {
    await gitCommit(
      cfg.orgDir,
      cfg.jrnlSubdir,
      cfg.gitUserName,
      cfg.gitUserEmail,
      `Auto-journal: research entry for ${formatAsOrgDate(now)}`,
    );
    ctx.logger.info(`Committed ${journalFile}`);
  } catch (e) {
    ctx.logger.warn("Git commit failed", { error: String(e) });
  }
  try {
    await runCommand(["git", "push"], cfg.orgDir, 30000);
    ctx.logger.info("Pushed to remote");
  } catch (e) {
    ctx.logger.warn("Git push failed", { error: String(e) });
  }

  const handle = await ctx.writeResource(
    "journalEntry",
    `daily-${year}-${month}`,
    {
      date: formatAsOrgDate(now),
      file: journalFile,
      status: "written",
      createdAt: formatTimestamp(now),
    },
  );
  return { dataHandles: [handle] };
}

/** Journal writer model. Reads research-collector data and writes org-mode journal entries with commit and push. */
export const model = {
  type: "@webframp/hermes-journal-writer" as const,
  version: "2026.06.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    journalEntry: {
      description: "Record of a journal entry",
      schema: z.object({
        date: z.string(),
        file: z.string(),
        status: z.string(),
        createdAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    write_daily_entry: {
      description:
        "Write a daily research journal entry to the org repo with commit/push.",
      arguments: z.object({}).strict(),
      execute: writeDailyEntry,
    },
  },
};
