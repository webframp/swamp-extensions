/**
 * Journal Writer — reads swamp research data and writes org-mode journal entries.
 *
 * Consumes data from research-collector and materializes it as org-mode
 * files in ~/org/journal/. One file per day: YYYY-MM-DD-dow.org
 * The org files are the living knowledge store —
 * this model is a data consumer + formatter, not a storage layer.
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

const ALL_SOURCES = [
  "hn",
  "lobsters",
  "sre",
  "ifin",
  "redmonk",
  "arxiv",
] as const;
type SourceName = typeof ALL_SOURCES[number];

const GlobalArgsSchema = z.object({
  orgDir: z.string().default("~/org")
    .describe("Root directory of the org repo (supports ~ expansion)"),
  jrnlSubdir: z.string().default("journal")
    .describe("Subdirectory under orgDir for journal entries"),
  swampBin: z.string().default("swamp")
    .describe(
      "Path to the swamp binary (must be on PATH or specify full path)",
    ),
  repoDir: z.string().default(".")
    .describe("Path to the swamp repo directory"),
  gitUserName: z.string().default("Hermes Research Bot")
    .describe("Git commit user name"),
  gitUserEmail: z.string().default("hermes@localhost")
    .describe("Git commit user email"),
  sources: z.array(z.enum(ALL_SOURCES))
    .default([...ALL_SOURCES])
    .describe(
      "Which sources to include in the journal entry. Omit a source name to disable it.",
    ),
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
  try {
    const output = await child.output();
    return {
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr).trim(),
      success: output.success,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** YYYY-MM-DD dow — used as the org #+DATE and in the filename. */
function formatAsOrgDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${date.getFullYear()}-${
    String(date.getMonth() + 1).padStart(2, "0")
  }-${String(date.getDate()).padStart(2, "0")} ${days[date.getDay()]}`;
}

/** YYYY-MM-DD-dow — used in the filename (lowercase day). */
function formatAsFileSuffix(date: Date): string {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return `${date.getFullYear()}-${
    String(date.getMonth() + 1).padStart(2, "0")
  }-${String(date.getDate()).padStart(2, "0")}-${days[date.getDay()]}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function sanitizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Sanitize and add a tag, dropping empties so FILETAGS never gets a `::` pair. */
function addTag(set: Set<string>, raw: string): void {
  const t = sanitizeTag(raw);
  if (t) set.add(t);
}

// =============================================================================
// Research data reader
// =============================================================================

async function readResearchData(
  swampBin: string,
  repoDir: string,
): Promise<Record<string, unknown> | null> {
  // Try spec name "research" first (the actual output spec of @webframp/research-collector),
  // falling back to legacy "brief" for older instances.
  for (const spec of ["research", "brief"]) {
    const result = await runCommand(
      [swampBin, "data", "get", "research-collector", spec, "--json"],
      repoDir,
      15000,
    );
    if (!result.success) continue;
    try {
      const parsed = JSON.parse(result.stdout);
      const content = parsed.content;
      if (typeof content === "string") {
        try {
          return JSON.parse(content);
        } catch {
          continue;
        }
      }
      if (content && typeof content === "object") {
        return content as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// =============================================================================
// Org file builder — one complete standalone file per day
// =============================================================================

function buildDailyFile(
  data: Record<string, unknown>,
  enabledSources: Set<SourceName>,
  now: Date,
): string {
  const orgDate = formatAsOrgDate(now);
  const ts = formatTimestamp(now);

  const allTags: Set<string> = new Set(["research", "journal"]);
  const allSources: string[] = [];

  // Extract each source (guarded — absent if collector didn't fetch it)
  const hnStories = enabledSources.has("hn")
    ? (((data["hnFrontPage"] as Record<string, unknown>)?.stories ??
      []) as Array<Record<string, unknown>>)
    : [];
  const lobStories = enabledSources.has("lobsters")
    ? (((data["lobstersHottest"] as Record<string, unknown>)?.stories ??
      []) as Array<Record<string, unknown>>)
    : [];
  const sreItems = enabledSources.has("sre")
    ? (((data["sreWeekly"] as Record<string, unknown>)?.items ?? []) as Array<
      Record<string, unknown>
    >)
    : [];
  const ifinTopics = enabledSources.has("ifin")
    ? (((data["ifin"] as Record<string, unknown>)?.topics ?? []) as Array<
      Record<string, unknown>
    >)
    : [];
  const redmonkItems = enabledSources.has("redmonk")
    ? (((data["redmonk"] as Record<string, unknown>)?.items ?? []) as Array<
      Record<string, unknown>
    >)
    : [];
  const arxivEntries = enabledSources.has("arxiv")
    ? (((data["arxiv"] as Record<string, unknown>)?.entries ?? []) as Array<
      Record<string, unknown>
    >)
    : [];

  // Collect tags from tagged sources
  for (const s of lobStories) {
    const t = s["tags"] as string[] | undefined;
    if (t) { for (const tag of t) addTag(allTags, tag); }
  }
  for (const t of ifinTopics) {
    const tags = t["tags"] as string[] | undefined;
    if (tags) { for (const tag of tags) addTag(allTags, String(tag)); }
  }
  for (const e of arxivEntries) {
    const cat = e["category"] as string | undefined;
    if (cat) addTag(allTags, cat);
  }

  // Collect source URLs for the SOURCES property
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
  for (const e of arxivEntries) {
    const l = e["link"] as string;
    if (l) allSources.push(l);
  }

  // Org FILETAGS are colon-delimited: `:tag1:tag2:`. Build with a single join
  // so adjacent tags don't produce a `::` (which org parses as an empty tag).
  const sortedTags = Array.from(allTags).sort();
  const filetags = sortedTags.length ? `:${sortedTags.join(":")}:` : "";

  // Build the counts summary line
  const counts: string[] = [];
  if (hnStories.length) counts.push(`${hnStories.length} HN`);
  if (lobStories.length) counts.push(`${lobStories.length} Lobste.rs`);
  if (sreItems.length) counts.push(`${sreItems.length} SRE Weekly`);
  if (ifinTopics.length) counts.push(`${ifinTopics.length} IFIN`);
  if (redmonkItems.length) counts.push(`${redmonkItems.length} RedMonk`);
  if (arxivEntries.length) counts.push(`${arxivEntries.length} arXiv`);

  // === File header ===
  let file = `#+TITLE: Research Journal ${orgDate}\n`;
  file += `#+DATE: <${orgDate}>\n`;
  file += `#+FILETAGS: ${filetags}\n`;
  file += `:PROPERTIES:\n`;
  file += `:SOURCE: research-brief\n`;
  file += `:SOURCES: ${
    allSources.slice(0, 10).map((u) => u.replace(/[\r\n]/g, "")).join(", ")
  }\n`;
  file += `:UPDATED: ${ts}\n`;
  file += `:END:\n\n`;
  file += `Research brief — ${counts.join(", ")}\n\n`;

  // === Sections (level-1 headings — they're the top level in a per-day file) ===
  if (hnStories.length > 0) {
    file += `* Hacker News\n`;
    for (const s of hnStories.slice(0, 10)) {
      const title = s["title"] as string;
      const url = s["url"] as string | null;
      file += `- *${title}* (${s["score"]}pts by ${s["by"]})\n`;
      if (url) file += `  ${url}\n`;
    }
    file += "\n";
  }

  if (lobStories.length > 0) {
    file += `* Lobste.rs\n`;
    for (const s of lobStories.slice(0, 10)) {
      const title = s["title"] as string;
      const tags = (s["tags"] as string[]) ?? [];
      const url = s["url"] as string | null;
      file += `- *${title}* (${s["score"]}pts)\n`;
      if (tags.length > 0) file += `  tags: ${tags.join(", ")}\n`;
      if (url) file += `  ${url}\n`;
    }
    file += "\n";
  }

  if (sreItems.length > 0) {
    file += `* SRE Weekly\n`;
    for (const item of sreItems) {
      const title = item["title"] as string;
      const link = item["link"] as string;
      const desc = (item["description"] as string ?? "").slice(0, 150);
      file += `- *${title}*\n`;
      if (desc) file += `  ${desc}\n`;
      if (link) file += `  ${link}\n`;
    }
    file += "\n";
  }

  if (ifinTopics.length > 0) {
    file += `* IFIN Security Topics\n`;
    for (const t of ifinTopics.slice(0, 8)) {
      const title = t["title"] as string;
      const tags = (t["tags"] as string[]) ?? [];
      const slug = t["slug"] as string;
      const excerpt = (t["excerpt"] as string ?? "").slice(0, 200);
      file += `- *${title}* (${t["views"]} views, ${t["posts_count"]} posts)\n`;
      if (tags.length > 0) file += `  tags: ${tags.join(", ")}\n`;
      if (excerpt) file += `  ${excerpt}\n`;
      if (slug) {
        file += `  https://discourse.ifin.network/t/${slug}/${t["id"]}\n`;
      }
    }
    file += "\n";
  }

  if (redmonkItems.length > 0) {
    file += `* RedMonk\n`;
    for (const item of redmonkItems) {
      const title = item["title"] as string;
      const author = item["author"] as string;
      const link = item["link"] as string;
      file += `- *${title}* by ${author}\n`;
      if (link) file += `  ${link}\n`;
    }
    file += "\n";
  }

  if (arxivEntries.length > 0) {
    file += `* arXiv\n`;
    for (const e of arxivEntries) {
      const title = e["title"] as string;
      const authors = (e["authors"] as string[]) ?? [];
      const link = e["link"] as string;
      const summary = (e["summary"] as string ?? "").replace(/\n/g, " ").slice(
        0,
        200,
      );
      file += `- *${title}*`;
      if (authors.length > 0) file += ` — ${authors.slice(0, 3).join(", ")}`;
      file += "\n";
      if (summary) file += `  ${summary}\n`;
      if (link) file += `  ${link}\n`;
    }
    file += "\n";
  }

  return file;
}

/**
 * Stage and commit a single file. Returns "committed" on success, "nothing" if
 * the file had no changes to commit. Throws (with git's stderr) on a real
 * failure — a caller that logs success unconditionally would otherwise hide a
 * broken commit, which for a persistence model is the worst failure to mask.
 */
async function gitCommit(
  orgDir: string,
  filePath: string,
  userName: string,
  userEmail: string,
  message: string,
): Promise<"committed" | "nothing"> {
  const add = await runCommand(["git", "add", "--", filePath], orgDir);
  if (!add.success) {
    throw new Error(`git add failed: ${add.stderr || "unknown error"}`);
  }
  // Only this file's staged state decides whether there's anything to commit.
  const status = await runCommand(
    ["git", "status", "--porcelain", "--", filePath],
    orgDir,
  );
  if (!status.stdout) return "nothing";
  const commit = await runCommand([
    "git",
    "-c",
    `user.name=${userName}`,
    "-c",
    `user.email=${userEmail}`,
    "commit",
    "-m",
    message,
    "--",
    filePath,
  ], orgDir);
  if (!commit.success) {
    throw new Error(`git commit failed: ${commit.stderr || "unknown error"}`);
  }
  return "committed";
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

  // Expand ~ and validate paths
  const orgDir = cfg.orgDir === "~"
    ? (Deno.env.get("HOME") ?? "")
    : cfg.orgDir.startsWith("~/")
    ? (Deno.env.get("HOME") ?? "") + cfg.orgDir.slice(1)
    : cfg.orgDir;
  if (
    !cfg.jrnlSubdir || cfg.jrnlSubdir.includes("..") ||
    cfg.jrnlSubdir.startsWith("/")
  ) {
    throw new Error(
      `Invalid jrnlSubdir "${cfg.jrnlSubdir}": must be a non-empty relative path without ".." segments`,
    );
  }
  // Validate git user inputs
  const safeNameRe = /^[\w .@+\-]{1,100}$/;
  if (!safeNameRe.test(cfg.gitUserName)) {
    throw new Error(
      `Invalid gitUserName: must match /[\\w .@+-]{1,100}/`,
    );
  }
  if (!safeNameRe.test(cfg.gitUserEmail)) {
    throw new Error(
      `Invalid gitUserEmail: must match /[\\w .@+-]{1,100}/`,
    );
  }

  // `sources` defaults to all via the schema, but guard against an undefined
  // value (e.g. a caller that skips schema validation): no list means all.
  const enabledSources = new Set(
    (cfg.sources ?? ALL_SOURCES) as SourceName[],
  );
  const data = await readResearchData(cfg.swampBin, cfg.repoDir);
  if (!data) {
    ctx.logger.warn(
      "No research data available — run research-brief workflow first",
    );
  }

  const fileSuffix = formatAsFileSuffix(now);
  const orgDate = formatAsOrgDate(now);
  const journalDir = `${orgDir}/${cfg.jrnlSubdir}`;
  const journalFile = `${journalDir}/${fileSuffix}.org`;
  const instanceKey = `daily-${fileSuffix}`;

  await Deno.mkdir(journalDir, { recursive: true });

  // Check for existing file — idempotent, don't overwrite
  try {
    await Deno.stat(journalFile);
    ctx.logger.info("Entry for today already exists, skipping", {
      file: journalFile,
    });
    const handle = await ctx.writeResource("journalEntry", instanceKey, {
      date: orgDate,
      file: journalFile,
      status: "already-exists",
      createdAt: formatTimestamp(now),
    });
    return { dataHandles: [handle] };
  } catch (e) {
    // Only "file doesn't exist" is expected here — proceed to write it.
    // Any other stat failure (permission denied, I/O error) is real: rethrow
    // it with context rather than masking it behind a later writeTextFile error.
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const fileContent = data
    ? buildDailyFile(data, enabledSources, now)
    : `#+TITLE: Research Journal ${orgDate}\n#+DATE: <${orgDate}>\n#+FILETAGS: :research:journal:\n:PROPERTIES:\n:UPDATED: ${
      formatTimestamp(now)
    }\n:END:\n\nNo research data available. Run \`swamp workflow run research-brief\` first.\n`;

  await Deno.writeTextFile(journalFile, fileContent);

  // Stage/commit only this day's file, and let the recorded status reflect what
  // actually reached the remote — logging "Pushed" when the push failed would
  // mask the one failure this model exists to prevent.
  const relFile = `${cfg.jrnlSubdir}/${fileSuffix}.org`;
  let status = "written-not-committed";
  try {
    const committed = await gitCommit(
      orgDir,
      relFile,
      cfg.gitUserName,
      cfg.gitUserEmail,
      `journal: research entry for ${orgDate}`,
    );
    if (committed === "committed") {
      ctx.logger.info(`Committed ${journalFile}`);
    }
    const push = await runCommand(["git", "push"], orgDir, 30000);
    if (push.success) {
      ctx.logger.info("Pushed to remote");
      status = "written";
    } else {
      ctx.logger.warn("Git push failed", {
        error: push.stderr || "non-zero exit",
      });
      status = "committed-not-pushed";
    }
  } catch (e) {
    ctx.logger.warn("Git commit failed", { error: String(e) });
  }

  const handle = await ctx.writeResource("journalEntry", instanceKey, {
    date: orgDate,
    file: journalFile,
    status,
    createdAt: formatTimestamp(now),
  });
  return { dataHandles: [handle] };
}

/** Journal writer model. Reads research-collector data and writes org-mode journal entries with commit and push. */
export const model = {
  type: "@webframp/hermes-journal-writer" as const,
  version: "2026.07.08.1",
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
