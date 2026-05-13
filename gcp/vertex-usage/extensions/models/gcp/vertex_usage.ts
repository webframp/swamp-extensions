/**
 * GCP Vertex AI token usage monitoring model for swamp.
 *
 * Queries the Cloud Monitoring API for Vertex AI token_count metrics across
 * multiple GCP projects. Provides per-model breakdowns with input/output
 * direction split and tokens-per-minute rates.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the vertex-usage model. */
const GlobalArgsSchema = z.object({
  projects: z
    .array(z.string())
    .describe("GCP project IDs to scan for Vertex AI metrics"),
});

/** Schema for a single model's token usage. */
const ModelUsageSchema = z.object({
  modelId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

/** Schema for per-project usage results. */
const ProjectUsageSchema = z.object({
  project: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  models: z.array(ModelUsageSchema),
  periodMinutes: z.number(),
  inputTokensPerMinute: z.number(),
  outputTokensPerMinute: z.number(),
});

/** Schema for the full scan results. */
const ScanResultsSchema = z.object({
  scannedAt: z.string(),
  days: z.number(),
  periodMinutes: z.number(),
  truncated: z.boolean(),
  projects: z.array(ProjectUsageSchema),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    inputTokensPerMinute: z.number(),
    outputTokensPerMinute: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get an access token from gcloud CLI.
 *
 * @returns Bearer token string.
 */
async function getAccessToken(): Promise<string> {
  const cmd = new Deno.Command("gcloud", {
    args: ["auth", "print-access-token"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `Failed to get gcloud access token: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Parsed time series data point. */
interface TokenData {
  model: string;
  direction: string;
  tokens: number;
}

/**
 * Query Vertex AI token_count metrics for a project.
 *
 * @param project - GCP project ID.
 * @param token - Bearer access token.
 * @param startTime - ISO start time.
 * @param endTime - ISO end time.
 * @returns Array of token data points grouped by model and direction.
 */
async function queryTokenMetrics(
  project: string,
  token: string,
  startTime: string,
  endTime: string,
  days: number,
): Promise<{ data: TokenData[]; truncated: boolean }> {
  const MAX_PAGES = 50;
  const alignPeriod = Math.min(days * 24 * 3600, 30 * 24 * 3600);
  const filter = encodeURIComponent(
    'metric.type = "aiplatform.googleapis.com/publisher/online_serving/token_count"',
  );
  const baseUrl =
    `https://monitoring.googleapis.com/v3/projects/${
      encodeURIComponent(project)
    }/timeSeries` +
    `?filter=${filter}` +
    `&interval.startTime=${startTime}` +
    `&interval.endTime=${endTime}` +
    `&aggregation.alignmentPeriod=${alignPeriod}s` +
    `&aggregation.perSeriesAligner=ALIGN_SUM`;

  const results: TokenData[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (body.includes("Cannot find metric")) {
        return { data: [], truncated: false };
      }
      throw new Error(`Monitoring API error for ${project}: ${resp.status}`);
    }

    const data = await resp.json();

    for (const ts of data.timeSeries || []) {
      const labels = ts.metric?.labels || {};
      const resourceLabels = ts.resource?.labels || {};
      const model = resourceLabels.model_user_id || "unknown";
      const direction = labels.type || "unknown";
      let tokens = 0;
      for (const point of ts.points || []) {
        tokens += Number(
          point.value?.int64Value ?? point.value?.doubleValue ?? 0,
        );
      }
      results.push({ model, direction, tokens });
    }

    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { data: results, truncated: !!pageToken };
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** GCP Vertex AI token usage monitoring model. */
export const model = {
  type: "@webframp/gcp/vertex-usage",
  version: "2026.05.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    scan_results: {
      description: "Multi-project Vertex AI token usage scan results",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    single_scan: {
      description: "Single project Vertex AI token usage scan",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    scan_projects: {
      description:
        "Fan-out scan across all configured GCP projects. Returns per-project token usage with model-level breakdown.",
      arguments: z.object({
        days: z.number().min(1).max(90).default(30).describe(
          "Lookback period in days",
        ),
      }),
      execute: async (
        args: { days: number },
        context: {
          globalArgs: { projects: string[] };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const projects: z.infer<typeof ProjectUsageSchema>[] = [];
        let anyTruncated = false;

        for (const project of context.globalArgs.projects) {
          try {
            const token = await getAccessToken();
            const { data, truncated: pageTruncated } = await queryTokenMetrics(
              project,
              token,
              startTime.toISOString(),
              endTime.toISOString(),
              args.days,
            );

            if (data.length === 0) continue;
            if (pageTruncated) anyTruncated = true;

            // Aggregate by model
            const modelMap = new Map<
              string,
              { input: number; output: number }
            >();
            for (const d of data) {
              const existing = modelMap.get(d.model) || {
                input: 0,
                output: 0,
              };
              if (d.direction === "input") existing.input += d.tokens;
              else if (d.direction === "output") existing.output += d.tokens;
              modelMap.set(d.model, existing);
            }

            const models: z.infer<typeof ModelUsageSchema>[] = [];
            let totalInput = 0;
            let totalOutput = 0;

            for (const [modelId, usage] of modelMap) {
              models.push({
                modelId,
                inputTokens: usage.input,
                outputTokens: usage.output,
                totalTokens: usage.input + usage.output,
              });
              totalInput += usage.input;
              totalOutput += usage.output;
            }

            models.sort((a, b) => b.totalTokens - a.totalTokens);

            projects.push({
              project,
              inputTokens: totalInput,
              outputTokens: totalOutput,
              totalTokens: totalInput + totalOutput,
              models,
              periodMinutes,
              inputTokensPerMinute: totalInput / periodMinutes,
              outputTokensPerMinute: totalOutput / periodMinutes,
            });

            context.logger.info("Scanned project", {
              project,
              totalTokens: totalInput + totalOutput,
            });
          } catch (err) {
            context.logger.warn("Failed to scan project", {
              project,
              error: String(err),
            });
          }
        }

        projects.sort((a, b) => b.totalTokens - a.totalTokens);

        const totalInput = projects.reduce(
          (s, p) => s + p.inputTokens,
          0,
        );
        const totalOutput = projects.reduce(
          (s, p) => s + p.outputTokens,
          0,
        );

        const result = {
          scannedAt: new Date().toISOString(),
          truncated: anyTruncated,
          days: args.days,
          periodMinutes,
          projects,
          totals: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
            inputTokensPerMinute: totalInput / periodMinutes,
            outputTokensPerMinute: totalOutput / periodMinutes,
          },
        };

        const handle = await context.writeResource(
          "scan_results",
          "current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    get_token_usage: {
      description:
        "Get token usage for a single GCP project with model breakdown.",
      arguments: z.object({
        project: z.string().describe("GCP project ID"),
        days: z.number().min(1).max(90).default(30).describe(
          "Lookback period in days",
        ),
      }),
      execute: async (
        args: { project: string; days: number },
        context: {
          globalArgs: { projects: string[] };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const token = await getAccessToken();

        const { data, truncated: pageTruncated } = await queryTokenMetrics(
          args.project,
          token,
          startTime.toISOString(),
          endTime.toISOString(),
          args.days,
        );

        const modelMap = new Map<
          string,
          { input: number; output: number }
        >();
        for (const d of data) {
          const existing = modelMap.get(d.model) || { input: 0, output: 0 };
          if (d.direction === "input") existing.input += d.tokens;
          else if (d.direction === "output") existing.output += d.tokens;
          modelMap.set(d.model, existing);
        }

        const models: z.infer<typeof ModelUsageSchema>[] = [];
        let totalInput = 0;
        let totalOutput = 0;
        for (const [modelId, usage] of modelMap) {
          models.push({
            modelId,
            inputTokens: usage.input,
            outputTokens: usage.output,
            totalTokens: usage.input + usage.output,
          });
          totalInput += usage.input;
          totalOutput += usage.output;
        }
        models.sort((a, b) => b.totalTokens - a.totalTokens);

        const result = {
          scannedAt: new Date().toISOString(),
          truncated: pageTruncated,
          days: args.days,
          periodMinutes,
          projects: [
            {
              project: args.project,
              inputTokens: totalInput,
              outputTokens: totalOutput,
              totalTokens: totalInput + totalOutput,
              models,
              periodMinutes,
              inputTokensPerMinute: totalInput / periodMinutes,
              outputTokensPerMinute: totalOutput / periodMinutes,
            },
          ],
          totals: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
            inputTokensPerMinute: totalInput / periodMinutes,
            outputTokensPerMinute: totalOutput / periodMinutes,
          },
        };

        const handle = await context.writeResource(
          "single_scan",
          args.project,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
