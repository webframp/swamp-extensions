// ABOUTME: Azure Blob Storage REST client — no SDK dependency. Implements
// ABOUTME: Shared Key request signing and Azure AD client-credentials OAuth,
// ABOUTME: matching the fetch-only pattern already used by azure/openai-usage.

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
): Promise<string> {
  const cacheKey = `${auth.tenantId}:${auth.clientId}`;
  const cached = ARM_LIKE_TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const url =
    `https://login.microsoftonline.com/${auth.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    scope: STORAGE_SCOPE,
  });
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Azure token exchange failed (${resp.status}): ${errBody}`);
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
}

export interface BlobRequestOptions {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface BlobResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export class BlobClient {
  constructor(
    private readonly auth: BlobAuth,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromAuth(auth: BlobAuth, fetchFn: typeof fetch = fetch): BlobClient {
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
    );
  }

  async request(opts: BlobRequestOptions): Promise<BlobResponse> {
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
      const token = await getServicePrincipalToken(this.auth, this.fetchFn);
      headers.set("Authorization", `Bearer ${token}`);
    }

    const resp = await this.fetchFn(url, {
      method: opts.method,
      headers,
      body: opts.body
        ? (new Uint8Array(opts.body).buffer as ArrayBuffer)
        : undefined,
    });
    const bodyBytes = new Uint8Array(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, body: bodyBytes };
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
