/**
 * Tests for the test generator module.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFinalTestArgs,
  extractPathPattern,
  generateTestSource,
  PATH_PARAM_TEST_VALUE,
} from "./test_generator.ts";
import { classifyServiceMethods } from "./method_classifier.ts";
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
  labels: [],
};

Deno.test("extractPathPattern: replaces path params with the fixed test value", () => {
  assertEquals(
    extractPathPattern("/assets/collections/{collection_id}/assets"),
    `/assets/collections/${PATH_PARAM_TEST_VALUE}/assets`,
  );
});

Deno.test("extractPathPattern: no scope prefix to strip (unlike cloudflare)", () => {
  assertEquals(
    extractPathPattern("/compute/instances/{id}"),
    `/compute/instances/${PATH_PARAM_TEST_VALUE}`,
  );
});

Deno.test("buildFinalTestArgs: path params win over a same-named fixture field", () => {
  const method = classifyServiceMethods({
    config: CONFIG,
    operations: [
      op({
        operationId: "getAssetCollection",
        path: "/assets/collections/{collection_id}",
        pathParams: [{
          name: "collection_id",
          in: "path",
          required: true,
          schema: { type: "string" },
        }],
      }),
    ],
  })[0];
  const args = buildFinalTestArgs(method, {
    collection_id: "from-fixture",
    name: "x",
  });
  assertEquals(args.collection_id, PATH_PARAM_TEST_VALUE);
  assertEquals(args.name, "x");
});

Deno.test("generateTestSource: mock server body is bare JSON (no envelope), nested under resultsField for list", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "listAssets",
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
  const source = generateTestSource(CONFIG, methods, "assets");

  assertStringIncludes(source, `"@webframp/falai/assets"`);
  assertStringIncludes(source, "startMockFalServer");
  assertStringIncludes(source, `{ "assets": [`);
  // No {success, result, result_info} envelope anywhere in the mock.
  assertEquals(source.includes("result_info"), false);
  assertEquals(source.includes('"success": true'), false);
});

Deno.test("generateTestSource: delete mock uses the fal.ai error shape on 404", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "deleteAssetCollection",
        httpMethod: "delete",
        path: "/assets/collections/{collection_id}",
        pathParams: [{
          name: "collection_id",
          in: "path",
          required: true,
          schema: { type: "string" },
        }],
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const source = generateTestSource(CONFIG, methods, "assets");
  assertStringIncludes(
    source,
    '{ error: { type: "not_found", message: "Not found" } }',
  );
});

Deno.test("generateTestSource: emits a vault-storage test for methods with sensitive response fields", () => {
  const keysConfig: ServiceConfig = {
    name: "keys",
    description: "fal.ai API Keys",
    tags: ["API Keys"],
    labels: [],
  };
  const group: ServiceGroup = {
    config: keysConfig,
    operations: [
      op({
        operationId: "createApiKey",
        httpMethod: "post",
        path: "/keys",
        requestBody: {
          type: "object",
          properties: { alias: { type: "string" } },
        },
        responseSchema: {
          type: "object",
          properties: {
            key_id: { type: "string" },
            key_secret: { type: "string" },
            key: { type: "string" },
          },
        },
      }),
    ],
  };
  const source = generateTestSource(
    keysConfig,
    classifyServiceMethods(group),
    "keys",
  );
  assertStringIncludes(
    source,
    "create_api_key marks key, key_secret sensitive so swamp stores them in a vault",
  );
  assertStringIncludes(source, '"plaintext-secret-key_secret"');
  assertStringIncludes(source, 'assertEquals(marked, ["key","key_secret"]);');
  assertStringIncludes(source, "schema.parse(persisted);");
});

Deno.test("generateTestSource: no vault-storage test for services without sensitive fields", () => {
  const group: ServiceGroup = { config: CONFIG, operations: [op({})] };
  const source = generateTestSource(
    CONFIG,
    classifyServiceMethods(group),
    "assets",
  );
  assertEquals(source.includes("stores them in a vault"), false);
});
