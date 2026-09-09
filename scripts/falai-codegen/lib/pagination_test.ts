/**
 * Tests for pagination strategy detection.
 */

import { assertEquals } from "@std/assert";
import { detectPagination, detectResultsField } from "./pagination.ts";
import type { ParameterObject, SchemaObject } from "./schema_fetcher.ts";

function param(name: string): ParameterObject {
  return { name, in: "query", schema: { type: "string" } };
}

Deno.test("pagination: limit+cursor query params -> paginated", () => {
  const info = detectPagination([param("limit"), param("cursor")], undefined);
  assertEquals(info.paginated, true);
});

Deno.test("pagination: limit without cursor -> not paginated", () => {
  const info = detectPagination([param("limit")], undefined);
  assertEquals(info.paginated, false);
});

Deno.test("pagination: no query params -> not paginated", () => {
  const info = detectPagination([], undefined);
  assertEquals(info.paginated, false);
});

Deno.test("pagination: unrelated query params -> not paginated", () => {
  const info = detectPagination([param("q"), param("section")], undefined);
  assertEquals(info.paginated, false);
});

Deno.test("detectResultsField: finds the top-level array property", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      next_cursor: { type: ["string", "null"] },
      has_more: { type: "boolean" },
      instances: { type: "array", items: { type: "object" } },
    },
  };
  assertEquals(detectResultsField(schema), "instances");
});

Deno.test("detectResultsField: undefined when no array property exists", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: { id: { type: "string" } },
  };
  assertEquals(detectResultsField(schema), undefined);
});

Deno.test("detectResultsField: undefined for undefined schema", () => {
  assertEquals(detectResultsField(undefined), undefined);
});

Deno.test("pagination: detects next_cursor/has_more presence on the response", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      next_cursor: { type: ["string", "null"] },
      has_more: { type: "boolean" },
      instances: { type: "array", items: { type: "object" } },
    },
  };
  const info = detectPagination([param("limit"), param("cursor")], schema);
  assertEquals(info.paginated, true);
  assertEquals(info.resultsField, "instances");
  assertEquals(info.hasNextCursor, true);
  assertEquals(info.hasHasMore, true);
});

Deno.test("pagination: an unpaginated list still reports its results field", () => {
  // GET /serverless/apps: no limit/cursor params, response is { apps: [...] }
  const schema: SchemaObject = {
    type: "object",
    properties: { apps: { type: "array", items: { type: "object" } } },
  };
  const info = detectPagination([param("environment")], schema);
  assertEquals(info.paginated, false);
  assertEquals(info.resultsField, "apps");
  assertEquals(info.hasNextCursor, false);
  assertEquals(info.hasHasMore, false);
});
