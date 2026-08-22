/**
 * Unified AI usage report extension for swamp.
 *
 * Workflow-scope report that aggregates token usage data from configured
 * providers into a unified markdown + JSON view. Uses the same provider
 * definitions as the model to stay in sync automatically.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { PROVIDERS } from "../models/ai_usage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numField(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  return typeof val === "number" ? val : 0;
}

function pickLatest(
  data: Array<{ attributes: Record<string, unknown>; updatedAt?: string }>,
): { attributes: Record<string, unknown>; updatedAt?: string } {
  const withTimestamp = data.filter((d) => d.updatedAt);
  if (withTimestamp.length === 0) return data[0];
  withTimestamp.sort(
    (a, b) =>
      new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime(),
  );
  return withTimestamp[0];
}

// ---------------------------------------------------------------------------
// Report Definition
// ---------------------------------------------------------------------------

/** Cross-provider AI token usage report with coverage status and per-provider breakdown. */
export const report = {
  name: "@webframp/ai-usage-report",
  description:
    "Cross-provider AI token usage report with coverage status, per-provider breakdown, and highlights",
  scope: "workflow" as const,
  labels: ["ai", "token-usage", "finops", "monitoring"],

  execute: async (context: {
    dataRepository: {
      findBySpec: (
        modelName: string,
        specName: string,
      ) => Promise<
        Array<{ attributes: Record<string, unknown>; updatedAt?: string }>
      >;
    };
    logger: {
      warn: (msg: string, props: Record<string, unknown>) => void;
    };
  }) => {
    const sections: string[] = [];
    const jsonData: Record<string, unknown> = {};
    let grandInput = 0;
    let grandOutput = 0;
    let grandTotal = 0;

    sections.push("# AI Token Usage Report\n");

    // --- Coverage ---
    const coverageRows: string[] = [];

    // Cache findBySpec results to avoid double-fetching
    const cachedData: Map<
      string,
      Array<{ attributes: Record<string, unknown>; updatedAt?: string }>
    > = new Map();

    for (const p of PROVIDERS) {
      try {
        const data = await context.dataRepository.findBySpec(
          p.modelName,
          p.scanSpec,
        );
        cachedData.set(p.modelName, data);
        if (data.length > 0) {
          coverageRows.push(`| ${p.name} | \u2705 Active | \u2014 |`);
        } else {
          coverageRows.push(
            `| ${p.name} | \u26A0\uFE0F Not configured | Create \`${p.modelName}\` model instance |`,
          );
        }
      } catch (err) {
        cachedData.set(p.modelName, []);
        context.logger.warn(
          "Failed to fetch scan data for provider, treating as unconfigured",
          {
            provider: p.name,
            modelName: p.modelName,
            scanSpec: p.scanSpec,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        coverageRows.push(
          `| ${p.name} | \u26A0\uFE0F Not configured | Create \`${p.modelName}\` model instance |`,
        );
      }
    }

    sections.push("## Provider Coverage\n");
    sections.push("| Provider | Status | Action |");
    sections.push("|----------|--------|--------|");
    sections.push(...coverageRows);
    sections.push("");

    // --- Per-provider sections ---
    for (const p of PROVIDERS) {
      const data = cachedData.get(p.modelName) ?? [];
      if (data.length === 0) continue;

      const latest = pickLatest(data);
      const attrs = latest.attributes as Record<string, unknown>;
      const totals = (attrs.totals ?? {}) as Record<string, unknown>;
      const groups = (attrs[p.fields.groupKey] ?? []) as Array<
        Record<string, unknown>
      >;

      const inputTokens = numField(totals, p.fields.inputTokens);
      const outputTokens = numField(totals, p.fields.outputTokens);
      const totalTokens = numField(totals, p.fields.totalTokens);
      const inputRate = numField(totals, p.fields.inputRate);
      const outputRate = numField(totals, p.fields.outputRate);

      grandInput += inputTokens;
      grandOutput += outputTokens;
      grandTotal += totalTokens;

      sections.push(`## ${p.name}\n`);
      sections.push(
        `**Total:** ${totalTokens.toLocaleString()} tokens (${
          inputRate.toFixed(1)
        } in/min, ${outputRate.toFixed(1)} out/min)\n`,
      );

      // Group table
      const groupLabel = p.fields.groupNameField.charAt(0).toUpperCase() +
        p.fields.groupNameField.slice(1);
      sections.push(`| ${groupLabel} | Input | Output | Total | % |`);
      sections.push("|---------|-------|--------|-------|---|");

      for (const g of groups.slice(0, 10)) {
        const name = String(g[p.fields.groupNameField] ?? "unknown");
        const gInput = numField(g, p.fields.inputTokens);
        const gOutput = numField(g, p.fields.outputTokens);
        const gTotal = numField(g, p.fields.groupTotalField);
        const pct = totalTokens > 0
          ? ((gTotal / totalTokens) * 100).toFixed(1)
          : "0";
        sections.push(
          `| ${name} | ${gInput.toLocaleString()} | ${gOutput.toLocaleString()} | ${gTotal.toLocaleString()} | ${pct}% |`,
        );
      }
      sections.push("");

      jsonData[p.modelName] = attrs;
    }

    // --- Grand Totals ---
    sections.push("## Grand Totals\n");
    sections.push("| Metric | Value |");
    sections.push("|--------|-------|");
    sections.push(`| Total Input/Prompt | ${grandInput.toLocaleString()} |`);
    sections.push(
      `| Total Output/Generated | ${grandOutput.toLocaleString()} |`,
    );
    sections.push(`| **Grand Total** | **${grandTotal.toLocaleString()}** |`);
    sections.push("");

    jsonData.grandTotals = {
      inputTokens: grandInput,
      outputTokens: grandOutput,
      totalTokens: grandTotal,
    };

    return {
      markdown: sections.join("\n"),
      json: jsonData,
    };
  },
};
