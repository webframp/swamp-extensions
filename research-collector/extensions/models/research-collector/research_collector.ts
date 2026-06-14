/**
 * Research data collector — gathers intelligence from HN, Lobste.rs, SRE Weekly,
 * IFIN Discourse, and RedMonk.
 *
 * Configurable counts per source. Hermes can self-tune by editing the model's
 * globalArguments when stories consistently return low-relevance content.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

const GlobalArgsSchema = z.object({
  hnCount: z.number().int().min(5).max(50).default(20)
    .describe("Number of Hacker News front-page stories to fetch"),
  lobstersCount: z.number().int().min(5).max(50).default(20)
    .describe("Number of Lobste.rs hottest stories to fetch"),
  sreCount: z.number().int().min(1).max(20).default(5)
    .describe("Number of SRE Weekly issues to fetch"),
  ifinCount: z.number().int().min(5).max(50).default(15)
    .describe("Number of IFIN Discourse topics to fetch"),
  redmonkCount: z.number().int().min(1).max(20).default(5)
    .describe("Number of RedMonk blog posts to fetch"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (spec: string, instance: string, data: unknown) => Promise<{ name: string; spec: string; instance: string }>;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void; };
}

const HnItemSchema = z.object({
  id: z.number(), title: z.string(), url: z.string().nullable().default(null),
  score: z.number(), by: z.string(), time: z.number(),
  descendants: z.number().default(0), type: z.string(),
});

const LobstersItemSchema = z.object({
  id: z.string(), title: z.string(), url: z.string().nullable().default(null),
  score: z.number(), commentCount: z.number().default(0),
  tags: z.array(z.string()), submitterUser: z.string(), created_at: z.string(),
});

const SreWeeklyItemSchema = z.object({
  title: z.string(), link: z.string(), description: z.string(), published: z.string(),
});

const IfinTopicSchema = z.object({
  id: z.number(), title: z.string(), slug: z.string(),
  tags: z.array(z.string()), excerpt: z.string(),
  created_at: z.string(), bumped_at: z.string(),
  posts_count: z.number(), views: z.number(), like_count: z.number(),
  last_poster_username: z.string(),
});

const RedmonkItemSchema = z.object({
  title: z.string(), link: z.string(), author: z.string(),
  published: z.string(), description: z.string(),
});

const ResearchBriefSchema = z.object({
  hnFrontPage: z.object({ stories: z.array(HnItemSchema), fetchedAt: z.string() }),
  lobstersHottest: z.object({ stories: z.array(LobstersItemSchema), fetchedAt: z.string() }),
  sreWeekly: z.object({ items: z.array(SreWeeklyItemSchema), fetchedAt: z.string() }),
  ifin: z.object({ topics: z.array(IfinTopicSchema), fetchedAt: z.string() }),
  redmonk: z.object({ items: z.array(RedmonkItemSchema), fetchedAt: z.string() }),
  config: z.object({
    hnCount: z.number(), lobstersCount: z.number(),
    sreCount: z.number(), ifinCount: z.number(), redmonkCount: z.number(),
  }),
  fetchedAt: z.string(),
});

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { headers: { "User-Agent": "swamp-research-collector/1.0" }, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.json();
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": "swamp-research-collector/1.0" }, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

async function gatherHnFrontPage(count: number) {
  const ids: number[] = (await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json")) as number[];
  const items = await Promise.all(ids.slice(0, count).map(async (id) => { try { return HnItemSchema.parse(await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)); } catch { return null; } }));
  return { stories: items.filter((i): i is z.infer<typeof HnItemSchema> => i !== null), fetchedAt: new Date().toISOString() };
}

async function gatherLobstersHottest(count: number) {
  const data = await fetchJson("https://lobste.rs/hottest.json") as Record<string, unknown>[];
  const stories = data.slice(0, count).map((item) => ({
    id: String(item["short_id"] ?? ""), title: String(item["title"] ?? ""),
    url: item["url"] ? String(item["url"]) : null, score: Number(item["score"] ?? 0),
    commentCount: Number(item["comment_count"] ?? 0),
    tags: (item["tags"] as string[]) ?? [],
    submitterUser: String((item["submitter_user"] as Record<string, unknown>)?.["username"] ?? ""),
    created_at: String(item["created_at"] ?? ""),
  }));
  return { stories: stories.map((s) => LobstersItemSchema.parse(s)), fetchedAt: new Date().toISOString() };
}

async function queryArxiv(query: string, maxResults = 8) {
  // Kept for reference but arXiv is rate-limiting. Use cautiously.
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}`);
  const entries: z.infer<typeof ArxivEntrySchema>[] = [];
  const totalResultsMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
  const totalResults = totalResultsMatch ? parseInt(totalResultsMatch[1]) : 0;
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m; while ((m = entryRegex.exec(xml)) !== null) {
    const b = m[1]; const idMatch = b.match(/<id[^>]*>([^<]+)<\/id>/);
    if (!idMatch) continue;
    const titleMatch = b.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const summaryMatch = b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const publishedMatch = b.match(/<published[^>]*>([^<]+)<\/published>/);
    const categoryMatch = b.match(/<category[^>]*term\s*=\s*"([^"]+)"/);
    const authors: string[] = [];
    const authorRegex = /<author>[\s\S]*?<name[^>]*>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let a; while ((a = authorRegex.exec(b)) !== null) authors.push(a[1].trim());
    const idVal = idMatch[1].trim().split("/").pop()?.split("v")[0] ?? idVal;
    entries.push({ id: idVal, title: (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim(), summary: (summaryMatch?.[1] ?? "").replace(/\s+/g, " ").trim(), authors, published: publishedMatch?.[1] ?? "", updated: publishedMatch?.[1] ?? "", link: `https://arxiv.org/abs/${idVal}`, category: categoryMatch?.[1] ?? "" });
  }
  return { entries, totalResults, fetchedAt: new Date().toISOString() };
}

async function gatherSreWeekly(count: number) {
  const xml = await fetchText("https://sreweekly.com/feed/");
  const items: z.infer<typeof SreWeeklyItemSchema>[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1]; const t = b.match(/<title>([^<]*)<\/title>/); if (!t) continue;
    const l = b.match(/<link>([^<]*)<\/link>/);
    const d = b.match(/<description>([^<]*)<\/description>/);
    const p = b.match(/<pubDate>([^<]*)<\/pubDate>/);
    items.push({ title: t[1].trim(), link: l?.[1]?.trim() ?? "", description: d?.[1]?.trim() ?? "", published: p?.[1]?.trim() ?? "" });
  }
  return items.slice(0, count);
}

async function gatherIfinDiscourse(count: number) {
  const data = await fetchJson("https://discourse.ifin.network/latest.json") as Record<string, unknown>;
  const topics = (data as any)?.topic_list?.topics ?? [];
  return (topics as any[]).filter((t: any) => !t.pinned && !t.archived).slice(0, count).map((t: any) => ({
    id: t.id, title: t.title, slug: t.slug,
    tags: (t.tags ?? []).map((s: any) => typeof s === "string" ? s : (s.name || s.slug || String(s))),
    excerpt: (t.excerpt ?? "").replace(/<[^>]*>/g, "").slice(0, 300),
    created_at: t.created_at, bumped_at: t.bumped_at,
    posts_count: t.posts_count, views: t.views, like_count: t.like_count,
    last_poster_username: t.last_poster_username ?? "",
  }));
}

async function gatherRedmonk(count: number) {
  const xml = await fetchText("https://redmonk.com/feed/");
  const items: z.infer<typeof RedmonkItemSchema>[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1]; const t = b.match(/<title>([^<]*)<\/title>/); if (!t) continue;
    const l = b.match(/<link>([^<]*)<\/link>/);
    const d = b.match(/<description>([^<]*)<\/description>/);
    const p = b.match(/<pubDate>([^<]*)<\/pubDate>/);
    const a = b.match(/<dc:creator>([^<]*)<\/dc:creator>/);
    items.push({ title: t[1].trim(), link: l?.[1]?.trim() ?? "", author: a?.[1]?.trim() ?? "", description: d?.[1]?.trim() ?? "", published: p?.[1]?.trim() ?? "" });
  }
  return items.slice(0, count);
}

async function gatherAll(_args: Record<string, never>, ctx: MethodContext): Promise<{ dataHandles: { spec: string; instance: string; name: string }[] }> {
  const cfg = ctx.globalArgs;
  ctx.logger.info("Gathering research data from all sources");
  const [hn, lobsters, sre, ifin, redmonk] = await Promise.all([
    gatherHnFrontPage(cfg.hnCount), gatherLobstersHottest(cfg.lobstersCount),
    gatherSreWeekly(cfg.sreCount), gatherIfinDiscourse(cfg.ifinCount),
    gatherRedmonk(cfg.redmonkCount),
  ]);
  const handle = await ctx.writeResource("research", "brief", {
    hnFrontPage: hn, lobstersHottest: lobsters,
    sreWeekly: { items: sre, fetchedAt: new Date().toISOString() },
    ifin: { topics: ifin, fetchedAt: new Date().toISOString() },
    redmonk: { items: redmonk, fetchedAt: new Date().toISOString() },
    config: { hnCount: cfg.hnCount, lobstersCount: cfg.lobstersCount, sreCount: cfg.sreCount, ifinCount: cfg.ifinCount, redmonkCount: cfg.redmonkCount },
    fetchedAt: new Date().toISOString(),
  });
  ctx.logger.info(`Gathered ${hn.stories.length} HN, ${lobsters.stories.length} Lobste.rs, ${sre.length} SRE Weekly, ${ifin.length} IFIN, ${redmonk.length} RedMonk`);
  return { dataHandles: [handle] };
}

export const model = {
  type: "@webframp/research-collector" as const,
  version: "2026.06.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    research: {
      description: "Aggregated research data from HN, Lobste.rs, SRE Weekly, IFIN Discourse, and RedMonk",
      schema: ResearchBriefSchema,
      lifetime: "1h" as const, garbageCollection: 10,
    },
  },
  methods: {
    gather: {
      description: "Gather research data from HN, Lobste.rs, SRE Weekly, IFIN Discourse, and RedMonk.",
      arguments: z.object({}),
      execute: gatherAll,
    },
  },
};
