/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Takes the raw Griptape OpenAPI spec and the service registry, then produces
 * one ServiceGroup per extension containing all operations that belong to it.
 *
 * Griptape differences from the Cloudflare grouper:
 * - Single API scope (no account_id/zone_id to strip). Every path param is a
 *   method argument.
 * - Request bodies and responses are $ref-ed to `*RequestContent` /
 *   `*ResponseContent` component schemas — resolved here.
 * - List responses have no fixed `result`/`items` key: each `List*ResponseContent`
 *   carries a resource-named array property (`threads`, `structures`, `logs`)
 *   plus a `pagination` object. We detect and record that array key
 *   (`listItemsKey`) so the method body reads the right field at runtime.
 */

import type {
  OpenAPISpec,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  SchemaObject,
} from "./schema_fetcher.ts";
import { resolveRef, resolveSchema } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

/** A single API operation grouped into a service. */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete). */
  httpMethod: string;
  /** Full path (e.g., /api/threads/{thread_id}). */
  path: string;
  /** OpenAPI operationId (PascalCase, e.g., CreateThread). */
  operationId: string;
  /** Human-readable summary. */
  summary: string;
  /** Full description. */
  description: string;
  /** Path parameters (all of them — Griptape has no scope param to strip). */
  pathParams: ParameterObject[];
  /** Query parameters. */
  queryParams: ParameterObject[];
  /** Resolved request body schema (if POST/PUT/PATCH). */
  requestBody?: SchemaObject;
  /**
   * Resolved success response schema. For list operations this is the ITEM
   * schema (the element type of the resource-named array). For single-resource
   * operations it is the entity schema itself.
   */
  responseSchema?: SchemaObject;
  /** Whether the response is a collection (list). */
  isCollection: boolean;
  /**
   * For list operations, the property name of the array in the response
   * wrapper (e.g., "threads"). Undefined for non-list operations.
   */
  listItemsKey?: string;
  /** Whether this endpoint is deprecated. */
  deprecated: boolean;
  /** Tags from the OpenAPI spec. */
  tags: string[];
}

/** A complete service group ready for code generation. */
export interface ServiceGroup {
  config: ServiceConfig;
  operations: GroupedOperation[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Group all operations in the spec into their service groups.
 * Operations that don't match any configured service are silently dropped.
 */
export function groupOperations(
  spec: OpenAPISpec,
  services: ServiceConfig[],
): ServiceGroup[] {
  const groups: Map<string, ServiceGroup> = new Map();
  for (const config of services) {
    groups.set(config.name, { config, operations: [] });
  }

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;

    const service = findService(path, services);
    if (!service) continue;

    const group = groups.get(service.name)!;
    const pathLevelParams = (pathItem.parameters ?? []) as ParameterObject[];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation) continue;
      if (
        typeof operation !== "object" ||
        !("responses" in operation || "tags" in operation)
      ) continue;

      const grouped = extractOperation(
        spec,
        method,
        path,
        operation,
        pathLevelParams,
      );
      if (grouped) group.operations.push(grouped);
    }
  }

  return Array.from(groups.values()).filter((g) => g.operations.length > 0);
}

/** Determine which service a path belongs to (longest prefix wins). */
function findService(
  path: string,
  services: ServiceConfig[],
): ServiceConfig | null {
  let best: { service: ServiceConfig; prefixLen: number } | null = null;

  for (const service of services) {
    if (service.excludePaths?.some((ex) => path.startsWith(ex))) continue;

    for (const prefix of service.pathPrefixes) {
      // Match a prefix only at a path-segment boundary: "/api/rules" must not
      // swallow "/api/rulesets". Either an exact match or the prefix followed
      // by "/".
      if (path === prefix || path.startsWith(prefix + "/")) {
        if (!best || prefix.length > best.prefixLen) {
          best = { service, prefixLen: prefix.length };
        }
      }
    }
  }

  return best?.service ?? null;
}

/**
 * Union path-template placeholders into the spec-declared path parameters.
 *
 * Code generation reads the path template directly, so any `{placeholder}`
 * absent from the declared `parameters` still becomes an `args.<name>`
 * reference. Synthesizing the missing ones keeps the arguments schema, the
 * `args`/`_args` signature decision, and the generated body in agreement.
 *
 * Exported for direct unit testing.
 */
export function withTemplatePlaceholders(
  path: string,
  declared: ParameterObject[],
): ParameterObject[] {
  const seen = new Set(declared.map((p) => p.name));
  const result = [...declared];

  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    } as ParameterObject);
  }

  return result;
}

/** Extract a single operation into our intermediate form. */
function extractOperation(
  spec: OpenAPISpec,
  httpMethod: string,
  path: string,
  operation: OperationObject,
  pathLevelParams: ParameterObject[],
): GroupedOperation | null {
  if (operation.deprecated) return null;

  // Skip endpoints whose success response is non-JSON (SSE event streams,
  // binary asset downloads). These need hand-written implementations.
  if (hasNonJsonSuccessResponse(operation)) return null;

  // Resolve a $ref on the requestBody itself before content-type checks.
  if (operation.requestBody) {
    const rawRb = operation.requestBody as unknown as Record<string, unknown>;
    if (typeof rawRb.$ref === "string") {
      operation = {
        ...operation,
        requestBody: resolveRef(
          spec,
          rawRb.$ref,
        ) as unknown as RequestBodyObject,
      };
    }
  }

  // Skip endpoints whose request body is exclusively non-JSON (multipart,
  // octet-stream). cfApi-style JSON serialization cannot express these.
  if (hasNonJsonRequestBody(operation)) return null;

  const declaredParams = [
    ...pathLevelParams,
    ...(operation.parameters ?? []),
  ] as ParameterObject[];

  const declaredPathParams = declaredParams.filter((p) => p.in === "path");
  const pathParams = withTemplatePlaceholders(path, declaredPathParams);
  const queryParams = declaredParams.filter((p) => p.in === "query");

  // Request body schema (application/json), $ref resolved.
  let requestBody: SchemaObject | undefined;
  if (operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content["application/json"];
    if (jsonContent?.schema) {
      requestBody = resolveSchema(spec, jsonContent.schema);
    }
  }

  const operationId = operation.operationId ??
    `${httpMethod}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;

  const { responseSchema, isCollection, listItemsKey } = extractResponseSchema(
    spec,
    operation,
    operationId,
  );

  return {
    httpMethod,
    path,
    operationId,
    summary: operation.summary ?? "",
    description: operation.description ?? "",
    pathParams,
    queryParams,
    requestBody,
    responseSchema,
    isCollection,
    listItemsKey,
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

/**
 * Extract the success response schema and classify it.
 *
 * List detection keys off the operationId's `List` prefix — the authoritative,
 * 100%-consistent signal in the Griptape spec — NOT off "the wrapper has an
 * array property". Single-entity responses inline the entity flat and routinely
 * carry array-typed fields (e.g. GetAssistant embeds `knowledge_base_ids: []`
 * and `retriever_ids: []`); treating the first array property as the collection
 * would misclassify those GETs as paginated lists over an id-list field and
 * discard the entity. So:
 *   - List* operation: find the resource-named array property; return its ITEM
 *     schema and record the property name as `listItemsKey`.
 *   - Everything else: the wrapper IS the entity; return it as-is.
 *
 * A response with no JSON body (e.g., 204 delete) yields no schema.
 */
export function extractResponseSchema(
  spec: OpenAPISpec,
  operation: OperationObject,
  operationId?: string,
): {
  responseSchema?: SchemaObject;
  isCollection: boolean;
  listItemsKey?: string;
} {
  if (!operation.responses) return { isCollection: false };

  // Griptape creates return 201; reads/updates return 200. Try both, then 2xx.
  const successCodes = ["200", "201", "202"];
  let schemaRef: SchemaObject | undefined;

  for (const code of successCodes) {
    const resp = operation.responses[code];
    const jsonSchema = resp?.content?.["application/json"]?.schema;
    if (jsonSchema) {
      schemaRef = jsonSchema;
      break;
    }
  }

  if (!schemaRef) return { isCollection: false };

  const wrapper = resolveSchema(spec, schemaRef);

  // A List* operation returns a collection wrapper. Find the array property
  // (the resource-named collection; the sibling is `pagination`, or for log
  // endpoints the array is the only property). Only List* operations take this
  // path — see the doc comment for why "has an array property" is unsafe.
  const id = operationId ?? operation.operationId ?? "";
  const isListOp = /^List/.test(id);

  if (isListOp && wrapper.properties) {
    for (const [key, prop] of Object.entries(wrapper.properties)) {
      if (key === "pagination") continue;
      const resolved = resolveSchema(spec, prop);
      if (resolved.type === "array" && resolved.items) {
        const itemSchema = resolveSchema(spec, resolved.items);
        return {
          responseSchema: itemSchema,
          isCollection: true,
          listItemsKey: key,
        };
      }
    }
  }

  // Single entity: the wrapper is the resource.
  return { responseSchema: wrapper, isCollection: false };
}

/**
 * Detect if an operation's success response is exclusively non-JSON.
 * Griptape's `.../events/stream` endpoints serve text/event-stream (SSE);
 * asset downloads serve binary. If a response has both JSON and non-JSON
 * content types, the JSON path is usable and the endpoint is kept.
 */
function hasNonJsonSuccessResponse(operation: OperationObject): boolean {
  if (!operation.responses) return false;

  for (const code of ["200", "201", "202"]) {
    const resp = operation.responses[code] as
      | { content?: Record<string, unknown> }
      | undefined;
    if (!resp?.content) continue;
    const contentTypes = Object.keys(resp.content);
    const hasJson = contentTypes.some((t) => t.includes("json"));
    if (!hasJson) return true;
  }

  return false;
}

/** Detect if an operation's request body is exclusively non-JSON. */
function hasNonJsonRequestBody(operation: OperationObject): boolean {
  if (!operation.requestBody?.content) return false;
  const contentTypes = Object.keys(operation.requestBody.content);
  if (contentTypes.length === 0) return false;
  const hasJson = contentTypes.some((t) => t.includes("json"));
  return !hasJson;
}
