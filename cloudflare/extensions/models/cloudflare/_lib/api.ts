// Cloudflare API Helper
// Shared utilities for all Cloudflare models

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
  };
}

export async function cfApi<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${CF_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API request failed (${method} ${path}): ${message}`,
      { cause: err },
    );
  }

  let data: CloudflareResponse<T>;
  try {
    data = (await response.json()) as CloudflareResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API returned a non-JSON response for ${method} ${path} ` +
        `(HTTP ${response.status}): ${message}`,
      { cause: err },
    );
  }

  if (!data.success) {
    const errorMsg = data.errors.map((e) => e.message).join("; ") ||
      `HTTP ${response.status} with no error detail`;
    throw new Error(
      `Cloudflare API error on ${method} ${path}: ${errorMsg}`,
    );
  }

  return data.result;
}

const MAX_PAGES = 20;

export interface PaginatedResult<T> {
  results: T[];
  truncated: boolean;
  totalFetched: number;
}

export async function cfApiPaginated<T>(
  apiToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<PaginatedResult<T>> {
  const allResults: T[] = [];
  let page = 1;
  const perPage = 50;
  let truncated = false;

  while (page <= MAX_PAGES) {
    const queryParams = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      ...params,
    });

    const url = `${CF_API_BASE}${path}?${queryParams}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cloudflare API request failed (GET ${path}, page ${page}): ${message}`,
        { cause: err },
      );
    }

    let data: CloudflareResponse<T[]>;
    try {
      data = (await response.json()) as CloudflareResponse<T[]>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cloudflare API returned a non-JSON response for GET ${path} ` +
          `(page ${page}, HTTP ${response.status}): ${message}`,
        { cause: err },
      );
    }

    if (!data.success) {
      const errorMsg = data.errors.map((e) => e.message).join("; ") ||
        `HTTP ${response.status} with no error detail`;
      throw new Error(
        `Cloudflare API error on GET ${path} (page ${page}): ${errorMsg}`,
      );
    }

    allResults.push(...data.result);

    if (!data.result_info || page >= data.result_info.total_pages) {
      break;
    }
    page++;
  }

  if (page > MAX_PAGES) {
    truncated = true;
  }

  return { results: allResults, truncated, totalFetched: allResults.length };
}
