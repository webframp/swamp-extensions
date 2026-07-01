// Microsoft Graph API Helper
// Shared fetch utilities for all Microsoft models.
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

export class GraphApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly graphCode: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

// ---------------------------------------------------------------------------
// Single-resource request
// ---------------------------------------------------------------------------

/**
 * Make a single Graph API request and return the parsed response body.
 * Throws GraphApiError on non-2xx responses.
 */
export async function graphRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  const response = await fetchFn(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    // No content — return empty object.
    return {} as T;
  }

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const err = data["error"] as
      | { code?: string; message?: string }
      | undefined;
    throw new GraphApiError(
      response.status,
      String(err?.code ?? "unknown"),
      String(err?.message ?? `Graph API error ${response.status}`),
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Paginated list request
// ---------------------------------------------------------------------------

export interface PaginatedResult<T> {
  items: T[];
  truncated: boolean;
}

/**
 * Fetch pages of a Graph API list endpoint, following @odata.nextLink up to
 * maxPages (default 20). Returns items and whether results were truncated.
 */
export async function graphRequestPaginated<T>(
  accessToken: string,
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  maxPages: number = 20,
): Promise<PaginatedResult<T>> {
  const allItems: T[] = [];

  let url: string;
  if (path.startsWith("https://")) {
    url = path;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      url = `${url}${url.includes("?") ? "&" : "?"}${qs}`;
    }
  } else {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    url = `${GRAPH_BASE}${path}${qs}`;
  }

  let pages = 0;
  while (pages < maxPages) {
    const page = await graphRequest<GraphListResponse<T>>(
      accessToken,
      "GET",
      url,
      undefined,
      extraHeaders,
      fetchFn,
    );

    allItems.push(...(page.value ?? []));
    pages++;

    if (!page["@odata.nextLink"]) {
      return { items: allItems, truncated: false };
    }

    url = page["@odata.nextLink"];
  }

  return { items: allItems, truncated: true };
}
