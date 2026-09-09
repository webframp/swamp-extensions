/**
 * Tests for the method classifier module.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  bodyReferencesArgs,
  classifyOperation,
  classifyServiceMethods,
  generateMethodName,
  generateModelSource,
} from "./method_classifier.ts";
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
  assertStringIncludes(source, "falApi<Record<string, unknown>>");
  assertStringIncludes(source, '["apps"]');
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
