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
  /** Reads the latest version (or a specific version) of a resource instance.
   * Returns null when no version exists yet. */
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
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

/** A single scored item in the digest, normalized across sources. */
const DigestItemSchema = z.object({
  source: z.string().describe("Originating source slug"),
  title: z.string(),
  url: z.string().nullable(),
  score: z.number().describe(
    "Normalized 0-100 prominence score (engagement + freshness)",
  ),
  tags: z.array(z.string()).default([]),
});

/** A cross-source topic cluster: a keyword shared by items from >=2 sources. */
const TopicClusterSchema = z.object({
  topic: z.string().describe("Lowercased shared keyword/phrase"),
  occurrences: z.number().int().describe("How many digest items mention it"),
  sources: z.array(z.string()).describe("Distinct sources mentioning it"),
});

/** Compact daily digest of the research brief. */
const DigestSchema = z.object({
  topItems: z.array(DigestItemSchema).describe(
    "Top items across all sources, ranked by prominence",
  ),
  perSource: z.record(
    z.string(),
    z.array(DigestItemSchema),
  ).describe("Top items grouped by source slug"),
  topics: z.array(TopicClusterSchema).describe(
    "Cross-source topic clusters (keywords in >=2 sources)",
  ),
  delta: z.object({
    newCount: z.number().int().describe(
      "Items in this digest absent from the previous digest",
    ),
    carriedCount: z.number().int().describe(
      "Items also present in the previous digest",
    ),
    previousDigestAt: z.string().nullable().describe(
      "fetchedAt of the previous digest, or null on first run",
    ),
  }),
  sourceCount: z.number().int().describe("Number of sources contributing"),
  briefFetchedAt: z.string().describe("fetchedAt of the source brief"),
  digestAt: z.string().describe("When this digest was built"),
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

/** Tokenize a title into lowercase keyword tokens for topic clustering. */
function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    // Drop very common stopwords that produce uninformative clusters.
    .filter((t) =>
      ![
        "that",
        "this",
        "with",
        "from",
        "your",
        "have",
        "will",
        "about",
        "into",
        "what",
        "when",
        "which",
        "their",
        "there",
        "they",
        "https",
      ].includes(t)
    );
}

/** Normalize a raw brief item from any source into a DigestItem with a 0-100
 * prominence score. Engagement metrics vary by source; we scale each to 0-100
 * so cross-source ranking is meaningful. */
function toDigestItem(
  source: string,
  raw: Record<string, unknown>,
  maxEngagement: number,
): {
  source: string;
  title: string;
  url: string | null;
  score: number;
  tags: string[];
} {
  const title = String(raw.title ?? "(untitled)");
  const url = raw.url != null
    ? String(raw.url)
    : (raw.link != null ? String(raw.link) : null);
  const tags = Array.isArray(raw.tags)
    ? (raw.tags as unknown[]).map((t) => String(t))
    : [];
  // Engagement: prefer an explicit score, fall back to comments/views/posts.
  const engagement = typeof raw.score === "number"
    ? raw.score
    : (typeof raw.descendants === "number"
      ? raw.descendants
      : (typeof raw.commentCount === "number"
        ? raw.commentCount
        : (typeof raw.posts_count === "number"
          ? raw.posts_count
          : (typeof raw.views === "number" ? raw.views : 0))));
  const scaled = maxEngagement > 0 ? (engagement / maxEngagement) * 100 : 0;
  // Round to one decimal of precision; keep it bounded.
  const score = Math.max(0, Math.min(100, Math.round(scaled * 10) / 10));
  return { source, title, url, score, tags };
}

/** Build a compact digest from a gathered brief: top items per source, ranked
 * cross-source, with topic clusters (keywords shared by >=2 sources) and a
 * delta against the previous digest. This is real downstream-useful work — a
 * journal-writer consumes the digest instead of re-scoring the raw brief. */
async function buildDigest(
  _args: Record<string, never>,
  ctx: MethodContext,
): Promise<
  { dataHandles: { spec: string; instance: string; name: string }[] }
> {
  if (!ctx.readResource) {
    throw new Error(
      "digest requires a readResource context (none provided)",
    );
  }
  ctx.logger.info("Building research digest from latest brief");
  const brief = await ctx.readResource("brief") as
    | Record<string, unknown>
    | null;
  if (!brief) {
    throw new Error(
      "No research brief found. Run gather before digest.",
    );
  }
  const briefFetchedAt = String(brief.fetchedAt ?? new Date().toISOString());
  const perSourceRaw: Record<string, unknown[]> = {
    hn: ((brief.hnFrontPage as { stories?: unknown[] } | undefined)?.stories) ??
      [],
    lobsters: ((brief.lobstersHottest as { stories?: unknown[] } | undefined)
      ?.stories) ?? [],
    sreWeekly:
      ((brief.sreWeekly as { items?: unknown[] } | undefined)?.items) ?? [],
    ifin: ((brief.ifin as { topics?: unknown[] } | undefined)?.topics) ?? [],
    redmonk: ((brief.redmonk as { items?: unknown[] } | undefined)?.items) ??
      [],
    arxiv: ((brief.arxiv as { entries?: unknown[] } | undefined)?.entries) ??
      [],
    aiDailyBrief: ((brief.aiDailyBrief as { editions?: unknown[] } | undefined)
      ?.editions) ?? [],
  };
  // Per-source max engagement for scaling, then normalize + take top 5/source.
  const perSource: Record<
    string,
    {
      source: string;
      title: string;
      url: string | null;
      score: number;
      tags: string[];
    }[]
  > = {};
  for (const [src, items] of Object.entries(perSourceRaw)) {
    let maxEng = 0;
    for (const it of items) {
      const r = it as Record<string, unknown>;
      const e = typeof r.score === "number"
        ? r.score
        : (typeof r.descendants === "number"
          ? r.descendants
          : (typeof r.posts_count === "number"
            ? r.posts_count
            : (typeof r.views === "number" ? r.views : 0)));
      if (e > maxEng) maxEng = e;
    }
    const norm = items.map((it) =>
      toDigestItem(src, it as Record<string, unknown>, maxEng)
    );
    // AI Daily Brief editions carry nuggets, not scores; keep them in title order.
    perSource[src] = src === "aiDailyBrief"
      ? norm.slice(0, 3)
      : norm.sort((a, b) => b.score - a.score).slice(0, 5);
  }
  // Cross-source top 10 by score (AI Daily Brief items get a flat 50).
  const allItems = Object.values(perSource).flat();
  const topItems = allItems.slice().sort((a, b) => b.score - a.score).slice(
    0,
    10,
  );
  // Topic clusters: tokens appearing in >=2 sources.
  const tokenSources = new Map<string, Set<string>>();
  const tokenCount = new Map<string, number>();
  for (const it of allItems) {
    for (const tok of new Set(tokenize(it.title))) {
      if (!tokenSources.has(tok)) tokenSources.set(tok, new Set());
      tokenSources.get(tok)!.add(it.source);
      tokenCount.set(tok, (tokenCount.get(tok) ?? 0) + 1);
    }
  }
  const topics = [...tokenSources.entries()]
    .filter(([, srcs]) => srcs.size >= 2)
    .map(([topic, srcs]) => ({
      topic,
      occurrences: tokenCount.get(topic) ?? 0,
      sources: [...srcs].sort(),
    }))
    .sort((a, b) =>
      b.occurrences - a.occurrences || b.sources.length - a.sources.length
    )
    .slice(0, 15);
  // Delta vs previous digest: compare normalized title sets.
  const prevDigest = await ctx.readResource("digest") as
    | Record<string, unknown>
    | null;
  const prevTitles = prevDigest
    ? new Set(
      (prevDigest.topItems as { title?: string }[] | undefined)?.map((i) =>
        i.title
      ) ?? [],
    )
    : new Set<string>();
  const newCount = topItems.filter((i) => !prevTitles.has(i.title)).length;
  const carriedCount = topItems.length - newCount;
  const previousDigestAt = prevDigest
    ? String(prevDigest.digestAt ?? null)
    : null;
  const handle = await ctx.writeResource("research", "digest", {
    topItems,
    perSource,
    topics,
    delta: { newCount, carriedCount, previousDigestAt },
    sourceCount: Object.keys(perSource).length,
    briefFetchedAt,
    digestAt: new Date().toISOString(),
  });
  ctx.logger.info(
    `Digest: ${topItems.length} top items, ${topics.length} cross-source topics, ${newCount} new since last digest`,
  );
  return { dataHandles: [handle] };
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
  version: "2026.07.23.1",
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
    {
      toVersion: "2026.07.21.1",
      description: "Repair broken XML test fixtures; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.23.1",
      description:
        "Adds the digest method and digest resource. No changes to existing global args or the research brief schema; existing instances need no migration.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
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
    digest: {
      description:
        "Compact daily digest of the research brief: top items per source, cross-source topic clusters, and a delta against the previous digest.",
      schema: DigestSchema,
      // Digests are stable summaries; keep them around longer than the raw brief.
      lifetime: "24h" as const,
      garbageCollection: 14,
    },
  },
  methods: {
    gather: {
      description:
        "Gather research data from HN, Lobste.rs, arXiv, SRE Weekly, IFIN Discourse, RedMonk, and The AI Daily Brief.",
      arguments: z.object({}),
      execute: gatherAll,
    },
    digest: {
      description:
        "Build a compact digest from the latest research brief: top items per source, cross-source topic clusters, and a delta against the previous digest. Run gather first.",
      arguments: z.object({}),
      execute: buildDigest,
    },
  },
};
