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

// ---------------------------------------------------------------------------
// withTemplatePlaceholders
//
// The Cloudflare spec does not always declare every {placeholder} present in a
// path template. Code generation reads the template, so an undeclared
// placeholder still becomes an `args.<name>` reference in the generated body,
// while the arguments schema and the args/_args signature decision are derived
// from the declared parameter list. When the two disagree the generated method
// does not compile.
//
// Real case: `get_managed_label` in cloudflare/api-shield, path
// /zones/{zone_id}/api_gateway/labels/managed/{name}, where the spec declares
// no parameter for {name}. It generated `arguments: z.object({})` and
// `execute: async (_args, ...)` with a body referencing `args.name`.
// ---------------------------------------------------------------------------

Deno.test("withTemplatePlaceholders: synthesizes an undeclared placeholder", () => {
  const result = withTemplatePlaceholders(
    "/zones/{zone_id}/api_gateway/labels/managed/{name}",
    [],
    "zone_id",
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "name");
  assertEquals(result[0].in, "path");
  assertEquals(result[0].required, true);
  assertEquals(result[0].schema?.type, "string");
});

Deno.test("withTemplatePlaceholders: never synthesizes the primary scope param", () => {
  // zone_id comes from globalArgs, so it must not become a method argument.
  const result = withTemplatePlaceholders(
    "/zones/{zone_id}/api_gateway/operations",
    [],
    "zone_id",
  );
  assertEquals(result.length, 0);
});

Deno.test("withTemplatePlaceholders: keeps a secondary scope param", () => {
  // An account-scoped service referencing {zone_id} does need it as an argument.
  const result = withTemplatePlaceholders(
    "/accounts/{account_id}/zones/{zone_id}/settings",
    [],
    "account_id",
  );
  assertEquals(result.map((p) => p.name), ["zone_id"]);
});

Deno.test("withTemplatePlaceholders: declared parameters win over synthesized", () => {
  const declared = [{
    name: "name",
    in: "path",
    required: true,
    description: "The label name",
    schema: { type: "string" },
    // deno-lint-ignore no-explicit-any
  }] as any;
  const result = withTemplatePlaceholders(
    "/zones/{zone_id}/api_gateway/labels/managed/{name}",
    declared,
    "zone_id",
  );
  // Not duplicated, and the declared description survives.
  assertEquals(result.length, 1);
  assertEquals(result[0].description, "The label name");
});

Deno.test("withTemplatePlaceholders: handles multiple undeclared placeholders in order", () => {
  const result = withTemplatePlaceholders(
    "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}",
    [],
    "account_id",
  );
  assertEquals(result.map((p) => p.name), ["namespace_id", "key_name"]);
});

Deno.test("withTemplatePlaceholders: a path with no placeholders adds nothing", () => {
  const result = withTemplatePlaceholders(
    "/accounts/x/r2/buckets",
    [],
    "account_id",
  );
  assertEquals(result.length, 0);
});

Deno.test("withTemplatePlaceholders: preserves declared params absent from the template", () => {
  // A declared path param that the template does not mention is still returned
  // rather than silently dropped.
  const declared = [{
    name: "legacy_id",
    in: "path",
    required: true,
    schema: { type: "string" },
    // deno-lint-ignore no-explicit-any
  }] as any;
  const result = withTemplatePlaceholders(
    "/zones/{zone_id}/api_gateway/operations",
    declared,
    "zone_id",
  );
  assertEquals(result.map((p) => p.name), ["legacy_id"]);
});

// ---------------------------------------------------------------------------
// Integration: the placeholder union must be wired into extractOperation.
//
// The unit tests above exercise withTemplatePlaceholders directly, so they pass
// even if extractOperation stops calling it. This test goes through
// groupOperations so removing the call site is caught.
// ---------------------------------------------------------------------------

Deno.test("service_grouper: an undeclared template placeholder reaches pathParams", () => {
  const spec = makeMinimalSpec({
    // {bucket_name} appears in the template but is declared nowhere — the shape
    // that produced uncompilable methods in cloudflare/api-shield.
    "/accounts/{account_id}/r2/buckets/{bucket_name}": {
      get: {
        operationId: "r2-get-bucket",
        summary: "Get bucket",
        tags: ["R2"],
        parameters: [
          { name: "account_id", in: "path", required: true },
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
  assertEquals(groups.length, 1);
  const op = groups[0].operations[0];

  // account_id is the primary scope param and must stay out of method args.
  assertEquals(op.pathParams.map((p) => p.name), ["bucket_name"]);
});

Deno.test("service_grouper: a declared placeholder is not duplicated end to end", () => {
  const spec = makeMinimalSpec({
    "/accounts/{account_id}/r2/buckets/{bucket_name}": {
      get: {
        operationId: "r2-get-bucket",
        summary: "Get bucket",
        tags: ["R2"],
        parameters: [
          { name: "account_id", in: "path", required: true },
          {
            name: "bucket_name",
            in: "path",
            required: true,
            description: "Bucket name",
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

  assertEquals(op.pathParams.length, 1);
  assertEquals(op.pathParams[0].description, "Bucket name");
});
