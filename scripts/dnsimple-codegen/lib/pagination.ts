/**
 * Pagination detection for DNSimple API endpoints.
 *
 * DNSimple's spec omits the `page` and `per_page` query parameters from all
 * but one paginated operation, even though the API honors them everywhere. A
 * detector that keys on query parameters (as falai-codegen's does) would treat
 * sixteen of the seventeen as single-page. This module detects pagination from
 * the response shape instead.
 *
 * Detection rules:
 * 1. An operation is paginated when its success response schema has a
 *    `pagination` property that is a `$ref` to
 *    `#/components/schemas/Pagination`. The check runs on the UNRESOLVED
 *    response schema, because resolution inlines the ref and loses the name.
 * 2. The results array is at `data`, unless `PAGINATED_RESULT_PATHS` names
 *    another path (`queryDnsAnalytics` returns `data: { headers, rows }`).
 *    Generation fails when a paginated operation's results path does not
 *    resolve to an array.
 * 3. The generated method never exposes `page` or `per_page`; the runtime
 *    helper owns them.
 */

import type { SchemaObject } from "./schema_fetcher.ts";
import { PAGINATED_RESULT_PATHS, type PaginatedResultPath } from "../config.ts";

/** The `$ref` every DNSimple paginated response points its `pagination` at. */
export const PAGINATION_REF = "#/components/schemas/Pagination";

/** Query parameters the runtime helper owns on a paginated operation. */
export const PAGINATION_PARAMS = ["page", "per_page"];

export interface PaginationInfo {
  /** True when the response carries the shared `Pagination` object. */
  paginated: boolean;
  /** Property path from the response root to the results array. */
  resultsPath: string[];
  /** Siblings of the results array to keep from the first page. */
  keep: string[];
}

const NOT_PAGINATED: PaginationInfo = {
  paginated: false,
  resultsPath: ["data"],
  keep: [],
};

/**
 * Detect whether an operation is paginated.
 *
 * @param operationId  used to look up a `PAGINATED_RESULT_PATHS` exception
 * @param rawResponse  the success response schema before `$ref` resolution
 * @param resolvedResponse  the same schema fully resolved
 */
export function detectPagination(
  operationId: string,
  rawResponse: SchemaObject | undefined,
  resolvedResponse: SchemaObject | undefined,
  resultPaths: Record<string, PaginatedResultPath> = PAGINATED_RESULT_PATHS,
): PaginationInfo {
  if (rawResponse?.properties?.pagination?.$ref !== PAGINATION_REF) {
    return NOT_PAGINATED;
  }
  const configured = resultPaths[operationId];
  const resultsPath = configured?.path ?? ["data"];
  const keep = configured?.keep ?? [];

  const results = schemaAtPath(resolvedResponse, resultsPath);
  const type = Array.isArray(results?.type) ? results.type[0] : results?.type;
  if (type !== "array") {
    throw new Error(
      `${operationId}: paginated response has no array at ` +
        `${
          resultsPath.join(".")
        }; add a PAGINATED_RESULT_PATHS entry in config.ts`,
    );
  }
  const parent = schemaAtPath(resolvedResponse, resultsPath.slice(0, -1));
  const missing = keep.filter((k) => !parent?.properties?.[k]);
  if (missing.length > 0) {
    throw new Error(
      `${operationId}: PAGINATED_RESULT_PATHS keeps ${missing.join(", ")}, ` +
        `which the response schema does not declare next to ` +
        `${resultsPath.join(".")}`,
    );
  }
  return { paginated: true, resultsPath, keep };
}

/** Walk a resolved schema down a property path; undefined when it breaks. */
export function schemaAtPath(
  schema: SchemaObject | undefined,
  path: string[],
): SchemaObject | undefined {
  let current = schema;
  for (const key of path) {
    current = current?.properties?.[key];
    if (!current) return undefined;
  }
  return current;
}
