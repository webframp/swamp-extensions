/**
 * Scenario Comparison Report — cross-scenario GPU inference cost comparison.
 *
 * Runs at model scope on each of the three cost-projection model types.
 * Every run scans all gpu-cloud, gpu-rental, and gpu-capex instances in the
 * repo (not just the instance that triggered it) via
 * `dataRepository.findAllGlobal()`, reads their latest projection resources,
 * normalizes to $/GPU-hour, and produces a comparison table with optional
 * crossover analysis.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

const STALE_DAYS = 90;

const MODEL_TYPES: Record<string, "cloud" | "rental" | "capex"> = {
  "@webframp/cost-projection/gpu-cloud": "cloud",
  "@webframp/cost-projection/gpu-rental": "rental",
  "@webframp/cost-projection/gpu-capex": "capex",
};

interface ScenarioRow {
  name: string;
  type: "cloud" | "rental" | "capex";
  gpuModel: string;
  costPerGpuHour: number;
  monthlyTotalCost: number;
  annualTotalCost: number;
  keyAssumption: string;
  quotedAt: string | null;
  stale: boolean;
  currency: string;
}

function daysSince(dateStr: string | null | undefined): number {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function formatUsd(n: number): string {
  if (n >= 1) {
    return `$${
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    }`;
  }
  return `$${n.toFixed(4)}`;
}

function formatLargeUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Cross-scenario GPU inference cost comparison report. */
export const report = {
  name: "@webframp/cost-projection-comparison",
  description:
    "Cross-scenario GPU inference cost comparison, normalized to $/GPU-hour. " +
    "Queries all cost-projection model instances and produces a ranked table " +
    "with crossover analysis when multiple scenarios exist.",
  scope: "model" as const,
  labels: ["gpu", "cost", "projection", "comparison", "finops"],

  async execute(
    context: any,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const scenarios: ScenarioRow[] = [];
    const warnings: string[] = [];

    // Scan every cost-projection instance across all three model types —
    // not just the instance whose method run triggered this report. This
    // runs on every method call across three model types, so a failure here
    // must degrade gracefully rather than throw: an uncaught error would
    // mark the *triggering* method run (which already succeeded) as failed.
    let allData: Array<{ data: any; modelType: unknown; modelId: string }>;
    try {
      allData = await context.dataRepository.findAllGlobal();
    } catch (err) {
      return {
        markdown:
          "Unable to scan cost projection scenarios — the comparison could " +
          `not run this time (${String(err)}).`,
        json: {
          scenarios: [],
          warnings: [`findAllGlobal failed: ${String(err)}`],
        },
      };
    }

    const projectionRows = allData.filter((row) =>
      row.data?.name === "projection" && String(row.modelType) in MODEL_TYPES
    );

    // Reads across instances are independent, so fetch them concurrently
    // rather than paying O(rows) sequential round-trips.
    const results = await Promise.all(projectionRows.map(async (row) => {
      try {
        const type = MODEL_TYPES[String(row.modelType)];
        const raw = await context.dataRepository.getContent(
          row.modelType,
          row.modelId,
          "projection",
        );
        if (!raw) return null;
        const data = JSON.parse(new TextDecoder().decode(raw));

        // Extract GPU model from scenario if available
        let gpuModel = "unknown";
        let quotedAt: string | null = null;
        let currency = "USD";
        let keyAssumption = "";

        // Try to read the scenario resource for metadata
        try {
          const scenarioRaw = await context.dataRepository.getContent(
            row.modelType,
            row.modelId,
            "scenario",
          );
          if (scenarioRaw) {
            const scenario = JSON.parse(new TextDecoder().decode(scenarioRaw));
            gpuModel = scenario.gpuModel ?? "unknown";
            quotedAt = scenario.quotedAt ?? null;
            currency = scenario.currency ?? "USD";

            if (type === "cloud") {
              keyAssumption = `${scenario.capacityModel ?? "on-demand"}, ${
                scenario.hoursPerDay ?? 24
              }h/day`;
            } else if (type === "rental") {
              keyAssumption = `${scenario.commitmentTerm ?? "none"} commit, ${
                scenario.provider ?? "unknown"
              }`;
            } else {
              keyAssumption = `${scenario.usefulLifeMonths ?? "?"}mo life, ${
                scenario.targetUtilizationPct ?? "?"
              }% util`;
            }
          }
        } catch { /* scenario read is best-effort */ }

        const stale = daysSince(quotedAt) > STALE_DAYS;

        const row_: ScenarioRow = {
          name: data.scenarioName ?? row.modelId ?? "unnamed",
          type,
          gpuModel,
          costPerGpuHour: type === "capex"
            ? data.costPerGpuHourAtTargetUtil ?? data.costPerGpuHour
            : data.costPerGpuHour,
          monthlyTotalCost: data.monthlyTotalCost,
          annualTotalCost: data.annualTotalCost,
          keyAssumption,
          quotedAt,
          stale,
          currency,
        };
        return row_;
      } catch {
        return null; // skip unreadable instances
      }
    }));
    scenarios.push(...results.filter((r): r is ScenarioRow => r !== null));

    if (scenarios.length === 0) {
      return {
        markdown:
          "No cost projection scenarios found. Record scenarios using " +
          "gpu-cloud, gpu-rental, or gpu-capex models first.",
        json: { scenarios: [], warnings: ["No data available"] },
      };
    }

    // Check for mixed currencies
    const currencies = new Set(scenarios.map((s) => s.currency));
    if (currencies.size > 1) {
      warnings.push(
        `Mixed currencies detected (${[...currencies].join(", ")}). ` +
          "Comparison is invalid — convert all rates to a single base currency.",
      );
    }

    // Sort by costPerGpuHour ascending
    scenarios.sort((a, b) => a.costPerGpuHour - b.costPerGpuHour);
    const cheapest = scenarios[0];

    // Build markdown
    const lines: string[] = [];
    lines.push("# GPU Inference Cost Comparison");
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    if (warnings.length > 0) {
      lines.push("## Warnings");
      lines.push("");
      for (const w of warnings) lines.push(`- ⚠️ ${w}`);
      lines.push("");
    }

    // Main comparison table
    lines.push("## Scenario Comparison");
    lines.push("");
    lines.push(
      "| Scenario | Type | GPU | $/GPU-hr | $/month | $/year | Key Assumption | Stale? |",
    );
    lines.push(
      "|----------|------|-----|----------|---------|--------|----------------|--------|",
    );
    for (const s of scenarios) {
      const staleFlag = s.stale ? "⚠️" : "✓";
      lines.push(
        `| ${s.name} | ${s.type} | ${s.gpuModel} | ${
          formatUsd(s.costPerGpuHour)
        } ` +
          `| ${formatLargeUsd(s.monthlyTotalCost)} | ${
            formatLargeUsd(s.annualTotalCost)
          } ` +
          `| ${s.keyAssumption} | ${staleFlag} |`,
      );
    }
    lines.push("");

    // Cheapest callout
    lines.push(
      `**Cheapest scenario:** ${cheapest.name} at ${
        formatUsd(cheapest.costPerGpuHour)
      }/GPU-hr`,
    );
    lines.push("");

    // Crossover analysis (when ≥2 scenarios with same GPU model exist)
    const gpuGroups = new Map<string, ScenarioRow[]>();
    for (const s of scenarios) {
      const existing = gpuGroups.get(s.gpuModel) ?? [];
      existing.push(s);
      gpuGroups.set(s.gpuModel, existing);
    }

    const crossovers: Array<{
      statement: string;
      scenarios: string[];
      condition: string;
    }> = [];

    for (const [gpu, group] of gpuGroups) {
      if (group.length < 2 || gpu === "unknown") continue;

      // Compare cheapest vs next
      const sorted = [...group].sort((a, b) =>
        a.costPerGpuHour - b.costPerGpuHour
      );
      const best = sorted[0];
      const rest = sorted.slice(1);

      for (const other of rest) {
        const pctDiff =
          ((other.costPerGpuHour - best.costPerGpuHour) / best.costPerGpuHour *
            100).toFixed(0);
        const statement =
          `${best.name} (${best.type}) beats ${other.name} (${other.type}) by ${pctDiff}% on ${gpu}`;
        crossovers.push({
          statement,
          scenarios: [best.name, other.name],
          condition: `${best.keyAssumption} vs ${other.keyAssumption}`,
        });
      }
    }

    if (crossovers.length > 0) {
      lines.push("## Crossover Analysis");
      lines.push("");
      for (const c of crossovers) {
        lines.push(`- ${c.statement}`);
        lines.push(`  Condition: ${c.condition}`);
      }
      lines.push("");
    }

    // Stale scenarios advisory
    const staleScenarios = scenarios.filter((s) => s.stale);
    if (staleScenarios.length > 0) {
      lines.push("## Stale Pricing");
      lines.push("");
      lines.push(
        `${staleScenarios.length} scenario(s) have pricing older than ${STALE_DAYS} days. ` +
          "Consider refreshing rates with `update_rate` or `update_hardware_cost`.",
      );
      lines.push("");
      for (const s of staleScenarios) {
        lines.push(`- **${s.name}**: quoted ${s.quotedAt ?? "unknown date"}`);
      }
      lines.push("");
    }

    const markdown = lines.join("\n");
    const json = {
      generatedAt: new Date().toISOString(),
      scenarios,
      cheapest: {
        name: cheapest.name,
        costPerGpuHour: cheapest.costPerGpuHour,
      },
      crossovers,
      warnings,
      apiBreakEven: null, // populated when break-even data is available in projections
    };

    return { markdown, json };
  },
};
