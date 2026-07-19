/**
 * Tests for the service grouper module.
 */

import { assertEquals } from "@std/assert";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

function makeMinimalSpec(paths: Record<string, unknown>): OpenAPISpec {
  return {
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0" },
    paths: paths as OpenAPISpec["paths"],
    components: { schemas: {} },
  };
}

const testService: ServiceConfig = {
  name: "r2",
  description: "R2 storage",
  pathPrefixes: ["/accounts/{account_id}/r2"],
  scope: "account",
  labels: ["cloudflare", "r2"],
};

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

Deno.test("service_grouper: groups operations by path prefix", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets": {
      get: {
        operationId: "r2-list-buckets",
        summary: "List buckets",
        tags: ["R2"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    result: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { name: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/accounts/{account_id}/r2/buckets/{bucket_name}": {
      get: {
        operationId: "r2-get-bucket",
        summary: "Get bucket",
        tags: ["R2"],
        parameters: [
          {
            name: "bucket_name",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    result: {
                      type: "object",
                      properties: { name: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].config.name, "r2");
  assertEquals(groups[0].operations.length, 2);
});

Deno.test("service_grouper: excludes paths matching excludePaths", () => {
  const service: ServiceConfig = {
    name: "workers-scripts",
    description: "Workers",
    pathPrefixes: ["/accounts/{account_id}/workers/scripts"],
    excludePaths: ["/accounts/{account_id}/workers/scripts/excluded"],
    scope: "account",
    labels: ["workers"],
  };

  const spec = makeMinimalSpec({
    "/accounts/{account_id}/workers/scripts": {
      get: {
        operationId: "list-scripts",
        summary: "List",
        tags: ["Workers"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    result: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/accounts/{account_id}/workers/scripts/excluded": {
      get: {
        operationId: "excluded-op",
        summary: "Excluded",
        tags: ["Workers"],
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [service]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].operations.length, 1);
  assertEquals(groups[0].operations[0].operationId, "list-scripts");
});

Deno.test("service_grouper: skips deprecated operations", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets": {
      get: {
        operationId: "r2-list-buckets",
        summary: "List buckets",
        deprecated: true,
        tags: ["R2"],
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  assertEquals(groups.length, 0); // No operations → filtered out
});

Deno.test("service_grouper: returns empty for unmatched paths", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/other/thing": {
      get: {
        operationId: "other-list",
        summary: "Other",
        tags: ["Other"],
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  assertEquals(groups.length, 0);
});

// ---------------------------------------------------------------------------
// Response schema extraction
// ---------------------------------------------------------------------------

Deno.test("service_grouper: detects collection responses", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets": {
      get: {
        operationId: "r2-list-buckets",
        summary: "List",
        tags: ["R2"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    result: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          created: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  assertEquals(groups[0].operations[0].isCollection, true);
});

Deno.test("service_grouper: detects single item responses", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets/{name}": {
      get: {
        operationId: "r2-get-bucket",
        summary: "Get",
        tags: ["R2"],
        parameters: [{
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
        }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    result: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        created: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  assertEquals(groups[0].operations[0].isCollection, false);
});

// ---------------------------------------------------------------------------
// Parameter handling
// ---------------------------------------------------------------------------

Deno.test("service_grouper: separates scope params from method params", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets/{bucket_name}": {
      parameters: [
        {
          name: "account_id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        operationId: "r2-get-bucket",
        summary: "Get",
        tags: ["R2"],
        parameters: [
          {
            name: "bucket_name",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { result: { type: "object" } },
                },
              },
            },
          },
        },
      },
    },
  });

  const groups = groupOperations(spec, [testService]);
  const op = groups[0].operations[0];
  // account_id should be excluded (it's a scope param)
  assertEquals(op.pathParams.length, 1);
  assertEquals(op.pathParams[0].name, "bucket_name");
});
