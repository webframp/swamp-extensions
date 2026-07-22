/**
 * GCP Vertex AI token usage monitoring model for swamp.
 *
 * Queries the Cloud Monitoring API for Vertex AI token_count metrics across
 * multiple GCP projects. Provides per-model breakdowns with input/output
 * direction split and tokens-per-minute rates.
 *
 * Authentication uses a GCP service account JSON key (signed JWT → access
 * token exchange) with no dependency on the `gcloud` CLI.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the vertex-usage model. */
const GlobalArgsSchema = z.object({
  projects: z
    .array(z.string())
    .describe("GCP project IDs to scan for Vertex AI metrics"),
  serviceAccountJson: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "GCP service account JSON key (stringified). " +
        "Falls back to GOOGLE_APPLICATION_CREDENTIALS env var if omitted.",
    )
    .optional(),
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
// Auth Helpers
// ---------------------------------------------------------------------------

/** Parsed service account key fields we need. */
interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Base64url encode a buffer or string. */
function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Import a PEM-encoded RSA private key for RS256 signing.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Create a signed JWT for the service account and exchange it for an
 * access token at Google's token endpoint.
 */
async function getAccessToken(
  sa: ServiceAccountKey,
  fetchFn: typeof fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: MONITORING_SCOPE,
      aud: sa.token_uri || TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  const jwt = `${signingInput}.${base64url(sig)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const resp = await fetchFn(sa.token_uri || TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `GCP token exchange failed (${resp.status}): ${errBody}`,
    );
  }

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("GCP token response missing access_token field");
  }
  return data.access_token;
}

/**
 * Resolve service account credentials from globalArgs or environment.
 */
function resolveServiceAccount(
  globalArgs: { serviceAccountJson?: string },
): ServiceAccountKey {
  const raw = globalArgs.serviceAccountJson ??
    (() => {
      const path = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS");
      if (!path) {
        throw new Error(
          "No serviceAccountJson provided and GOOGLE_APPLICATION_CREDENTIALS " +
            "environment variable is not set. Provide one or the other.",
        );
      }
      return Deno.readTextFileSync(path);
    })();

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Service account JSON must contain client_email and private_key fields",
    );
  }

  return {
    client_email: parsed.client_email as string,
    private_key: parsed.private_key as string,
    token_uri: (parsed.token_uri as string) || TOKEN_ENDPOINT,
  };
}

// ---------------------------------------------------------------------------
// Monitoring API Helpers
// ---------------------------------------------------------------------------

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
 * @param days - Lookback period for alignment.
 * @param fetchFn - Fetch function (injected for testability).
 * @returns Array of token data points grouped by model and direction.
 */
async function queryTokenMetrics(
  project: string,
  token: string,
  startTime: string,
  endTime: string,
  days: number,
  fetchFn: typeof fetch,
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

    const resp = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (body.includes("Cannot find metric")) {
        return { data: [], truncated: false };
      }
      throw new Error(`Monitoring API error for ${project}: ${resp.status}`);
    }

    const data = (await resp.json()) as {
      timeSeries?: Array<{
        metric?: { labels?: Record<string, string> };
        resource?: { labels?: Record<string, string> };
        points?: Array<{
          value?: { int64Value?: string; doubleValue?: number };
        }>;
      }>;
      nextPageToken?: string;
    };

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
  version: "2026.07.21.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.21.1",
      description:
        "Remove gcloud CLI dependency; auth via service account JSON key",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
          globalArgs: { projects: string[]; serviceAccountJson?: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
          fetchFn?: typeof fetch;
        },
      ) => {
        const fetchFn = context.fetchFn ?? fetch;
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;
        const projects: z.infer<typeof ProjectUsageSchema>[] = [];
        let anyTruncated = false;

        const sa = resolveServiceAccount(context.globalArgs);
        const token = await getAccessToken(sa, fetchFn);

        for (const project of context.globalArgs.projects) {
          try {
            const { data, truncated: pageTruncated } = await queryTokenMetrics(
              project,
              token,
              startTime.toISOString(),
              endTime.toISOString(),
              args.days,
              fetchFn,
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
          globalArgs: { projects: string[]; serviceAccountJson?: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
          fetchFn?: typeof fetch;
        },
      ) => {
        const fetchFn = context.fetchFn ?? fetch;
        const endTime = new Date();
        const startTime = new Date(
          endTime.getTime() - args.days * 24 * 60 * 60 * 1000,
        );
        const periodMinutes = args.days * 24 * 60;

        const sa = resolveServiceAccount(context.globalArgs);
        const token = await getAccessToken(sa, fetchFn);

        const { data, truncated: pageTruncated } = await queryTokenMetrics(
          args.project,
          token,
          startTime.toISOString(),
          endTime.toISOString(),
          args.days,
          fetchFn,
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
