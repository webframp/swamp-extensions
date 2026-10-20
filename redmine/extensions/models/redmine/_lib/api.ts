// SPDX-License-Identifier: Apache-2.0
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

// Only a read is safe to repeat after a 502/504 or a bare 503: the gateway
// can time out after Redmine committed the write. A retried POST creates a
// second issue or upload, a retried PUT with notes adds a second journal
// entry, and a retried DELETE reports 404 for a delete that succeeded. A 429,
// and a 503 with Retry-After (a throttle or maintenance responder that sets
// the header; nginx limit_req does not by default), are rejected before any
// work, so every method retries those.
function isRetryableStatus(response: Response, method: string): boolean {
  const { status } = response;
  if (status === 429) return true;
  if (status === 503 && response.headers.has("Retry-After")) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return status === 502 || status === 503 || status === 504;
}

/**
 * The longest Retry-After a request waits out before retrying, and the total
 * time all retries of one request may spend waiting. Rate limiters
 * with a time window (Skipper's clusterClientRatelimit over "2m", for one)
 * ask for up to the whole window, so this covers a few minutes; anything
 * longer is a maintenance window or daily quota, not worth blocking on.
 */
export const MAX_RETRY_DELAY_MS = 300_000;

/**
 * How long to wait before the next attempt, or null to stop retrying.
 * Retry-After may be seconds or an HTTP date; a value that is negative,
 * unparseable or already past falls back to exponential backoff. A server
 * asking for more than MAX_RETRY_DELAY_MS (a maintenance window, a daily
 * quota) gets no retry: the response is returned rather than blocking the
 * method for hours.
 */
export function retryDelayMs(
  response: Response,
  attempt: number,
): number | null {
  const backoff = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const retryAfter = response.headers.get("Retry-After")?.trim();
  if (!retryAfter) return backoff;
  const delay = /^\d+(\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return backoff;
  return delay > MAX_RETRY_DELAY_MS ? null : delay;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["X-Redmine-API-Key", "X-Redmine-Username"];

/** Per-attempt deadline for JSON requests, covering headers and body. */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * What to do when a redirect leaves the configured Redmine origin.
 * - `reject`: throw. API calls use this: following without credentials
 *   would silently return anonymous (partial or empty) results.
 * - `strip`: follow without the Redmine credentials. Downloads use this,
 *   for storage backends that redirect to a presigned S3 or CDN URL.
 */
export type CrossOriginRedirect = "reject" | "strip";

/**
 * Same host, http upgraded to https on the default ports (80 to 443), the
 * redirect a load balancer such as an AWS ALB issues. A TLS listener on any
 * other port of the host is not trusted with the key: a setup that redirects
 * there gets the "set host to ..." error and points `host` at the https URL.
 */
export function isHttpsUpgrade(from: URL, to: URL): boolean {
  return from.protocol === "http:" && to.protocol === "https:" &&
    from.hostname === to.hostname && from.port === "" && to.port === "";
}

// fetch's own redirect handling strips only Authorization on a cross-origin
// hop, so X-Redmine-API-Key would go to whatever host a Location names (an
// S3 or CDN storage backend, a proxy, a misconfigured vhost). Follow
// redirects by hand: same-origin hops and an http->https upgrade of the same
// host keep the credentials; any other hop is rejected or followed without
// them, per `crossOrigin`. Method rewriting follows the fetch spec (303, and
// 301/302 on POST, become a bodyless GET).
async function fetchFollowingRedirects(
  url: string,
  init: RequestInit,
  crossOrigin: CrossOriginRedirect,
  onResponse?: () => void,
): Promise<{ response: Response; redirected: boolean }> {
  let trusted = new URL(url);
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
    onResponse?.();
    const location = response.headers.get("Location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, redirected: hop > 0 };
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
    // A 307/308 resends the body; a stream was consumed by the first hop.
    if (body instanceof ReadableStream) {
      throw new Error(
        `cannot follow a ${response.status} redirect with a streamed body`,
      );
    }
    const next = new URL(location, current);
    if (next.origin !== trusted.origin) {
      if (isHttpsUpgrade(trusted, next)) {
        trusted = next;
      } else if (crossOrigin === "reject") {
        throw new Error(
          `redirected from ${trusted.origin} to ${next.origin}; ` +
            `set host to the Redmine URL it redirects to`,
        );
      } else {
        // Deleted for good: a later hop back to the origin stays anonymous.
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      }
    }
    current = next;
  }
}

// Redmine's rate limiter can trip even under sequential (concurrency-1)
// callers — a workflow enriching dozens of issues one at a time in a tight
// loop is enough. Retry 429/502/503/504 with backoff (honoring Retry-After
// when the server sends one) instead of failing the whole run on the first
// transient block. Each attempt gets a fresh signal from `makeSignal`.
/** Options for `redmineFetch`. */
export interface RedmineFetchOptions {
  /** A fresh signal for each attempt (default: a REQUEST_TIMEOUT_MS deadline). */
  makeSignal?: () => AbortSignal;
  /** Redirects off the Redmine origin (default: reject). */
  crossOrigin?: CrossOriginRedirect;
  /** Called as each response (including each redirect hop) arrives. */
  onResponse?: () => void;
  /** Total time all retries of one request may wait (default MAX_RETRY_DELAY_MS). */
  retryBudgetMs?: number;
}

/** Fetch a Redmine URL with retries, safe redirects, and a per-attempt timeout. */
export async function redmineFetch(
  url: string,
  init: RequestInit,
  options: RedmineFetchOptions = {},
): Promise<Response> {
  const makeSignal = options.makeSignal ??
    (() => AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  const crossOrigin = options.crossOrigin ?? "reject";
  const method = (init.method ?? "GET").toUpperCase();
  // One budget for the summed waits of every retry, so a limiter that keeps
  // asking for the maximum cannot hold a request for MAX_RETRIES times it.
  const retryBudgetMs = options.retryBudgetMs ?? MAX_RETRY_DELAY_MS;
  let waitedMs = 0;
  let response: Response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fetchFollowingRedirects(
      url,
      {
        ...init,
        signal: makeSignal(),
      },
      crossOrigin,
      options.onResponse,
    );
    response = result.response;
    // A retry restarts from `url` with `init`, so it repeats the original
    // method. Once a write has been redirected, the server may already have
    // committed it (POST -> 303 -> GET), so no status, not even a 429 on the
    // redirected request, makes repeating it safe.
    if (
      (result.redirected && method !== "GET" && method !== "HEAD") ||
      !isRetryableStatus(response, method) || attempt === MAX_RETRIES
    ) {
      return response;
    }
    // A streamed body was consumed by this attempt and cannot be resent.
    if (init.body instanceof ReadableStream) return response;
    const delay = retryDelayMs(response, attempt);
    if (delay === null || waitedMs + delay > retryBudgetMs) return response;
    waitedMs += delay;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return response!;
}

/** Parse a 2xx JSON body, naming the request if reading it fails. */
async function readJson<T>(
  response: Response,
  method: string,
  path: string,
  host: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (e) {
    throw new Error(
      `Redmine ${method} ${path} from ${host} failed while reading the body: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { cause: e },
    );
  }
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

  return await readJson<T>(response, method, path, host);
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

    const data = await readJson<Record<string, unknown>>(
      response,
      "GET",
      path,
      host,
    );
    const items = (data[resultKey] ?? []) as T[];
    const totalCount = (data.total_count as number | undefined) ?? 0;

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

/** Largest download allowed; also redmineDownload's default `maxBytes`. */
export const MAX_DOWNLOAD_BYTES = 524_288_000;

/** A download is aborted when no bytes arrive for this long. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

const INITIAL_BUFFER_CAP = 8 * 1024 * 1024;

/**
 * Download raw bytes from a Redmine path (for example an attachment).
 * Retries like the JSON helpers. A redirect off the Redmine origin is followed
 * without the Redmine credentials (storage backends redirect to S3 or a CDN). Throws on a non-2xx
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
  maxBytes: number = MAX_DOWNLOAD_BYTES,
  idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const headers: Record<string, string> = { "X-Redmine-API-Key": apiKey };
  if (username) {
    headers["X-Redmine-Username"] = username;
  }

  // Each attempt gets its own controller. A timer still pending from an
  // earlier attempt (it can fire during the retry backoff) aborts only that
  // attempt's controller, whose response is already discarded, so it cannot
  // cut short a later attempt.
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
      response = await redmineFetch(`${host}${path}`, { headers }, {
        makeSignal: () => {
          controller = new AbortController();
          resetIdle();
          return controller.signal;
        },
        crossOrigin: "strip",
        // Each hop's response is data arriving: restart the idle timer, so
        // slow hops are judged one at a time, not added together.
        onResponse: resetIdle,
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
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new RedmineDownloadTooLargeError(path, declared, maxBytes);
    }
    if (!response.body) {
      return { bytes: new Uint8Array(0), contentType };
    }

    // Allocate once when the length is declared; otherwise grow in place.
    // Either way the bytes are held in one buffer, never in a chunk list
    // plus a merged copy.
    // The up-front allocation is capped so a large declared length costs
    // nothing until the bytes actually arrive.
    let buffer = new Uint8Array(
      Number.isInteger(declared) && declared >= 0
        ? Math.min(declared, INITIAL_BUFFER_CAP)
        : 64 * 1024,
    );
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        if (total + value.length > maxBytes) {
          await reader.cancel();
          throw new RedmineDownloadTooLargeError(
            path,
            total + value.length,
            maxBytes,
          );
        }
        if (total + value.length > buffer.length) {
          let size = Math.max(buffer.length * 2, total + value.length);
          size = Math.min(size, maxBytes);
          const grown = new Uint8Array(size);
          grown.set(buffer.subarray(0, total));
          buffer = grown;
        }
        buffer.set(value, total);
        total += value.length;
      }
    } catch (e) {
      if (e instanceof RedmineDownloadTooLargeError) throw e;
      // Release the connection now rather than when the reader is collected.
      await reader.cancel().catch(() => {});
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
