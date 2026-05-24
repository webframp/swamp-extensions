// Reddit OAuth2 API helper
// SPDX-License-Identifier: Apache-2.0

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
const MAX_PAGES = 10;
const RATE_LIMIT_FLOOR = 5;

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

export interface RedditActionResponse {
  json?: {
    errors: string[][];
    data?: Record<string, unknown>;
  };
}

/** Create an authenticated Reddit API client with automatic token refresh. */
export function createRedditClient(creds: RedditCredentials) {
  let tokenState: TokenState | null = null;
  let rateLimitRemaining = 60;
  let rateLimitResetMs = 0;

  async function respectRateLimit(): Promise<void> {
    if (rateLimitRemaining > RATE_LIMIT_FLOOR) return;
    const waitMs = Math.max(0, rateLimitResetMs - Date.now());
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }

  function trackRateLimit(resp: Response): void {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    const reset = resp.headers.get("x-ratelimit-reset");
    if (remaining != null) {
      const n = parseFloat(remaining);
      if (isFinite(n)) rateLimitRemaining = n;
    }
    if (reset != null) {
      const n = parseFloat(reset);
      if (isFinite(n)) rateLimitResetMs = Date.now() + n * 1000;
    }
  }

  async function authenticate(): Promise<string> {
    if (tokenState && Date.now() < tokenState.expiresAt - 60_000) {
      return tokenState.accessToken;
    }

    const basicAuth = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const body = new URLSearchParams({
      grant_type: "password",
      username: creds.username,
      password: creds.password,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "User-Agent": creds.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Reddit auth failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    tokenState = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
    return tokenState.accessToken;
  }

  /** Make an authenticated GET request to the Reddit API. */
  async function api<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    await respectRateLimit();
    const token = await authenticate();
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": creds.userAgent,
      },
    });
    trackRateLimit(resp);

    if (resp.status === 401) {
      tokenState = null;
      const newToken = await authenticate();
      const retry = await fetch(url.toString(), {
        headers: {
          "Authorization": `Bearer ${newToken}`,
          "User-Agent": creds.userAgent,
        },
      });
      trackRateLimit(retry);
      if (!retry.ok) {
        throw new Error(
          `Reddit API error (${retry.status}): ${await retry.text()}`,
        );
      }
      return (await retry.json()) as T;
    }

    if (!resp.ok) {
      throw new Error(
        `Reddit API error (${resp.status}): ${await resp.text()}`,
      );
    }

    return (await resp.json()) as T;
  }

  /** Paginate a Reddit listing endpoint using `after` cursors. */
  async function paginate<T>(
    path: string,
    limit: number,
    params?: Record<string, string>,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let after: string | undefined;
    let pages = 0;
    const perPage = Math.min(limit, 100);

    while (pages < MAX_PAGES && items.length < limit) {
      const reqParams: Record<string, string> = {
        ...params,
        limit: String(perPage),
      };
      if (after) reqParams.after = after;

      const data = await api<
        { data: { children: Array<{ data: T }>; after: string | null } }
      >(
        path,
        reqParams,
      );

      after = data.data.after ?? undefined;
      if (data.data.children.length === 0) break;

      for (const child of data.data.children) {
        items.push(child.data);
        if (items.length >= limit) break;
      }

      if (!after) break;
      pages++;
    }

    return {
      items: items.slice(0, limit),
      truncated: after !== undefined,
    };
  }

  /** Make an authenticated POST request to the Reddit API. */
  async function post<T>(
    path: string,
    body: Record<string, string | boolean | number>,
    opts?: { json?: boolean },
  ): Promise<T> {
    await respectRateLimit();
    const token = await authenticate();
    const url = `${API_BASE}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
      "User-Agent": creds.userAgent,
    };

    let reqBody: string;
    if (opts?.json) {
      headers["Content-Type"] = "application/json";
      reqBody = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        params.set(k, String(v));
      }
      reqBody = params.toString();
    }

    const resp = await fetch(url, { method: "POST", headers, body: reqBody });
    trackRateLimit(resp);

    if (resp.status === 401) {
      tokenState = null;
      const newToken = await authenticate();
      headers["Authorization"] = `Bearer ${newToken}`;
      const retry = await fetch(url, {
        method: "POST",
        headers,
        body: reqBody,
      });
      trackRateLimit(retry);
      if (!retry.ok) {
        throw new Error(
          `Reddit API error (${retry.status}): ${await retry.text()}`,
        );
      }
      return await parseJsonResponse<T>(retry);
    }

    if (!resp.ok) {
      throw new Error(
        `Reddit API error (${resp.status}): ${await resp.text()}`,
      );
    }

    return await parseJsonResponse<T>(resp);
  }

  async function parseJsonResponse<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    if (!text || text.trim() === "") return {} as T;
    return JSON.parse(text) as T;
  }

  return { api, paginate, post };
}

/** Exported for testing — exposes internal constants for assertion. */
export const _internals = {
  TOKEN_URL,
  API_BASE,
  MAX_PAGES,
  RATE_LIMIT_FLOOR,
};
