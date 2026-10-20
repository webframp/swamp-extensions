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

// Redmine's rate limiter can trip even under sequential (concurrency-1)
// callers — a workflow enriching dozens of issues one at a time in a tight
// loop is enough. Retry 429/502/503/504 with backoff (honoring Retry-After
// when the server sends one) instead of failing the whole run on the first
// transient block.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    response = await fetch(url, init);
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
    response = await fetchWithRetry(url, {
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
      response = await fetchWithRetry(url, {
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

/**
 * Download raw bytes from a Redmine path (for example an attachment).
 * Retries like the JSON helpers. Throws on a non-2xx response, and throws
 * `RedmineDownloadTooLargeError` when the response is larger than `maxBytes`.
 * The body is read as a stream and abandoned as soon as it passes the cap,
 * so a missing or wrong Content-Length cannot make it buffer without bound.
 */
export async function redmineDownload(
  host: string,
  apiKey: string,
  path: string,
  username?: string,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const headers: Record<string, string> = { "X-Redmine-API-Key": apiKey };
  if (username) {
    headers["X-Redmine-Username"] = username;
  }

  let response: Response;
  try {
    response = await fetchWithRetry(`${host}${path}`, { headers });
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
  const declared = Number(response.headers.get("Content-Length") ?? NaN);
  if (maxBytes !== undefined && declared > maxBytes) {
    await response.body?.cancel();
    throw new RedmineDownloadTooLargeError(path, declared, maxBytes);
  }
  if (!response.body) {
    return { bytes: new Uint8Array(0), contentType };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (maxBytes !== undefined && total > maxBytes) {
      await reader.cancel();
      throw new RedmineDownloadTooLargeError(path, total, maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, contentType };
}
