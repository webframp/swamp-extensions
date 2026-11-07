/**
 * Tests for the Griptape service grouper module.
 */

import { assertEquals } from "@std/assert";
import {
  extractResponseSchema,
  groupOperations,
  reportCoverage,
  skipReason,
  withTemplatePlaceholders,
} from "./service_grouper.ts";
import type { OpenAPISpec, OperationObject } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// withTemplatePlaceholders
// ---------------------------------------------------------------------------

Deno.test("withTemplatePlaceholders: synthesizes undeclared path params", () => {
  const result = withTemplatePlaceholders(
    "/api/threads/{thread_id}/messages/{message_id}",
    [{ name: "thread_id", in: "path", required: true }],
  );
  assertEquals(result.map((p) => p.name), ["thread_id", "message_id"]);
});

Deno.test("withTemplatePlaceholders: declared params win, no duplicates", () => {
  const result = withTemplatePlaceholders(
    "/api/threads/{thread_id}",
    [{
      name: "thread_id",
      in: "path",
      required: true,
      description: "declared",
    }],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].description, "declared");
});

// ---------------------------------------------------------------------------
// Path-prefix boundary matching — /api/rules must not swallow /api/rulesets
// ---------------------------------------------------------------------------

Deno.test("groupOperations: prefix matches only at segment boundaries", () => {
  const services: ServiceConfig[] = [
    {
      name: "rulesets",
      description: "",
      pathPrefixes: ["/api/rulesets", "/api/rules"],
      labels: [],
    },
  ];
  const spec = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/api/rules": { get: listOp("ListRules") },
      "/api/rulesets": { get: listOp("ListRulesets") },
      "/api/rulesets/{ruleset_id}": { get: getOp("GetRuleset") },
    },
    components: { schemas: {} },
  } as unknown as OpenAPISpec;

  const groups = groupOperations(spec, services);
  assertEquals(groups.length, 1);
  // All three paths land in the single rulesets service (both prefixes belong
  // to it), and none is mis-grouped or dropped.
  assertEquals(groups[0].operations.length, 3);
});

Deno.test("groupOperations: longest prefix wins across services", () => {
  const services: ServiceConfig[] = [
    {
      name: "rules",
      description: "",
      pathPrefixes: ["/api/rules"],
      labels: [],
    },
    {
      name: "rulesets",
      description: "",
      pathPrefixes: ["/api/rulesets"],
      labels: [],
    },
  ];
  const spec = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/api/rulesets/{ruleset_id}": { get: getOp("GetRuleset") },
      "/api/rules/{rule_id}": { get: getOp("GetRule") },
    },
    components: { schemas: {} },
  } as unknown as OpenAPISpec;

  const groups = groupOperations(spec, services);
  const byName = Object.fromEntries(groups.map((g) => [g.config.name, g]));
  assertEquals(byName["rulesets"].operations.length, 1);
  assertEquals(byName["rules"].operations.length, 1);
  assertEquals(byName["rulesets"].operations[0].operationId, "GetRuleset");
  assertEquals(byName["rules"].operations[0].operationId, "GetRule");
});

// ---------------------------------------------------------------------------
// extractResponseSchema — envelope-agnostic list vs single detection
// ---------------------------------------------------------------------------

Deno.test("extractResponseSchema: List* op with array -> item schema + itemsKey", () => {
  const spec = {
    components: { schemas: {} },
  } as unknown as OpenAPISpec;
  const op: OperationObject = {
    operationId: "ListThreads",
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                threads: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { thread_id: { type: "string" } },
                  },
                },
                pagination: { type: "object" },
              },
            },
          },
        },
      },
    },
  };
  const { isCollection, listItemsKey, responseSchema } = extractResponseSchema(
    spec,
    op,
    op.operationId,
  );
  assertEquals(isCollection, true);
  assertEquals(listItemsKey, "threads");
  assertEquals(responseSchema?.properties?.thread_id?.type, "string");
});

Deno.test("extractResponseSchema: Get* entity WITH an inline array is NOT a list (regression)", () => {
  // GetAssistant embeds knowledge_base_ids: string[] and retriever_ids: string[].
  // The 'first array property = collection' heuristic would misclassify this as
  // a paginated list over knowledge_base_ids and discard the entity. Keying off
  // the List* prefix prevents that.
  const spec = { components: { schemas: {} } } as unknown as OpenAPISpec;
  const op: OperationObject = {
    operationId: "GetAssistant",
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                assistant_id: { type: "string" },
                name: { type: "string" },
                knowledge_base_ids: {
                  type: "array",
                  items: { type: "string" },
                },
                retriever_ids: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
  const { isCollection, listItemsKey, responseSchema } = extractResponseSchema(
    spec,
    op,
    op.operationId,
  );
  assertEquals(isCollection, false);
  assertEquals(listItemsKey, undefined);
  // The whole entity is returned, not the array item type.
  assertEquals(responseSchema?.properties?.assistant_id?.type, "string");
  assertEquals(responseSchema?.properties?.name?.type, "string");
});

Deno.test("extractResponseSchema: flat entity -> single, no itemsKey", () => {
  const spec = {
    components: { schemas: {} },
  } as unknown as OpenAPISpec;
  const op: OperationObject = {
    operationId: "GetThread",
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                thread_id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
  const { isCollection, listItemsKey, responseSchema } = extractResponseSchema(
    spec,
    op,
    op.operationId,
  );
  assertEquals(isCollection, false);
  assertEquals(listItemsKey, undefined);
  assertEquals(responseSchema?.properties?.name?.type, "string");
});

Deno.test("extractResponseSchema: create 201 body is found", () => {
  const spec = { components: { schemas: {} } } as unknown as OpenAPISpec;
  const op: OperationObject = {
    operationId: "CreateThread",
    responses: {
      "201": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { thread_id: { type: "string" } },
            },
          },
        },
      },
    },
  };
  const { isCollection, responseSchema } = extractResponseSchema(
    spec,
    op,
    op.operationId,
  );
  assertEquals(isCollection, false);
  assertEquals(responseSchema?.properties?.thread_id?.type, "string");
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function listOp(operationId: string): OperationObject {
  return {
    operationId,
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                items: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
    },
  };
}

function getOp(operationId: string): OperationObject {
  return {
    operationId,
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// skipReason / reportCoverage
// ---------------------------------------------------------------------------

const emptySpec = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: { schemas: {} },
} as unknown as OpenAPISpec;

Deno.test("skipReason: names each reason a matched operation is dropped", () => {
  assertEquals(skipReason(emptySpec, getOp("GetThing")), null);
  assertEquals(
    skipReason(emptySpec, { ...getOp("GetThing"), deprecated: true }),
    "deprecated",
  );
  assertEquals(
    skipReason(emptySpec, {
      ...getOp("StreamEvents"),
      responses: {
        "200": { description: "ok", content: { "text/event-stream": {} } },
      },
    } as unknown as OperationObject),
    "non-JSON response",
  );
  assertEquals(
    skipReason(emptySpec, {
      ...getOp("Upload"),
      requestBody: {
        content: { "multipart/form-data": { schema: { type: "object" } } },
      },
    } as unknown as OperationObject),
    "non-JSON request body",
  );
});

Deno.test("reportCoverage: lists unclaimed families and skipped operations", () => {
  const services: ServiceConfig[] = [
    {
      name: "threads",
      description: "",
      pathPrefixes: ["/api/threads"],
      labels: [],
    },
  ];
  const spec = {
    ...emptySpec,
    paths: {
      "/api/threads": { get: listOp("ListThreads") },
      "/api/threads/{thread_id}": {
        get: { ...getOp("GetThread"), deprecated: true },
      },
      // Unclaimed family: 2 paths, 3 operations.
      "/api/retrievers": { get: listOp("ListRetrievers"), post: getOp("Make") },
      "/api/retrievers/{id}": { get: getOp("GetRetriever") },
      // Path item with no operations must not break the count.
      "/api/empty/{id}": { parameters: [] },
      // Segment boundary: "/api/threadsX" is not "/api/threads".
      "/api/threadsX": { get: getOp("Other") },
    },
  } as unknown as OpenAPISpec;

  const report = reportCoverage(spec, services);

  assertEquals(report.uncovered, [
    { family: "/api/empty", paths: 1, operations: 0 },
    { family: "/api/retrievers", paths: 2, operations: 3 },
    { family: "/api/threadsX", paths: 1, operations: 1 },
  ]);
  assertEquals(report.skipped.map((s) => [s.operationId, s.reason]), [
    ["GetThread", "deprecated"],
  ]);
});

Deno.test("reportCoverage: agrees with groupOperations on what is generated", () => {
  const services: ServiceConfig[] = [
    {
      name: "threads",
      description: "",
      pathPrefixes: ["/api/threads"],
      labels: [],
    },
  ];
  const spec = {
    ...emptySpec,
    paths: {
      "/api/threads": { get: listOp("ListThreads") },
      "/api/threads/{thread_id}": {
        get: { ...getOp("GetThread"), deprecated: true },
        delete: getOp("DeleteThread"),
      },
    },
  } as unknown as OpenAPISpec;

  const generated = groupOperations(spec, services)
    .flatMap((g) => g.operations).length;
  const report = reportCoverage(spec, services);
  // 3 operations total = generated + skipped; none unclaimed.
  assertEquals(generated + report.skipped.length, 3);
  assertEquals(report.uncovered.length, 0);
});
