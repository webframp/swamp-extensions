/**
 * Tests for the method classifier module.
 */

import { assertEquals } from "@std/assert";
import {
  classifyOperation,
  classifyServiceMethods,
  generateMethodName,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { ServiceConfig } from "../config.ts";

function makeOp(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/accounts/{account_id}/r2/buckets",
    operationId: "r2-list-buckets",
    summary: "List buckets",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    deprecated: false,
    tags: ["R2"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyOperation
// ---------------------------------------------------------------------------

Deno.test("method_classifier: GET collection is list", () => {
  const op = makeOp({ httpMethod: "get", isCollection: true });
  assertEquals(classifyOperation(op), "list");
});

Deno.test("method_classifier: GET single is get", () => {
  const op = makeOp({ httpMethod: "get", isCollection: false });
  assertEquals(classifyOperation(op), "get");
});

Deno.test("method_classifier: POST with body and non-param path is create", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/accounts/{account_id}/r2/buckets",
    requestBody: { type: "object", properties: { name: { type: "string" } } },
  });
  assertEquals(classifyOperation(op), "create");
});

Deno.test("method_classifier: POST to param path is action", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/accounts/{account_id}/r2/buckets/{bucket_name}",
  });
  assertEquals(classifyOperation(op), "action");
});

Deno.test("method_classifier: PUT is update", () => {
  const op = makeOp({ httpMethod: "put" });
  assertEquals(classifyOperation(op), "update");
});

Deno.test("method_classifier: PATCH is update", () => {
  const op = makeOp({ httpMethod: "patch" });
  assertEquals(classifyOperation(op), "update");
});

Deno.test("method_classifier: DELETE is delete", () => {
  const op = makeOp({ httpMethod: "delete" });
  assertEquals(classifyOperation(op), "delete");
});

// ---------------------------------------------------------------------------
// generateMethodName
// ---------------------------------------------------------------------------

Deno.test("method_classifier: generates name from operationId", () => {
  const op = makeOp({ operationId: "r2-list-buckets" });
  const name = generateMethodName(op, "list");
  assertEquals(name, "list_buckets");
});

Deno.test("method_classifier: adds verb prefix when no verb found", () => {
  const op = makeOp({ operationId: "r2-buckets" });
  const name = generateMethodName(op, "get");
  // "r2-buckets" has no recognized verb, so type is prepended
  assertEquals(name, "get_r2_buckets");
});

Deno.test("method_classifier: does not duplicate verb prefix", () => {
  const op = makeOp({ operationId: "r2-get-bucket" });
  const name = generateMethodName(op, "get");
  assertEquals(name, "get_bucket");
});

Deno.test("method_classifier: falls back to path segments", () => {
  const op = makeOp({
    operationId: undefined,
    path: "/accounts/{account_id}/r2/buckets/{name}",
  });
  const name = generateMethodName(op, "get");
  assertEquals(name, "get_r2_buckets");
});

// ---------------------------------------------------------------------------
// classifyServiceMethods
// ---------------------------------------------------------------------------

Deno.test("method_classifier: deduplicates methods by name", () => {
  const config: ServiceConfig = {
    name: "r2",
    description: "R2",
    pathPrefixes: ["/accounts/{account_id}/r2"],
    scope: "account",
    labels: ["r2"],
  };

  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({ operationId: "r2-list-buckets", isCollection: true }),
      makeOp({ operationId: "r2-list-buckets", isCollection: true }), // duplicate
      makeOp({ operationId: "r2-get-bucket", isCollection: false }),
    ],
  };

  const methods = classifyServiceMethods(group);
  assertEquals(methods.length, 2);
  assertEquals(methods[0].name, "list_buckets");
  assertEquals(methods[1].name, "get_bucket");
});

Deno.test("method_classifier: classifies all method types correctly", () => {
  const config: ServiceConfig = {
    name: "r2",
    description: "R2",
    pathPrefixes: ["/accounts/{account_id}/r2"],
    scope: "account",
    labels: ["r2"],
  };

  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        operationId: "r2-list-buckets",
        httpMethod: "get",
        isCollection: true,
      }),
      makeOp({
        operationId: "r2-get-bucket",
        httpMethod: "get",
        isCollection: false,
        path: "/accounts/{account_id}/r2/buckets/{name}",
      }),
      makeOp({
        operationId: "r2-create-bucket",
        httpMethod: "post",
        requestBody: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
      makeOp({
        operationId: "r2-update-bucket",
        httpMethod: "put",
        path: "/accounts/{account_id}/r2/buckets/{name}",
      }),
      makeOp({
        operationId: "r2-delete-bucket",
        httpMethod: "delete",
        path: "/accounts/{account_id}/r2/buckets/{name}",
      }),
    ],
  };

  const methods = classifyServiceMethods(group);
  assertEquals(methods.length, 5);
  assertEquals(methods[0].type, "list");
  assertEquals(methods[1].type, "get");
  assertEquals(methods[2].type, "create");
  assertEquals(methods[3].type, "update");
  assertEquals(methods[4].type, "delete");
});
