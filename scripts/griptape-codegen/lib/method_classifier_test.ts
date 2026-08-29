/**
 * Tests for the Griptape method classifier module.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  bodyReferencesArgs,
  buildApiPath,
  classifyOperation,
  classifyServiceMethods,
  entityIdCandidates,
  generateMethodName,
  generateModelSource,
  resourceNameFor,
  splitOperationId,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { ServiceConfig } from "../config.ts";

function makeOp(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/api/threads",
    operationId: "ListThreads",
    summary: "List threads",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// splitOperationId
// ---------------------------------------------------------------------------

Deno.test("splitOperationId: simple PascalCase", () => {
  assertEquals(splitOperationId("CreateThread"), ["create", "thread"]);
});

Deno.test("splitOperationId: multi-word", () => {
  assertEquals(splitOperationId("ListThreadMessages"), [
    "list",
    "thread",
    "messages",
  ]);
  assertEquals(splitOperationId("CancelAssistantRun"), [
    "cancel",
    "assistant",
    "run",
  ]);
});

Deno.test("splitOperationId: acronym run", () => {
  assertEquals(splitOperationId("CreateOrganizationApiKey"), [
    "create",
    "organization",
    "api",
    "key",
  ]);
});

// ---------------------------------------------------------------------------
// classifyOperation
// ---------------------------------------------------------------------------

Deno.test("classifyOperation: GET collection is list", () => {
  assertEquals(
    classifyOperation(makeOp({ httpMethod: "get", isCollection: true })),
    "list",
  );
});

Deno.test("classifyOperation: GET single is get", () => {
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "get", operationId: "GetThread" }),
    ),
    "get",
  );
});

Deno.test("classifyOperation: POST Create* is create", () => {
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "post", operationId: "CreateThread" }),
    ),
    "create",
  );
});

Deno.test("classifyOperation: run/query/cancel/refresh verbs are action", () => {
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "post", operationId: "CancelStructureRun" }),
    ),
    "action",
  );
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "post", operationId: "QueryKnowledgeBase" }),
    ),
    "action",
  );
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "post", operationId: "SearchKnowledgeBase" }),
    ),
    "action",
  );
});

Deno.test("classifyOperation: PUT/PATCH is update, DELETE is delete", () => {
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "patch", operationId: "UpdateThread" }),
    ),
    "update",
  );
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "put", operationId: "UpdateThread" }),
    ),
    "update",
  );
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "delete", operationId: "DeleteThread" }),
    ),
    "delete",
  );
});

Deno.test("classifyOperation: PUT named Create* is a create (SaveBucketAsset)", () => {
  // CreateAsset = PUT /api/buckets/{bucket_id}/assets creates/replaces a named
  // resource, so it must classify as create (keyed on the entity id/name), not
  // update (which would key on the parent bucket_id path param).
  assertEquals(
    classifyOperation(
      makeOp({ httpMethod: "put", operationId: "CreateAsset" }),
    ),
    "create",
  );
});

// ---------------------------------------------------------------------------
// generateMethodName
// ---------------------------------------------------------------------------

Deno.test("generateMethodName: verb-led ids keep their verb", () => {
  assertEquals(
    generateMethodName(makeOp({ operationId: "CreateThread" }), "create"),
    "create_thread",
  );
  assertEquals(
    generateMethodName(
      makeOp({ operationId: "ListThreadMessages", isCollection: true }),
      "list",
    ),
    "list_thread_messages",
  );
  assertEquals(
    generateMethodName(
      makeOp({ operationId: "CancelAssistantRun", httpMethod: "post" }),
      "action",
    ),
    "cancel_assistant_run",
  );
});

// ---------------------------------------------------------------------------
// entityIdCandidates — derived from the resource, never the parent path param
// ---------------------------------------------------------------------------

Deno.test("entityIdCandidates: top-level create derives <resource>_id", () => {
  const method = {
    name: "create_thread",
    type: "create" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/threads",
      operationId: "CreateThread",
    }),
  };
  assertEquals(entityIdCandidates(method), ["thread_id", "id"]);
});

Deno.test("entityIdCandidates: nested create excludes the parent path param", () => {
  // POST /api/threads/{thread_id}/messages — path does NOT end in a param, so
  // the parent thread_id is not a candidate; the child id (message_id) leads.
  const method = {
    name: "create_message",
    type: "create" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/threads/{thread_id}/messages",
      operationId: "CreateMessage",
      pathParams: [
        { name: "thread_id", in: "path", required: true } as never,
      ],
    }),
  };
  assertEquals(entityIdCandidates(method), ["message_id", "id"]);
});

Deno.test("entityIdCandidates: organization_id is never a candidate", () => {
  const method = {
    name: "create_thing",
    type: "create" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/things/{organization_id}",
      operationId: "CreateThing",
      pathParams: [
        { name: "organization_id", in: "path", required: true } as never,
      ],
    }),
  };
  const candidates = entityIdCandidates(method);
  assertEquals(candidates.includes("organization_id"), false);
});

// ---------------------------------------------------------------------------
// buildApiPath
// ---------------------------------------------------------------------------

Deno.test("buildApiPath: substitutes and percent-encodes every path param", () => {
  assertEquals(
    buildApiPath("/api/threads/{thread_id}/messages"),
    "/api/threads/${encodeURIComponent(String(args.thread_id))}/messages",
  );
  assertEquals(
    buildApiPath("/api/tools/{tool_id}/activities/{activity_path}"),
    "/api/tools/${encodeURIComponent(String(args.tool_id))}/activities/${encodeURIComponent(String(args.activity_path))}",
  );
});

// ---------------------------------------------------------------------------
// bodyReferencesArgs
// ---------------------------------------------------------------------------

Deno.test("bodyReferencesArgs: detects args, ignores _args and comments", () => {
  assertEquals(bodyReferencesArgs(["const x = args.thread_id;"]), true);
  assertEquals(
    bodyReferencesArgs(["// mentions args in a comment only"]),
    false,
  );
  assertEquals(
    bodyReferencesArgs(["const { apiKey } = context.globalArgs;"]),
    false,
  );
});

// ---------------------------------------------------------------------------
// generateModelSource — smoke test on a small hand-built group
// ---------------------------------------------------------------------------

Deno.test("resourceNameFor: query/search actions get a distinct sub-resource name", () => {
  // query_knowledge_base must NOT collapse to knowledge_base (the parent entity
  // slot) — it returns a distinct result, named knowledge_base_query.
  const query = {
    name: "query_knowledge_base",
    type: "action" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/knowledge-bases/{knowledge_base_id}/query",
      operationId: "QueryKnowledgeBase",
    }),
  };
  assertEquals(resourceNameFor(query), "knowledge_base_query");

  const search = {
    name: "search_knowledge_base",
    type: "action" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/knowledge-bases/{knowledge_base_id}/search",
      operationId: "SearchKnowledgeBase",
    }),
  };
  assertEquals(resourceNameFor(search), "knowledge_base_search");

  // cancel acts on the existing entity and returns it — verb stripped, no append.
  const cancel = {
    name: "cancel_structure_run",
    type: "action" as const,
    description: "",
    operation: makeOp({
      httpMethod: "post",
      path: "/api/structure-runs/{structure_run_id}/cancel",
      operationId: "CancelStructureRun",
    }),
  };
  assertEquals(resourceNameFor(cancel), "structure_run");
});

Deno.test("generateModelSource: scoped list keys instance on the scope param, not 'main'", () => {
  // list_messages under a thread must key on thread_id, or a second thread's
  // messages overwrite the first under a shared "messages"/"main" instance.
  const config: ServiceConfig = {
    name: "threads",
    description: "Griptape Cloud Threads",
    pathPrefixes: ["/api/threads"],
    labels: ["griptape", "threads"],
  };
  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        httpMethod: "get",
        path: "/api/threads/{thread_id}/messages",
        operationId: "ListMessages",
        isCollection: true,
        listItemsKey: "messages",
        pathParams: [
          { name: "thread_id", in: "path", required: true } as never,
        ],
        responseSchema: {
          type: "object",
          properties: { message_id: { type: "string" } },
        },
      }),
      makeOp({
        httpMethod: "get",
        path: "/api/threads",
        operationId: "ListThreads",
        isCollection: true,
        listItemsKey: "threads",
        responseSchema: {
          type: "object",
          properties: { thread_id: { type: "string" } },
        },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const src = generateModelSource(group, methods, "2026.01.01.1");
  // Scoped list keys on the scope param.
  assertStringIncludes(
    src,
    `context.writeResource("messages", sanitizeInstanceName(String(args.thread_id))`,
  );
  // Top-level list still uses the constant "main".
  assertStringIncludes(src, `context.writeResource("threads", "main"`);
});

Deno.test("generateModelSource: action guards against a 204 undefined result", () => {
  // cancel_* returns 204 with no body; griptapeApi yields undefined. The body
  // must not call writeResource(..., undefined) — it should return no handles.
  const config: ServiceConfig = {
    name: "structures",
    description: "Griptape Cloud Structures",
    pathPrefixes: ["/api/structures"],
    labels: ["griptape", "structures"],
  };
  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        httpMethod: "post",
        path: "/api/structure-runs/{structure_run_id}/cancel",
        operationId: "CancelStructureRun",
        pathParams: [
          { name: "structure_run_id", in: "path", required: true } as never,
        ],
        responseSchema: { type: "object", properties: {} },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  assertEquals(methods[0].type, "action");
  const src = generateModelSource(group, methods, "2026.01.01.1");
  assertStringIncludes(src, "if (result === undefined || result === null)");
});

Deno.test("generateModelSource: action with a path param keys instance on it, not 'latest'", () => {
  // InvokeStructureWebhookPost = POST /api/structures/{structure_id}/webhook.
  // Distinct structures must not collide onto one "latest" instance.
  const config: ServiceConfig = {
    name: "structures",
    description: "Griptape Cloud Structures",
    pathPrefixes: ["/api/structures"],
    labels: ["griptape", "structures"],
  };
  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        httpMethod: "post",
        path: "/api/structures/{structure_id}/webhook",
        operationId: "InvokeStructureWebhookPost",
        pathParams: [
          { name: "structure_id", in: "path", required: true } as never,
        ],
        responseSchema: { type: "object", properties: {} },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  assertEquals(methods[0].type, "action");
  const src = generateModelSource(group, methods, "2026.01.01.1");
  assertStringIncludes(
    src,
    "sanitizeInstanceName(String(args.structure_id))",
  );
});

Deno.test("generateModelSource: get keys instance on last URL segment param, not last declared", () => {
  // GetAsset declares params [name, bucket_id] but the URL is
  // /api/buckets/{bucket_id}/assets/{name} — the resource key is `name`.
  const config: ServiceConfig = {
    name: "buckets",
    description: "Griptape Cloud Buckets",
    pathPrefixes: ["/api/buckets"],
    labels: ["griptape", "buckets"],
  };
  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        httpMethod: "get",
        path: "/api/buckets/{bucket_id}/assets/{name}",
        operationId: "GetAsset",
        pathParams: [
          { name: "name", in: "path", required: true } as never,
          { name: "bucket_id", in: "path", required: true } as never,
        ],
        responseSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const src = generateModelSource(group, methods, "2026.01.01.1");
  // The instance name must be derived from args.name (last URL segment), never
  // args.bucket_id (the parent), which would collide every asset in a bucket.
  assertStringIncludes(src, "sanitizeInstanceName(String(args.name))");
});

Deno.test("generateModelSource: emits a well-formed model", () => {
  const config: ServiceConfig = {
    name: "threads",
    description: "Griptape Cloud Threads",
    pathPrefixes: ["/api/threads"],
    labels: ["griptape", "threads"],
  };
  const group: ServiceGroup = {
    config,
    operations: [
      makeOp({
        httpMethod: "get",
        path: "/api/threads",
        operationId: "ListThreads",
        isCollection: true,
        listItemsKey: "threads",
        responseSchema: {
          type: "object",
          properties: { thread_id: { type: "string" } },
        },
      }),
      makeOp({
        httpMethod: "post",
        path: "/api/threads",
        operationId: "CreateThread",
        requestBody: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        responseSchema: {
          type: "object",
          properties: { thread_id: { type: "string" } },
        },
      }),
    ],
  };

  const methods = classifyServiceMethods(group);
  assertEquals(methods.map((m) => m.name), ["list_threads", "create_thread"]);

  const src = generateModelSource(group, methods, "2026.01.01.1");
  assertStringIncludes(src, `type: "@webframp/griptape/threads"`);
  assertStringIncludes(src, `version: "2026.01.01.1"`);
  assertStringIncludes(src, "griptapeApiPaginated");
  assertStringIncludes(src, `"threads",`); // itemsKey passed to paginator
  assertStringIncludes(src, `const idCandidates = ["thread_id","id"]`); // create key resolution
});
