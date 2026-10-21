/**
 * Tests for the method classifier module.
 */

import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertSensitiveOperationsExist,
  bodyReferencesArgs,
  classifyOperation,
  classifyServiceMethods,
  generateMethodName,
  generateModelSource,
  sensitiveFieldsForResource,
} from "./method_classifier.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { ServiceConfig } from "../config.ts";

function op(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/assets",
    operationId: "listAssets",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    pagination: { paginated: false, hasNextCursor: false, hasHasMore: false },
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

const CONFIG: ServiceConfig = {
  name: "assets",
  description: "fal.ai Assets",
  tags: ["Assets"],
  labels: ["falai", "assets"],
};

// ---------------------------------------------------------------------------
// classifyOperation
// ---------------------------------------------------------------------------

Deno.test("classifyOperation: GET collection -> list", () => {
  assertEquals(
    classifyOperation(op({ httpMethod: "get", isCollection: true })),
    "list",
  );
});

Deno.test("classifyOperation: GET single -> get", () => {
  assertEquals(
    classifyOperation(
      op({
        httpMethod: "get",
        isCollection: false,
        path: "/assets/{asset_id}",
      }),
    ),
    "get",
  );
});

Deno.test("classifyOperation: POST with object body properties -> create", () => {
  assertEquals(
    classifyOperation(
      op({
        httpMethod: "post",
        path: "/assets/collections",
        requestBody: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
    ),
    "create",
  );
});

Deno.test("classifyOperation: POST ending in a path param -> action", () => {
  assertEquals(
    classifyOperation(
      op({
        httpMethod: "post",
        path: "/assets/collections/{collection_id}/favorite",
      }),
    ),
    "action",
  );
});

Deno.test("classifyOperation: PATCH -> update", () => {
  assertEquals(classifyOperation(op({ httpMethod: "patch" })), "update");
});

Deno.test("classifyOperation: DELETE -> delete", () => {
  assertEquals(classifyOperation(op({ httpMethod: "delete" })), "delete");
});

// ---------------------------------------------------------------------------
// generateMethodName
// ---------------------------------------------------------------------------

Deno.test("generateMethodName: camelCase operationId converts to snake_case verb-first name", () => {
  assertEquals(
    generateMethodName(op({ operationId: "listAssets" }), "list"),
    "list_assets",
  );
  assertEquals(
    generateMethodName(op({ operationId: "createComputeInstance" }), "create"),
    "create_compute_instance",
  );
});

Deno.test("generateMethodName: strips a leading service prefix ahead of the verb", () => {
  assertEquals(
    generateMethodName(op({ operationId: "serverlessListApps" }), "list"),
    "list_apps",
  );
  assertEquals(
    generateMethodName(op({ operationId: "serverlessGetAppQueueInfo" }), "get"),
    "get_app_queue_info",
  );
});

Deno.test("generateMethodName: no verb detected on an action prefixes nothing extra", () => {
  const name = generateMethodName(op({ operationId: "getMeta" }), "get");
  assertEquals(name, "get_meta");
});

// ---------------------------------------------------------------------------
// classifyServiceMethods (dedup)
// ---------------------------------------------------------------------------

Deno.test("classifyServiceMethods: de-duplicates by method name, first wins", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "listAssets",
        httpMethod: "get",
        isCollection: true,
        summary: "first",
      }),
      op({
        operationId: "listAssets",
        httpMethod: "get",
        isCollection: true,
        summary: "second",
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  assertEquals(methods.length, 1);
  assertEquals(methods[0].description, "first");
});

// ---------------------------------------------------------------------------
// bodyReferencesArgs
// ---------------------------------------------------------------------------

Deno.test("bodyReferencesArgs: true when body references args.foo", () => {
  assertEquals(bodyReferencesArgs(["const x = args.foo;"]), true);
});

Deno.test("bodyReferencesArgs: false for _args or unrelated identifiers", () => {
  assertEquals(bodyReferencesArgs(["const x = _args.foo;"]), false);
  assertEquals(bodyReferencesArgs(["const myargs = 1;"]), false);
});

Deno.test("bodyReferencesArgs: ignores mentions inside line comments", () => {
  assertEquals(bodyReferencesArgs(["// uses args.foo"]), false);
});

// ---------------------------------------------------------------------------
// generateModelSource — end-to-end shape checks
// ---------------------------------------------------------------------------

Deno.test("generateModelSource: emits falai model type and apiToken-only globalArgs", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "listAssets",
        httpMethod: "get",
        isCollection: true,
        pagination: {
          paginated: true,
          resultsField: "assets",
          hasNextCursor: false,
          hasHasMore: false,
        },
        queryParams: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responseSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");

  assertStringIncludes(source, `type: "@webframp/falai/assets"`);
  assertStringIncludes(source, "GlobalArgsSchema = z.object({");
  assertStringIncludes(source, "apiToken: z.string()");
  // No account/zone scoping should ever appear.
  assertEquals(source.includes("accountId"), false);
  assertEquals(source.includes("zoneId"), false);
  assertStringIncludes(source, "falApiPaginated");
  assertStringIncludes(source, '"assets"');
  assertMatch(source, /version: "2026\.01\.01\.1"/);
});

Deno.test("generateModelSource: unpaginated list uses falApi with the detected results field", () => {
  const group: ServiceGroup = {
    config: {
      name: "serverless",
      description: "d",
      pathPrefixes: ["/serverless"],
      labels: [],
    },
    operations: [
      op({
        operationId: "serverlessListApps",
        path: "/serverless/apps",
        httpMethod: "get",
        isCollection: true,
        pagination: {
          paginated: false,
          resultsField: "apps",
          hasNextCursor: false,
          hasHasMore: false,
        },
        responseSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");
  assertStringIncludes(source, "falApiData<Record<string, unknown>>");
  assertStringIncludes(source, '["apps"]');
});

Deno.test("generateModelSource: data-returning methods use falApiData, delete/action use falApi, imports match", () => {
  const group: ServiceGroup = {
    config: {
      name: "serverless",
      description: "d",
      pathPrefixes: ["/serverless"],
      labels: [],
    },
    operations: [
      op({
        operationId: "getThing",
        path: "/serverless/things/{id}",
        pathParams: [{
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        }],
      }),
    ],
  };
  const getOnly = generateModelSource(
    group,
    classifyServiceMethods(group),
    "2026.01.01.1",
  );
  assertStringIncludes(getOnly, "import { falApiData,");
  assertEquals(getOnly.includes("import { falApi,"), false);
  assertEquals(getOnly.includes("await falApi<"), false);

  const withDelete: ServiceGroup = {
    ...group,
    operations: [
      ...group.operations,
      op({
        operationId: "deleteThing",
        httpMethod: "delete",
        path: "/serverless/things/{id}",
        pathParams: [{
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        }],
      }),
    ],
  };
  const both = generateModelSource(
    withDelete,
    classifyServiceMethods(withDelete),
    "2026.01.01.1",
  );
  assertStringIncludes(both, "import { falApi, falApiData,");
});

Deno.test("generateModelSource: create method sanitizes the returned id into the instance name", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "createAssetCollection",
        httpMethod: "post",
        path: "/assets/collections",
        requestBody: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        responseSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");
  assertStringIncludes(source, "sanitizeInstanceName");
  assertStringIncludes(source, "POST");
});

Deno.test("generateModelSource: singleton get/action never write the reserved name 'latest'", () => {
  // swamp rejects the data name "latest"; a singleton instance must be keyed
  // "<resource>-current" instead.
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({ httpMethod: "get", path: "/status", operationId: "getStatus" }),
      op({ httpMethod: "post", path: "/run", operationId: "runThing" }),
    ],
  };
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(/["']latest["']/.test(src), false);
  assertEquals(
    /writeResource\("[a-z0-9_-]+", "[a-z0-9_-]+-current"/.test(src),
    true,
  );
});

Deno.test("generateModelSource: action resources keep API fields and are keyed by path param", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        httpMethod: "post",
        path: "/keys/{key_id}/revoke",
        operationId: "revokeKey",
        pathParams: [{ name: "key_id", in: "path", required: true }],
      }),
    ],
  };
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  // An empty strict z.object({}) would strip every field the API returns.
  assertStringIncludes(src, "schema: z.object({}).passthrough()");
  // A fixed "-current" instance would overwrite each prior action's record.
  assertStringIncludes(
    src,
    "sanitizeInstanceName(String(args.key_id))",
  );
  assertEquals(/revoke[a-z_]*-current/.test(src), false);
});

// ---------------------------------------------------------------------------
// Sensitive response fields (fal.ai createApiKey one-time secret)
// ---------------------------------------------------------------------------

const KEYS_CONFIG: ServiceConfig = {
  name: "keys",
  description: "fal.ai API Keys",
  tags: ["API Keys"],
  labels: ["falai", "keys"],
};

function createApiKeyOp(
  properties: Record<string, { type: string }> = {
    key_id: { type: "string" },
    key_secret: { type: "string" },
    key: { type: "string" },
  },
): GroupedOperation {
  return op({
    operationId: "createApiKey",
    httpMethod: "post",
    path: "/keys",
    requestBody: {
      type: "object",
      properties: { alias: { type: "string" } },
      required: ["alias"],
    },
    responseSchema: { type: "object", properties },
  });
}

function keysModel(operation: GroupedOperation): string {
  const group: ServiceGroup = { config: KEYS_CONFIG, operations: [operation] };
  return generateModelSource(
    group,
    classifyServiceMethods(group),
    "2026.01.01.1",
  );
}

Deno.test("generateModelSource: createApiKey secrets are marked sensitive in the resource schema, not dropped", () => {
  const source = keysModel(createApiKeyOp());
  assertMatch(
    source,
    /key_secret: z\.string\(\)\.meta\(\{ sensitive: true \}\)\.optional\(\),/,
  );
  assertMatch(
    source,
    /\bkey: z\.string\(\)\.meta\(\{ sensitive: true \}\)\.optional\(\),/,
  );
  assertMatch(source, /key_id: z\.string\(\)\.optional\(\),/);
  // The full response is handed to swamp, which vaults the marked fields.
  assertEquals(source.includes("delete stored"), false);
  assertStringIncludes(
    source,
    'context.writeResource("api_key", id, result)',
  );
});

Deno.test("sensitiveFieldsForResource: fails when a configured field is not declared in the spec", () => {
  const operation = createApiKeyOp({ key_id: { type: "string" } });
  const group: ServiceGroup = { config: KEYS_CONFIG, operations: [operation] };
  const [method] = classifyServiceMethods(group);
  assertThrows(
    () => sensitiveFieldsForResource(method, [method]),
    Error,
    "key_secret, key are not declared",
  );
});

Deno.test("sensitiveFieldsForResource: fails when the operation has no response schema", () => {
  const operation = { ...createApiKeyOp(), responseSchema: undefined };
  const group: ServiceGroup = { config: KEYS_CONFIG, operations: [operation] };
  const [method] = classifyServiceMethods(group);
  assertThrows(
    () => sensitiveFieldsForResource(method, [method]),
    Error,
    "no response schema",
  );
});

Deno.test("sensitiveFieldsForResource: empty for operations with no configured secrets", () => {
  const group: ServiceGroup = { config: CONFIG, operations: [op({})] };
  const [method] = classifyServiceMethods(group);
  assertEquals(sensitiveFieldsForResource(method, [method]), []);
});

Deno.test("assertSensitiveOperationsExist: fails when a configured operationId is missing from the spec", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/keys": { get: { operationId: "listApiKeys" } } },
    components: { schemas: {} },
  } as OpenAPISpec;
  assertThrows(
    () => assertSensitiveOperationsExist(spec),
    Error,
    "createApiKey",
  );
  spec.paths["/keys"].post = { operationId: "createApiKey" };
  assertSensitiveOperationsExist(spec);
});
