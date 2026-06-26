// Twitch Helix API Client
// Shared HTTP client for all Twitch models with token refresh and pagination.
// SPDX-License-Identifier: Apache-2.0

import type {
  HelixResponse,
  TokenResponse,
  TwitchCredentials,
} from "./types.ts";

export const HELIX_BASE = "https://api.twitch.tv/helix";
export const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/**
 * In-process credential cache keyed by clientId.
 *
 * When helixApi refreshes an expired token, it stores the new tokens here
 * along with the original expired token that triggered the refresh. Subsequent
 * calls with the same clientId only use the cached tokens when the caller still
 * holds the same expired token — if the caller supplies a different token
 * (e.g., after a manual credential rotation in vault), the cache is bypassed
 * so fresh credentials take effect immediately.
 *
 * This is necessary because MethodContext.globalArgs is a fresh copy per method
 * call — mutations to creds in one method are invisible to the next.
 */
const tokenCache = new Map<
  string,
  {
    expiredToken: string;
    accessToken: string;
    refreshToken: string;
  }
>();

/** Exported for testing — clears the in-process token cache. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Refresh an expired OAuth2 access token using the refresh token grant.
 * Throws with a helpful message (including re-authorization hint) on failure.
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to refresh Twitch access token (${response.status}): ${text}. ` +
        "The refresh token may have been revoked. " +
        "Re-authorize via the Twitch OAuth2 flow to obtain new credentials.",
    );
  }

  return (await response.json()) as TokenResponse;
}

/**
 * Make a single Helix API request with automatic token refresh on 401.
 *
 * On 401 the function refreshes the access token, mutates creds in place,
 * and retries the request once. On other HTTP errors it throws.
 *
 * After a successful response, checks the Ratelimit-Remaining header and
 * waits if the remaining budget drops below 20.
 */
export async function helixApi<T>(
  creds: TwitchCredentials,
  path: string,
  method: string = "GET",
  body?: unknown,
): Promise<HelixResponse<T>> {
  // Apply cached tokens only if the caller still holds the same expired token
  // that triggered the original refresh. If the caller has a different token
  // (e.g., manually rotated via vault), skip the cache so new creds take effect.
  const cached = tokenCache.get(creds.clientId);
  if (cached && creds.accessToken === cached.expiredToken) {
    creds.accessToken = cached.accessToken;
    creds.refreshToken = cached.refreshToken;
  }

  const doRequest = async (): Promise<Response> => {
    const url = `${HELIX_BASE}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${creds.accessToken}`,
      "Client-Id": creds.clientId,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let response = await doRequest();

  // On 401, refresh the token and retry once
  if (response.status === 401) {
    await response.body?.cancel();
    const expiredToken = creds.accessToken;
    const tokens = await refreshAccessToken(
      creds.clientId,
      creds.clientSecret,
      creds.refreshToken,
    );
    creds.accessToken = tokens.access_token;
    creds.refreshToken = tokens.refresh_token;
    tokenCache.set(creds.clientId, {
      expiredToken,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });
    response = await doRequest();
  }

  if (!response.ok) {
    throw new Error(
      `Twitch Helix API error ${response.status}: ${await response.text()}`,
    );
  }

  // Read the response body before any rate-limit sleep to avoid holding the
  // connection open or risking a server-side timeout on the stream.
  const data = (await response.json()) as HelixResponse<T>;

  // Rate-limit awareness: sleep until reset if running low
  const remaining = response.headers.get("Ratelimit-Remaining");
  if (remaining !== null && parseInt(remaining, 10) < 20) {
    const resetEpoch = response.headers.get("Ratelimit-Reset");
    let waitMs = 1000;
    if (resetEpoch !== null) {
      waitMs = Math.min(
        Math.max(parseInt(resetEpoch, 10) * 1000 - Date.now(), 0),
        60000,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  return data;
}

/**
 * Paginate through all pages of a Helix endpoint using cursor-based pagination.
 *
 * Twitch uses `first` (page size) and `after` (cursor) query parameters.
 * The path may already contain query parameters.
 */
const MAX_PAGINATED_RESULTS = 50_000;

export async function helixApiPaginated<T>(
  creds: TwitchCredentials,
  path: string,
): Promise<T[]> {
  const allResults: T[] = [];
  let cursor: string | undefined;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const paginatedPath = cursor
      ? `${path}${separator}first=100&after=${encodeURIComponent(cursor)}`
      : `${path}${separator}first=100`;

    const response = await helixApi<T>(creds, paginatedPath);
    allResults.push(...response.data);

    if (allResults.length >= MAX_PAGINATED_RESULTS) {
      break;
    }

    cursor = response.pagination?.cursor;
    if (!cursor) {
      break;
    }
  }

  return allResults;
}
