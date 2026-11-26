// SPDX-License-Identifier: Apache-2.0
/**
 * A bulk delete names the items to remove in its request body, so the body must
 * reach the API. A response field that changed shape between API versions must
 * keep accepting the earlier shape so stored resources still validate.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ServiceConfig } from "../config.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";

const CONFIG: ServiceConfig = {
  name: "things",
  description: "Things",
  pathPrefixes: ["/orgs/{org_id}/things"],
  scope: "org",
  labels: [],
  legacyResponseShapes: [{
    field: "tags",
    current: "z.record(z.string(), z.string())",
    legacy: "z.array(z.string())",
  }],
};

function op(partial: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/orgs/{org_id}/things",
    operationId: "x",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    usesCursorPagination: true,
    hasResponseBody: true,
    deprecated: false,
    tags: [],
    ...partial,
  };
}

function build(operations: GroupedOperation[]): string {
  const group: ServiceGroup = { config: CONFIG, operations };
  return generateModelSource(
    group,
    classifyServiceMethods(group),
    "2026.01.01.1",
  );
}

Deno.test("a bulk delete sends its request body", () => {
  const src = build([
    op({
      operationId: "deleteThings",
      httpMethod: "delete",
      hasResponseBody: false,
      responseSchema: undefined,
      requestBody: {
        type: "object",
        properties: { data: { type: "array", items: { type: "string" } } },
      },
    }),
  ]);
  const start = src.indexOf("delete_things: {");
  const body = src.slice(start);
  assertStringIncludes(body, '"DELETE"');
  assertStringIncludes(body, "if (!excludeKeys.has(k)) body[k] = v;");
  assertStringIncludes(body, "version,\n          body,");
});

Deno.test("a delete without a request body sends none", () => {
  const src = build([
    op({
      operationId: "deleteThing",
      httpMethod: "delete",
      path: "/orgs/{org_id}/things/{thing_id}",
      pathParams: [{ name: "thing_id", in: "path", required: true }],
      hasResponseBody: false,
      responseSchema: undefined,
    }),
  ]);
  assertEquals(src.includes("body[k] = v"), false);
});

Deno.test("a field that changed shape accepts the earlier shape too", () => {
  const src = build([
    op({
      operationId: "getThing",
      path: "/orgs/{org_id}/things/{thing_id}",
      pathParams: [{ name: "thing_id", in: "path", required: true }],
      responseSchema: {
        type: "object",
        properties: {
          tags: { type: "object", additionalProperties: { type: "string" } },
          name: { type: "string" },
        },
      },
    }),
  ]);
  assertStringIncludes(
    src,
    "tags: z.union([z.record(z.string(), z.string()), z.array(z.string())])",
  );
});

Deno.test("a create with no declared response body says why it still stores the reply", () => {
  const src = build([
    op({
      operationId: "createThing",
      httpMethod: "post",
      hasResponseBody: false,
      responseSchema: undefined,
      requestBody: { type: "object", properties: { n: { type: "string" } } },
    }),
  ]);
  assertStringIncludes(src, "The spec declares no response body");
});
