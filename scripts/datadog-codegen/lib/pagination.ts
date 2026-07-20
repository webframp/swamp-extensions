/**
 * Pagination strategy detection for Datadog API endpoints.
 *
 * Datadog uses 20+ different parameter naming patterns for pagination.
 * This module detects the style from query parameter names at codegen time
 * and resolves the cursor response path from the response meta schema.
 *
 * Detection rules (applied in order, first match wins):
 * 1. Has page[cursor]/cursor/page[token]/page[continuation_token]/page[next_record_id] → cursor
 * 2. Has page[offset]/offset/page_offset → offset
 * 3. Has page[number]/page_number/page (with page[size] or per_page) → page_number
 * 4. Has page[limit] or limit but no cursor/offset → offset (default offset=0)
 * 5. No pagination params → none
 */

import type { PaginationConfig, PaginationStyle } from "../config.ts";
import type {
  OpenAPISpec,
  OperationObject,
  ParameterObject,
  RefObject,
  ResponseObject,
  SchemaObject,
} from "./schema_fetcher.ts";
import { resolveSchema } from "./schema_fetcher.ts";

/** Parameter names that indicate cursor-based pagination */
const CURSOR_PARAMS = new Set([
  "page[cursor]",
  "cursor",
  "page[token]",
  "page[continuation_token]",
  "page[next_record_id]",
  "page[queryId]",
]);

/** Parameter names that indicate offset-based pagination */
const OFFSET_PARAMS = new Set([
  "page[offset]",
  "offset",
  "page_offset",
]);

/** Parameter names that indicate page-number pagination */
const PAGE_NUMBER_PARAMS = new Set([
  "page[number]",
  "page_number",
]);

/** Parameter names that indicate a limit/size control */
const LIMIT_PARAMS = new Set([
  "page[limit]",
  "page[size]",
  "page_size",
  "per_page",
  "limit",
]);

/** All pagination-related params (excluded from user-facing query args) */
export const ALL_PAGINATION_PARAMS = new Set([
  ...CURSOR_PARAMS,
  ...OFFSET_PARAMS,
  ...PAGE_NUMBER_PARAMS,
  ...LIMIT_PARAMS,
  "page",
]);

/**
 * Detect pagination style from an operation's query parameters.
 *
 * Returns a PaginationConfig if pagination is detected, or a "none" config otherwise.
 */
export function detectPagination(
  spec: OpenAPISpec,
  operation: OperationObject,
  queryParams: ParameterObject[],
): PaginationConfig {
  const paramNames = new Set(queryParams.map((p) => p.name));

  // Rule 1: Cursor-based
  for (const name of CURSOR_PARAMS) {
    if (paramNames.has(name)) {
      const limitParam = findLimitParam(paramNames);
      const cursorResponsePath = detectCursorResponsePath(spec, operation);
      return {
        style: "cursor",
        limitParam,
        limitDefault: 100,
        cursorParam: name,
        cursorResponsePath,
      };
    }
  }

  // Rule 2: Offset-based
  for (const name of OFFSET_PARAMS) {
    if (paramNames.has(name)) {
      const limitParam = findLimitParam(paramNames);
      return {
        style: "offset",
        limitParam,
        limitDefault: 100,
        offsetParam: name,
      };
    }
  }

  // Rule 3: Page-number
  for (const name of PAGE_NUMBER_PARAMS) {
    if (paramNames.has(name)) {
      const limitParam = findLimitParam(paramNames);
      return {
        style: "page_number",
        limitParam,
        limitDefault: 50,
        pageParam: name,
      };
    }
  }

  // Rule 3b: Bare "page" param with a size companion
  if (
    paramNames.has("page") && (paramNames.has("per_page") ||
      paramNames.has("page[size]") || paramNames.has("page_size"))
  ) {
    const limitParam = findLimitParam(paramNames);
    return {
      style: "page_number",
      limitParam,
      limitDefault: 50,
      pageParam: "page",
    };
  }

  // Rule 4: Has limit but no cursor/offset/page → treat as offset from 0
  if (hasAnyParam(paramNames, LIMIT_PARAMS)) {
    const limitParam = findLimitParam(paramNames);
    return {
      style: "offset",
      limitParam,
      limitDefault: 100,
      offsetParam: "page[offset]",
    };
  }

  // Rule 5: No pagination detected
  return {
    style: "none",
    limitParam: "",
    limitDefault: 0,
  };
}

/**
 * Detect where in the response meta the cursor/offset value lives.
 *
 * Checks common Datadog patterns:
 * - meta.page.after → cursor
 * - meta.page.cursor → cursor
 * - meta.pagination.next_offset → offset (also used as cursor)
 * - meta.next_record_id → record-id cursor
 */
function detectCursorResponsePath(
  spec: OpenAPISpec,
  operation: OperationObject,
): string {
  if (!operation.responses) return "meta.page.after";

  // Try 200 response
  const resp = operation.responses["200"] as ResponseObject | undefined;
  if (!resp?.content) return "meta.page.after";

  const jsonContent = resp.content["application/json"];
  if (!jsonContent?.schema) return "meta.page.after";

  const fullSchema = resolveSchema(spec, jsonContent.schema);
  if (!fullSchema.properties) return "meta.page.after";

  // Look at the meta property
  const metaProp = fullSchema.properties.meta;
  if (!metaProp) return "meta.page.after";

  const metaSchema = resolveSchema(spec, metaProp);
  if (!metaSchema.properties) return "meta.page.after";

  // Check meta.page
  if (metaSchema.properties.page) {
    const pageSchema = resolveSchema(spec, metaSchema.properties.page);
    if (pageSchema.properties) {
      if (pageSchema.properties.after) return "meta.page.after";
      if (pageSchema.properties.cursor) return "meta.page.cursor";
    }
  }

  // Check meta.pagination
  if (metaSchema.properties.pagination) {
    const paginationSchema = resolveSchema(
      spec,
      metaSchema.properties.pagination,
    );
    if (paginationSchema.properties) {
      if (paginationSchema.properties.next_offset) {
        return "meta.pagination.next_offset";
      }
    }
  }

  // Check meta.next_record_id
  if (metaSchema.properties.next_record_id) {
    return "meta.next_record_id";
  }

  // Default fallback
  return "meta.page.after";
}

/** Find the best limit/size parameter name from available params */
function findLimitParam(paramNames: Set<string>): string {
  if (paramNames.has("page[limit]")) return "page[limit]";
  if (paramNames.has("page[size]")) return "page[size]";
  if (paramNames.has("page_size")) return "page_size";
  if (paramNames.has("per_page")) return "per_page";
  if (paramNames.has("limit")) return "limit";
  return "page[limit]";
}

/** Check if any param from the set exists */
function hasAnyParam(
  paramNames: Set<string>,
  candidates: Set<string>,
): boolean {
  for (const name of candidates) {
    if (paramNames.has(name)) return true;
  }
  return false;
}

/**
 * Determine if an operation is a paginated list endpoint.
 *
 * Heuristics:
 * - HTTP GET method
 * - Has pagination params
 * - Response data is an array
 */
export function isPaginatedList(
  style: PaginationStyle,
  httpMethod: string,
): boolean {
  return httpMethod === "get" && style !== "none";
}

/**
 * Resolve parameter refs for pagination detection.
 */
export function resolveParamsForPagination(
  spec: OpenAPISpec,
  params: (ParameterObject | RefObject)[],
): ParameterObject[] {
  return params.map((p) => {
    if ("$ref" in p) {
      const ref = p.$ref;
      if (!ref.startsWith("#/")) return p as unknown as ParameterObject;
      const parts = ref.replace("#/", "").split("/");
      // deno-lint-ignore no-explicit-any
      let current: any = spec;
      for (const part of parts) {
        current = current?.[part];
      }
      return (current ?? p) as ParameterObject;
    }
    return p;
  });
}
