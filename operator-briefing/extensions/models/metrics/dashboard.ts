/**
 * Pure renderer for the operator-briefing dashboard.
 *
 * Turns the durable metrics series (trend history) plus, optionally, the
 * operator-briefing report JSON (today's queue + ops) into ONE self-contained
 * HTML document — inline CSS, inline SVG charts, no external fetch, no foreign
 * runtime — so it persists as a versioned swamp data resource and renders
 * anywhere (a browser, a claude.ai Artifact) under a strict CSP.
 *
 * Kept pure (string in, string out) so it unit-tests without swamp: the model
 * method is a thin wrapper that reads the series, calls this, and writes a file.
 *
 * ## Redaction
 *
 * The numeric series (spend, DAU/WAU/MAU, seats, quota/pending counts) is
 * non-identifying and always shown. `redact` governs the report-derived
 * sections, which CAN carry internal identifiers (CLAUDE.md: never expose
 * internal URLs, usernames, or credentials in a shareable artifact):
 *
 * - redact=false (operator-local): show the tier-1 queue table (reference,
 *   title, author, effort) for the operator's own work. Internal deep-link URLs
 *   are NEVER emitted as links, in either mode.
 * - redact=true (shareable): show only aggregate tier COUNTS and ops severities;
 *   drop every reference, title, author, and free-text ops `detail` (which may
 *   name a person or project). Quota `entries` are safe by the report contract
 *   (they never carry an account id).
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

// A single dated point of the series. Mirror of the model's Row; every metric
// is optional because a given day may not carry every field.
export interface DashboardRow {
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
}

// The subset of the operator-briefing BriefingJson contract this renderer uses.
// Everything is optional and defensively read — a malformed or absent report
// degrades to a trends-only dashboard, never throws.
interface QueueItemLike {
  reference?: string;
  title?: string;
  who?: string;
  ageDays?: number;
  stale?: boolean;
  effort?: number;
  draft?: boolean;
  actionHint?: string;
}
interface OpsSignalLike {
  source?: string;
  label?: string;
  severity?: string;
  detail?: string;
  stale?: boolean;
  degraded?: boolean;
  degradedReason?: string;
}
export interface ReportLike {
  generatedAt?: string;
  tiers?: {
    waitingOnYou?: QueueItemLike[];
    awaitingMerge?: QueueItemLike[];
    mentions?: QueueItemLike[];
    yourOpenMrs?: QueueItemLike[];
  };
  ops?: OpsSignalLike[];
  degraded?: boolean;
}

export interface RenderOptions {
  rows: DashboardRow[];
  report?: ReportLike | null;
  redact: boolean;
  title: string;
  generatedAt: string;
}

// --- HTML escaping -----------------------------------------------------------

/** Escape text for HTML body/attribute context. */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- number formatting -------------------------------------------------------

function fmtUsd(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtInt(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** The finite numeric values of one field across the series, in date order. */
function seriesValues(
  rows: DashboardRow[],
  key: keyof DashboardRow,
): Array<{ date: string; value: number }> {
  const out: Array<{ date: string; value: number }> = [];
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ date: r.date, value: v });
    }
  }
  return out;
}

/** The last finite value of a field, or undefined. */
function latest(
  rows: DashboardRow[],
  key: keyof DashboardRow,
): number | undefined {
  const vals = seriesValues(rows, key);
  return vals.length ? vals[vals.length - 1].value : undefined;
}

// --- inline SVG charts -------------------------------------------------------

const CHART_W = 260;
const CHART_H = 64;
const PAD = 4;

/**
 * A single-series sparkline as inline SVG: an area + line, scaled to the
 * observed min/max. Returns a placeholder when there are fewer than two points
 * (a line needs two). Coordinates are rounded to keep the markup compact.
 */
function sparkline(
  points: Array<{ date: string; value: number }>,
  color: string,
): string {
  if (points.length === 0) {
    return `<div class="nochart">no data</div>`;
  }
  if (points.length === 1) {
    return `<div class="nochart">1 point · ${
      esc(fmtInt(points[0].value))
    }</div>`;
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const x = (i: number) => PAD + (i / (points.length - 1)) * innerW;
  const y = (v: number) => PAD + innerH - ((v - min) / span) * innerH;
  const pts = points.map((p, i) =>
    `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
  );
  const line = pts.join(" ");
  const area = `${PAD},${(CHART_H - PAD).toFixed(1)} ${line} ${
    (CHART_W - PAD).toFixed(1)
  },${(CHART_H - PAD).toFixed(1)}`;
  const gid = "g" + color.replace(/[^a-z0-9]/gi, "");
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" class="spark">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
  </linearGradient></defs>
  <polygon points="${area}" fill="url(#${gid})"/>
  <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2"
    stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

/** A stat tile: big current value, label, and optional sub-line + sparkline. */
function statTile(opts: {
  label: string;
  value: string;
  sub?: string;
  spark?: string;
}): string {
  return `<div class="tile">
  <div class="tile-label">${esc(opts.label)}</div>
  <div class="tile-value">${esc(opts.value)}</div>
  ${opts.sub ? `<div class="tile-sub">${esc(opts.sub)}</div>` : ""}
  ${opts.spark ?? ""}
</div>`;
}

// --- sections ----------------------------------------------------------------

function trendsSection(rows: DashboardRow[]): string {
  const spend = seriesValues(rows, "spendUsd");
  const dau = seriesValues(rows, "dau");
  const wau = seriesValues(rows, "wau");
  const mau = seriesValues(rows, "mau");
  const active = seriesValues(rows, "activeSeats");
  const total = latest(rows, "totalSeats");
  const quota = seriesValues(rows, "quotaOverCount");
  const pending = seriesValues(rows, "pendingCount");

  const seatsSub = total != null
    ? `${fmtInt(latest(rows, "activeSeats"))} active of ${fmtInt(total)} seats`
    : `${fmtInt(latest(rows, "activeSeats"))} active`;

  const tiles = [
    statTile({
      label: "Spend (trailing 7d)",
      value: fmtUsd(latest(rows, "spendUsd")),
      sub: `${spend.length} obs`,
      spark: sparkline(spend, "#3b82f6"),
    }),
    statTile({
      label: "Daily active users",
      value: fmtInt(latest(rows, "dau")),
      sub: `WAU ${fmtInt(latest(rows, "wau"))} · MAU ${
        fmtInt(latest(rows, "mau"))
      }`,
      spark: sparkline(dau, "#10b981"),
    }),
    statTile({
      label: "Weekly / Monthly active",
      value: `${fmtInt(latest(rows, "wau"))} / ${fmtInt(latest(rows, "mau"))}`,
      sub: `WAU trend`,
      spark: sparkline(wau.length >= 2 ? wau : mau, "#8b5cf6"),
    }),
    statTile({
      label: "Seats active",
      value: fmtInt(latest(rows, "activeSeats")),
      sub: seatsSub,
      spark: sparkline(active, "#f59e0b"),
    }),
    statTile({
      label: "AWS quotas over threshold",
      value: fmtInt(latest(rows, "quotaOverCount")),
      sub: `pending increases: ${fmtInt(latest(rows, "pendingCount"))}`,
      spark: sparkline(quota, "#ef4444"),
    }),
    statTile({
      label: "Pending quota increases",
      value: fmtInt(latest(rows, "pendingCount")),
      sub: `${pending.length} obs`,
      spark: sparkline(pending, "#ec4899"),
    }),
  ];

  return `<section>
  <h2>Trends <span class="muted">· ${rows.length} day${
    rows.length === 1 ? "" : "s"
  }</span></h2>
  <div class="tiles">${tiles.join("\n")}</div>
</section>`;
}

const SEV_ORDER: Record<string, number> = {
  critical: 3,
  warn: 2,
  info: 1,
  ok: 0,
};

/** A known severity string maps to its own class; anything else is neutral. */
function sevClass(sev: string): string {
  return SEV_ORDER[sev] !== undefined ? sev : "info";
}

function opsSection(report: ReportLike, redact: boolean): string {
  // Filter to objects: a null/primitive element must not throw (this renderer
  // is documented and tested as a pure function that degrades, never throws).
  const ops = (Array.isArray(report.ops) ? report.ops : [])
    .filter((s): s is OpsSignalLike => !!s && typeof s === "object");
  if (ops.length === 0) return "";
  const sorted = [...ops].sort((a, b) =>
    (SEV_ORDER[b.severity ?? "ok"] ?? 0) - (SEV_ORDER[a.severity ?? "ok"] ?? 0)
  );
  const rows = sorted.map((s) => {
    const sevRaw = s.severity ?? "ok";
    const sev = esc(sevRaw);
    const flags: string[] = [];
    if (s.stale) flags.push("stale");
    if (s.degraded) {
      // `degradedReason` is free text of the same class as `detail` (it can name
      // a person, project, or AWS account), so it is dropped in redact mode too.
      const reason = !redact && s.degradedReason ? `: ${s.degradedReason}` : "";
      flags.push(`degraded${reason}`);
    }
    const flagStr = flags.length ? flags.join(", ") : "ok";
    // In redact mode drop the free-text detail (may name a person/project).
    const detail = redact ? "" : esc(s.detail ?? "");
    return `<tr>
      <td><span class="sev sev-${sevClass(sevRaw)}">${sev}</span></td>
      <td>${esc(s.label ?? s.source ?? "")}</td>
      <td class="detail">${detail}</td>
      <td class="muted">${esc(flagStr)}</td>
    </tr>`;
  }).join("\n");
  return `<section>
  <h2>Ops signals</h2>
  <div class="scroll"><table>
    <thead><tr><th>Sev</th><th>Signal</th><th>Detail</th><th>Fresh</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}

/** A tier array, filtered to objects (a null/primitive element must not throw). */
function tierItems(arr: unknown): QueueItemLike[] {
  return (Array.isArray(arr) ? arr : [])
    .filter((i): i is QueueItemLike => !!i && typeof i === "object");
}

function queueSection(report: ReportLike, redact: boolean): string {
  const t = (report.tiers && typeof report.tiers === "object")
    ? report.tiers
    : {};
  const waiting = tierItems(t.waitingOnYou);
  const counts = [
    { label: "Waiting on you", n: waiting.length },
    { label: "Awaiting your merge", n: tierItems(t.awaitingMerge).length },
    { label: "Mentions", n: tierItems(t.mentions).length },
    { label: "Your open MRs", n: tierItems(t.yourOpenMrs).length },
  ];
  const countTiles = counts.map((c) =>
    statTile({ label: c.label, value: fmtInt(c.n) })
  ).join("\n");

  let table = "";
  const tier1 = waiting;
  if (!redact && tier1.length > 0) {
    const body = [...tier1]
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
      .map((i) => {
        const staleMark = i.stale ? " ⚠" : "";
        const draftMark = i.draft ? " 🚧" : "";
        const effort = i.effort != null ? `${esc(i.effort)}/5` : "";
        return `<tr>
        <td class="mono">${esc(i.reference ?? "")}</td>
        <td>${esc(i.title ?? "")}${draftMark}</td>
        <td>${esc(i.who ?? "")}</td>
        <td class="num">${esc(fmtInt(i.ageDays))}d${staleMark}</td>
        <td class="num">${effort}</td>
        <td>${esc(i.actionHint ?? "")}</td>
      </tr>`;
      }).join("\n");
    table = `<div class="scroll"><table>
      <thead><tr><th>Item</th><th>Title</th><th>Who</th><th>Age</th><th>Effort</th><th>Action</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  } else if (redact) {
    table = `<p class="muted">Item detail hidden (redacted view).</p>`;
  }

  return `<section>
  <h2>Review queue</h2>
  <div class="tiles">${countTiles}</div>
  ${table}
</section>`;
}

// --- document ----------------------------------------------------------------

const STYLE = `
:root{
  --bg:#f7f8fa; --panel:#ffffff; --ink:#1f2430; --muted:#6b7280;
  --border:#e5e7eb; --accent:#3b82f6;
  --ok:#10b981; --info:#3b82f6; --warn:#f59e0b; --critical:#ef4444;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0f1115; --panel:#171a21; --ink:#e6e8ec; --muted:#9aa2af;
    --border:#262b34; --accent:#60a5fa;
  }
}
:root[data-theme="dark"]{
  --bg:#0f1115; --panel:#171a21; --ink:#e6e8ec; --muted:#9aa2af;
  --border:#262b34; --accent:#60a5fa;
}
:root[data-theme="light"]{
  --bg:#f7f8fa; --panel:#ffffff; --ink:#1f2430; --muted:#6b7280;
  --border:#e5e7eb; --accent:#3b82f6;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.wrap{max-width:1000px;margin:0 auto;padding:24px 20px 64px;}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:8px;}
h1{font-size:22px;margin:0;}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  margin:28px 0 12px;font-weight:600;}
.muted{color:var(--muted);font-weight:400;}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;
  border:1px solid var(--border);}
.badge.warn{color:var(--warn);border-color:var(--warn);}
.badge.redact{color:var(--muted);}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px;}
.tile-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
.tile-value{font-size:26px;font-weight:650;margin:2px 0;}
.tile-sub{font-size:12px;color:var(--muted);margin-bottom:8px;}
.spark{width:100%;height:48px;display:block;}
.nochart{height:48px;display:flex;align-items:center;color:var(--muted);font-size:12px;}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
table{width:100%;border-collapse:collapse;background:var(--panel);
  border:1px solid var(--border);border-radius:12px;overflow:hidden;font-size:14px;}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top;}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
tr:last-child td{border-bottom:none;}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:nowrap;}
.num{text-align:right;white-space:nowrap;}
.detail{max-width:420px;}
.sev{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;}
.sev-ok{color:var(--ok);} .sev-info{color:var(--info);}
.sev-warn{color:var(--warn);} .sev-critical{color:#fff;background:var(--critical);}
footer{margin-top:40px;color:var(--muted);font-size:12px;}
`;

/**
 * Render the whole dashboard document. Never throws on a malformed report —
 * every report access is guarded and degrades to trends-only.
 */
export function renderDashboardHtml(opts: RenderOptions): string {
  const { rows, report, redact, title, generatedAt } = opts;
  const badges: string[] = [];
  if (redact) badges.push(`<span class="badge redact">redacted</span>`);
  if (report?.degraded) {
    badges.push(`<span class="badge warn">briefing degraded</span>`);
  }

  const sections: string[] = [trendsSection(rows)];
  if (report && typeof report === "object") {
    // queue first (the operator's actionable work), then ops signals.
    if (report.tiers) sections.push(queueSection(report, redact));
    if (Array.isArray(report.ops) && report.ops.length) {
      sections.push(opsSection(report, redact));
    }
  }

  const genLine = report?.generatedAt ?? generatedAt;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(title)}</h1>
  ${badges.join(" ")}
</header>
<div class="muted">Generated ${esc(genLine)} · series through ${
    esc(rows.length ? rows[rows.length - 1].date : "—")
  }</div>
${sections.join("\n")}
<footer>Observed once, rendered many — a projection of the operator-briefing metrics series.${
    redact ? " Redacted for sharing: item detail and ops text omitted." : ""
  }</footer>
</div>
</body>
</html>`;
}
