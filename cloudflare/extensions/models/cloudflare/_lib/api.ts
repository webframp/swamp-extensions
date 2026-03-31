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

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as CloudflareResponse<T>;

  if (!data.success) {
    const errorMsg = data.errors.map((e) => e.message).join("; ");
    throw new Error(`Cloudflare API error: ${errorMsg}`);
  }

  return data.result;
}

export async function cfApiPaginated<T>(
  apiToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<T[]> {
  const allResults: T[] = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const queryParams = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      ...params,
    });

    const url = `${CF_API_BASE}${path}?${queryParams}`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CloudflareResponse<T[]>;

    if (!data.success) {
      const errorMsg = data.errors.map((e) => e.message).join("; ");
      throw new Error(`Cloudflare API error: ${errorMsg}`);
    }

    allResults.push(...data.result);

    if (!data.result_info || page >= data.result_info.total_pages) {
      break;
    }
    page++;
  }

  return allResults;
}
