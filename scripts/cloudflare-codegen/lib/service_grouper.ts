/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Takes the raw OpenAPI spec and the service registry config, then produces
 * a grouped intermediate representation: one ServiceGroup per extension,
 * containing all operations that belong to that service.
 */

import type {
  OpenAPISpec,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from "./schema_fetcher.ts";
import { resolveSchema } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

/** A single API operation grouped into a service */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete) */
  httpMethod: string;
  /** Full path (e.g., /accounts/{account_id}/r2/buckets/{bucket_name}) */
  path: string;
  /** OpenAPI operationId */
  operationId: string;
  /** Human-readable summary */
  summary: string;
  /** Full description */
  description: string;
  /** Path parameters (excluding scope params like account_id, zone_id) */
  pathParams: ParameterObject[];
  /** Query parameters */
  queryParams: ParameterObject[];
  /** Resolved request body schema (if POST/PUT/PATCH) */
  requestBody?: SchemaObject;
  /** Resolved success response schema (the `result` field) */
  responseSchema?: SchemaObject;
  /** Whether the response is a collection (array) or single item */
  isCollection: boolean;
  /** Whether this endpoint uses cursor-based pagination (not page-based) */
  usesCursorPagination: boolean;
  /** Whether this endpoint is deprecated */
  deprecated: boolean;
  /** Tags from the OpenAPI spec */
  tags: string[];
}

/** A complete service group ready for code generation */
export interface ServiceGroup {
  config: ServiceConfig;
  operations: GroupedOperation[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Scope parameters that become globalArgs, not method args */
// Note: only the PRIMARY scope param is stripped; secondary scope params
// (e.g., zone_id in an account-scoped service) become method arguments.

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

    // Find which service this path belongs to
    const service = findService(path, pathItem, services);
    if (!service) continue;

    const group = groups.get(service.name)!;

    // Path-level parameters
    const pathLevelParams = (pathItem.parameters ?? []) as ParameterObject[];

    // Determine which scope param is primary for this service
    const primaryScopeParam = service.scope === "account"
      ? "account_id"
      : "zone_id";

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
        primaryScopeParam,
      );
      if (grouped) {
        group.operations.push(grouped);
      }
    }
  }

  // Filter out services with no operations
  return Array.from(groups.values()).filter((g) => g.operations.length > 0);
}

/** Determine which service a path belongs to */
function findService(
  path: string,
  pathItem: Record<string, unknown>,
  services: ServiceConfig[],
): ServiceConfig | null {
  for (const service of services) {
    // Check exclusions first
    if (service.excludePaths?.some((ex) => path.startsWith(ex))) {
      continue;
    }

    // Check path prefix match
    if (service.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
      return service;
    }

    // Check tag match as fallback
    if (service.tags) {
      for (const method of HTTP_METHODS) {
        const op = pathItem[method] as OperationObject | undefined;
        if (op?.tags?.some((t) => service.tags!.includes(t))) {
          return service;
        }
      }
    }
  }
  return null;
}

/**
 * Union path-template placeholders into the spec-declared path parameters.
 *
 * Two sources describe a path parameter: the OpenAPI `parameters` list, and the
 * `{placeholder}` tokens in the path template itself. Code generation reads the
 * template, so any placeholder absent from `parameters` still becomes an
 * `args.<name>` reference in the generated body — while the arguments schema and
 * the `args`/`_args` signature decision are both derived from `parameters`.
 * When they disagree the generated method does not compile.
 *
 * Declared parameters win on conflict, so their schema and description survive.
 * Synthesized ones are required strings, matching how a path segment behaves.
 *
 * Only the PRIMARY scope param is skipped. Secondary scope params are
 * deliberately kept, because buildApiPath() in method_classifier.ts emits
 * `${args.account_id}` / `${args.zone_id}` for them — they are method arguments,
 * not globalArgs. Changing this to skip both scope params would reintroduce the
 * exact signature/body mismatch this function exists to prevent.
 *
 * Exported for direct unit testing.
 */
export function withTemplatePlaceholders(
  path: string,
  declared: ParameterObject[],
  primaryScopeParam: string,
): ParameterObject[] {
  const seen = new Set(declared.map((p) => p.name));
  const result = [...declared];

  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    // The primary scope param comes from globalArgs, never from method args.
    if (name === primaryScopeParam) continue;
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

/** Extract a single operation into our intermediate form */
function extractOperation(
  spec: OpenAPISpec,
  httpMethod: string,
  path: string,
  operation: OperationObject,
  pathLevelParams: ParameterObject[],
  primaryScopeParam: string,
): GroupedOperation | null {
  // Skip deprecated by default (can be made configurable)
  if (operation.deprecated) return null;

  // Skip endpoints whose success response is non-JSON (binary, streaming, raw text).
  // These require hand-written implementations that handle raw bytes.
  if (hasNonJsonSuccessResponse(operation)) return null;

  // Skip endpoints whose request body is exclusively non-JSON (multipart/form-data,
  // octet-stream). These require hand-written implementations with FormData or
  // raw byte handling that cfApi's JSON serialization cannot support.
  if (hasNonJsonRequestBody(operation)) return null;

  const allParams = [
    ...pathLevelParams,
    ...(operation.parameters ?? []),
  ] as ParameterObject[];

  // Only strip the PRIMARY scope param — secondary scope params become method args
  const declaredPathParams = allParams.filter(
    (p) => p.in === "path" && p.name !== primaryScopeParam,
  );
  // The Cloudflare spec does not always declare every `{placeholder}` that
  // appears in a path template. Code generation reads the template directly
  // (buildApiPath regexes it and emits `args.<name>`), so a placeholder missing
  // from `parameters` produced a method whose body referenced an argument that
  // was neither in the signature nor in the arguments schema — a type error and
  // an unusable method. Union the template placeholders in so both sources of
  // truth agree.
  const pathParams = withTemplatePlaceholders(
    path,
    declaredPathParams,
    primaryScopeParam,
  );
  const queryParams = allParams.filter((p) => p.in === "query");

  // Extract request body schema
  let requestBody: SchemaObject | undefined;
  if (operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content["application/json"];
    if (jsonContent?.schema) {
      requestBody = resolveSchema(spec, jsonContent.schema);
    }
  }

  // Extract response schema — look for 200/201/2xx success responses
  const { responseSchema, isCollection } = extractResponseSchema(
    spec,
    operation,
  );

  const operationId = operation.operationId ??
    `${httpMethod}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;

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
    usesCursorPagination: queryParams.some((p) => p.name === "cursor"),
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

/** Extract the success response schema and determine if it's a collection */
function extractResponseSchema(
  spec: OpenAPISpec,
  operation: OperationObject,
): { responseSchema?: SchemaObject; isCollection: boolean } {
  if (!operation.responses) return { isCollection: false };

  // Try 200, 201, then any 2xx
  const successCodes = ["200", "201"];
  let responseObj: Record<string, { schema?: SchemaObject }> | undefined;

  for (const code of successCodes) {
    const resp = operation.responses[code] as
      | { content?: Record<string, { schema?: SchemaObject }> }
      | undefined;
    if (resp?.content?.["application/json"]) {
      responseObj = resp.content;
      break;
    }
  }

  if (!responseObj?.["application/json"]?.schema) {
    return { isCollection: false };
  }

  const fullResponseSchema = resolveSchema(
    spec,
    responseObj["application/json"].schema,
  );

  // The CF API wraps responses in an envelope. The actual data is in `result`.
  // Check if this is a collection (api-response-collection) or single (api-response-common).
  // Heuristic: if the result type is array, it's a collection.
  let responseSchema: SchemaObject | undefined;
  let isCollection = false;

  if (fullResponseSchema.properties?.result) {
    const resultSchema = resolveSchema(
      spec,
      fullResponseSchema.properties.result,
    );
    if (resultSchema.type === "array" && resultSchema.items) {
      responseSchema = resolveSchema(spec, resultSchema.items);
      isCollection = true;
    } else {
      responseSchema = resultSchema;
    }
  } else {
    // Some schemas use allOf to compose the envelope — try to extract result
    responseSchema = fullResponseSchema;
  }

  return { responseSchema, isCollection };
}

/**
 * Detect if an operation's success response uses a non-JSON content type.
 * These endpoints return raw bytes (octet-stream, images, PDFs, etc.)
 * or streaming responses (text/event-stream) that don't fit the standard
 * Cloudflare JSON envelope pattern and require hand-written implementations.
 */
function hasNonJsonSuccessResponse(operation: OperationObject): boolean {
  if (!operation.responses) return false;

  for (const code of ["200", "201"]) {
    const resp = operation.responses[code] as
      | { content?: Record<string, unknown> }
      | undefined;
    if (!resp?.content) continue;

    const contentTypes = Object.keys(resp.content);
    // If the ONLY success content type is non-JSON, skip this endpoint.
    // If it has both JSON and non-JSON (e.g., Workers AI with json + event-stream),
    // keep it — the JSON path is the standard one.
    const hasJson = contentTypes.some((t) => t.includes("json"));
    if (!hasJson) return true;
  }

  return false;
}

/**
 * Detect if an operation's request body is exclusively non-JSON.
 * Endpoints requiring multipart/form-data (file uploads, Workers script content)
 * or application/octet-stream cannot be served by cfApi's JSON serialization.
 * If the request body has BOTH JSON and non-JSON content types, the JSON path
 * is usable and the endpoint is kept.
 */
function hasNonJsonRequestBody(operation: OperationObject): boolean {
  if (!operation.requestBody?.content) return false;

  const contentTypes = Object.keys(operation.requestBody.content);
  if (contentTypes.length === 0) return false;

  const hasJson = contentTypes.some((t) => t.includes("json"));
  return !hasJson;
}
