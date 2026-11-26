/**
 * A GET that takes query parameters must forward them to the API, and a call
 * that supplies any must write its own instance: two calls differing only in a
 * filter would otherwise overwrite one stored result, and the filter would
 * never reach the API at all.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

const RESPONSE = {
  "200": {
    description: "ok",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            result: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  components: { schemas: {} },
  paths: {
    "/accounts/{account_id}/demo/series/{series_id}": {
      get: {
        operationId: "demo-get-series",
        summary: "Get series",
        tags: ["Demo"],
        parameters: [
          {
            name: "series_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "granularity", in: "query", schema: { type: "string" } },
          { name: "filter[status]", in: "query", schema: { type: "string" } },
        ],
        responses: RESPONSE,
      },
    },
    "/accounts/{account_id}/demo/summary": {
      get: {
        operationId: "demo-get-summary",
        summary: "Get summary",
        tags: ["Demo"],
        parameters: [
          { name: "days", in: "query", schema: { type: "integer" } },
        ],
        responses: RESPONSE,
      },
    },
    "/accounts/{account_id}/demo/plain": {
      get: {
        operationId: "demo-get-plain",
        summary: "Get plain",
        tags: ["Demo"],
        responses: RESPONSE,
      },
    },
  },
} as unknown as OpenAPISpec;

const SERVICE: ServiceConfig = {
  name: "demo",
  description: "Demo",
  pathPrefixes: ["/accounts/{account_id}/demo"],
  scope: "account",
  labels: ["cloudflare"],
};

function methodSource(name: string): string {
  const [group] = groupOperations(SPEC, [SERVICE]);
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.11.05.1");
  const start = source.indexOf(`    ${name}: {`);
  assertEquals(start >= 0, true, name);
  const next = source.indexOf("\n    },\n", start);
  return source.slice(start, next);
}

Deno.test("a get forwards query parameters under their API names", () => {
  const body = methodSource("get_series");
  assertStringIncludes(body, '"filter_status":"filter[status]"');
  assertStringIncludes(body, "encodeURIComponent(queryNames[k])");
  assertStringIncludes(body, "${qs}`");
  assertEquals(body.includes("(_args"), false);
});

Deno.test("a get with a path id and a query keys its instance on both", () => {
  const body = methodSource("get_series");
  assertStringIncludes(
    body,
    "sanitizeInstanceName(`${String(args.series_id)}${querySuffix}`)",
  );
});

Deno.test("a get with only a query keys its instance on the query", () => {
  const body = methodSource("get_summary");
  assertStringIncludes(body, "`summary-current${querySuffix}`");
});

Deno.test("a get without query parameters keeps its constant instance", () => {
  const body = methodSource("get_plain");
  assertStringIncludes(body, '"plain-current"');
  assertEquals(body.includes("querySuffix"), false);
});
