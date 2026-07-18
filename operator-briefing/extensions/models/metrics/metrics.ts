/**
 * Durable time-series accumulator for the operator briefing.
 *
 * Point-in-time briefing data (the review queue, current spend, AWS headroom)
 * is always re-observable, so garbage-collecting its versioned snapshots is
 * harmless. A *time series* is not: once a versioned snapshot of a daily
 * metric is GC'd, that historical point is gone forever. So this model stores
 * the series as first-class data. The trick that keeps it GC-safe is a single
 * append-only resource whose LATEST version holds the entire history — an
 * array of dated rows. Version-GC then only ever drops old *partial* states;
 * the latest version always carries everything a trend chart needs.
 *
 * The model makes no external API calls. It only reads its own prior series
 * (via `readResource`, which returns the latest version of a named resource
 * within this model's own scope) and writes the merged series back under the
 * stable instance name "metrics" so it versions in place.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";
import {
  type DashboardRow,
  renderDashboardHtml,
  type ReportLike,
} from "./dashboard.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

/** One dated point in the series. `date` is required; every metric is optional. */
const Row = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  spendUsd: z.number().optional(),
  dau: z.number().optional(),
  wau: z.number().optional(),
  mau: z.number().optional(),
  activeSeats: z.number().optional(),
  totalSeats: z.number().optional(),
  projects: z.number().optional(),
  skills: z.number().optional(),
  connectors: z.number().optional(),
  quotaOverCount: z.number().optional(),
  pendingCount: z.number().optional(),
});

/** The whole append-only series: the latest version holds all rows. */
const Series = z.object({
  rows: z.array(Row),
  count: z.number(),
  updatedAt: z.string(),
});

type RowT = z.infer<typeof Row>;

/**
 * The metric field names carried by a row (everything except `date`). Kept in
 * one place so the merge logic and the argument schema stay in lockstep.
 */
const METRIC_KEYS = [
  "spendUsd",
  "dau",
  "wau",
  "mau",
  "activeSeats",
  "totalSeats",
  "projects",
  "skills",
  "connectors",
  "quotaOverCount",
  "pendingCount",
] as const;

// =============================================================================
// Merge helpers
// =============================================================================

/**
 * Merge an incoming row's metric fields onto an existing row (or a fresh row
 * keyed by the incoming date). A provided finite number overwrites; an absent
 * or wrong-shaped field is skipped, so the prior value survives. This is why a
 * run that carries only spend does not wipe that day's dau. A row that carries
 * only a date still produces (or preserves) a dated marker.
 */
function mergeRow(target: RowT | undefined, incoming: any): RowT {
  const out: any = target ? { ...target } : {};
  out.date = incoming.date;
  for (const k of METRIC_KEYS) {
    const v = incoming?.[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out as RowT;
}

/**
 * A row is usable only if it is an object carrying a zero-padded `YYYY-MM-DD`
 * date. The strict shape matters twice: it screens junk out of a stored series,
 * and it guarantees the lexicographic sort below is also chronological (a
 * non-padded date like `2026-7-3` would sort wrong), so we never rely on
 * `Date` parsing.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function hasValidDate(row: any): boolean {
  return !!row && typeof row === "object" &&
    typeof row.date === "string" && DATE_RE.test(row.date);
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (
    spec: string,
    instance: string,
    overrides?: { contentType?: string },
  ) => { writeText: (text: string) => Promise<{ name: string }> };
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
    error: (msg: string, props: Record<string, unknown>) => void;
  };
};

type RenderArgs = {
  redact?: boolean;
  title?: string;
  report?: ReportLike;
};

type AppendArgs = {
  date: string;
  spendUsd?: number;
  dau?: number;
  wau?: number;
  mau?: number;
  activeSeats?: number;
  totalSeats?: number;
  projects?: number;
  skills?: number;
  connectors?: number;
  quotaOverCount?: number;
  pendingCount?: number;
  backfill?: RowT[];
};

// =============================================================================
// Model Definition
// =============================================================================

/** Durable append-only time-series accumulator for operator-briefing trends. */
export const model = {
  type: "@webframp/operator-briefing/metrics",
  version: "2026.07.18.2",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    series: {
      description:
        "Append-only metrics time series; the latest version holds the full history of dated rows.",
      schema: Series,
      lifetime: "infinite" as const,
      // Keep a handful of versions — safe because the latest holds everything.
      garbageCollection: 5,
    },
  },

  files: {
    dashboard: {
      description:
        "Self-contained HTML dashboard rendered from the series (trends) and, optionally, the operator-briefing report JSON (today's queue + ops). A downstream projection of observed data; regenerated on demand, so a short retention is enough.",
      contentType: "text/html",
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    append_metrics: {
      description:
        "Append (upsert-by-date, merging fields) one day's metrics onto the durable series. Accepts an optional `backfill` array to seed prior dates once. Reads the latest series, merges, sorts ascending by date, and writes the whole series back under the stable name 'metrics'. Never throws, and never clobbers: if the prior series can't be read or is malformed, it skips the write rather than overwrite history with a shorter series.",
      arguments: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
          .describe(
            "The row date in zero-padded YYYY-MM-DD form (required).",
          ),
        spendUsd: z.number().optional().describe("Spend in USD for the day."),
        dau: z.number().optional().describe("Daily active users."),
        wau: z.number().optional().describe("Weekly active users."),
        mau: z.number().optional().describe("Monthly active users."),
        activeSeats: z.number().optional().describe("Active seats."),
        totalSeats: z.number().optional().describe("Total provisioned seats."),
        projects: z.number().optional().describe("Project count."),
        skills: z.number().optional().describe("Skill count."),
        connectors: z.number().optional().describe("Connector count."),
        quotaOverCount: z.number().optional().describe(
          "Count of AWS quotas over threshold.",
        ),
        pendingCount: z.number().optional().describe(
          "Count of pending quota-increase requests.",
        ),
        backfill: z.array(Row).optional().describe(
          "Optional prior rows to seed once. Applied before the current run's row; incoming values win on a shared date.",
        ),
      }),
      execute: async (args: AppendArgs, ctx: ModelContext) => {
        try {
          // 1. Read the existing series. The cardinal rule of an append-only
          //    accumulator: NEVER write a shorter series over a longer one. A
          //    write is only safe when we KNOW the prior history — so anything
          //    that leaves the prior state uncertain must skip the write, not
          //    fall back to an empty/truncated write.
          //
          //    - read THROWS  -> unknown/transient failure, NOT proof of
          //      absence. Writing now could clobber good history. Skip.
          //    - read is null -> resource genuinely absent (first-ever run).
          //      A fresh series is safe to create.
          //    - read is an object with array `rows` -> normal history.
          //    - read is an object whose `rows` is not an array, or is a
          //      non-empty array with zero parseable rows -> corruption of
          //      unknown extent. Skip rather than overwrite it away.
          let existing: Record<string, unknown> | null;
          try {
            existing = await ctx.readResource("metrics");
          } catch (err) {
            ctx.logger.warn(
              "append_metrics: could not read prior series; skipping write to avoid clobbering history: {error}",
              { error: String(err) },
            );
            return { dataHandles: [] };
          }

          let priorRows: RowT[] = [];
          if (existing !== null) {
            const rows = (existing as any)?.rows;
            if (!Array.isArray(rows)) {
              ctx.logger.warn(
                "append_metrics: stored series is present but malformed (rows is not an array); skipping write to avoid clobbering history",
                {},
              );
              return { dataHandles: [] };
            }
            const valid = rows.filter(hasValidDate) as RowT[];
            if (rows.length > 0 && valid.length === 0) {
              ctx.logger.warn(
                "append_metrics: stored series has rows but none are parseable; skipping write to avoid clobbering history",
                { storedCount: rows.length },
              );
              return { dataHandles: [] };
            }
            priorRows = valid;
          }

          // 2. Build an upsert map keyed by date from the existing rows.
          //    Routed through mergeRow (not a raw set) so that if a corrupt
          //    stored series ever carried two rows for one date, their fields
          //    merge rather than the second silently dropping the first.
          const byDate = new Map<string, RowT>();
          for (const r of priorRows) {
            byDate.set(r.date, mergeRow(byDate.get(r.date), r));
          }

          // 2a. Apply backfill rows first (incoming wins on a shared date),
          //     merging field-by-field so a partial backfill row does not
          //     clobber fields already present for that date.
          const backfill = Array.isArray(args.backfill) ? args.backfill : [];
          for (const b of backfill) {
            if (!hasValidDate(b)) continue;
            const merged = mergeRow(byDate.get((b as any).date), b);
            byDate.set(merged.date, merged);
          }

          // 2b. Upsert the current run's row, built only from the non-backfill
          //     args. A row with only a date still upserts a dated marker; when
          //     a row for that date already exists its fields are MERGED, not
          //     clobbered.
          if (hasValidDate(args)) {
            const incoming: any = { date: args.date };
            for (const k of METRIC_KEYS) {
              const v = (args as any)[k];
              if (typeof v === "number" && Number.isFinite(v)) incoming[k] = v;
            }
            const merged = mergeRow(byDate.get(args.date), incoming);
            byDate.set(merged.date, merged);
          }

          // 3. Sort ascending by date and write the full series back under the
          //    stable instance name so it versions in place.
          const rows = Array.from(byDate.values()).sort((a, b) =>
            a.date < b.date ? -1 : a.date > b.date ? 1 : 0
          );

          const handle = await ctx.writeResource("series", "metrics", {
            rows,
            count: rows.length,
            updatedAt: new Date().toISOString(),
          });

          ctx.logger.info(
            "Appended metrics for {date}; series now holds {count} rows",
            { date: args.date, count: rows.length },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          // Degrade contract: never throw. Crucially, do NOT attempt a
          // fallback write here — a failure AFTER the read (a throwing
          // writeResource as the series grows, a logger that throws) must
          // leave whatever is already stored untouched. A "minimal" empty
          // write would destroy the history we exist to protect. Log (guarded,
          // since even the logger may be the thing that threw) and yield no
          // handles.
          try {
            ctx.logger.error("append_metrics failed unexpectedly: {error}", {
              error: String(err),
            });
          } catch {
            // Nothing we can safely do; never rethrow.
          }
          return { dataHandles: [] };
        }
      },
    },

    render_dashboard: {
      description:
        "Render a self-contained HTML dashboard from the durable metrics series (trends) and, optionally, the operator-briefing report JSON (today's queue + ops). Writes a versioned `dashboard` file resource. `redact: true` produces a shareable variant that shows only aggregate counts and numeric trends — no references, authors, or free-text ops detail (never any internal URL or identifier). Reads only its own series; never fetches. Degrades rather than throws.",
      arguments: z.object({
        redact: z.boolean().optional().describe(
          "Produce a shareable, redacted dashboard: aggregate counts + numeric trends only, with every reference / author / ops detail stripped. Default false (operator-local, full detail).",
        ),
        title: z.string().optional().describe(
          "Dashboard title. Defaults to 'Operator Briefing'.",
        ),
        report: z.record(z.string(), z.any()).optional().describe(
          "Optional operator-briefing report JSON (the BriefingJson contract: tiers, ops, generatedAt, degraded). When present, the dashboard adds a review-queue and ops-signals section; when absent it renders trends only.",
        ),
      }),
      execute: async (args: RenderArgs, ctx: ModelContext) => {
        try {
          const redact = args.redact === true;
          const title = typeof args.title === "string" && args.title.trim()
            ? args.title.trim()
            : "Operator Briefing";

          // Read the durable series (own scope). A missing series is not fatal —
          // render an empty-state dashboard rather than throw.
          let rows: DashboardRow[] = [];
          try {
            const existing = await ctx.readResource("metrics");
            const raw = (existing as { rows?: unknown } | null)?.rows;
            if (Array.isArray(raw)) {
              rows = raw.filter(
                (r): r is DashboardRow =>
                  !!r && typeof r === "object" &&
                  typeof (r as { date?: unknown }).date === "string",
              );
            }
          } catch (err) {
            ctx.logger.warn(
              "render_dashboard: could not read series; rendering trends-empty dashboard: {error}",
              { error: String(err) },
            );
          }

          const report = args.report && typeof args.report === "object"
            ? args.report as ReportLike
            : null;

          const html = renderDashboardHtml({
            rows,
            report,
            redact,
            title,
            generatedAt: new Date().toISOString(),
          });

          const instance = redact ? "dashboard-redacted" : "dashboard";
          const writer = ctx.createFileWriter("dashboard", instance, {
            contentType: "text/html",
          });
          const handle = await writer.writeText(html);

          ctx.logger.info(
            "Rendered dashboard '{instance}' from {count} series rows (redact={redact})",
            { instance, count: rows.length, redact },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          try {
            ctx.logger.error("render_dashboard failed unexpectedly: {error}", {
              error: String(err),
            });
          } catch {
            // Never rethrow.
          }
          return { dataHandles: [] };
        }
      },
    },
  },
};
