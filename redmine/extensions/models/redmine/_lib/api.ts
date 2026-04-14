// Redmine API Helper
// Shared utilities for all Redmine models

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
): Promise<T> {
  const url = `${host}${path}`;
  const headers: Record<string, string> = {
    "X-Redmine-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null as T;
  }

  if (!response.ok) {
    let errorMsg = `Redmine API error ${response.status}`;
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
    const response = await fetch(url, {
      headers: {
        "X-Redmine-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      let errorMsg = `Redmine API error ${response.status}`;
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
