/**
 * Pagination strategy detection for fal.ai API endpoints.
 *
 * Unlike Cloudflare's fixed `{success, result, result_info}` envelope, every
 * fal.ai response is a bare JSON object whose list-valued field has a
 * different name per endpoint (`assets`, `instances`, `apps`, ...), and not
 * every list endpoint is paginated at all (e.g. GET /serverless/apps has no
 * `limit`/`cursor` params). This module detects both facts per-operation from
 * the OpenAPI spec, modeled on datadog-codegen's per-endpoint detection.
 *
 * Detection rules:
 * 1. Paginated iff the operation's query parameters include BOTH `limit` and
 *    `cursor`. fal.ai does not vary the parameter names the way Datadog does.
 * 2. The results field is the top-level response property whose schema is
 *    `type: "array"` (never hardcoded to a fixed name like `"result"`).
 * 3. `next_cursor` / `has_more` response fields, when present, drive the
 *    stop condition; their absence falls back to the cloudflare-style
 *    heuristic of stopping once a page is shorter than the requested limit.
 */

import type { ParameterObject, SchemaObject } from "./schema_fetcher.ts";

export interface PaginationInfo {
  /** True when the operation accepts both `limit` and `cursor` query params. */
  paginated: boolean;
  /** The response's top-level array-valued property name, if any was found. */
  resultsField?: string;
  /** True when the response schema declares a `next_cursor` field. */
  hasNextCursor: boolean;
  /** True when the response schema declares a `has_more` field. */
  hasHasMore: boolean;
}

/**
 * Detect whether an operation is a paginated list endpoint, and if so, where
 * the array of results and the cursor/has-more fields live in the response.
 */
export function detectPagination(
  queryParams: ParameterObject[],
  responseSchema: SchemaObject | undefined,
): PaginationInfo {
  const paramNames = new Set(queryParams.map((p) => p.name));
  const paginated = paramNames.has("limit") && paramNames.has("cursor");

  const resultsField = detectResultsField(responseSchema);
  const hasNextCursor = Boolean(responseSchema?.properties?.next_cursor);
  const hasHasMore = Boolean(responseSchema?.properties?.has_more);

  return { paginated, resultsField, hasNextCursor, hasHasMore };
}

/**
 * Find the top-level response property whose schema is `type: "array"`.
 * Returns undefined if none is found (e.g. a single-object response, or an
 * operation whose response schema wasn't resolved).
 */
export function detectResultsField(
  responseSchema: SchemaObject | undefined,
): string | undefined {
  if (!responseSchema?.properties) return undefined;
  for (const [name, prop] of Object.entries(responseSchema.properties)) {
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (type === "array") return name;
  }
  return undefined;
}
