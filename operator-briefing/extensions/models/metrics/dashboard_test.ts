// Operator-briefing dashboard renderer — tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  type DashboardRow,
  renderDashboardHtml,
  type ReportLike,
} from "./dashboard.ts";

const SERIES: DashboardRow[] = [
  { date: "2026-07-06", dau: 148, wau: 424, mau: 424, totalSeats: 586 },
  { date: "2026-07-07", dau: 164, wau: 430, mau: 430, totalSeats: 586 },
  {
    date: "2026-07-10",
    dau: 143,
    wau: 285,
    mau: 437,
    totalSeats: 586,
    spendUsd: 1661.79,
  },
  {
    date: "2026-07-13",
    dau: 49,
    wau: 284,
    mau: 437,
    activeSeats: 49,
    totalSeats: 586,
    spendUsd: 1235.99,
    quotaOverCount: 1,
    pendingCount: 1,
  },
];

const REPORT: ReportLike = {
  generatedAt: "2026-07-13T12:55:00.000Z",
  degraded: false,
  tiers: {
    waitingOnYou: [
      {
        reference: "appsvc/docs!5613",
        title: "Dedup ADR content",
        who: "JTAGUE",
        ageDays: 1,
        effort: 2,
        actionHint: "review",
      },
    ],
    awaitingMerge: [],
    mentions: [],
    yourOpenMrs: [{
      reference: "o11n/gitlab!857",
      title: "x",
      who: "sescriva",
    }],
  },
  ops: [
    {
      source: "aws-quotas",
      label: "utilization:ec2",
      severity: "warn",
      detail: "1 quota over threshold in jw-cd-orchestration-prd",
    },
    {
      source: "analytics",
      label: "cost",
      severity: "info",
      detail: "$1,236 trailing 7d",
    },
  ],
};

Deno.test("renders a self-contained HTML document", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: null,
    redact: false,
    title: "Operator Briefing",
    generatedAt: "2026-07-13T00:00:00Z",
  });
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "<style>");
  assertStringIncludes(html, "Operator Briefing");
  // No external resource references (CSP-safe / self-contained).
  assertEquals(html.includes("http://"), false);
  assertEquals(html.includes("https://"), false);
  assertEquals(html.includes("<script"), false);
  // Trend section present with an inline SVG sparkline.
  assertStringIncludes(html, "Trends");
  assertStringIncludes(html, "<svg");
});

Deno.test("latest values are surfaced from the series", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: null,
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertStringIncludes(html, "$1,236"); // latest trailing-7d spend, rounded
  assertStringIncludes(html, "series through 2026-07-13");
});

Deno.test("with a report, renders queue + ops sections (non-redacted)", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: REPORT,
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertStringIncludes(html, "Review queue");
  assertStringIncludes(html, "Ops signals");
  // Non-redacted shows item detail.
  assertStringIncludes(html, "appsvc/docs!5613");
  assertStringIncludes(html, "JTAGUE");
  assertStringIncludes(html, "1 quota over threshold");
});

Deno.test("redacted view drops references, authors, and ops detail", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: REPORT,
    redact: true,
    title: "T",
    generatedAt: "x",
  });
  // Aggregate counts + trends survive.
  assertStringIncludes(html, "Review queue");
  assertStringIncludes(html, "redacted");
  assertStringIncludes(html, "$1,236");
  // Identifiers are gone.
  assertEquals(html.includes("appsvc/docs!5613"), false);
  assertEquals(html.includes("JTAGUE"), false);
  assertEquals(html.includes("o11n/gitlab!857"), false);
  assertEquals(html.includes("jw-cd-orchestration-prd"), false);
  // Ops labels/severities still shown (non-identifying).
  assertStringIncludes(html, "utilization:ec2");
});

Deno.test("redacted view drops degradedReason free-text (may name a person/account)", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: {
      ops: [
        {
          source: "analytics",
          label: "cost",
          severity: "warn",
          degraded: true,
          degradedReason:
            "cost fetch failed for jw-cd-orchestration-prd (sso for sescriva)",
        },
      ],
    },
    redact: true,
    title: "T",
    generatedAt: "x",
  });
  assertEquals(html.includes("jw-cd-orchestration-prd"), false);
  assertEquals(html.includes("sescriva"), false);
  // The degraded flag itself still shows (non-identifying), just not the reason.
  assertStringIncludes(html, "degraded");
});

Deno.test("non-redacted keeps degradedReason", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: {
      ops: [{
        source: "analytics",
        label: "cost",
        severity: "warn",
        degraded: true,
        degradedReason: "sso-login-required",
      }],
    },
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertStringIncludes(html, "sso-login-required");
});

Deno.test("degrades (no throw) on null elements in report arrays", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    // ops and tier arrays carrying null / primitive junk must not throw.
    report: {
      ops: [null, "junk", { severity: "warn", label: "ok-signal" }],
      tiers: {
        waitingOnYou: [null, { reference: "x!1", title: "real", who: "a" }],
        mentions: [undefined as unknown as null],
      },
    } as unknown as Parameters<typeof renderDashboardHtml>[0]["report"],
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertStringIncludes(html, "Review queue");
  assertStringIncludes(html, "ok-signal");
  assertStringIncludes(html, "real");
});

Deno.test("degrades to trends-only on an empty series without throwing", () => {
  const html = renderDashboardHtml({
    rows: [],
    report: null,
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertStringIncludes(html, "Trends");
  assertStringIncludes(html, "no data");
});

Deno.test("HTML-escapes report-derived text", () => {
  const html = renderDashboardHtml({
    rows: SERIES,
    report: {
      tiers: {
        waitingOnYou: [
          {
            reference: "x!1",
            title: "<script>alert(1)</script>",
            who: "a & b",
          },
        ],
      },
    },
    redact: false,
    title: "T",
    generatedAt: "x",
  });
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
  assertStringIncludes(html, "a &amp; b");
});
