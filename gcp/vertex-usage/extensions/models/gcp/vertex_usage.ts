/**
 * GCP Vertex AI usage and cost analysis model for swamp.
 *
 * Combines two sources so token volume and dollars can be reconciled:
 *
 * - Cloud Monitoring `token_count` and `model_invocation_count` metrics,
 *   returned as flat daily rows per project, location, publisher, model and
 *   request type (`scan_usage`).
 * - The Cloud Billing export in BigQuery, the source of record for cost
 *   (`get_billing_costs`, `discover_billing_services`).
 *
 * Projects are either listed explicitly or discovered at runtime through the
 * Cloud Resource Manager API (`discover_projects`), so an account-wide scan
 * needs no hand-maintained project list. Results are written as one resource
 * instance per project so they can be filtered with CEL or `swamp data query`.
 *
 * Authentication supports a service account JSON key (signed JWT exchange), a
 * pre-obtained OAuth2 access token, or an `authorized_user` ADC file. There is
 * no dependency on the `gcloud` CLI.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";

const EXTENSION_NAME = "@webframp/gcp/vertex-usage";

const TOKEN_METRIC =
  "aiplatform.googleapis.com/publisher/online_serving/token_count";
const INVOCATION_METRIC =
  "aiplatform.googleapis.com/publisher/online_serving/model_invocation_count";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments for the vertex-usage model. */
const GlobalArgsSchema = z.object({
  projects: z
    .array(z.string().min(1))
    .min(1, "At least one GCP project ID must be configured")
    .describe(
      "GCP project IDs to scan for Vertex AI metrics. Optional: when omitted, " +
        "projects are discovered at runtime via the Cloud Resource Manager API.",
    )
    .optional(),
  serviceAccountJson: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "GCP service account JSON key (stringified). Falls back to the " +
        "GCP_ACCESS_TOKEN env var, then to the file named by " +
        "GOOGLE_APPLICATION_CREDENTIALS, if omitted.",
    )
    .optional(),
  billingTable: z
    .string()
    .regex(
      /^[A-Za-z0-9_.:-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_$-]+$/,
      "Must be a fully qualified BigQuery table: project.dataset.table",
    )
    .describe(
      "Cloud Billing export table, e.g. my-billing-proj.billing.gcp_billing_export_v1_XXXXXX. " +
        "Required for get_billing_costs and discover_billing_services.",
    )
    .optional(),
  billingSchema: z
    .enum(["auto", "standard", "focus"])
    .default("auto")
    .describe(
      "Billing export format: the standard usage-cost export, or the FOCUS " +
        "export. auto reads the table schema to decide.",
    ),
  billingQueryProject: z
    .string()
    .min(1)
    .describe(
      "Project that runs (and is billed for) BigQuery jobs. " +
        "Defaults to the project in billingTable.",
    )
    .optional(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Schema for a single model's token usage (legacy scan results). */
const ModelUsageSchema = z.object({
  modelId: z.string().describe(
    "Vertex AI publisher model ID (e.g. gemini-1.5-pro)",
  ),
  inputTokens: z.number().describe(
    "Total input-direction tokens for this model over the scanned period",
  ),
  outputTokens: z.number().describe(
    "Total output-direction tokens for this model over the scanned period",
  ),
  totalTokens: z.number().describe(
    "Sum of inputTokens and outputTokens for this model",
  ),
});

/** Schema for per-project usage results (legacy scan results). */
const ProjectUsageSchema = z.object({
  project: z.string().describe("GCP project ID"),
  inputTokens: z.number().describe(
    "Total input-direction tokens across all models over the scanned period",
  ),
  outputTokens: z.number().describe(
    "Total output-direction tokens across all models over the scanned period",
  ),
  totalTokens: z.number().describe(
    "Sum of inputTokens and outputTokens for this project",
  ),
  models: z.array(ModelUsageSchema).describe(
    "Per-model token usage breakdown",
  ),
  periodMinutes: z.number().describe(
    "Length of the scanned lookback period, in minutes",
  ),
  inputTokensPerMinute: z.number().describe(
    "inputTokens divided by periodMinutes",
  ),
  outputTokensPerMinute: z.number().describe(
    "outputTokens divided by periodMinutes",
  ),
});

/** Schema for the legacy full scan results. */
const ScanResultsSchema = z.object({
  scannedAt: z.string().describe("ISO 8601 timestamp when the scan completed"),
  days: z.number().describe("Lookback period in days used for this scan"),
  periodMinutes: z.number().describe(
    "Length of the scanned lookback period, in minutes",
  ),
  truncated: z.boolean().describe(
    "True if any project's metrics query was paginated beyond the fetch cap or failed, meaning results may be incomplete",
  ),
  projects: z.array(ProjectUsageSchema).describe(
    "Per-project usage results, sorted by totalTokens descending",
  ),
  totals: z.object({
    inputTokens: z.number().describe("Sum of inputTokens across all projects"),
    outputTokens: z.number().describe(
      "Sum of outputTokens across all projects",
    ),
    totalTokens: z.number().describe("Sum of totalTokens across all projects"),
    inputTokensPerMinute: z.number().describe(
      "Total inputTokens divided by periodMinutes",
    ),
    outputTokensPerMinute: z.number().describe(
      "Total outputTokens divided by periodMinutes",
    ),
  }),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const WindowSchema = z.object({
  start: z.string().describe("Inclusive window start (UTC midnight, ISO 8601)"),
  end: z.string().describe("Exclusive window end (UTC midnight, ISO 8601)"),
  days: z.number().describe("Number of complete UTC days in the window"),
});

const MetaFields = {
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
};

/** A discovered GCP project. */
const DiscoveredProjectSchema = z.object({
  projectId: z.string().describe("GCP project ID"),
  projectNumber: z.string().optional().describe("GCP project number"),
  displayName: z.string().optional().describe("Project display name"),
  parent: z.string().optional().describe(
    "Parent resource, e.g. folders/123 or organizations/456",
  ),
  state: z.string().describe("Lifecycle state, e.g. ACTIVE"),
  labels: z.record(z.string(), z.string()).optional().describe(
    "Project labels",
  ),
});

const ProjectsResultSchema = z.object({
  discoveredAt: z.string().describe("ISO 8601 timestamp of discovery"),
  parents: z.array(z.string()).describe(
    "Parents the search was scoped to; empty means every project the credential can see",
  ),
  count: z.number().describe("Number of projects discovered"),
  projects: z.array(DiscoveredProjectSchema),
  ...MetaFields,
});

/** One day of usage for a unique project/location/publisher/model/request type. */
const UsageRowSchema = z.object({
  date: z.string().describe("UTC calendar day, YYYY-MM-DD"),
  location: z.string().describe("Serving region, or 'unknown'"),
  publisher: z.string().describe("Model publisher, e.g. google, or 'unknown'"),
  modelId: z.string().describe("Publisher model ID"),
  requestType: z.string().describe(
    "Request type label (e.g. shared or dedicated), or 'unknown'",
  ),
  sharedRequestType: z.string().describe(
    "Shared request tier (e.g. standard), or '' when not applicable",
  ),
  inputTokens: z.number(),
  outputTokens: z.number(),
  otherTokens: z.number().describe(
    "Tokens whose direction label was neither input nor output",
  ),
  totalTokens: z.number(),
  requests: z.number().describe(
    "Model invocations; 0 when requestsAvailable is false",
  ),
  errorRequests: z.number().describe(
    "Invocations with a non-2xx response_code (includes rateLimitedRequests)",
  ),
  rateLimitedRequests: z.number().describe(
    "Invocations that returned HTTP 429",
  ),
});

const UsageTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  otherTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
  errorRequests: z.number(),
  rateLimitedRequests: z.number(),
});

/** Per-project usage, one resource instance per project. */
const UsageSchema = z.object({
  project: z.string().describe("GCP project ID"),
  window: WindowSchema,
  rows: z.array(UsageRowSchema).describe(
    "Flat daily rows; filter and group these with CEL",
  ),
  byModel: z.array(
    UsageTotalsSchema.extend({
      publisher: z.string(),
      modelId: z.string(),
    }),
  ).describe(
    "Per publisher/model rollup across days, locations and request types",
  ),
  totals: UsageTotalsSchema,
  requestsAvailable: z.boolean().describe(
    "False when the invocation-count metric could not be read for this project",
  ),
  truncated: z.boolean().describe(
    "True when pagination hit the fetch cap, so rows may be incomplete",
  ),
  warnings: z.array(z.string()),
  ...MetaFields,
});

/** Outcome of scanning one project. */
const ProjectStatusSchema = z.object({
  project: z.string(),
  status: z.enum(["ok", "no_data", "error"]).describe(
    "ok = usage found, no_data = metric empty for the window, error = scan failed",
  ),
  error: z.string().optional(),
  rows: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});

/** Summary of one scan_usage run. */
const ScanSummarySchema = z.object({
  scannedAt: z.string(),
  window: WindowSchema,
  discovered: z.boolean().describe(
    "True when the project list came from Resource Manager discovery",
  ),
  complete: z.boolean().describe(
    "False when any project errored, was truncated or lacked request counts; totals may understate usage",
  ),
  projects: z.array(ProjectStatusSchema).describe(
    "Per-project status, including projects that errored or had no data",
  ),
  totals: UsageTotalsSchema,
  ...MetaFields,
});

const BillingRowSchema = z.object({
  date: z.string().describe("UTC calendar day, YYYY-MM-DD"),
  project: z.string().describe("Project ID, or '' for unassigned charges"),
  service: z.string(),
  sku: z.string(),
  location: z.string(),
  costType: z.string().describe(
    "regular, tax, adjustment or rounding_error",
  ),
  currency: z.string(),
  usageUnit: z.string(),
  usageAmount: z.number(),
  cost: z.number().describe("Gross cost before credits"),
  credits: z.number().describe("Sum of credits (negative values reduce cost)"),
  netCost: z.number().describe("cost + credits"),
});

const CurrencyTotalSchema = z.object({
  currency: z.string(),
  cost: z.number(),
  credits: z.number(),
  netCost: z.number(),
});

/** Per-project billing, one resource instance per project. */
const BillingCostsSchema = z.object({
  project: z.string().describe("Project ID, or '' for unassigned charges"),
  window: WindowSchema,
  services: z.array(z.string()).describe("Service filter used"),
  rows: z.array(BillingRowSchema),
  totals: z.array(CurrencyTotalSchema).describe(
    "Totals per currency; currencies are never summed together",
  ),
  ...MetaFields,
});

const BillingSummarySchema = z.object({
  window: WindowSchema,
  table: z.string(),
  billingSchema: z.enum(["standard", "focus"]).describe(
    "Export format the table was read as",
  ),
  services: z.array(z.string()),
  skuPattern: z.string().optional(),
  projectCount: z.number(),
  rowCount: z.number(),
  totals: z.array(CurrencyTotalSchema),
  byProject: z.array(
    z.object({
      project: z.string(),
      totals: z.array(CurrencyTotalSchema),
    }),
  ),
  dataThrough: z.string().nullable().describe(
    "Latest usage_end_time in the export for the window; null if the window has no rows",
  ),
  complete: z.boolean().describe(
    "False when the export has not caught up to the window end, so recent days may be understated",
  ),
  warnings: z.array(z.string()),
  ...MetaFields,
});

const BillingServicesSchema = z.object({
  window: WindowSchema,
  table: z.string(),
  pattern: z.string(),
  services: z.array(
    z.object({
      service: z.string(),
      currency: z.string(),
      cost: z.number(),
      skuCount: z.number(),
    }),
  ),
  skus: z.array(
    z.object({
      service: z.string(),
      sku: z.string(),
      currency: z.string(),
      usageUnit: z.string(),
      usageAmount: z.number(),
      cost: z.number(),
    }),
  ),
  ...MetaFields,
});

const GeminiTokenRowSchema = z.object({
  date: z.string().describe("UTC calendar day, YYYY-MM-DD"),
  location: z.string(),
  modelId: z.string().describe("Gemini API model name"),
  outputModality: z.string().describe("e.g. text or image; '' when absent"),
  thinkingEnabled: z.string().describe("'true', 'false' or '' when absent"),
  outputTokens: z.number(),
});

const GeminiRequestRowSchema = z.object({
  date: z.string().describe("UTC calendar day, YYYY-MM-DD"),
  location: z.string(),
  apiVersion: z.string().describe("API version, e.g. v1beta"),
  method: z.string().describe(
    "Service method without the google.ai.generativelanguage.<version> prefix",
  ),
  credentialId: z.string().describe(
    "Credential the call used, e.g. apikey:<id>; '' when absent",
  ),
  responseCode: z.string(),
  requests: z.number(),
});

const GeminiTotalsSchema = z.object({
  outputTokens: z.number(),
  requests: z.number().describe("All API methods, not only generation"),
  errorRequests: z.number().describe("Requests with a non-2xx response code"),
  rateLimitedRequests: z.number().describe("Requests that returned HTTP 429"),
});

/** Per-project Gemini API usage, one resource instance per project. */
const GeminiUsageSchema = z.object({
  project: z.string(),
  window: WindowSchema,
  inputTokensAvailable: z.literal(false).describe(
    "Cloud Monitoring exposes no input-token metric for the Gemini API; use billing for input volume",
  ),
  tokenRows: z.array(GeminiTokenRowSchema),
  requestRows: z.array(GeminiRequestRowSchema),
  byModel: z.array(z.object({ modelId: z.string(), outputTokens: z.number() })),
  byCredential: z.array(
    z.object({
      credentialId: z.string(),
      requests: z.number(),
      errorRequests: z.number(),
    }),
  ),
  totals: GeminiTotalsSchema,
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  ...MetaFields,
});

const GeminiStatusSchema = z.object({
  project: z.string(),
  status: z.enum(["ok", "no_data", "error"]),
  error: z.string().optional(),
  rows: z.number(),
  outputTokens: z.number(),
  requests: z.number(),
});

const GeminiScanSummarySchema = z.object({
  scannedAt: z.string(),
  window: WindowSchema,
  discovered: z.boolean(),
  complete: z.boolean().describe(
    "False when any project errored, was truncated or lacked request counts",
  ),
  projects: z.array(GeminiStatusSchema),
  totals: GeminiTotalsSchema,
  ...MetaFields,
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The slice of the swamp method context these methods use. */
interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
  };
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  /** Injected for tests so retry backoff does not sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected for tests so rate limiting does not depend on the wall clock. */
  nowFn?: () => number;
}

// ---------------------------------------------------------------------------
// HTTP with retry
// ---------------------------------------------------------------------------

interface Http {
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  nowFn: () => number;
  /** Awaited before every request when set; see makeRateLimiter. */
  limit?: () => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 500;
const RATE_LIMIT_DELAY_MS = 5_000;

function makeHttp(context: MethodContext): Http {
  return {
    fetchFn: context.fetchFn ?? fetch,
    sleepFn: context.sleepFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    nowFn: context.nowFn ?? Date.now,
  };
}

/**
 * Sliding-window limiter: at most `perMinute` requests in any 60s window.
 * Cloud Monitoring's default quota is 180 requests per minute per user, and a
 * fan-out over ~100 projects exceeds that within seconds without it.
 */
function makeRateLimiter(
  perMinute: number,
  http: Pick<Http, "sleepFn" | "nowFn">,
): () => Promise<void> {
  const stamps: number[] = [];
  return async () => {
    for (;;) {
      const t = http.nowFn();
      while (stamps.length > 0 && t - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length < perMinute) {
        stamps.push(t);
        return;
      }
      await http.sleepFn(stamps[0] + 60_000 - t);
    }
  };
}

/**
 * fetch with exponential backoff on 429 and 5xx. Returns the final response,
 * which the caller checks; network errors propagate after the last attempt.
 */
async function gcpFetch(
  http: Http,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0;; attempt++) {
    let resp: Response | undefined;
    await http.limit?.();
    try {
      resp = await http.fetchFn(url, init);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
    }
    if (resp && (!RETRY_STATUSES.has(resp.status) || attempt >= MAX_RETRIES)) {
      return resp;
    }
    const retryAfter = Number(resp?.headers.get("retry-after"));
    // Quota (429) windows last a minute, so back off harder than for 5xx.
    const base = resp?.status === 429 ? RATE_LIMIT_DELAY_MS : BASE_DELAY_MS;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 60_000)
      : Math.min(base * 2 ** attempt, 30_000);
    await resp?.body?.cancel();
    await http.sleepFn(delay);
  }
}

// ---------------------------------------------------------------------------
// Auth Helpers
// ---------------------------------------------------------------------------

/** Parsed service account key fields we need. */
interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

type Credentials =
  | { kind: "service_account"; key: ServiceAccountKey }
  | {
    kind: "authorized_user";
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    tokenUri: string;
  }
  | { kind: "access_token"; token: string };

const SCOPE_MONITORING = "https://www.googleapis.com/auth/monitoring.read";
const SCOPE_PROJECTS =
  "https://www.googleapis.com/auth/cloudplatformprojects.readonly";
const SCOPE_BIGQUERY = "https://www.googleapis.com/auth/bigquery";
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

/** Read the access_token field from a token endpoint response. */
async function readTokenResponse(
  resp: Response,
  who: string,
): Promise<string> {
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `GCP token exchange failed (${resp.status}): ${errBody}`,
    );
  }
  let data: { access_token?: string };
  try {
    data = (await resp.json()) as { access_token?: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GCP token exchange returned malformed JSON for ${who}: ${msg}`,
      { cause: err },
    );
  }
  if (!data.access_token) {
    throw new Error(
      `GCP token exchange response for ${who} is missing the access_token field`,
    );
  }
  return data.access_token;
}

/**
 * Create a signed JWT for the service account and exchange it for an
 * access token at Google's token endpoint.
 */
async function getServiceAccountToken(
  sa: ServiceAccountKey,
  scopes: string[],
  http: Http,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(" "),
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

  const resp = await gcpFetch(http, sa.token_uri || TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return readTokenResponse(resp, `service account "${sa.client_email}"`);
}

/** Exchange an `authorized_user` refresh token for an access token. */
async function getAuthorizedUserToken(
  creds: Extract<Credentials, { kind: "authorized_user" }>,
  http: Http,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  const resp = await gcpFetch(http, creds.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return readTokenResponse(resp, "authorized_user credentials");
}

/** Turn resolved credentials into a bearer token for the given scopes. */
async function getAccessToken(
  creds: Credentials,
  scopes: string[],
  http: Http,
): Promise<string> {
  switch (creds.kind) {
    case "access_token":
      return creds.token;
    case "authorized_user":
      return await getAuthorizedUserToken(creds, http);
    case "service_account":
      return await getServiceAccountToken(creds.key, scopes, http);
  }
}

/** Parse a credentials JSON document (service account or authorized_user). */
function parseCredentialsJson(raw: string): Credentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Service account credentials are not valid JSON: ${msg}`,
      { cause: err },
    );
  }
  if (parsed.type === "authorized_user") {
    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
      throw new Error(
        "authorized_user credentials must contain client_id, client_secret and refresh_token fields",
      );
    }
    return {
      kind: "authorized_user",
      clientId: parsed.client_id as string,
      clientSecret: parsed.client_secret as string,
      refreshToken: parsed.refresh_token as string,
      tokenUri: (parsed.token_uri as string) || TOKEN_ENDPOINT,
    };
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Service account JSON must contain client_email and private_key fields",
    );
  }
  return {
    kind: "service_account",
    key: {
      client_email: parsed.client_email as string,
      private_key: parsed.private_key as string,
      token_uri: (parsed.token_uri as string) || TOKEN_ENDPOINT,
    },
  };
}

/**
 * Resolve credentials. Order: serviceAccountJson arg, GCP_ACCESS_TOKEN env,
 * then the file named by GOOGLE_APPLICATION_CREDENTIALS.
 */
function resolveCredentials(
  globalArgs: { serviceAccountJson?: string },
): Credentials {
  if (globalArgs.serviceAccountJson) {
    return parseCredentialsJson(globalArgs.serviceAccountJson);
  }
  const accessToken = Deno.env.get("GCP_ACCESS_TOKEN");
  if (accessToken) return { kind: "access_token", token: accessToken };

  const path = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS");
  if (!path) {
    throw new Error(
      "No serviceAccountJson provided and neither GCP_ACCESS_TOKEN nor " +
        "GOOGLE_APPLICATION_CREDENTIALS is set. Provide one of them.",
    );
  }
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read service account key file at GOOGLE_APPLICATION_CREDENTIALS ` +
        `path "${path}": ${msg}`,
      { cause: err },
    );
  }
  return parseCredentialsJson(raw);
}

// ---------------------------------------------------------------------------
// Time windows and small helpers
// ---------------------------------------------------------------------------

interface Window {
  start: Date;
  end: Date;
  days: number;
}

/**
 * The last `days` complete UTC days, ending at today's UTC midnight. Aligning
 * to midnight makes Monitoring's daily buckets and billing's usage_start_time
 * cover identical days, so the two can be compared.
 */
function completeDaysWindow(days: number, now = new Date()): Window {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start: new Date(end.getTime() - days * DAY_MS), end, days };
}

function windowOut(w: Window): z.infer<typeof WindowSchema> {
  return {
    start: w.start.toISOString(),
    end: w.end.toISOString(),
    days: w.days,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Resource instance names map to storage paths, so keep them path-safe. */
function instanceName(prefix: string, id: string): string {
  return `${prefix}-${
    id === "" ? "unassigned" : id.replace(/[^A-Za-z0-9_.-]/g, "_")
  }`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Project discovery (Cloud Resource Manager)
// ---------------------------------------------------------------------------

const PARENT_RE = /^(organizations|folders)\/\d+$/;

/**
 * List ACTIVE projects visible to the credential via projects:search. With
 * `parents`, restricts to direct children of those organizations or folders.
 */
async function discoverProjects(
  token: string,
  parents: string[],
  http: Http,
): Promise<z.infer<typeof DiscoveredProjectSchema>[]> {
  const MAX_PAGES = 100;
  const clauses = ["state:ACTIVE"];
  if (parents.length > 0) {
    clauses.push(`(${parents.map((p) => `parent:${p}`).join(" OR ")})`);
  }
  const base =
    `https://cloudresourcemanager.googleapis.com/v3/projects:search` +
    `?pageSize=500&query=${encodeURIComponent(clauses.join(" "))}`;

  const found: z.infer<typeof DiscoveredProjectSchema>[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = pageToken
      ? `${base}&pageToken=${encodeURIComponent(pageToken)}`
      : base;
    const resp = await gcpFetch(http, url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `Cloud Resource Manager project search failed (HTTP ${resp.status}): ${await resp
          .text()}`,
      );
    }
    let data: {
      projects?: Array<{
        projectId?: string;
        name?: string;
        displayName?: string;
        parent?: string;
        state?: string;
        labels?: Record<string, string>;
      }>;
      nextPageToken?: string;
    };
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(
        `Cloud Resource Manager returned malformed JSON: ${errMessage(err)}`,
        { cause: err },
      );
    }
    for (const p of data.projects ?? []) {
      if (!p.projectId) continue;
      found.push({
        projectId: p.projectId,
        projectNumber: p.name?.replace(/^projects\//, ""),
        displayName: p.displayName,
        parent: p.parent,
        state: p.state ?? "ACTIVE",
        labels: p.labels,
      });
    }
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  if (pageToken) {
    throw new Error(
      `Project discovery stopped after ${MAX_PAGES} pages with more results remaining; ` +
        `scope it with parents or pass an explicit project list.`,
    );
  }
  found.sort((a, b) => a.projectId.localeCompare(b.projectId));
  return found;
}

/**
 * Decide which projects to scan. Precedence: explicit method `projects`,
 * then the model's `projects` global arg, then runtime discovery.
 */
async function resolveProjects(
  explicit: string[] | undefined,
  parents: string[],
  globalArgs: GlobalArgs,
  creds: Credentials,
  http: Http,
  extraScopes: string[],
): Promise<{ projects: string[]; discovered: boolean; token: string }> {
  const list = explicit?.length ? explicit : globalArgs.projects;
  if (list && list.length > 0) {
    if (parents.length > 0) {
      throw new Error(
        "parents only applies to project discovery, but an explicit project list was provided",
      );
    }
    const token = await getAccessToken(creds, extraScopes, http);
    return { projects: [...new Set(list)], discovered: false, token };
  }
  const token = await getAccessToken(
    creds,
    [...extraScopes, SCOPE_PROJECTS],
    http,
  );
  const found = await discoverProjects(token, parents, http);
  return {
    projects: found.map((p) => p.projectId),
    discovered: true,
    token,
  };
}

// ---------------------------------------------------------------------------
// Monitoring API Helpers
// ---------------------------------------------------------------------------

interface TimeSeries {
  metric?: { labels?: Record<string, string> };
  resource?: { labels?: Record<string, string> };
  points?: Array<{
    interval?: { startTime?: string; endTime?: string };
    value?: { int64Value?: string; doubleValue?: number };
  }>;
}

const MAX_PAGES = 50;

/**
 * Page through timeSeries.list for one metric. Returns an empty set when the
 * metric does not exist for the project (Vertex never used there).
 */
async function listTimeSeries(
  project: string,
  token: string,
  metricType: string,
  startTime: string,
  endTime: string,
  alignPeriodSeconds: number,
  http: Http,
  extraFilter?: string,
): Promise<{ series: TimeSeries[]; truncated: boolean }> {
  const filter = encodeURIComponent(
    `metric.type = "${metricType}"${extraFilter ? ` AND ${extraFilter}` : ""}`,
  );
  const baseUrl =
    `https://monitoring.googleapis.com/v3/projects/${
      encodeURIComponent(project)
    }/timeSeries` +
    `?filter=${filter}` +
    `&interval.startTime=${startTime}` +
    `&interval.endTime=${endTime}` +
    `&aggregation.alignmentPeriod=${alignPeriodSeconds}s` +
    `&aggregation.perSeriesAligner=ALIGN_SUM`;

  const series: TimeSeries[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;
    const resp = await gcpFetch(http, url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (body.includes("Cannot find metric")) {
        return { series: [], truncated: false };
      }
      throw new Error(
        `Cloud Monitoring API request failed for project "${project}" ` +
          `(HTTP ${resp.status}): ${body}`,
      );
    }

    let data: { timeSeries?: TimeSeries[]; nextPageToken?: string };
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(
        `Cloud Monitoring API returned malformed JSON for project "${project}": ${
          errMessage(err)
        }`,
        { cause: err },
      );
    }
    series.push(...(data.timeSeries ?? []));
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { series, truncated: !!pageToken };
}

function pointValue(
  p: { value?: { int64Value?: string; doubleValue?: number } },
): number {
  return Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
}

/** UTC calendar day a daily-aligned point belongs to. */
function pointDay(
  p: { interval?: { startTime?: string; endTime?: string } },
): string | undefined {
  const start = p.interval?.startTime;
  if (start) return start.slice(0, 10);
  const end = p.interval?.endTime;
  // A point with only an end time covers the day ending there.
  return end
    ? new Date(Date.parse(end) - 1).toISOString().slice(0, 10)
    : undefined;
}

type UsageRow = z.infer<typeof UsageRowSchema>;
type UsageTotals = z.infer<typeof UsageTotalsSchema>;

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    otherTokens: 0,
    totalTokens: 0,
    requests: 0,
    errorRequests: 0,
    rateLimitedRequests: 0,
  };
}

function addTotals(into: UsageTotals, row: UsageTotals): void {
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.otherTokens += row.otherTokens;
  into.totalTokens += row.totalTokens;
  into.requests += row.requests;
  into.errorRequests += row.errorRequests;
  into.rateLimitedRequests += row.rateLimitedRequests;
}

/** Fold token and invocation series into flat daily rows. */
function buildUsageRows(
  tokenSeries: TimeSeries[],
  invocationSeries: TimeSeries[],
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const rowFor = (ts: TimeSeries, date: string): UsageRow => {
    const res = ts.resource?.labels ?? {};
    const met = ts.metric?.labels ?? {};
    const location = res.location || "unknown";
    const publisher = res.publisher || "unknown";
    const modelId = res.model_user_id || "unknown";
    const requestType = met.request_type || "unknown";
    const sharedRequestType = met.shared_request_type || "";
    const key = [
      date,
      location,
      publisher,
      modelId,
      requestType,
      sharedRequestType,
    ].join("\u0000");
    let row = rows.get(key);
    if (!row) {
      row = {
        date,
        location,
        publisher,
        modelId,
        requestType,
        sharedRequestType,
        inputTokens: 0,
        outputTokens: 0,
        otherTokens: 0,
        totalTokens: 0,
        requests: 0,
        errorRequests: 0,
        rateLimitedRequests: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const ts of tokenSeries) {
    const direction = ts.metric?.labels?.type;
    for (const p of ts.points ?? []) {
      const date = pointDay(p);
      if (!date) continue;
      const row = rowFor(ts, date);
      const n = pointValue(p);
      if (direction === "input") row.inputTokens += n;
      else if (direction === "output") row.outputTokens += n;
      else row.otherTokens += n;
      row.totalTokens += n;
    }
  }
  for (const ts of invocationSeries) {
    const code = ts.metric?.labels?.response_code ?? "";
    for (const p of ts.points ?? []) {
      const date = pointDay(p);
      if (!date) continue;
      const row = rowFor(ts, date);
      const n = pointValue(p);
      row.requests += n;
      // An absent response_code is not evidence of failure.
      if (code !== "" && !code.startsWith("2")) row.errorRequests += n;
      if (code === "429") row.rateLimitedRequests += n;
    }
  }

  return [...rows.values()].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.publisher.localeCompare(b.publisher) ||
    a.modelId.localeCompare(b.modelId) ||
    a.location.localeCompare(b.location) ||
    a.requestType.localeCompare(b.requestType) ||
    a.sharedRequestType.localeCompare(b.sharedRequestType)
  );
}

function rollup(rows: UsageRow[]): {
  totals: UsageTotals;
  byModel: Array<UsageTotals & { publisher: string; modelId: string }>;
} {
  const totals = emptyTotals();
  const models = new Map<
    string,
    UsageTotals & { publisher: string; modelId: string }
  >();
  for (const row of rows) {
    addTotals(totals, row);
    const key = `${row.publisher}\u0000${row.modelId}`;
    let m = models.get(key);
    if (!m) {
      m = {
        publisher: row.publisher,
        modelId: row.modelId,
        ...emptyTotals(),
      };
      models.set(key, m);
    }
    addTotals(m, row);
  }
  const byModel = [...models.values()].sort((a, b) =>
    b.totalTokens - a.totalTokens
  );
  return { totals, byModel };
}

/** Scan one project's daily token and request usage. */
async function scanProjectUsage(
  project: string,
  token: string,
  window: Window,
  http: Http,
): Promise<z.infer<typeof UsageSchema>> {
  const start = window.start.toISOString();
  const end = window.end.toISOString();
  const warnings: string[] = [];

  const tokens = await listTimeSeries(
    project,
    token,
    TOKEN_METRIC,
    start,
    end,
    86400,
    http,
  );

  let invocations: { series: TimeSeries[]; truncated: boolean } = {
    series: [],
    truncated: false,
  };
  let requestsAvailable = true;
  try {
    invocations = await listTimeSeries(
      project,
      token,
      INVOCATION_METRIC,
      start,
      end,
      86400,
      http,
    );
  } catch (err) {
    requestsAvailable = false;
    warnings.push(`Request counts unavailable: ${errMessage(err)}`);
  }

  const rows = buildUsageRows(tokens.series, invocations.series);
  const { totals, byModel } = rollup(rows);
  return {
    project,
    window: windowOut(window),
    rows,
    byModel,
    totals,
    requestsAvailable,
    truncated: tokens.truncated || invocations.truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Gemini API (generativelanguage.googleapis.com)
// ---------------------------------------------------------------------------

const GEMINI_TOKEN_METRIC =
  "generativelanguage.googleapis.com/generate_content_usage_output_token_count";
const GEMINI_REQUEST_METRIC = "serviceruntime.googleapis.com/api/request_count";
const GEMINI_SERVICE = "generativelanguage.googleapis.com";

type GeminiUsage = z.infer<typeof GeminiUsageSchema>;

/** Scan one project's Gemini API output tokens and request counts by day. */
async function scanProjectGemini(
  project: string,
  token: string,
  window: Window,
  http: Http,
): Promise<GeminiUsage> {
  const start = window.start.toISOString();
  const end = window.end.toISOString();
  const warnings: string[] = [];

  const tokens = await listTimeSeries(
    project,
    token,
    GEMINI_TOKEN_METRIC,
    start,
    end,
    86400,
    http,
  );
  // Request counts are API-wide, so failing to read them must not hide tokens.
  let requests: { series: TimeSeries[]; truncated: boolean } = {
    series: [],
    truncated: false,
  };
  try {
    requests = await listTimeSeries(
      project,
      token,
      GEMINI_REQUEST_METRIC,
      start,
      end,
      86400,
      http,
      `resource.labels.service = "${GEMINI_SERVICE}"`,
    );
  } catch (err) {
    warnings.push(`Request counts unavailable: ${errMessage(err)}`);
  }

  const tokenRows = new Map<string, z.infer<typeof GeminiTokenRowSchema>>();
  for (const ts of tokens.series) {
    const res = ts.resource?.labels ?? {};
    const met = ts.metric?.labels ?? {};
    for (const p of ts.points ?? []) {
      const date = pointDay(p);
      if (!date) continue;
      const row = {
        date,
        location: res.location || "unknown",
        modelId: met.model || "unknown",
        outputModality: met.output_modality ?? "",
        thinkingEnabled: met.thinking_enabled ?? "",
        outputTokens: 0,
      };
      const key = [
        row.date,
        row.location,
        row.modelId,
        row.outputModality,
        row.thinkingEnabled,
      ].join("\u0000");
      const existing = tokenRows.get(key) ?? row;
      existing.outputTokens += pointValue(p);
      tokenRows.set(key, existing);
    }
  }

  const requestRows = new Map<string, z.infer<typeof GeminiRequestRowSchema>>();
  for (const ts of requests.series) {
    const res = ts.resource?.labels ?? {};
    const met = ts.metric?.labels ?? {};
    const method = (res.method ?? "").replace(
      /^google\.ai\.generativelanguage\.[^.]+\./,
      "",
    );
    for (const p of ts.points ?? []) {
      const date = pointDay(p);
      if (!date) continue;
      const row = {
        date,
        location: res.location || "unknown",
        apiVersion: res.version ?? "",
        method,
        credentialId: res.credential_id ?? "",
        responseCode: met.response_code ?? "",
        requests: 0,
      };
      const key = [
        row.date,
        row.location,
        row.apiVersion,
        row.method,
        row.credentialId,
        row.responseCode,
      ].join("\u0000");
      const existing = requestRows.get(key) ?? row;
      existing.requests += pointValue(p);
      requestRows.set(key, existing);
    }
  }

  const tokenList = [...tokenRows.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.modelId.localeCompare(b.modelId) ||
    a.location.localeCompare(b.location) ||
    a.outputModality.localeCompare(b.outputModality) ||
    a.thinkingEnabled.localeCompare(b.thinkingEnabled)
  );
  const requestList = [...requestRows.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.method.localeCompare(b.method) ||
    a.credentialId.localeCompare(b.credentialId) ||
    a.responseCode.localeCompare(b.responseCode)
  );

  const totals = {
    outputTokens: 0,
    requests: 0,
    errorRequests: 0,
    rateLimitedRequests: 0,
  };
  const models = new Map<string, number>();
  for (const r of tokenList) {
    totals.outputTokens += r.outputTokens;
    models.set(r.modelId, (models.get(r.modelId) ?? 0) + r.outputTokens);
  }
  const creds = new Map<string, { requests: number; errorRequests: number }>();
  for (const r of requestList) {
    totals.requests += r.requests;
    const isError = r.responseCode !== "" && !r.responseCode.startsWith("2");
    if (isError) totals.errorRequests += r.requests;
    if (r.responseCode === "429") totals.rateLimitedRequests += r.requests;
    const c = creds.get(r.credentialId) ?? { requests: 0, errorRequests: 0 };
    c.requests += r.requests;
    if (isError) c.errorRequests += r.requests;
    creds.set(r.credentialId, c);
  }

  return {
    project,
    window: windowOut(window),
    inputTokensAvailable: false,
    tokenRows: tokenList,
    requestRows: requestList,
    byModel: [...models].map(([modelId, outputTokens]) => ({
      modelId,
      outputTokens,
    })).sort((a, b) => b.outputTokens - a.outputTokens),
    byCredential: [...creds].map(([credentialId, c]) => ({
      credentialId,
      ...c,
    })).sort((a, b) => b.requests - a.requests),
    totals,
    truncated: tokens.truncated || requests.truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Fan-out over projects
// ---------------------------------------------------------------------------

const NO_PROJECTS_MESSAGE =
  "No projects to scan: discovery returned none. Check the credential's " +
  "resourcemanager.projects.get access or pass an explicit project list.";

interface FanOutArgs {
  days: number;
  projects?: string[];
  parents: string[];
  concurrency: number;
  maxRequestsPerMinute: number;
}

const MaxRequestsPerMinuteArg = z.number().int().min(10).max(6000).default(120)
  .describe(
    "Cap on Cloud Monitoring requests per minute across all projects. The " +
      "default Monitoring quota is 180 per minute per user, so 120 leaves headroom.",
  );

/**
 * Resolve the project list and run `scanOne` over it with bounded
 * concurrency. A failing project is captured as an error result and logged,
 * never dropped.
 */
async function fanOutProjects<U>(
  args: FanOutArgs,
  context: MethodContext,
  scanOne: (
    project: string,
    token: string,
    window: Window,
    http: Http,
  ) => Promise<U>,
): Promise<{
  window: Window;
  discovered: boolean;
  results: Array<
    { project: string; usage: U } | { project: string; error: string }
  >;
}> {
  const http = makeHttp(context);
  const creds = resolveCredentials(context.globalArgs);
  const window = completeDaysWindow(args.days);

  const { projects, discovered, token } = await resolveProjects(
    args.projects,
    args.parents,
    context.globalArgs,
    creds,
    http,
    [SCOPE_MONITORING],
  );
  if (projects.length === 0) throw new Error(NO_PROJECTS_MESSAGE);

  const scanHttp: Http = {
    ...http,
    limit: makeRateLimiter(args.maxRequestsPerMinute, http),
  };
  const results = await mapLimit(projects, args.concurrency, async (p) => {
    try {
      return { project: p, usage: await scanOne(p, token, window, scanHttp) };
    } catch (err) {
      context.logger.warn("Failed to scan project", {
        project: p,
        error: errMessage(err),
      });
      return { project: p, error: errMessage(err) };
    }
  });

  if (results.every((r) => "error" in r)) {
    const first = results[0] as { error: string };
    throw new Error(
      `Every project failed to scan (${results.length}). First error: ${first.error}`,
    );
  }
  return { window, discovered, results };
}

// ---------------------------------------------------------------------------
// BigQuery Helpers
// ---------------------------------------------------------------------------

type BqParam = {
  name: string;
  parameterType: {
    type: string;
    arrayType?: { type: string };
  };
  parameterValue: {
    value?: string;
    arrayValues?: Array<{ value: string }>;
  };
};

const bqString = (name: string, value: string): BqParam => ({
  name,
  parameterType: { type: "STRING" },
  parameterValue: { value },
});
const bqTimestamp = (name: string, value: Date): BqParam => ({
  name,
  parameterType: { type: "TIMESTAMP" },
  parameterValue: { value: value.toISOString() },
});
const bqStringArray = (name: string, values: string[]): BqParam => ({
  name,
  parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
  parameterValue: { arrayValues: values.map((value) => ({ value })) },
});

type BqRow = Record<string, string | null>;

interface BqResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: Array<{ name: string }> };
  rows?: Array<{ f: Array<{ v: string | null }> }>;
  pageToken?: string;
  errors?: unknown;
}

/**
 * Run a parameterized standard-SQL query through jobs.query and collect every
 * page. Throws rather than returning partial results: a cost figure built from
 * a truncated result set would be silently wrong.
 */
async function runBigQuery(
  jobProject: string,
  sql: string,
  params: BqParam[],
  token: string,
  http: Http,
): Promise<BqRow[]> {
  const MAX_POLLS = 20;
  const MAX_RESULT_PAGES = 200;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${
    encodeURIComponent(jobProject)
  }/queries`;

  const readJson = async (resp: Response): Promise<BqResponse> => {
    if (!resp.ok) {
      throw new Error(
        `BigQuery request failed (HTTP ${resp.status}): ${await resp.text()}`,
      );
    }
    try {
      return await resp.json() as BqResponse;
    } catch (err) {
      throw new Error(`BigQuery returned malformed JSON: ${errMessage(err)}`, {
        cause: err,
      });
    }
  };

  let page = await readJson(
    await gcpFetch(http, base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: params,
        // Lets BigQuery deduplicate if a 5xx after acceptance makes us resend.
        requestId: crypto.randomUUID(),
        timeoutMs: 60_000,
        maxResults: 10_000,
      }),
    }),
  );

  const ref = page.jobReference;
  for (let polls = 0; page.jobComplete === false; polls++) {
    if (polls >= MAX_POLLS || !ref?.jobId) {
      throw new Error("BigQuery job did not complete in time");
    }
    const loc = ref.location
      ? `&location=${encodeURIComponent(ref.location)}`
      : "";
    page = await readJson(
      await gcpFetch(
        http,
        `${base}/${
          encodeURIComponent(ref.jobId)
        }?timeoutMs=30000&maxResults=10000${loc}`,
        { headers },
      ),
    );
  }

  const fields = (page.schema?.fields ?? []).map((f) => f.name);
  const out: BqRow[] = [];
  const collect = (p: BqResponse) => {
    for (const r of p.rows ?? []) {
      const row: BqRow = {};
      fields.forEach((name, i) => row[name] = r.f[i]?.v ?? null);
      out.push(row);
    }
  };
  collect(page);

  for (let pages = 0; page.pageToken; pages++) {
    if (pages >= MAX_RESULT_PAGES || !ref?.jobId) {
      throw new Error(
        "BigQuery result exceeded the page cap; narrow the window or filters",
      );
    }
    const loc = ref.location
      ? `&location=${encodeURIComponent(ref.location)}`
      : "";
    page = await readJson(
      await gcpFetch(
        http,
        `${base}/${encodeURIComponent(ref.jobId)}?maxResults=10000&pageToken=${
          encodeURIComponent(page.pageToken)
        }${loc}`,
        { headers },
      ),
    );
    collect(page);
  }
  return out;
}

/**
 * Split project.dataset.table. The project may itself contain dots and a colon
 * (domain-scoped IDs such as example.com:proj), so split from the right.
 */
function parseBillingTable(table: string): {
  project: string;
  dataset: string;
  name: string;
} {
  const m = /^(.+)\.([^.]+)\.([^.]+)$/.exec(table);
  if (!m) {
    throw new Error(
      `billingTable "${table}" is not a fully qualified project.dataset.table`,
    );
  }
  return { project: m[1], dataset: m[2], name: m[3] };
}

/** Resolve the billing table and the project that runs BigQuery jobs. */
function billingConfig(globalArgs: GlobalArgs): {
  table: string;
  jobProject: string;
} {
  if (!globalArgs.billingTable) {
    throw new Error(
      "billingTable is not configured. Set the billingTable global argument " +
        "to the Cloud Billing export table (project.dataset.table).",
    );
  }
  const jobProject = globalArgs.billingQueryProject ??
    parseBillingTable(globalArgs.billingTable).project;
  return { table: globalArgs.billingTable, jobProject };
}

/**
 * How each export format maps onto the fields these methods need. FOCUS
 * (FinOps Open Cost and Usage Specification) and the standard usage-cost export
 * name everything differently and disagree on what "cost" means:
 *
 * - standard: `cost` is gross, `credits[]` are negative, net = cost + credits.
 * - FOCUS: `ContractedCost` is gross, `x_Credits[]` are negative, and
 *   `BilledCost` is net (verified: ContractedCost + credits = BilledCost).
 */
interface BillingColumns {
  schema: "standard" | "focus";
  ts: string;
  endTs: string;
  service: string;
  sku: string;
  project: string;
  location: string;
  costType: string;
  currency: string;
  unit: string;
  amount: string;
  gross: string;
  /** Per-row credit total expression. */
  credits: string;
  /** Per-row net cost expression. */
  net: string;
}

const BILLING_COLUMNS: Record<"standard" | "focus", BillingColumns> = {
  standard: {
    schema: "standard",
    ts: "usage_start_time",
    endTs: "usage_end_time",
    service: "service.description",
    sku: "sku.description",
    project: "project.id",
    location: "location.location",
    costType: "cost_type",
    currency: "currency",
    unit: "usage.unit",
    amount: "usage.amount",
    gross: "CAST(cost AS NUMERIC)",
    credits:
      "IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) AS c), 0)",
    net:
      "CAST(cost AS NUMERIC) + IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) AS c), 0)",
  },
  focus: {
    schema: "focus",
    ts: "ChargePeriodStart",
    endTs: "ChargePeriodEnd",
    service: "ServiceName",
    sku: "ChargeDescription",
    project: "x_Project.Id",
    location: "x_Location",
    costType: "x_CostType",
    currency: "BillingCurrency",
    unit: "ConsumedUnit",
    amount: "ConsumedQuantity",
    gross: "ContractedCost",
    credits: "IFNULL((SELECT SUM(c.Amount) FROM UNNEST(x_Credits) AS c), 0)",
    net: "BilledCost",
  },
};

/** Pick the billing column map, reading the table schema when set to auto. */
async function resolveBillingColumns(
  table: string,
  globalArgs: GlobalArgs,
  token: string,
  http: Http,
): Promise<BillingColumns> {
  const configured = globalArgs.billingSchema ?? "auto";
  if (configured !== "auto") return BILLING_COLUMNS[configured];

  const { project, dataset, name } = parseBillingTable(table);
  const resp = await gcpFetch(
    http,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${
      encodeURIComponent(project)
    }/datasets/${encodeURIComponent(dataset)}/tables/${
      encodeURIComponent(name)
    }`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    throw new Error(
      `Could not read the schema of billing table ${table} to detect its format ` +
        `(HTTP ${resp.status}): ${await resp.text()}. Set billingSchema to ` +
        `"standard" or "focus" to skip detection.`,
    );
  }
  let body: { schema?: { fields?: Array<{ name: string }> } };
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(
      `BigQuery returned malformed JSON for the schema of ${table}: ${
        errMessage(err)
      }`,
      { cause: err },
    );
  }
  const names = new Set((body.schema?.fields ?? []).map((f) => f.name));
  if (names.has("ServiceName") && names.has("BilledCost")) {
    return BILLING_COLUMNS.focus;
  }
  if (names.has("service") && names.has("usage_start_time")) {
    return BILLING_COLUMNS.standard;
  }
  throw new Error(
    `Billing table ${table} matches neither the standard nor the FOCUS export schema. ` +
      `Set billingSchema if it is one of them.`,
  );
}

const num = (v: string | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

/** Round away float noise from NUMERIC sums without losing cents. */
const money = (v: string | null | undefined): number =>
  Math.round(num(v) * 1e9) / 1e9;

// ---------------------------------------------------------------------------
// Legacy single-bucket scan (scan_projects / get_token_usage)
// ---------------------------------------------------------------------------

/** Parsed time series data point. */
interface TokenData {
  model: string;
  direction: string;
  tokens: number;
}

/** Query Vertex AI token_count for a project as one bucket over the window. */
async function queryTokenMetrics(
  project: string,
  token: string,
  startTime: string,
  endTime: string,
  days: number,
  http: Http,
): Promise<{ data: TokenData[]; truncated: boolean }> {
  const alignPeriod = Math.min(days * 24 * 3600, 30 * 24 * 3600);
  const { series, truncated } = await listTimeSeries(
    project,
    token,
    TOKEN_METRIC,
    startTime,
    endTime,
    alignPeriod,
    http,
  );
  const results: TokenData[] = series.map((ts) => ({
    model: ts.resource?.labels?.model_user_id || "unknown",
    direction: ts.metric?.labels?.type || "unknown",
    tokens: (ts.points ?? []).reduce((sum, p) => sum + pointValue(p), 0),
  }));
  return { data: results, truncated };
}

/** Aggregate raw data points into per-model input/output totals. */
function aggregateModels(data: TokenData[]): {
  models: z.infer<typeof ModelUsageSchema>[];
  inputTokens: number;
  outputTokens: number;
} {
  const modelMap = new Map<string, { input: number; output: number }>();
  for (const d of data) {
    const existing = modelMap.get(d.model) || { input: 0, output: 0 };
    if (d.direction === "input") existing.input += d.tokens;
    else if (d.direction === "output") existing.output += d.tokens;
    modelMap.set(d.model, existing);
  }
  const models: z.infer<typeof ModelUsageSchema>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [modelId, usage] of modelMap) {
    models.push({
      modelId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.input + usage.output,
    });
    inputTokens += usage.input;
    outputTokens += usage.output;
  }
  models.sort((a, b) => b.totalTokens - a.totalTokens);
  return { models, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

const ParentsArg = z.array(z.string().regex(PARENT_RE)).default([]).describe(
  "Restrict discovery to direct children of these organizations/N or " +
    "folders/N. Empty discovers every ACTIVE project the credential can see. " +
    "Only valid when no explicit project list is given.",
);

const ProjectsFilterArg = z.array(z.string().min(1)).optional().describe(
  "Explicit project IDs. Overrides the model's projects global argument.",
);

/** GCP Vertex AI usage and cost analysis model. */
export const model = {
  type: "@webframp/gcp/vertex-usage",
  version: "2026.10.01.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.21.1",
      description:
        "Remove gcloud CLI dependency; auth via service account JSON key",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "Add error-message context for credentials/JSON parsing/Monitoring API failures; require at least one configured project",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.1",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.28.1",
      description:
        "No schema changes — normalized license to Apache-2.0 and corrected copyright holder to Sean Escriva",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.15.1",
      description: "No schema changes — dependency/license maintenance bump",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.1",
      description:
        "Normalized zod dependency version to 4.6.5; no behavioral changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.1",
      description:
        "projects is now optional (runtime discovery); added optional billingTable and billingQueryProject. Existing definitions are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    scan_results: {
      description:
        "Legacy multi-project Vertex AI token usage scan (single bucket)",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    single_scan: {
      description: "Legacy single project Vertex AI token usage scan",
      schema: ScanResultsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    projects: {
      description: "GCP projects discovered through Cloud Resource Manager",
      schema: ProjectsResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    usage: {
      description:
        "Daily Vertex AI token and request usage for one project (instance usage-<project>)",
      schema: UsageSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    scan_summary: {
      description:
        "Per-project status and totals for the latest scan_usage run, including errors",
      schema: ScanSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    gemini_usage: {
      description:
        "Daily Gemini API output tokens and request counts for one project (instance gemini-usage-<project>)",
      schema: GeminiUsageSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    gemini_scan_summary: {
      description:
        "Per-project status and totals for the latest scan_gemini_api_usage run, including errors",
      schema: GeminiScanSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    billing_costs: {
      description:
        "Vertex AI billing export cost rows for one project (instance billing-<project>)",
      schema: BillingCostsSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    billing_summary: {
      description:
        "Totals and export-freshness check for the latest get_billing_costs run",
      schema: BillingSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    billing_services: {
      description:
        "Billing services and SKUs matching an AI-related pattern, for choosing the cost filter",
      schema: BillingServicesSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    discover_projects: {
      description:
        "List ACTIVE GCP projects visible to the credential via Cloud Resource Manager. Needs resourcemanager.projects.get; grant it at the organization or folder level.",
      arguments: z.object({ parents: ParentsArg }),
      execute: async (
        args: { parents: string[] },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const http = makeHttp(context);
        const creds = resolveCredentials(context.globalArgs);
        const token = await getAccessToken(creds, [SCOPE_PROJECTS], http);
        const projects = await discoverProjects(token, args.parents, http);
        context.logger.info("Discovered projects", { count: projects.length });

        const handle = await context.writeResource("projects", "discovered", {
          discoveredAt: new Date().toISOString(),
          parents: args.parents,
          count: projects.length,
          projects,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        return { dataHandles: [handle] };
      },
    },

    scan_usage: {
      description:
        "Fan-out scan of Vertex AI token and request usage as flat daily rows per project, location, publisher, model and request type. Writes one usage-<project> instance per project plus a scan_summary with per-project status. Covers the last N complete UTC days; Cloud Monitoring retains these metrics for a limited time, so use get_billing_costs for older history.",
      arguments: z.object({
        days: z.number().int().min(1).max(90).default(30).describe(
          "Number of complete UTC days to scan, ending at today's UTC midnight",
        ),
        projects: ProjectsFilterArg,
        parents: ParentsArg,
        concurrency: z.number().int().min(1).max(16).default(4).describe(
          "Projects scanned in parallel",
        ),
        maxRequestsPerMinute: MaxRequestsPerMinuteArg,
      }),
      execute: async (args: FanOutArgs, context: MethodContext) => {
        const startMs = Date.now();
        const { window, discovered, results } = await fanOutProjects(
          args,
          context,
          scanProjectUsage,
        );

        const statuses: z.infer<typeof ProjectStatusSchema>[] = [];
        const totals = emptyTotals();
        const handles: { name: string }[] = [];
        const meta = () => ({
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        let anyTruncated = false;
        for (const r of results) {
          if ("error" in r) {
            statuses.push({
              project: r.project,
              status: "error",
              error: r.error,
              rows: 0,
              totalTokens: 0,
              requests: 0,
            });
            continue;
          }
          const u = r.usage;
          if (u.truncated || !u.requestsAvailable) anyTruncated = true;
          addTotals(totals, u.totals);
          statuses.push({
            project: u.project,
            status: u.rows.length === 0 ? "no_data" : "ok",
            rows: u.rows.length,
            totalTokens: u.totals.totalTokens,
            requests: u.totals.requests,
          });
          // Projects with no Vertex usage would only add empty instances.
          if (u.rows.length > 0) {
            handles.push(
              await context.writeResource(
                "usage",
                instanceName("usage", u.project),
                { ...u, ...meta() },
              ),
            );
          }
        }

        const errored = statuses.filter((s) => s.status === "error");
        statuses.sort((a, b) =>
          b.totalTokens - a.totalTokens || a.project.localeCompare(b.project)
        );

        handles.push(
          await context.writeResource("scan_summary", "current", {
            scannedAt: new Date().toISOString(),
            window: windowOut(window),
            discovered,
            complete: errored.length === 0 && !anyTruncated,
            projects: statuses,
            totals,
            ...meta(),
          }),
        );
        context.logger.info("Scanned projects", {
          projects: statuses.length,
          errors: errored.length,
          totalTokens: totals.totalTokens,
        });
        return { dataHandles: handles };
      },
    },

    scan_gemini_api_usage: {
      description:
        "Fan-out scan of Gemini API (generativelanguage.googleapis.com, the Gemini Developer API) usage as daily rows. Cloud Monitoring exposes output tokens only: there is no input-token metric, so use get_billing_costs for input volume. Request counts come from the API-wide request_count metric and include credentialId (which API key made the call) and every API method. Writes one gemini-usage-<project> instance per project plus a gemini_scan_summary with per-project status.",
      arguments: z.object({
        days: z.number().int().min(1).max(90).default(30).describe(
          "Number of complete UTC days to scan, ending at today's UTC midnight",
        ),
        projects: ProjectsFilterArg,
        parents: ParentsArg,
        concurrency: z.number().int().min(1).max(16).default(4).describe(
          "Projects scanned in parallel",
        ),
        maxRequestsPerMinute: MaxRequestsPerMinuteArg,
      }),
      execute: async (args: FanOutArgs, context: MethodContext) => {
        const startMs = Date.now();
        const { window, discovered, results } = await fanOutProjects(
          args,
          context,
          scanProjectGemini,
        );
        const meta = () => ({
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        const statuses: z.infer<typeof GeminiStatusSchema>[] = [];
        const totals = {
          outputTokens: 0,
          requests: 0,
          errorRequests: 0,
          rateLimitedRequests: 0,
        };
        const handles: { name: string }[] = [];
        let anyTruncated = false;
        for (const r of results) {
          if ("error" in r) {
            statuses.push({
              project: r.project,
              status: "error",
              error: r.error,
              rows: 0,
              outputTokens: 0,
              requests: 0,
            });
            continue;
          }
          const u = r.usage;
          if (u.truncated || u.warnings.length > 0) anyTruncated = true;
          totals.outputTokens += u.totals.outputTokens;
          totals.requests += u.totals.requests;
          totals.errorRequests += u.totals.errorRequests;
          totals.rateLimitedRequests += u.totals.rateLimitedRequests;
          const rows = u.tokenRows.length + u.requestRows.length;
          statuses.push({
            project: u.project,
            status: rows === 0 ? "no_data" : "ok",
            rows,
            outputTokens: u.totals.outputTokens,
            requests: u.totals.requests,
          });
          if (rows > 0) {
            handles.push(
              await context.writeResource(
                "gemini_usage",
                instanceName("gemini-usage", u.project),
                { ...u, ...meta() },
              ),
            );
          }
        }
        const errored = statuses.filter((x) => x.status === "error");
        statuses.sort((a, b) =>
          b.outputTokens - a.outputTokens || a.project.localeCompare(b.project)
        );
        handles.push(
          await context.writeResource("gemini_scan_summary", "current", {
            scannedAt: new Date().toISOString(),
            window: windowOut(window),
            discovered,
            complete: errored.length === 0 && !anyTruncated,
            projects: statuses,
            totals,
            ...meta(),
          }),
        );
        context.logger.info("Scanned projects for Gemini API usage", {
          projects: statuses.length,
          errors: errored.length,
          outputTokens: totals.outputTokens,
        });
        return { dataHandles: handles };
      },
    },

    discover_billing_services: {
      description:
        "List billing services and SKUs in the Cloud Billing export that match an AI-related pattern, with cost. Run this first to confirm which service names to pass to get_billing_costs, since partner models can bill under a different service than Google's own.",
      arguments: z.object({
        days: z.number().int().min(1).max(365).default(30),
        pattern: z.string().min(1).default(
          "(?i)vertex|gemini|claude|anthropic|generative|model garden|ai platform",
        ).describe(
          "RE2 regex matched against 'service.description sku.description'",
        ),
      }),
      execute: async (
        args: { days: number; pattern: string },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const http = makeHttp(context);
        const { table, jobProject } = billingConfig(context.globalArgs);
        const creds = resolveCredentials(context.globalArgs);
        const token = await getAccessToken(creds, [SCOPE_BIGQUERY], http);
        const window = completeDaysWindow(args.days);

        const cols = await resolveBillingColumns(
          table,
          context.globalArgs,
          token,
          http,
        );
        const sql = `
SELECT
  ${cols.service} AS o_service,
  ${cols.sku} AS o_sku,
  ${cols.currency} AS o_currency,
  IFNULL(${cols.unit}, '') AS o_usage_unit,
  SUM(${cols.amount}) AS o_usage_amount,
  CAST(SUM(${cols.gross}) AS STRING) AS o_cost
FROM \`${table}\`
WHERE ${cols.ts} >= @start AND ${cols.ts} < @end
  AND REGEXP_CONTAINS(CONCAT(${cols.service}, ' ', ${cols.sku}), @pattern)
GROUP BY 1, 2, 3, 4
ORDER BY SUM(${cols.gross}) DESC`;
        const rows = await runBigQuery(
          jobProject,
          sql,
          [
            bqTimestamp("start", window.start),
            bqTimestamp("end", window.end),
            bqString("pattern", args.pattern),
          ],
          token,
          http,
        );

        const skus = rows.map((r) => ({
          service: r.o_service ?? "",
          sku: r.o_sku ?? "",
          currency: r.o_currency ?? "",
          usageUnit: r.o_usage_unit ?? "",
          usageAmount: num(r.o_usage_amount),
          cost: money(r.o_cost),
        }));
        const bySvc = new Map<
          string,
          { service: string; currency: string; cost: number; skus: Set<string> }
        >();
        for (const s of skus) {
          const key = `${s.service}\u0000${s.currency}`;
          const e = bySvc.get(key) ??
            {
              service: s.service,
              currency: s.currency,
              cost: 0,
              skus: new Set(),
            };
          e.cost += s.cost;
          e.skus.add(s.sku);
          bySvc.set(key, e);
        }
        const services = [...bySvc.values()]
          .map((e) => ({
            service: e.service,
            currency: e.currency,
            cost: Math.round(e.cost * 1e9) / 1e9,
            skuCount: e.skus.size,
          }))
          .sort((a, b) => b.cost - a.cost);

        const handle = await context.writeResource(
          "billing_services",
          "current",
          {
            window: windowOut(window),
            table,
            pattern: args.pattern,
            services,
            skus,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_billing_costs: {
      description:
        "Query the Cloud Billing export in BigQuery for Vertex AI cost over the last N complete UTC days. Writes one billing-<project> instance per project (gross cost, credits and net cost per day and SKU, never mixing currencies or cost types) plus a billing_summary that flags an export that has not caught up to the window end.",
      arguments: z.object({
        days: z.number().int().min(1).max(365).default(30).describe(
          "Number of complete UTC days, ending at today's UTC midnight",
        ),
        services: z.array(z.string().min(1)).min(1).default([
          "Vertex AI",
          "Gemini API",
        ])
          .describe(
            "Exact service.description values to include. Confirm with discover_billing_services.",
          ),
        skuPattern: z.string().min(1).optional().describe(
          "Optional RE2 regex on sku.description to narrow results",
        ),
        projects: ProjectsFilterArg.describe(
          "Optional project IDs to filter server-side. Omit for every project.",
        ),
      }),
      execute: async (
        args: {
          days: number;
          services: string[];
          skuPattern?: string;
          projects?: string[];
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const http = makeHttp(context);
        const { table, jobProject } = billingConfig(context.globalArgs);
        const creds = resolveCredentials(context.globalArgs);
        const token = await getAccessToken(creds, [SCOPE_BIGQUERY], http);
        const window = completeDaysWindow(args.days);

        const cols = await resolveBillingColumns(
          table,
          context.globalArgs,
          token,
          http,
        );
        const filters = [
          `${cols.ts} >= @start`,
          `${cols.ts} < @end`,
          `${cols.service} IN UNNEST(@services)`,
        ];
        const params: BqParam[] = [
          bqTimestamp("start", window.start),
          bqTimestamp("end", window.end),
          bqStringArray("services", args.services),
        ];
        if (args.skuPattern) {
          filters.push(`REGEXP_CONTAINS(${cols.sku}, @skuPattern)`);
          params.push(bqString("skuPattern", args.skuPattern));
        }
        if (args.projects && args.projects.length > 0) {
          filters.push(`${cols.project} IN UNNEST(@projects)`);
          params.push(bqStringArray("projects", args.projects));
        }
        const where = filters.join("\n  AND ");

        // Output aliases are o_-prefixed because several collide with
        // export column names (service, sku, cost, credits, ...).
        const sql = `
SELECT
  CAST(DATE(${cols.ts}, 'UTC') AS STRING) AS o_date,
  IFNULL(${cols.project}, '') AS o_project,
  ${cols.service} AS o_service,
  ${cols.sku} AS o_sku,
  IFNULL(${cols.location}, '') AS o_location,
  IFNULL(${cols.costType}, '') AS o_cost_type,
  ${cols.currency} AS o_currency,
  IFNULL(${cols.unit}, '') AS o_usage_unit,
  SUM(${cols.amount}) AS o_usage_amount,
  CAST(SUM(${cols.gross}) AS STRING) AS o_cost,
  CAST(SUM(${cols.credits}) AS STRING) AS o_credits,
  CAST(SUM(${cols.net}) AS STRING) AS o_net
FROM \`${table}\`
WHERE ${where}
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY 1, 2, 3, 4`;
        const rows = await runBigQuery(jobProject, sql, params, token, http);

        // Freshness: the export lags usage by hours, so the newest day can be
        // partial. Compare the latest charge end time against the window end.
        const freshRows = await runBigQuery(
          jobProject,
          `SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(${cols.endTs})) AS o_data_through
FROM \`${table}\` WHERE ${where}`,
          params,
          token,
          http,
        );
        const dataThrough = freshRows[0]?.o_data_through ?? null;
        const warnings: string[] = [];
        let complete = true;
        if (dataThrough === null) {
          warnings.push(
            "No billing rows matched the filters in this window. Confirm the " +
              "service names with discover_billing_services.",
          );
        } else if (Date.parse(dataThrough) < window.end.getTime() - 3600_000) {
          complete = false;
          warnings.push(
            `Export data runs through ${dataThrough}, before the window end ` +
              `${window.end.toISOString()}; the last day(s) are understated.`,
          );
        }

        type Row = z.infer<typeof BillingRowSchema>;
        const byProject = new Map<string, Row[]>();
        let reconcileDrift = 0;
        for (const r of rows) {
          const cost = money(r.o_cost);
          const credits = money(r.o_credits);
          const netCost = money(r.o_net);
          // The export's own net figure is authoritative; flag any row where
          // gross + credits does not reproduce it so it is never silently wrong.
          reconcileDrift += Math.abs(cost + credits - netCost);
          const row: Row = {
            date: r.o_date ?? "",
            project: r.o_project ?? "",
            service: r.o_service ?? "",
            sku: r.o_sku ?? "",
            location: r.o_location ?? "",
            costType: r.o_cost_type ?? "",
            currency: r.o_currency ?? "",
            usageUnit: r.o_usage_unit ?? "",
            usageAmount: num(r.o_usage_amount),
            cost,
            credits,
            netCost,
          };
          const list = byProject.get(row.project) ?? [];
          list.push(row);
          byProject.set(row.project, list);
        }
        if (reconcileDrift > 0.01) {
          warnings.push(
            `gross cost + credits differs from the export's net cost by ` +
              `${
                reconcileDrift.toFixed(4)
              } across rows; netCost uses the export's figure.`,
          );
        }

        const sumByCurrency = (rs: Row[]) => {
          const m = new Map<string, z.infer<typeof CurrencyTotalSchema>>();
          for (const r of rs) {
            const t = m.get(r.currency) ??
              { currency: r.currency, cost: 0, credits: 0, netCost: 0 };
            t.cost += r.cost;
            t.credits += r.credits;
            t.netCost += r.netCost;
            m.set(r.currency, t);
          }
          return [...m.values()].map((t) => ({
            currency: t.currency,
            cost: Math.round(t.cost * 1e9) / 1e9,
            credits: Math.round(t.credits * 1e9) / 1e9,
            netCost: Math.round(t.netCost * 1e9) / 1e9,
          })).sort((a, b) => a.currency.localeCompare(b.currency));
        };

        const meta = () => ({
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        const handles: { name: string }[] = [];
        const projectTotals: {
          project: string;
          totals: ReturnType<typeof sumByCurrency>;
        }[] = [];
        for (
          const [project, list] of [...byProject].sort((a, b) =>
            a[0].localeCompare(b[0])
          )
        ) {
          const totals = sumByCurrency(list);
          projectTotals.push({ project, totals });
          handles.push(
            await context.writeResource(
              "billing_costs",
              instanceName("billing", project),
              {
                project,
                window: windowOut(window),
                services: args.services,
                rows: list,
                totals,
                ...meta(),
              },
            ),
          );
        }

        handles.push(
          await context.writeResource("billing_summary", "current", {
            window: windowOut(window),
            table,
            billingSchema: cols.schema,
            services: args.services,
            skuPattern: args.skuPattern,
            projectCount: byProject.size,
            rowCount: rows.length,
            totals: sumByCurrency([...byProject.values()].flat()),
            byProject: projectTotals,
            dataThrough,
            complete,
            warnings,
            ...meta(),
          }),
        );
        for (const w of warnings) context.logger.warn(w, {});
        return { dataHandles: handles };
      },
    },

    scan_projects: {
      description:
        "Legacy: fan-out scan returning one total per model per project, with no daily detail. Prefer scan_usage. Projects come from the model's projects global argument or runtime discovery.",
      arguments: z.object({
        days: z.number().min(1).max(90).default(30).describe(
          "Lookback period in days",
        ),
      }),
      execute: async (
        args: { days: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const http = makeHttp(context);
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - args.days * DAY_MS);
        const periodMinutes = args.days * 24 * 60;
        const projects: z.infer<typeof ProjectUsageSchema>[] = [];
        let anyTruncated = false;

        const creds = resolveCredentials(context.globalArgs);
        const resolved = await resolveProjects(
          undefined,
          [],
          context.globalArgs,
          creds,
          http,
          [SCOPE_MONITORING],
        );
        const token = resolved.token;
        if (resolved.projects.length === 0) {
          throw new Error(NO_PROJECTS_MESSAGE);
        }

        for (const project of resolved.projects) {
          try {
            const { data, truncated: pageTruncated } = await queryTokenMetrics(
              project,
              token,
              startTime.toISOString(),
              endTime.toISOString(),
              args.days,
              http,
            );

            if (data.length === 0) continue;
            if (pageTruncated) anyTruncated = true;

            const { models, inputTokens, outputTokens } = aggregateModels(data);
            projects.push({
              project,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              models,
              periodMinutes,
              inputTokensPerMinute: inputTokens / periodMinutes,
              outputTokensPerMinute: outputTokens / periodMinutes,
            });

            context.logger.info("Scanned project", {
              project,
              totalTokens: inputTokens + outputTokens,
            });
          } catch (err) {
            // A failed project makes the scan incomplete, not empty.
            anyTruncated = true;
            context.logger.warn("Failed to scan project", {
              project,
              error: String(err),
            });
          }
        }

        projects.sort((a, b) => b.totalTokens - a.totalTokens);

        const totalInput = projects.reduce((s, p) => s + p.inputTokens, 0);
        const totalOutput = projects.reduce((s, p) => s + p.outputTokens, 0);

        const handle = await context.writeResource(
          "scan_results",
          "current",
          {
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
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_token_usage: {
      description:
        "Legacy: token usage for a single GCP project with a per-model total. Prefer scan_usage with projects set.",
      arguments: z.object({
        project: z.string().min(1).describe("GCP project ID"),
        days: z.number().min(1).max(90).default(30).describe(
          "Lookback period in days",
        ),
      }),
      execute: async (
        args: { project: string; days: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const http = makeHttp(context);
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - args.days * DAY_MS);
        const periodMinutes = args.days * 24 * 60;

        const creds = resolveCredentials(context.globalArgs);
        const token = await getAccessToken(creds, [SCOPE_MONITORING], http);

        const { data, truncated: pageTruncated } = await queryTokenMetrics(
          args.project,
          token,
          startTime.toISOString(),
          endTime.toISOString(),
          args.days,
          http,
        );
        const { models, inputTokens, outputTokens } = aggregateModels(data);

        const handle = await context.writeResource(
          "single_scan",
          args.project,
          {
            scannedAt: new Date().toISOString(),
            truncated: pageTruncated,
            days: args.days,
            periodMinutes,
            projects: [
              {
                project: args.project,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                models,
                periodMinutes,
                inputTokensPerMinute: inputTokens / periodMinutes,
                outputTokensPerMinute: outputTokens / periodMinutes,
              },
            ],
            totals: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              inputTokensPerMinute: inputTokens / periodMinutes,
              outputTokensPerMinute: outputTokens / periodMinutes,
            },
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
