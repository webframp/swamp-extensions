/**
 * Tests for the service grouper module.
 */

import { assertEquals } from "@std/assert";
import {
  groupOperations,
  withTemplatePlaceholders,
} from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

const ASSETS: ServiceConfig = {
  name: "assets",
  description: "assets",
  tags: ["Assets"],
  labels: [],
};

const SERVERLESS: ServiceConfig = {
  name: "serverless",
  description: "serverless",
  pathPrefixes: ["/serverless"],
  labels: [],
};

function baseSpec(paths: OpenAPISpec["paths"]): OpenAPISpec {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "v1" },
    paths,
    components: { schemas: {} },
  };
}

Deno.test("groupOperations: matches by tag", () => {
  const spec = baseSpec({
    "/assets": {
      get: {
        operationId: "listAssets",
        tags: ["Assets"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    assets: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [ASSETS]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].config.name, "assets");
  assertEquals(groups[0].operations.length, 1);
});

Deno.test("groupOperations: matches by pathPrefix when tags absent/different", () => {
  const spec = baseSpec({
    "/serverless/apps": {
      get: {
        operationId: "serverlessListApps",
        tags: ["Serverless", "Apps"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apps: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [SERVERLESS]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].config.name, "serverless");
});

Deno.test("groupOperations: union match — a config with both tags and pathPrefixes matches on either", () => {
  const both: ServiceConfig = {
    name: "both",
    description: "d",
    tags: ["Assets"],
    pathPrefixes: ["/serverless"],
    labels: [],
  };
  const spec = baseSpec({
    "/serverless/apps": {
      get: {
        operationId: "serverlessListApps",
        tags: ["Serverless"],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apps: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [both]);
  assertEquals(groups.length, 1);
});

Deno.test("groupOperations: excludePaths wins over a matching pathPrefix", () => {
  const withExclude: ServiceConfig = {
    ...SERVERLESS,
    excludePaths: ["/serverless/apps"],
  };
  const spec = baseSpec({
    "/serverless/apps": {
      get: {
        operationId: "serverlessListApps",
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [withExclude]);
  assertEquals(groups.length, 0);
});

Deno.test("groupOperations: unmatched operations are silently dropped", () => {
  const spec = baseSpec({
    "/keys": {
      get: {
        operationId: "listApiKeys",
        tags: ["Keys"],
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [ASSETS]);
  assertEquals(groups.length, 0);
});

Deno.test("groupOperations: a collection is detected by an array-typed property, not a fixed name", () => {
  const spec = baseSpec({
    "/compute/instances": {
      get: {
        operationId: "listComputeInstances",
        tags: ["Compute"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    next_cursor: { type: ["string", "null"] },
                    has_more: { type: "boolean" },
                    instances: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const compute: ServiceConfig = {
    name: "compute",
    description: "d",
    tags: ["Compute"],
    labels: [],
  };
  const groups = groupOperations(spec, [compute]);
  const op = groups[0].operations[0];
  assertEquals(op.isCollection, true);
  assertEquals(op.responseSchema?.type, "string");
  assertEquals(op.pagination.paginated, true);
  assertEquals(op.pagination.resultsField, "instances");
  assertEquals(op.pagination.hasNextCursor, true);
  assertEquals(op.pagination.hasHasMore, true);
});

Deno.test("groupOperations: skips deprecated operations", () => {
  const spec = baseSpec({
    "/assets": {
      get: {
        operationId: "listAssets",
        tags: ["Assets"],
        deprecated: true,
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [ASSETS]);
  assertEquals(groups.length, 0);
});

Deno.test("groupOperations: skips non-JSON success responses", () => {
  const spec = baseSpec({
    "/assets/{asset_id}/download": {
      get: {
        operationId: "downloadAsset",
        tags: ["Assets"],
        responses: {
          "200": {
            content: {
              "application/octet-stream": { schema: { type: "string" } },
            },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [ASSETS]);
  assertEquals(groups.length, 0);
});

Deno.test("groupOperations: skips non-JSON request bodies", () => {
  const spec = baseSpec({
    "/assets/uploads": {
      post: {
        operationId: "uploadAsset",
        tags: ["Assets"],
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  });
  const groups = groupOperations(spec, [ASSETS]);
  assertEquals(groups.length, 0);
});

Deno.test("withTemplatePlaceholders: unions undeclared path placeholders", () => {
  const result = withTemplatePlaceholders(
    "/workflows/{username}/{workflow_name}",
    [
      {
        name: "username",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
  );
  assertEquals(result.length, 2);
  assertEquals(result.map((p) => p.name).sort(), ["username", "workflow_name"]);
});

Deno.test("withTemplatePlaceholders: declared params are not duplicated", () => {
  const result = withTemplatePlaceholders("/assets/{asset_id}", [
    { name: "asset_id", in: "path", required: true, description: "d" },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].description, "d");
});
