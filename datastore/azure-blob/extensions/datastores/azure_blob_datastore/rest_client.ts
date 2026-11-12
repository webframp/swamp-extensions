// ABOUTME: Azure Blob Storage REST client — no SDK dependency. Implements
// ABOUTME: Shared Key request signing and Azure AD client-credentials OAuth,
// ABOUTME: matching the fetch-only pattern already used by azure/openai-usage.

import { Attr, withSpan } from "./_lib/tracing.ts";

const STORAGE_API_VERSION = "2021-08-06";
const STORAGE_SCOPE = "https://storage.azure.com/.default";

export interface ConnectionStringAuth {
  mode: "connectionString";
  connectionString: string;
}

export interface SharedKeyAuth {
  mode: "sharedKey";
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
}

export interface ServicePrincipalAuth {
  mode: "servicePrincipal";
  accountName: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  endpointSuffix: string;
}

export type BlobAuth =
  | ConnectionStringAuth
  | SharedKeyAuth
  | ServicePrincipalAuth;

export class BlobHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "BlobHttpError";
  }
}

interface ParsedConnectionString {
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
}

export function parseConnectionString(cs: string): ParsedConnectionString {
  const parts = new Map<string, string>();
  for (const segment of cs.split(";")) {
    if (!segment) continue;
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    parts.set(segment.slice(0, idx), segment.slice(idx + 1));
  }
  const accountName = parts.get("AccountName");
  const accountKey = parts.get("AccountKey");
  if (!accountName || !accountKey) {
    throw new Error(
      "Connection string must include AccountName and AccountKey",
    );
  }
  return {
    accountName,
    accountKey,
    endpointSuffix: parts.get("EndpointSuffix") ?? "core.windows.net",
  };
}

function resolveSharedKey(auth: BlobAuth): SharedKeyAuth | null {
  if (auth.mode === "sharedKey") return auth;
  if (auth.mode === "connectionString") {
    const parsed = parseConnectionString(auth.connectionString);
    return { mode: "sharedKey", ...parsed };
  }
  return null;
}

function accountUrl(accountName: string, endpointSuffix: string): string {
  return `https://${accountName}.blob.${endpointSuffix}`;
}

async function hmacSha256Base64(
  key: Uint8Array,
  data: string,
): Promise<string> {
  const keyBuffer = new Uint8Array(key).buffer as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/** Builds the CanonicalizedHeaders segment: sorted x-ms-* headers, "name:value\n" each. */
function canonicalizeHeaders(headers: Headers): string {
  const msHeaders: Array<[string, string]> = [];
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase().startsWith("x-ms-")) {
      msHeaders.push([name.toLowerCase(), value.trim()]);
    }
  }
  msHeaders.sort((a, b) => a[0].localeCompare(b[0]));
  return msHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
}

/** Builds the CanonicalizedResource segment: /account/path + sorted query params. */
function canonicalizeResource(
  accountName: string,
  pathAndQuery: string,
): string {
  const [path, query] = pathAndQuery.split("?", 2);
  let resource = `/${accountName}${path}`;
  if (query) {
    const params = new Map<string, string[]>();
    for (const [key, value] of new URLSearchParams(query).entries()) {
      const lowerKey = key.toLowerCase();
      const existing = params.get(lowerKey);
      if (existing) existing.push(value);
      else params.set(lowerKey, [value]);
    }
    const sortedKeys = [...params.keys()].sort();
    for (const key of sortedKeys) {
      // Azure's Shared Key spec requires repeated values for the same
      // parameter to be sorted lexicographically before comma-joining, not
      // left in the order they appeared in the query string.
      const values = params.get(key)!.slice().sort();
      resource += `\n${key}:${values.join(",")}`;
    }
  }
  return resource;
}

/** Exported for testing against Microsoft's published Shared Key signing example. */
export function buildStringToSign(
  accountName: string,
  method: string,
  pathAndQuery: string,
  headers: Headers,
  contentLength: number,
): string {
  return [
    method,
    headers.get("content-encoding") ?? "",
    headers.get("content-language") ?? "",
    contentLength > 0 ? String(contentLength) : "",
    headers.get("content-md5") ?? "",
    headers.get("content-type") ?? "",
    "", // Date — empty because we authenticate via x-ms-date instead
    headers.get("if-modified-since") ?? "",
    headers.get("if-match") ?? "",
    headers.get("if-none-match") ?? "",
    headers.get("if-unmodified-since") ?? "",
    headers.get("range") ?? "",
  ].join("\n") + "\n" +
    canonicalizeHeaders(headers) +
    canonicalizeResource(accountName, pathAndQuery);
}

async function signSharedKey(
  auth: SharedKeyAuth,
  method: string,
  pathAndQuery: string,
  headers: Headers,
  contentLength: number,
): Promise<string> {
  const stringToSign = buildStringToSign(
    auth.accountName,
    method,
    pathAndQuery,
    headers,
    contentLength,
  );
  const keyBytes = Uint8Array.from(
    atob(auth.accountKey),
    (c) => c.charCodeAt(0),
  );
  const signature = await hmacSha256Base64(keyBytes, stringToSign);
  return `SharedKey ${auth.accountName}:${signature}`;
}

const ARM_LIKE_TOKEN_CACHE = new Map<
  string,
  { token: string; expiresAt: number }
>();

async function getServicePrincipalToken(
  auth: ServicePrincipalAuth,
  fetchFn: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const cacheKey = `${auth.tenantId}:${auth.clientId}`;
  const cached = ARM_LIKE_TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  // Only the response status is recorded. The request body carries
  // client_secret and the response carries a bearer token — neither may ever
  // become a span attribute.
  return await withSpan("Azure Blob tokenExchange", {
    [Attr.RPC_SYSTEM]: "azure-blob-storage",
    [Attr.RPC_SERVICE]: "AzureAD",
    [Attr.RPC_METHOD]: "tokenExchange",
    [Attr.HTTP_REQUEST_METHOD]: "POST",
  }, async (span) => {
    const url =
      `https://login.microsoftonline.com/${auth.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: STORAGE_SCOPE,
    });
    // One deadline covers the exchange and the JSON body read.
    const deadline = requestDeadline(signal);
    deadline.arm(timeoutMs);
    try {
      const resp = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: deadline.signal,
      });
      span.setAttribute(Attr.HTTP_RESPONSE_STATUS_CODE, resp.status);
      if (!resp.ok) {
        // The response body is deliberately dropped rather than interpolated
        // into the message. withSpan records error.message via setStatus and
        // recordException, so anything in the message reaches the trace
        // backend — and this is the AAD token endpoint's raw response.
        throw new Error(
          `Azure token exchange failed (${resp.status} ${resp.statusText})`,
        );
      }
      const data = await resp.json() as {
        access_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) {
        throw new Error("Azure token response missing access_token field");
      }
      ARM_LIKE_TOKEN_CACHE.set(cacheKey, {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      });
      return data.access_token;
    } finally {
      deadline.clear();
    }
  });
}

/**
 * Base deadline for one request phase. Without a deadline a connection that
 * black-holes mid-request leaves `fetch` pending until the kernel gives up
 * (~15 min with Linux `tcp_retries2=15`), surfacing as an opaque
 * `fetch failed`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Slowest transfer rate a healthy link is assumed to sustain (~4 Mbit/s).
 * Large bodies get `bytes / MIN_THROUGHPUT_BYTES_PER_SEC` extra seconds so a
 * slow but progressing transfer is not cut off at the base deadline.
 */
export const MIN_THROUGHPUT_BYTES_PER_SEC = 512 * 1024;

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Deadline for a phase that moves `bytes`: the base plus transfer allowance. */
export function deadlineForBytes(baseMs: number, bytes: number): number {
  return baseMs + Math.ceil(bytes / MIN_THROUGHPUT_BYTES_PER_SEC) * 1000;
}

/**
 * A resettable per-request deadline. `signal` aborts with a `TimeoutError`
 * DOMException when the current phase's timer fires (or follows the caller's
 * signal, preserving its reason). `arm` replaces the timer for the next phase;
 * `clear` must run in a `finally` so no timer outlives the request.
 */
function requestDeadline(callerSignal: AbortSignal | undefined) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (rawMs: number) => {
    if (timer !== undefined) clearTimeout(timer);
    // setTimeout fires immediately for NaN, non-positive, or > 2^31-1 values.
    const ms = Number.isFinite(rawMs)
      ? Math.min(Math.max(Math.trunc(rawMs), 1), MAX_TIMER_MS)
      : MAX_TIMER_MS;
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            `Request exceeded its ${ms}ms deadline`,
            "TimeoutError",
          ),
        ),
      ms,
    );
  };
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  return { signal, arm, clear };
}

export interface BlobRequestOptions {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Operation name for the emitted span; defaults to the HTTP method. */
  op?: string;
  /** Caller abort signal, combined with the per-request deadline. */
  signal?: AbortSignal;
  /** Tighter base deadline for this request; never exceeds the client's. */
  timeoutMs?: number;
}

export interface BlobResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/**
 * True when a conditional create (`If-None-Match: *`) lost to an existing
 * blob. Azure reports that as 409 BlobAlreadyExists, not 412 (412 is for
 * `If-Match` ETag mismatches). Other 409s, such as ContainerBeingDeleted or
 * lease conflicts, return false.
 */
export function isBlobAlreadyExists(resp: BlobResponse): boolean {
  if (resp.status !== 409) return false;
  return resp.headers.get("x-ms-error-code") === "BlobAlreadyExists" ||
    new TextDecoder().decode(resp.body).includes("BlobAlreadyExists");
}

export class BlobClient {
  constructor(
    private readonly auth: BlobAuth,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  static fromAuth(
    auth: BlobAuth,
    fetchFn: typeof fetch = fetch,
    requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): BlobClient {
    const accountName = auth.mode === "connectionString"
      ? parseConnectionString(auth.connectionString).accountName
      : auth.accountName;
    const endpointSuffix = auth.mode === "connectionString"
      ? parseConnectionString(auth.connectionString).endpointSuffix
      : auth.endpointSuffix;
    return new BlobClient(
      auth,
      accountUrl(accountName, endpointSuffix),
      fetchFn,
      requestTimeoutMs,
    );
  }

  async request(opts: BlobRequestOptions): Promise<BlobResponse> {
    const op = opts.op ?? opts.method;
    // path is always /<container>[/<blob key>] — split so the container and
    // the blob key land on separate attributes.
    const trimmed = opts.path.startsWith("/") ? opts.path.slice(1) : opts.path;
    const slash = trimmed.indexOf("/");
    const container = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const blobKey = slash === -1 ? undefined : trimmed.slice(slash + 1);

    return await withSpan(`Azure Blob ${op}`, {
      [Attr.RPC_SYSTEM]: "azure-blob-storage",
      [Attr.RPC_SERVICE]: "Blob",
      [Attr.RPC_METHOD]: op,
      [Attr.HTTP_REQUEST_METHOD]: opts.method,
      [Attr.AZURE_BLOB_CONTAINER]: container,
      ...(blobKey ? { [Attr.AZURE_BLOB_KEY]: blobKey } : {}),
    }, async (span) => {
      const baseMs = Math.min(
        opts.timeoutMs ?? this.requestTimeoutMs,
        this.requestTimeoutMs,
      );
      const now = new Date().toUTCString();
      const query = new URLSearchParams(opts.query ?? {});
      const search = query.toString();
      const pathAndQuery = search ? `${opts.path}?${search}` : opts.path;
      const url = `${this.baseUrl}${pathAndQuery}`;

      const headers = new Headers(opts.headers ?? {});
      headers.set("x-ms-date", now);
      headers.set("x-ms-version", STORAGE_API_VERSION);

      const sharedKey = resolveSharedKey(this.auth);
      if (sharedKey) {
        const signature = await signSharedKey(
          sharedKey,
          opts.method,
          pathAndQuery,
          headers,
          opts.body?.byteLength ?? 0,
        );
        headers.set("Authorization", signature);
      } else if (this.auth.mode === "servicePrincipal") {
        const token = await getServicePrincipalToken(
          this.auth,
          this.fetchFn,
          baseMs,
          opts.signal,
        );
        headers.set("Authorization", `Bearer ${token}`);
      }

      // Phase 1 (send + response headers): the base deadline plus an allowance
      // for the request body. Phase 2 (response body): re-armed from
      // Content-Length once headers arrive. The signal stays live through the
      // body read, so a stalled body is bounded too.
      const deadline = requestDeadline(opts.signal);
      let resp: Response;
      let bodyBytes: Uint8Array;
      try {
        deadline.arm(deadlineForBytes(baseMs, opts.body?.byteLength ?? 0));
        resp = await this.fetchFn(url, {
          method: opts.method,
          headers,
          body: opts.body
            ? (new Uint8Array(opts.body).buffer as ArrayBuffer)
            : undefined,
          signal: deadline.signal,
        });
        const declared = Number(resp.headers.get("content-length"));
        deadline.arm(
          deadlineForBytes(baseMs, Number.isFinite(declared) ? declared : 0),
        );
        bodyBytes = new Uint8Array(await resp.arrayBuffer());
      } finally {
        deadline.clear();
      }

      span.setAttribute(Attr.HTTP_RESPONSE_STATUS_CODE, resp.status);
      span.setAttribute(Attr.HTTP_RESPONSE_BODY_SIZE, bodyBytes.byteLength);
      const requestId = resp.headers.get("x-ms-request-id");
      if (requestId) span.setAttribute(Attr.AZURE_REQUEST_ID, requestId);

      return { status: resp.status, headers: resp.headers, body: bodyBytes };
    });
  }
}

export function isNotFound(resp: BlobResponse): boolean {
  return resp.status === 404;
}

export function throwOnError(
  resp: BlobResponse,
  allowed: number[] = [],
): void {
  if (resp.status >= 200 && resp.status < 300) return;
  if (allowed.includes(resp.status)) return;
  const message = new TextDecoder().decode(resp.body);
  throw new BlobHttpError(resp.status, String(resp.status), message);
}
