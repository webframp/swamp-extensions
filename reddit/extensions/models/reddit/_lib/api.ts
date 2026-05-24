// Reddit OAuth2 API helper
// SPDX-License-Identifier: Apache-2.0

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
const MAX_PAGES = 10;

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

    if (resp.status === 401) {
      tokenState = null;
      const newToken = await authenticate();
      const retry = await fetch(url.toString(), {
        headers: {
          "Authorization": `Bearer ${newToken}`,
          "User-Agent": creds.userAgent,
        },
      });
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

      for (const child of data.data.children) {
        items.push(child.data);
        if (items.length >= limit) break;
      }

      after = data.data.after ?? undefined;
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

    if (resp.status === 401) {
      tokenState = null;
      const newToken = await authenticate();
      headers["Authorization"] = `Bearer ${newToken}`;
      const retry = await fetch(url, {
        method: "POST",
        headers,
        body: reqBody,
      });
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

  return { api, paginate, post };
}

/** Exported for testing — exposes internal constants for assertion. */
export const _internals = {
  TOKEN_URL,
  API_BASE,
  MAX_PAGES,
};
