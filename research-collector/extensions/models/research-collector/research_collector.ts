/**
 * Research data collector — gathers intelligence from HN, Lobste.rs, arXiv,
 * SRE Weekly, IFIN Discourse, RedMonk, and The AI Daily Brief.
 *
 * Configurable counts per source. Hermes can self-tune by editing the model's
 * globalArguments when stories consistently return low-relevance content.
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

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
  arxivCount: z.number().int().min(1).max(30).default(8)
    .describe("Number of arXiv paper entries to fetch"),
  aiDailyBriefDays: z.number().int().min(1).max(14).default(3)
    .describe(
      "Number of recent The AI Daily Brief editions to gather (one per day)",
    ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (spec: string, instance: string, data: unknown) => Promise<
    { name: string; spec: string; instance: string }
  >;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
}

const HnItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string().nullable().default(null),
  score: z.number(),
  by: z.string(),
  time: z.number(),
  descendants: z.number().default(0),
  type: z.string(),
});

const LobstersItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable().default(null),
  score: z.number(),
  commentCount: z.number().default(0),
  tags: z.array(z.string()),
  submitterUser: z.string(),
  created_at: z.string(),
});

const SreWeeklyItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  description: z.string(),
  published: z.string(),
});

const IfinTopicSchema = z.object({
  id: z.number(),
  title: z.string(),
  slug: z.string(),
  tags: z.array(z.string()),
  excerpt: z.string(),
  created_at: z.string(),
  bumped_at: z.string(),
  posts_count: z.number(),
  views: z.number(),
  like_count: z.number(),
  last_poster_username: z.string(),
});

const RedmonkItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  author: z.string(),
  published: z.string(),
  description: z.string(),
});

const ArxivEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  authors: z.array(z.string()),
  published: z.string(),
  updated: z.string(),
  link: z.string(),
  category: z.string(),
});

/**
 * A written analysis "nugget" from a The AI Daily Brief edition. The site
 * publishes daily editions at /e/YYYY-MM-DD; each edition is a thesis plus a
 * set of written takeaways. Editions also link to the audio/video episode —
 * we deliberately keep only the written analysis here and drop video embeds,
 * so downstream briefings get articles + analysis, not video sources.
 */
const AiDailyBriefNuggetSchema = z.object({
  heading: z.string(),
  body: z.string(),
  anchor: z.string().describe("In-page anchor id for deep-linking"),
});

const AiDailyBriefEditionSchema = z.object({
  date: z.string().describe("Edition date as YYYY-MM-DD"),
  url: z.string().describe("Canonical edition URL"),
  title: z.string().describe("Edition headline (ed-h1)"),
  summary: z.string().describe("Edition thesis / og:description"),
  tags: z.array(z.string()).describe("Topical tags shown on the edition"),
  nuggets: z.array(AiDailyBriefNuggetSchema),
});

const ResearchBriefSchema = z.object({
  hnFrontPage: z.object({
    stories: z.array(HnItemSchema),
    fetchedAt: z.string(),
  }),
  lobstersHottest: z.object({
    stories: z.array(LobstersItemSchema),
    fetchedAt: z.string(),
  }),
  sreWeekly: z.object({
    items: z.array(SreWeeklyItemSchema),
    fetchedAt: z.string(),
  }),
  ifin: z.object({
    topics: z.array(IfinTopicSchema),
    fetchedAt: z.string(),
  }),
  redmonk: z.object({
    items: z.array(RedmonkItemSchema),
    fetchedAt: z.string(),
  }),
  arxiv: z.object({
    entries: z.array(ArxivEntrySchema),
    fetchedAt: z.string(),
  }),
  aiDailyBrief: z.object({
    editions: z.array(AiDailyBriefEditionSchema),
    fetchedAt: z.string(),
  }),
  config: z.object({
    hnCount: z.number(),
    lobstersCount: z.number(),
    sreCount: z.number(),
    ifinCount: z.number(),
    redmonkCount: z.number(),
    arxivCount: z.number(),
    aiDailyBriefDays: z.number(),
  }),
  fetchedAt: z.string(),
});

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "swamp-research-collector/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.json();
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "swamp-research-collector/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

async function gatherHnFrontPage(count: number) {
  const ids: number[] = (await fetchJson(
    "https://hacker-news.firebaseio.com/v0/topstories.json",
  )) as number[];
  const items = await Promise.all(
    ids.slice(0, count).map(async (id) => {
      try {
        return HnItemSchema.parse(
          await fetchJson(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
          ),
        );
      } catch {
        return null;
      }
    }),
  );
  return {
    stories: items.filter((i): i is z.infer<typeof HnItemSchema> => i !== null),
    fetchedAt: new Date().toISOString(),
  };
}

async function gatherLobstersHottest(count: number) {
  const data = await fetchJson(
    "https://lobste.rs/hottest.json",
  ) as Record<string, unknown>[];
  const stories = data.slice(0, count).map((item) => ({
    id: String(item["short_id"] ?? ""),
    title: String(item["title"] ?? ""),
    url: item["url"] ? String(item["url"]) : null,
    score: Number(item["score"] ?? 0),
    commentCount: Number(item["comment_count"] ?? 0),
    tags: Array.isArray(item["tags"]) ? (item["tags"] as string[]) : [],
    submitterUser: String(
      (item["submitter_user"] as Record<string, unknown>)?.["username"] ?? "",
    ),
    created_at: String(item["created_at"] ?? ""),
  }));
  return {
    stories: stories.map((s) => LobstersItemSchema.parse(s)),
    fetchedAt: new Date().toISOString(),
  };
}

async function queryArxiv(query: string, maxResults: number) {
  const xml = await fetchText(
    `https://export.arxiv.org/api/query?search_query=${
      encodeURIComponent(query)
    }&start=0&max_results=${maxResults}`,
  );
  const entries: z.infer<typeof ArxivEntrySchema>[] = [];
  const totalResultsMatch = xml.match(
    /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/,
  );
  const totalResults = totalResultsMatch ? parseInt(totalResultsMatch[1]) : 0;
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const idMatch = block.match(/<id[^>]*>([^<]+)<\/id>/);
    if (!idMatch) continue;
    const idVal = idMatch[1].trim().split("/").pop()?.split("v")[0] ?? "";
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const summaryMatch = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const publishedMatch = block.match(/<published[^>]*>([^<]+)<\/published>/);
    const updatedMatch = block.match(/<updated[^>]*>([^<]+)<\/updated>/);
    const categoryMatch = block.match(/<category[^>]*term\s*=\s*"([^"]+)"/);
    const authors: string[] = [];
    const authorRegex =
      /<author>[\s\S]*?<name[^>]*>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let a;
    while ((a = authorRegex.exec(block)) !== null) authors.push(a[1].trim());
    entries.push({
      id: idVal,
      title: (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim(),
      summary: (summaryMatch?.[1] ?? "").replace(/\s+/g, " ").trim(),
      authors,
      published: publishedMatch?.[1] ?? "",
      updated: updatedMatch?.[1] ?? publishedMatch?.[1] ?? "",
      link: `https://arxiv.org/abs/${idVal}`,
      category: categoryMatch?.[1] ?? "",
    });
  }
  return { entries, totalResults, fetchedAt: new Date().toISOString() };
}

async function gatherSreWeekly(
  count: number,
): Promise<z.infer<typeof SreWeeklyItemSchema>[]> {
  const xml = await fetchText("https://sreweekly.com/feed/");
  const stripped = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const items: z.infer<typeof SreWeeklyItemSchema>[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const block = m[1];
    const t = block.match(/<title>([^<]*)<\/title>/);
    if (!t) continue;
    const l = block.match(/<link>([^<]*)<\/link>/);
    const d = block.match(/<description>([^<]*)<\/description>/);
    const p = block.match(/<pubDate>([^<]*)<\/pubDate>/);
    items.push({
      title: t[1].trim(),
      link: l?.[1]?.trim() ?? "",
      description: d?.[1]?.trim() ?? "",
      published: p?.[1]?.trim() ?? "",
    });
  }
  return items.slice(0, count);
}

async function gatherIfinDiscourse(count: number) {
  const data = await fetchJson(
    "https://discourse.ifin.network/latest.json",
  ) as Record<string, unknown>;
  const topicList = data?.topic_list as Record<string, unknown> | undefined;
  const topics = (topicList?.topics ?? []) as Record<string, unknown>[];
  return topics.filter((t) => !t.pinned && !t.archived).slice(0, count).map(
    (t: Record<string, unknown>) => ({
      id: t.id as number,
      title: t.title as string,
      slug: t.slug as string,
      tags: Array.isArray(t.tags) ? (t.tags as string[]).map(String) : [],
      excerpt: ((t.excerpt as string) ?? "").replace(/<[^>]*>/g, "").slice(
        0,
        300,
      ),
      created_at: t.created_at as string,
      bumped_at: t.bumped_at as string,
      posts_count: t.posts_count as number,
      views: t.views as number,
      like_count: t.like_count as number,
      last_poster_username: (t.last_poster_username as string) ?? "",
    }),
  );
}

async function gatherRedmonk(
  count: number,
): Promise<z.infer<typeof RedmonkItemSchema>[]> {
  const xml = await fetchText("https://redmonk.com/feed/");
  const stripped = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const items: z.infer<typeof RedmonkItemSchema>[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const block = m[1];
    const t = block.match(/<title>([^<]*)<\/title>/);
    if (!t) continue;
    const l = block.match(/<link>([^<]*)<\/link>/);
    const d = block.match(/<description>([^<]*)<\/description>/);
    const p = block.match(/<pubDate>([^<]*)<\/pubDate>/);
    const a = block.match(/<dc:creator>([^<]*)<\/dc:creator>/);
    items.push({
      title: t[1].trim(),
      link: l?.[1]?.trim() ?? "",
      author: a?.[1]?.trim() ?? "",
      description: d?.[1]?.trim() ?? "",
      published: p?.[1]?.trim() ?? "",
    });
  }
  return items.slice(0, count);
}

async function gatherArxiv(count: number) {
  // Catch rate-limit errors gracefully — arXiv is unreliable but valuable
  try {
    return await queryArxiv(
      "cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CR+OR+cat:cs.SE",
      count,
    );
  } catch {
    return {
      entries: [] as z.infer<typeof ArxivEntrySchema>[],
      totalResults: 0,
      fetchedAt: new Date().toISOString(),
    };
  }
}

/** Strip HTML tags and decode entities, collapsing whitespace. */
function stripHtml(input: string): string {
  const noTags = input.replace(/<[^>]*>/g, " ");
  const decoded = noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * Pull recent The AI Daily Brief editions from the homepage index, then fetch
 * each edition page and extract its written analysis nuggets. Video/audio
 * embeds are intentionally discarded — only written takeaways are kept.
 */
async function gatherAiDailyBrief(
  days: number,
): Promise<z.infer<typeof AiDailyBriefEditionSchema>[]> {
  // The homepage lists recent editions as links to /e/YYYY-MM-DD.
  const htmlText = await fetchText("https://aidailybrief.ai/");
  const dateSet = new Set<string>();
  const dateRe = /href="\/e\/(\d{4}-\d{2}-\d{2})"/g;
  let dm;
  while ((dm = dateRe.exec(htmlText)) !== null) {
    dateSet.add(dm[1]);
  }
  // Dates are not guaranteed sorted on the page; sort descending (newest first)
  // and take the requested window.
  const dates = Array.from(dateSet).sort().reverse().slice(0, days);
  const editions = await Promise.all(
    dates.map(
      async (
        date,
      ): Promise<z.infer<typeof AiDailyBriefEditionSchema> | null> => {
        try {
          const url = `https://aidailybrief.ai/e/${date}`;
          const page = await fetchText(url);
          // Edition headline lives in <h1 class="ed-h1">…</h1>.
          const h1 = page.match(/<h1 class="ed-h1"[^>]*>([\s\S]*?)<\/h1>/);
          // og:description holds the edition thesis and is always present.
          const desc = page.match(
            /<meta property="og:description" content="([^"]*)"/,
          );
          // Topical tags appear as <span class="tag">…</span> near each nugget.
          const tagSet = new Set<string>();
          const tagRe = /<span class="tag">([^<]*)<\/span>/g;
          let tm;
          while ((tm = tagRe.exec(page)) !== null) {
            const t = stripHtml(tm[1]);
            if (t) tagSet.add(t);
          }
          // Written nuggets: each lives in an <article class="nug-wrap" id="…">
          // wrapper containing an <h3 class="nug-h"> heading and a
          // <p class="nug-b"> written-analysis body. The wrapper's id is the
          // deep-link anchor. Video/audio embeds sit in separate <div
          // class="ep-embed"> elements outside the h3/p pair, so they are
          // naturally excluded — we keep only written analysis.
          const nuggets: z.infer<typeof AiDailyBriefNuggetSchema>[] = [];
          const nugRe =
            /<article class="nug-wrap[^">]*"([^>]*)>([\s\S]*?)<\/article>/g;
          let nm;
          while ((nm = nugRe.exec(page)) !== null) {
            const attrs = nm[1];
            const inner = nm[2];
            const anchorMatch = attrs.match(/id="([^"]*)"/);
            const hm = inner.match(/<h3 class="nug-h"[^>]*>([\s\S]*?)<\/h3>/);
            const bm = inner.match(/<p class="nug-b"[^>]*>([\s\S]*?)<\/p>/);
            if (!hm || !bm) continue;
            nuggets.push({
              heading: stripHtml(hm[1]),
              body: stripHtml(bm[1]),
              anchor: anchorMatch ? anchorMatch[1] : "",
            });
          }
          return {
            date,
            url,
            title: stripHtml(h1?.[1] ?? ""),
            summary: stripHtml(desc?.[1] ?? ""),
            tags: Array.from(tagSet),
            nuggets,
          };
        } catch {
          return null;
        }
      },
    ),
  );
  return editions.filter(
    (e): e is z.infer<typeof AiDailyBriefEditionSchema> => e !== null,
  );
}

/** Gather research data from all configured sources and write a brief resource. */
async function gatherAll(
  _args: Record<string, never>,
  ctx: MethodContext,
): Promise<
  { dataHandles: { spec: string; instance: string; name: string }[] }
> {
  const cfg = ctx.globalArgs;
  ctx.logger.info("Gathering research data from all sources");
  // Each source is independently wrapped so a single source failure
  // never kills the entire brief — partial data is better than no data.
  const [hn, lobsters, sre, ifin, redmonk, arxiv, aiDailyBrief] = await Promise
    .all([
      gatherHnFrontPage(cfg.hnCount).catch(() => ({
        stories: [],
        fetchedAt: new Date().toISOString(),
      })),
      gatherLobstersHottest(cfg.lobstersCount).catch(() => ({
        stories: [],
        fetchedAt: new Date().toISOString(),
      })),
      gatherSreWeekly(cfg.sreCount).catch(() => []),
      gatherIfinDiscourse(cfg.ifinCount).catch(() => []),
      gatherRedmonk(cfg.redmonkCount).catch(() => []),
      gatherArxiv(cfg.arxivCount),
      gatherAiDailyBrief(cfg.aiDailyBriefDays).catch(() => []),
    ]);
  const handle = await ctx.writeResource("research", "brief", {
    hnFrontPage: hn,
    lobstersHottest: lobsters,
    sreWeekly: { items: sre, fetchedAt: new Date().toISOString() },
    ifin: { topics: ifin, fetchedAt: new Date().toISOString() },
    redmonk: { items: redmonk, fetchedAt: new Date().toISOString() },
    arxiv,
    aiDailyBrief: {
      editions: aiDailyBrief,
      fetchedAt: new Date().toISOString(),
    },
    config: {
      hnCount: cfg.hnCount,
      lobstersCount: cfg.lobstersCount,
      sreCount: cfg.sreCount,
      ifinCount: cfg.ifinCount,
      redmonkCount: cfg.redmonkCount,
      arxivCount: cfg.arxivCount,
      aiDailyBriefDays: cfg.aiDailyBriefDays,
    },
    fetchedAt: new Date().toISOString(),
  });
  ctx.logger.info(
    `Gathered ${hn.stories.length} HN, ${lobsters.stories.length} Lobste.rs, ` +
      `${sre.length} SRE Weekly, ${ifin.length} IFIN, ${redmonk.length} RedMonk, ` +
      `${arxiv.entries.length} arXiv, ${aiDailyBrief.length} AI Daily Brief editions`,
  );
  return { dataHandles: [handle] };
}

/** Research data collector model. */
export const model = {
  type: "@webframp/research-collector" as const,
  version: "2026.07.20.1",
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.20.1",
      description:
        "Adds the aiDailyBrief source and aiDailyBriefDays global arg. Existing instances keep their per-source counts; new instances default to 3 editions/day.",
      upgradeAttributes: (old: Record<string, unknown>) => ({
        ...old,
        aiDailyBriefDays: 3,
      }),
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    research: {
      description:
        "Aggregated research data from HN, Lobste.rs, arXiv, SRE Weekly, IFIN Discourse, RedMonk, and The AI Daily Brief",
      schema: ResearchBriefSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    gather: {
      description:
        "Gather research data from HN, Lobste.rs, arXiv, SRE Weekly, IFIN Discourse, RedMonk, and The AI Daily Brief.",
      arguments: z.object({}),
      execute: gatherAll,
    },
  },
};
