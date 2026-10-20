/**
 * Redmine API helper utilities.
 *
 * Shared HTTP client functions for all Redmine model methods.
 * Handles authentication, pagination, and error responses.
 *
 * @module
 */

const MAX_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 1000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  return BASE_RETRY_DELAY_MS * 2 ** attempt;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["X-Redmine-API-Key", "X-Redmine-Username"];

/** Per-attempt deadline for JSON requests, covering headers and body. */
export const REQUEST_TIMEOUT_MS = 120_000;

// fetch's own redirect handling strips only Authorization on a cross-origin
// hop, so X-Redmine-API-Key would go to whatever host a Location names (an
// S3 or CDN storage backend, a proxy, a misconfigured vhost). Follow
// redirects by hand: same-origin hops keep the credentials, cross-origin
// hops are still followed but without them. Method rewriting follows the
// fetch spec (303, and 301/302 on POST, become a bodyless GET).
async function fetchFollowingRedirects(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const origin = new URL(url).origin;
  let current = new URL(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let hop = 0;; hop++) {
    const response = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    const location = response.headers.get("Location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    }
    if (
      (response.status === 303 && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers.delete("Content-Type");
    }
    current = new URL(location, current);
    if (current.origin !== origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }
  }
}

// Redmine's rate limiter can trip even under sequential (concurrency-1)
// callers — a workflow enriching dozens of issues one at a time in a tight
// loop is enough. Retry 429/502/503/504 with backoff (honoring Retry-After
// when the server sends one) instead of failing the whole run on the first
// transient block. Each attempt gets a fresh signal from `makeSignal`.
/** Fetch a Redmine URL with retries, safe redirects, and a per-attempt timeout. */
export async function redmineFetch(
  url: string,
  init: RequestInit,
  makeSignal: () => AbortSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<Response> {
  let response: Response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    response = await fetchFollowingRedirects(url, {
      ...init,
      signal: makeSignal(),
    });
    if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) {
      return response;
    }
    await response.body?.cancel();
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response, attempt))
    );
  }
  return response!;
}

/**
 * Make a single Redmine API request.
 * Returns parsed JSON for 2xx, null for 204. Throws on error.
 */
export async function redmineApi<T = null>(
  host: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  username?: string,
): Promise<T> {
  const url = `${host}${path}`;
  const headers: Record<string, string> = {
    "X-Redmine-API-Key": apiKey,
    "Content-Type": "application/json",
  };
  if (username) {
    headers["X-Redmine-Username"] = username;
  }

  let response: Response;
  try {
    response = await redmineFetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `Redmine ${method} ${path} request to ${host} failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { cause: e },
    );
  }

  if (response.status === 204) {
    return null as T;
  }

  if (!response.ok) {
    let errorMsg = `Redmine API ${method} ${path} failed (${response.status})`;
    try {
      const data = await response.json();
      if (data.errors && Array.isArray(data.errors)) {
        errorMsg += `: ${data.errors.join("; ")}`;
      }
    } catch {
      // Response body may not be JSON
    }
    throw new Error(errorMsg);
  }

  return (await response.json()) as T;
}

/**
 * Make a paginated Redmine API request.
 * Follows offset/limit/total_count until all items or maxItems reached.
 * Redmine page size is capped at 100. maxItems defaults to 100, capped at 500.
 */
export async function redmineApiPaginated<T>(
  host: string,
  apiKey: string,
  path: string,
  resultKey: string,
  params?: Record<string, string>,
  maxItems?: number,
  username?: string,
): Promise<T[]> {
  const cap = Math.min(maxItems ?? 100, 500);
  const pageSize = Math.min(cap, 100);
  const allResults: T[] = [];
  let offset = 0;

  while (allResults.length < cap) {
    const queryParams = new URLSearchParams({
      ...params,
      offset: String(offset),
      limit: String(pageSize),
    });

    const url = `${host}${path}?${queryParams}`;
    const fetchHeaders: Record<string, string> = {
      "X-Redmine-API-Key": apiKey,
      "Content-Type": "application/json",
    };
    if (username) {
      fetchHeaders["X-Redmine-Username"] = username;
    }
    let response: Response;
    try {
      response = await redmineFetch(url, {
        headers: fetchHeaders,
      });
    } catch (e) {
      throw new Error(
        `Redmine GET ${path} request to ${host} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }

    if (!response.ok) {
      let errorMsg = `Redmine API GET ${path} failed (${response.status})`;
      try {
        const data = await response.json();
        if (data.errors && Array.isArray(data.errors)) {
          errorMsg += `: ${data.errors.join("; ")}`;
        }
      } catch {
        // Response body may not be JSON
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const items = (data[resultKey] ?? []) as T[];
    const totalCount: number = data.total_count ?? 0;

    allResults.push(...items);

    offset += items.length;

    // Stop if we have fetched all available items or reached the cap
    if (offset >= totalCount || items.length === 0) {
      break;
    }
  }

  // Trim to cap if we overshot
  return allResults.slice(0, cap);
}

/** Thrown by `redmineDownload` when a response is larger than `maxBytes`. */
export class RedmineDownloadTooLargeError extends Error {
  constructor(path: string, size: number, maxBytes: number) {
    super(
      `Redmine GET ${path} is ${size} bytes, more than maxBytes=${maxBytes}`,
    );
    this.name = "RedmineDownloadTooLargeError";
  }
}

/** A download is aborted when no bytes arrive for this long. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Download raw bytes from a Redmine path (for example an attachment).
 * Retries and follows redirects like the JSON helpers. Throws on a non-2xx
 * response, and throws `RedmineDownloadTooLargeError` when the response is
 * larger than `maxBytes`. The body is read as a stream and abandoned as soon
 * as it passes the cap, so a missing or wrong Content-Length cannot make it
 * buffer without bound. Instead of a total deadline (a large file can take
 * minutes), the download aborts when the connection is idle for
 * `idleTimeoutMs`.
 */
export async function redmineDownload(
  host: string,
  apiKey: string,
  path: string,
  username?: string,
  maxBytes?: number,
  idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const headers: Record<string, string> = { "X-Redmine-API-Key": apiKey };
  if (username) {
    headers["X-Redmine-Username"] = username;
  }

  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(timer);
    const c = controller;
    timer = setTimeout(
      () =>
        c.abort(
          new Error(`no data for ${idleTimeoutMs}ms`),
        ),
      idleTimeoutMs,
    );
  };

  try {
    let response: Response;
    try {
      response = await redmineFetch(`${host}${path}`, { headers }, () => {
        controller = new AbortController();
        resetIdle();
        return controller.signal;
      });
    } catch (e) {
      throw new Error(
        `Redmine GET ${path} request to ${host} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Redmine API GET ${path} failed (${response.status})`);
    }

    const contentType = response.headers.get("Content-Type");
    const lengthHeader = response.headers.get("Content-Length");
    const declared = lengthHeader === null ? NaN : Number(lengthHeader);
    if (maxBytes !== undefined && declared > maxBytes) {
      await response.body?.cancel();
      throw new RedmineDownloadTooLargeError(path, declared, maxBytes);
    }
    if (!response.body) {
      return { bytes: new Uint8Array(0), contentType };
    }

    // Allocate once when the length is declared; otherwise grow in place.
    // Either way the bytes are held in one buffer, never in a chunk list
    // plus a merged copy.
    let buffer = new Uint8Array(
      Number.isInteger(declared) && declared >= 0 ? declared : 64 * 1024,
    );
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        if (maxBytes !== undefined && total + value.length > maxBytes) {
          await reader.cancel();
          throw new RedmineDownloadTooLargeError(
            path,
            total + value.length,
            maxBytes,
          );
        }
        if (total + value.length > buffer.length) {
          let size = Math.max(buffer.length * 2, total + value.length);
          if (maxBytes !== undefined) size = Math.min(size, maxBytes);
          const grown = new Uint8Array(size);
          grown.set(buffer.subarray(0, total));
          buffer = grown;
        }
        buffer.set(value, total);
        total += value.length;
      }
    } catch (e) {
      if (e instanceof RedmineDownloadTooLargeError) throw e;
      throw new Error(
        `Redmine GET ${path} from ${host} failed while reading the body: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }
    return {
      bytes: total === buffer.length ? buffer : buffer.subarray(0, total),
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}
