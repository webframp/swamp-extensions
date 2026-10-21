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
  planSecrets,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import { groupOperations } from "./service_grouper.ts";
import { generateApiLib } from "./extension_generator.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";
import { ZOD_VERSION } from "../config.ts";

// The zod the generated models pin, loaded by its configured version so the
// end-to-end test reads sensitive-field metadata from the registry they use.
const { z } = await import(`npm:zod@${ZOD_VERSION}`);

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

  // No id-like field is declared and no path parameter scopes the call, so
  // the fallback is a hash of the request, never a shared "created" slot.
  assertEquals(src.includes('"created"'), false);
  assertEquals(
    src.includes(
      "sanitizeInstanceName(String(created?.id ?? await shortHash(JSON.stringify(requestKey))))",
    ),
    true,
  );
  assertEquals(src.includes('shortHash } from "./_lib/api.ts"'), true);
});

Deno.test("generateModelSource: a created Turnstile widget is named by its sitekey", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/zones/{zone_id}/api_gateway/widgets",
    operationId: "api-shield-create-widget",
    summary: "Create widget",
    requestBody: { type: "object", properties: { name: { type: "string" } } },
    responseSchema: {
      type: "object",
      properties: { sitekey: { type: "string" }, name: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    } as any,
    // deno-lint-ignore no-explicit-any
  } as any);
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(
    src.includes("String(created?.id ?? created?.sitekey ?? await shortHash("),
    true,
  );
});

Deno.test("generateModelSource: a bare-string create response is named by its path parameter", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/zones/{zone_id}/api_gateway/tunnels/{tunnel_id}/management",
    operationId: "api-shield-create-management-token",
    summary: "Create management token",
    pathParams: [
      {
        name: "zone_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "tunnel_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
    requestBody: {
      type: "object",
      properties: { resources: { type: "array" } },
    },
    responseSchema: { type: "string" },
    responseSecrets: { vaultable: [], leaves: [], wrapRoot: true },
    // deno-lint-ignore no-explicit-any
  } as any);
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(
    src.includes("const id = sanitizeInstanceName(String(args.tunnel_id));"),
    true,
  );
  assertEquals(src.includes("created?."), false);
  assertEquals(src.includes("shortHash"), false);
});

Deno.test("generateModelSource: several scoping path parameters are hashed together", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/zones/{zone_id}/api_gateway/{a}/{b}/token",
    operationId: "api-shield-create-token",
    summary: "Create token",
    pathParams: [
      { name: "a", in: "path", required: true, schema: { type: "string" } },
      { name: "b", in: "path", required: true, schema: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    ] as any,
    requestBody: { type: "object", properties: { name: { type: "string" } } },
    responseSchema: { type: "string" },
    // deno-lint-ignore no-explicit-any
  } as any);
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(
    src.includes(
      "sanitizeInstanceName(await shortHash(JSON.stringify([String(args.a), String(args.b)])))",
    ),
    true,
  );
});

Deno.test("generateModelSource: the request hash leaves secret arguments out", () => {
  const op = makeOp({
    httpMethod: "post",
    path: "/zones/{zone_id}/api_gateway/credentials",
    operationId: "api-shield-create-credential",
    summary: "Create credential",
    requestBody: {
      type: "object",
      properties: { name: { type: "string" }, password: { type: "string" } },
    },
    responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    inputSecrets: ["password"],
    // deno-lint-ignore no-explicit-any
  } as any);
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(
    src.includes('const secretArgs = new Set<string>(["password"]);'),
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

// ---------------------------------------------------------------------------
// Cursor pagination: follow result_info.cursor instead of a single fetch.
// ---------------------------------------------------------------------------

Deno.test("generateModelSource: cursor-paginated list uses cfApiPaginatedCursor, not a hardcoded truncated: false", () => {
  const op = makeOp({
    httpMethod: "get",
    path: "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys",
    operationId: "workers-kv-namespace-list-keys",
    summary: "List a namespace's keys",
    isCollection: true,
    usesCursorPagination: true,
    pathParams: [
      {
        name: "namespace_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
    queryParams: [
      { name: "cursor", in: "query", schema: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });
  const group = makeGroup(op);
  const src = generateModelSource(group, classifyServiceMethods(group), "1");

  assertEquals(
    src.includes("cfApiPaginatedCursor<Record<string, unknown>>"),
    true,
  );
  assertEquals(src.includes("truncated: false,"), false);
  assertEquals(src.includes("import { cfApiPaginatedCursor }"), true);
});

Deno.test("generateModelSource: singleton get/action never write the reserved name 'latest'", () => {
  // swamp rejects the data name "latest"; a singleton instance must be keyed
  // "<resource>-current" instead.
  const group: ServiceGroup = {
    config: {
      name: "demo",
      description: "Demo",
      pathPrefixes: ["/accounts/{account_id}/demo"],
      scope: "account",
      labels: ["cloudflare"],
    },
    operations: [
      makeOp({
        httpMethod: "get",
        path: "/accounts/{account_id}/demo/status",
        operationId: "demo-get-status",
      }),
      makeOp({
        httpMethod: "post",
        path: "/accounts/{account_id}/demo/run",
        operationId: "demo-run",
      }),
    ],
  };
  const src = generateModelSource(group, classifyServiceMethods(group), "1");
  assertEquals(/["']latest["']/.test(src), false);
  assertEquals(
    /writeResource\("[a-z0-9_-]+", "[a-z0-9_-]+-current"/.test(src),
    true,
  );
});

// ---------------------------------------------------------------------------
// Secrets: arguments, returned secrets, and the generated method end to end
// ---------------------------------------------------------------------------

const envelope = (result: unknown) => ({
  "200": {
    content: {
      "application/json": {
        schema: { type: "object", properties: { result } },
      },
    },
  },
});

function secretsSpec(): OpenAPISpec {
  const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  return {
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0" },
    components: {
      schemas: {
        access_client_secret: { type: "string", "x-sensitive": true },
        tunnel_tunnel_token: { type: "string", "x-sensitive": true },
        logpush_destination_conf: { type: "string", "x-sensitive": true },
        turnstile_secret: { type: "string", "x-sensitive": true },
      },
    },
    paths: {
      "/accounts/{account_id}/access/service_tokens": {
        post: {
          operationId: "access-service-tokens-create-a-service-token",
          summary: "Create a service token",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          responses: envelope({
            type: "object",
            properties: {
              id: { type: "string" },
              client_id: { type: "string" },
              client_secret: ref("access_client_secret"),
            },
          }),
        },
      },
      "/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token": {
        get: {
          operationId: "cloudflare-tunnel-get-a-cloudflare-tunnel-token",
          summary: "Get a tunnel token",
          parameters: [{ name: "tunnel_id", in: "path", required: true }],
          responses: envelope(ref("tunnel_tunnel_token")),
        },
      },
      "/accounts/{account_id}/logpush/jobs": {
        get: {
          operationId: "get-accounts-account_id-logpush-jobs",
          summary: "List Logpush jobs",
          responses: envelope({
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                destination_conf: ref("logpush_destination_conf"),
              },
            },
          }),
        },
      },
      "/accounts/{account_id}/r2-catalog/{bucket_name}/credential": {
        post: {
          operationId: "store-credentials",
          summary: "Store catalog credentials",
          parameters: [{ name: "bucket_name", in: "path", required: true }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string" } },
                  required: ["token"],
                },
              },
            },
          },
          responses: envelope({ type: "object", nullable: true }),
        },
      },
      "/accounts/{account_id}/challenges/widgets/{sitekey}/rotate_secret": {
        post: {
          operationId: "accounts-turnstile-widget-rotate-secret",
          summary: "Rotate Secret for a Turnstile Widget",
          parameters: [{ name: "sitekey", in: "path", required: true }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { invalidate_immediately: { type: "boolean" } },
                },
              },
            },
          },
          responses: envelope({
            type: "object",
            properties: {
              sitekey: { type: "string" },
              secret: ref("turnstile_secret"),
            },
          }),
        },
      },
    } as unknown as OpenAPISpec["paths"],
  };
}

const secretsConfig: ServiceConfig = {
  name: "secrets-demo",
  description: "Secret handling demo",
  pathPrefixes: ["/accounts/{account_id}"],
  scope: "account",
  labels: ["cloudflare"],
};

function secretsGroup(): ServiceGroup {
  return groupOperations(secretsSpec(), [secretsConfig])[0];
}

/** Paths swamp's data writer would move into a vault for a resource schema. */
function swampVaultPaths(schema: unknown, prefix: string[] = []): string[] {
  type Def = {
    _def: { type: string; innerType?: Def; shape?: Record<string, Def> };
  };
  const unwrap = (s: Def): Def => {
    let c = s;
    while (["optional", "nullable", "default"].includes(c._def.type)) {
      c = c._def.innerType!;
    }
    return c;
  };
  const marked = (f: Def): boolean => {
    let c: Def | undefined = f;
    while (c) {
      const meta = z.globalRegistry.get(c) as
        | { sensitive?: boolean }
        | undefined;
      if (meta?.sensitive) return true;
      c = ["optional", "nullable", "default"].includes(c._def.type)
        ? c._def.innerType
        : undefined;
    }
    return false;
  };
  const obj = unwrap(schema as Def);
  if (obj._def.type !== "object" || !obj._def.shape) return [];
  const out: string[] = [];
  for (const [k, f] of Object.entries(obj._def.shape)) {
    if (marked(f)) out.push([...prefix, k].join("."));
    else out.push(...swampVaultPaths(f, [...prefix, k]));
  }
  return out;
}

Deno.test("planSecrets: vaults reachable secrets, strips list secrets, wraps a bare token", () => {
  const methods = classifyServiceMethods(secretsGroup());
  const plan = planSecrets(methods);
  const get = (n: string) => plan.methods.get(n)!;
  assertEquals(get("create_a_service_token").vaulted, [["client_secret"]]);
  assertEquals(get("get_a_cloudflare_tunnel_token").wrapRoot, true);
  assertEquals(get("get_accounts_account_id_logpush_jobs").strip, [[
    { each: true },
    { k: "destination_conf" },
  ]]);
  assertEquals(get("create_store_credentials").inputs, ["token"]);
});

Deno.test("generateModelSource: generated methods keep returned secrets out of plaintext storage", async () => {
  const group = secretsGroup();
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.10.21.1");
  const dir = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  try {
    await Deno.mkdir(`${dir}/_lib`);
    await Deno.writeTextFile(`${dir}/_lib/api.ts`, generateApiLib());
    await Deno.writeTextFile(`${dir}/model.ts`, source);
    const { model } = await import(`file://${dir}/model.ts`);

    const results: Record<string, unknown> = {
      "/access/service_tokens": {
        id: "tok-1",
        client_id: "cid",
        client_secret: "CLIENT-SECRET",
      },
      "/token": "TUNNEL-TOKEN",
      "/logpush/jobs": [{ id: 7, destination_conf: "s3://b?secret=DEST" }],
      "/credential": null,
      "/rotate_secret": { sitekey: "sk", secret: "ROTATED-SECRET" },
    };
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      const key = Object.keys(results).find((k) => url.pathname.endsWith(k))!;
      return Promise.resolve(Response.json({
        success: true,
        errors: [],
        messages: [],
        result: results[key],
        result_info: Array.isArray(results[key])
          ? { page: 1, per_page: 50, total_count: 1, total_pages: 1 }
          : undefined,
      }));
    }) as typeof fetch;

    const written: { spec: string; data: Record<string, unknown> }[] = [];
    const context = {
      globalArgs: { apiToken: "t", accountId: "acct" },
      writeResource: (spec: string, instance: string, data: unknown) => {
        written.push({ spec, data: data as Record<string, unknown> });
        return Promise.resolve({ name: instance });
      },
      logger: { info: () => {} },
    };
    const run = async (name: string, args: Record<string, unknown>) => {
      written.length = 0;
      await model.methods[name].execute(args, context);
      const [w] = written;
      // Every spec a method writes must be declared, or swamp rejects it.
      assertEquals(w.spec in model.resources, true, `${name} -> ${w.spec}`);
      return { ...w, vault: swampVaultPaths(model.resources[w.spec].schema) };
    };

    // A minted secret is kept for the vault and declared sensitive.
    const token = await run("create_a_service_token", { name: "ci" });
    assertEquals(token.data.client_secret, "CLIENT-SECRET");
    assertEquals(token.vault, ["client_secret"]);

    // A bare token response is wrapped so it has a field to vault.
    const tunnel = await run("get_a_cloudflare_tunnel_token", {
      tunnel_id: "t1",
    });
    assertEquals(tunnel.data, { value: "TUNNEL-TOKEN" });
    assertEquals(tunnel.vault, ["value"]);

    // Secrets in list items cannot be vaulted, so they are never written.
    const jobs = await run("get_accounts_account_id_logpush_jobs", {});
    assertEquals(JSON.stringify(jobs.data).includes("DEST"), false);
    assertEquals((jobs.data.items as { id: number }[])[0].id, 7);

    // A create-typed method named get_* writes the resource it declares.
    const rotated = await run("get_rotate_secret", { sitekey: "sk" });
    assertEquals(rotated.spec, "rotate_secret");
    assertEquals(rotated.vault, ["secret"]);

    // A secret argument is marked so swamp redacts it.
    const args = model.methods.create_store_credentials.arguments;
    assertEquals(swampVaultPaths(args), ["token"]);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateModelSource: apiToken describe leads with the vault and calls the env var a discouraged fallback", () => {
  const source = generateModelSource(
    secretsGroup(),
    classifyServiceMethods(secretsGroup()),
    "2026.10.21.1",
  );
  assertEquals(
    source.includes('vault.get(\\"cloudflare\\", \\"API_TOKEN\\")'),
    true,
  );
  assertEquals(source.includes("not redacted and is not recommended"), true);
  assertEquals(source.includes("overrides the CLOUDFLARE_API_TOKEN"), false);
});
