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
    const tokens = await refreshAccessToken(
      creds.clientId,
      creds.clientSecret,
      creds.refreshToken,
    );
    creds.accessToken = tokens.access_token;
    creds.refreshToken = tokens.refresh_token;
    response = await doRequest();
  }

  if (!response.ok) {
    throw new Error(
      `Twitch Helix API error ${response.status}: ${await response.text()}`,
    );
  }

  // Rate-limit awareness: pause if close to the limit
  const remaining = response.headers.get("Ratelimit-Remaining");
  if (remaining !== null && parseInt(remaining, 10) < 20) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return (await response.json()) as HelixResponse<T>;
}

/**
 * Paginate through all pages of a Helix endpoint using cursor-based pagination.
 *
 * Twitch uses `first` (page size) and `after` (cursor) query parameters.
 * The path may already contain query parameters.
 */
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

    cursor = response.pagination?.cursor;
    if (!cursor) {
      break;
    }
  }

  return allResults;
}
