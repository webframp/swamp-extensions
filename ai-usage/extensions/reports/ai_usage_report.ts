/**
 * Unified AI usage report extension for swamp.
 *
 * Workflow-scope report that aggregates token usage data from AWS Bedrock,
 * GCP Vertex AI, and Azure OpenAI scan results into a unified view.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

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
  }) => {
    const sections: string[] = [];
    const jsonData: Record<string, unknown> = {};
    let grandInput = 0;
    let grandOutput = 0;

    sections.push("# AI Token Usage Report\n");

    // --- Coverage ---
    const coverageRows: string[] = [];
    const providers = [
      { name: "AWS Bedrock", model: "bedrock-usage", spec: "scan_results" },
      { name: "GCP Vertex AI", model: "vertex-usage", spec: "scan_results" },
      { name: "Azure OpenAI", model: "azure-ai-usage", spec: "scan_results" },
    ];

    // Cache findBySpec results to avoid double-fetching
    const cachedData: Record<string, Array<Record<string, unknown>>> = {};

    for (const p of providers) {
      try {
        const data = await context.dataRepository.findBySpec(p.model, p.spec);
        cachedData[p.model] = data as unknown as Array<
          Record<string, unknown>
        >;
        if (data && data.length > 0) {
          coverageRows.push(`| ${p.name} | ✅ Active | — |`);
        } else {
          coverageRows.push(
            `| ${p.name} | ⚠️ Not configured | Create \`${p.model}\` model instance |`,
          );
        }
      } catch {
        cachedData[p.model] = [];
        coverageRows.push(
          `| ${p.name} | ⚠️ Not configured | Create \`${p.model}\` model instance |`,
        );
      }
    }

    sections.push("## Provider Coverage\n");
    sections.push("| Provider | Status | Action |");
    sections.push("|----------|--------|--------|");
    sections.push(...coverageRows);
    sections.push("");

    // --- AWS ---
    {
      const data = cachedData["bedrock-usage"] ?? [];
      if (data.length > 0) {
        const sorted = data.filter((d: Record<string, unknown>) => d.updatedAt)
          .sort((
            a: Record<string, unknown>,
            b: Record<string, unknown>,
          ) =>
            new Date(b.updatedAt as string).getTime() -
            new Date(a.updatedAt as string).getTime()
          );
        const latest = sorted[0] ?? data[0];
        const attrs = latest.attributes as {
          totals: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            inputTokensPerMinute: number;
            outputTokensPerMinute: number;
          };
          accounts: Array<
            {
              profile: string;
              totalTokens: number;
              inputTokens: number;
              outputTokens: number;
              models: Array<{ modelId: string; totalTokens: number }>;
            }
          >;
        };
        grandInput += attrs.totals.inputTokens;
        grandOutput += attrs.totals.outputTokens;

        sections.push("## AWS Bedrock\n");
        sections.push(
          `**Total:** ${attrs.totals.totalTokens.toLocaleString()} tokens (${
            attrs.totals.inputTokensPerMinute.toFixed(1)
          } in/min, ${
            attrs.totals.outputTokensPerMinute.toFixed(1)
          } out/min)\n`,
        );
        sections.push("| Account | Input | Output | Total | % |");
        sections.push("|---------|-------|--------|-------|---|");
        for (const a of (attrs.accounts || []).slice(0, 10)) {
          const pct = attrs.totals.totalTokens > 0
            ? ((a.totalTokens / attrs.totals.totalTokens) * 100).toFixed(1)
            : "0";
          sections.push(
            `| ${a.profile} | ${a.inputTokens.toLocaleString()} | ${a.outputTokens.toLocaleString()} | ${a.totalTokens.toLocaleString()} | ${pct}% |`,
          );
        }
        sections.push("");
        jsonData.aws = attrs;
      }
    }

    // --- GCP ---
    {
      const data = cachedData["vertex-usage"] ?? [];
      if (data.length > 0) {
        const sorted = data.filter((d: Record<string, unknown>) => d.updatedAt)
          .sort((
            a: Record<string, unknown>,
            b: Record<string, unknown>,
          ) =>
            new Date(b.updatedAt as string).getTime() -
            new Date(a.updatedAt as string).getTime()
          );
        const latest = sorted[0] ?? data[0];
        const attrs = latest.attributes as {
          totals: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            inputTokensPerMinute: number;
            outputTokensPerMinute: number;
          };
          projects: Array<
            {
              project: string;
              totalTokens: number;
              inputTokens: number;
              outputTokens: number;
            }
          >;
        };
        grandInput += attrs.totals.inputTokens;
        grandOutput += attrs.totals.outputTokens;

        sections.push("## GCP Vertex AI\n");
        sections.push(
          `**Total:** ${attrs.totals.totalTokens.toLocaleString()} tokens (${
            attrs.totals.inputTokensPerMinute.toFixed(1)
          } in/min, ${
            attrs.totals.outputTokensPerMinute.toFixed(1)
          } out/min)\n`,
        );
        sections.push("| Project | Input | Output | Total |");
        sections.push("|---------|-------|--------|-------|");
        for (const p of (attrs.projects || []).slice(0, 10)) {
          sections.push(
            `| ${p.project} | ${p.inputTokens.toLocaleString()} | ${p.outputTokens.toLocaleString()} | ${p.totalTokens.toLocaleString()} |`,
          );
        }
        sections.push("");
        jsonData.gcp = attrs;
      }
    }

    // --- Azure ---
    {
      const data = cachedData["azure-ai-usage"] ?? [];
      if (data.length > 0) {
        const sorted = data.filter((d: Record<string, unknown>) => d.updatedAt)
          .sort((
            a: Record<string, unknown>,
            b: Record<string, unknown>,
          ) =>
            new Date(b.updatedAt as string).getTime() -
            new Date(a.updatedAt as string).getTime()
          );
        const latest = sorted[0] ?? data[0];
        const attrs = latest.attributes as {
          totals: {
            promptTokens: number;
            generatedTokens: number;
            totalTokens: number;
            promptTokensPerMinute: number;
            generatedTokensPerMinute: number;
          };
          resources: Array<
            {
              resourceName: string;
              totalTokens: number;
              promptTokens: number;
              generatedTokens: number;
            }
          >;
        };
        grandInput += attrs.totals.promptTokens;
        grandOutput += attrs.totals.generatedTokens;

        sections.push("## Azure OpenAI\n");
        sections.push(
          `**Total:** ${attrs.totals.totalTokens.toLocaleString()} tokens (${
            attrs.totals.promptTokensPerMinute.toFixed(1)
          } in/min, ${
            attrs.totals.generatedTokensPerMinute.toFixed(1)
          } out/min)\n`,
        );
        sections.push("| Resource | Prompt | Generated | Total |");
        sections.push("|----------|--------|-----------|-------|");
        for (const r of (attrs.resources || []).slice(0, 10)) {
          sections.push(
            `| ${r.resourceName} | ${r.promptTokens.toLocaleString()} | ${r.generatedTokens.toLocaleString()} | ${r.totalTokens.toLocaleString()} |`,
          );
        }
        sections.push("");
        jsonData.azure = attrs;
      }
    }

    // --- Grand Totals ---
    const grandTotal = grandInput + grandOutput;
    sections.push("## Grand Totals\n");
    sections.push(`| Metric | Value |`);
    sections.push(`|--------|-------|`);
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
