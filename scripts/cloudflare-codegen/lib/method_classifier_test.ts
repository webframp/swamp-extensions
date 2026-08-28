/**
 * Tests for the method classifier module.
 */

import { assertEquals } from "@std/assert";
import {
  bodyReferencesArgs,
  classifyOperation,
  classifyServiceMethods,
  generateMethodName,
  generateModelSource,
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
    usesCursorPagination: false,
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

// ---------------------------------------------------------------------------
// bodyReferencesArgs
//
// The execute parameter used to be named by predicting whether the body would
// reference `args` (methodUsesArgs), which could disagree with the body actually
// generated. It is now derived from the generated body instead, so this is the
// gate that keeps the signature and the body in agreement.
// ---------------------------------------------------------------------------

Deno.test("bodyReferencesArgs: detects a path interpolation", () => {
  assertEquals(
    bodyReferencesArgs([
      "      `/zones/${zoneId}/api_gateway/labels/managed/${args.name}`,",
    ]),
    true,
  );
});

Deno.test("bodyReferencesArgs: detects a bare reference", () => {
  assertEquals(
    bodyReferencesArgs(["      for (const [k, v] of Object.entries(args)) {"]),
    true,
  );
});

Deno.test("bodyReferencesArgs: a body with no args reference is false", () => {
  assertEquals(
    bodyReferencesArgs([
      "      const { apiToken, zoneId } = context.globalArgs;",
      '      const result = await cfApi(apiToken, "GET", `/zones/${zoneId}/settings`);',
    ]),
    false,
  );
});

Deno.test("bodyReferencesArgs: context.globalArgs alone does not count", () => {
  // `globalArgs` ends in "Args" and is preceded by a dot — must not match.
  assertEquals(
    bodyReferencesArgs(["      const { apiToken } = context.globalArgs;"]),
    false,
  );
});

Deno.test("bodyReferencesArgs: an already-underscored param does not count", () => {
  assertEquals(bodyReferencesArgs(["      // _args is unused here"]), false);
});

Deno.test("bodyReferencesArgs: a longer identifier containing args does not count", () => {
  assertEquals(
    bodyReferencesArgs(["      const argsSchema = z.object({});"]),
    false,
  );
  assertEquals(bodyReferencesArgs(["      const myargs = 1;"]), false);
});

Deno.test("bodyReferencesArgs: a comment mentioning args does not count", () => {
  // A comment says nothing about whether the code uses the parameter; naming it
  // `args` on that basis would produce a misleading signature.
  assertEquals(
    bodyReferencesArgs(["      // args is supplied via context"]),
    false,
  );
  assertEquals(
    bodyReferencesArgs([
      "      const { apiToken } = context.globalArgs; // args unused here",
    ]),
    false,
  );
});

Deno.test("bodyReferencesArgs: code wins over a comment on the same line", () => {
  assertEquals(
    bodyReferencesArgs(["      const id = args.id; // uses args"]),
    true,
  );
});

// ---------------------------------------------------------------------------
// Round trip: generateModelSource -> body generation -> parameter naming.
//
// bodyReferencesArgs and withTemplatePlaceholders are each covered in isolation,
// but the composition is what this fix actually delivers: an undeclared path
// placeholder must produce BOTH a populated arguments schema and an `args`
// parameter. A regression in the wiring between them would be invisible to the
// isolated tests.
// ---------------------------------------------------------------------------

function makeGroup(op: GroupedOperation): ServiceGroup {
  const config: ServiceConfig = {
    name: "api-shield",
    description: "API Shield",
    pathPrefixes: ["/zones/{zone_id}/api_gateway"],
    scope: "zone",
    labels: ["cloudflare"],
  };
  return { config, operations: [op] };
}

Deno.test("generateModelSource: undeclared placeholder yields args, not _args", () => {
  // The real api-shield shape: {name} is in the template, declared nowhere, so
  // withTemplatePlaceholders synthesizes it. The body then interpolates
  // args.name and the signature must be named `args`.
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/labels/managed/{name}",
    operationId: "api-shield-get-managed-label",
    summary: "Retrieve managed label",
    pathParams: [
      { name: "name", in: "path", required: true, schema: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(src.includes("${args.name}"), true);
  assertEquals(src.includes("_args: Record<string, unknown>"), false);
  assertEquals(src.includes("args: Record<string, unknown>"), true);
  // The argument must also be declared, or the method is uncallable.
  assertEquals(/name:\s*z\.string\(\)/.test(src), true);
});

Deno.test("generateModelSource: a body with no args reference yields _args", () => {
  // No path params beyond the primary scope and no request body, so nothing
  // references args — the parameter must stay underscored to satisfy lint.
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/configuration",
    operationId: "api-shield-get-configuration",
    summary: "Retrieve configuration",
    pathParams: [],
    queryParams: [],
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(src.includes("_args: Record<string, unknown>"), true);
});

Deno.test("generateModelSource: derives args from the body, not from pathParams", () => {
  // This is the case that distinguishes deriving the parameter name from
  // predicting it. pathParams is EMPTY while the path template still carries a
  // {placeholder}, so buildApiPath emits `args.name` regardless. Any predictor
  // keyed on pathParams answers "_args" and the method does not compile.
  //
  // withTemplatePlaceholders normally prevents this state from reaching the
  // classifier, so this test guards the second line of defense: if that union
  // is ever bypassed or regressed, the signature still matches the body.
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/labels/managed/{name}",
    operationId: "api-shield-get-managed-label",
    summary: "Retrieve managed label",
    pathParams: [],
    queryParams: [],
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(src.includes("${args.name}"), true);
  assertEquals(src.includes("_args: Record<string, unknown>"), false);
});

// ---------------------------------------------------------------------------
// Reference-inspired hardening: instance-name sanitization + output passthrough.
// ---------------------------------------------------------------------------

Deno.test("generateModelSource: get-by-id sanitizes the instance name and imports the helper", () => {
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/operations/{operation_id}",
    operationId: "api-shield-get-operation",
    summary: "Retrieve operation",
    pathParams: [
      {
        name: "operation_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  // The instance name derives from an API-influenced arg, so it must be routed
  // through sanitizeInstanceName, and the helper must be imported.
  assertEquals(
    src.includes("sanitizeInstanceName(String(args.operation_id))"),
    true,
  );
  assertEquals(src.includes("import { cfApi, sanitizeInstanceName }"), true);
});

Deno.test("generateModelSource: created resource id is sanitized", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/zones/{zone_id}/api_gateway/user_schemas",
    operationId: "api-shield-create-user-schema",
    summary: "Create user schema",
    requestBody: { type: "object", properties: { name: { type: "string" } } },
    // deno-lint-ignore no-explicit-any
  } as any);
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(
    src.includes(
      'sanitizeInstanceName(String((result as { id?: unknown }).id ?? "created"))',
    ),
    true,
  );
});

Deno.test("generateModelSource: list output item schema gets .passthrough()", () => {
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/operations",
    operationId: "api-shield-list-operations",
    summary: "List operations",
    isCollection: true,
    responseSchema: {
      type: "object",
      properties: { id: { type: "string" }, method: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    } as any,
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  // The item schema is a top-level object, so it must carry .passthrough() so
  // unknown API fields survive validation.
  assertEquals(src.includes("}).passthrough()"), true);
});

Deno.test("generateModelSource: nullable object schema gets passthrough before nullable", () => {
  // A nullable object response must emit z.object({...}).passthrough().nullable(),
  // never z.object({...}).nullable().passthrough() — ZodNullable has no
  // .passthrough() and the latter fails to type-check.
  const op = makeOp({
    httpMethod: "get",
    path: "/zones/{zone_id}/api_gateway/settings/{setting_id}",
    operationId: "api-shield-get-setting",
    summary: "Retrieve setting",
    pathParams: [
      {
        name: "setting_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
    responseSchema: {
      type: "object",
      nullable: true,
      properties: { enabled: { type: "boolean" } },
      // deno-lint-ignore no-explicit-any
    } as any,
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(src.includes(".passthrough().nullable()"), true);
  assertEquals(src.includes(".nullable().passthrough()"), false);
});
