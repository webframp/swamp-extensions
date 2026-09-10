/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Takes the raw OpenAPI spec and the service registry config, then produces
 * a grouped intermediate representation: one ServiceGroup per extension,
 * containing all operations that belong to that service.
 *
 * Unlike the Cloudflare/Snyk codegens, fal.ai paths carry no account/zone/org
 * scope segment, so there is no primary-scope-param stripping here — every
 * path parameter in the spec becomes a method argument.
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
import { detectPagination, type PaginationInfo } from "./pagination.ts";

/** A single API operation grouped into a service */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete) */
  httpMethod: string;
  /** Full path (e.g., /compute/instances/{id}) */
  path: string;
  /** OpenAPI operationId */
  operationId: string;
  /** Human-readable summary */
  summary: string;
  /** Full description */
  description: string;
  /** Path parameters */
  pathParams: ParameterObject[];
  /** Query parameters */
  queryParams: ParameterObject[];
  /** Resolved request body schema (if POST/PUT/PATCH) */
  requestBody?: SchemaObject;
  /**
   * Resolved success response schema. For a collection response this is the
   * ITEM schema (the array's `items`), matching cloudflare-codegen's
   * convention — the list wrapper (`items`/`truncated`/...) is generated
   * separately in method_classifier.ts.
   */
  responseSchema?: SchemaObject;
  /** Whether the response is a collection (array) or single item */
  isCollection: boolean;
  /** Pagination shape detected for this operation */
  pagination: PaginationInfo;
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

    const pathLevelParams = (pathItem.parameters ?? []) as ParameterObject[];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation) continue;
      if (
        typeof operation !== "object" ||
        !("responses" in operation || "tags" in operation)
      ) continue;

      const service = findService(path, operation, services);
      if (!service) continue;

      const group = groups.get(service.name)!;
      const grouped = extractOperation(
        spec,
        method,
        path,
        operation,
        pathLevelParams,
      );
      if (grouped) {
        group.operations.push(grouped);
      }
    }
  }

  // Filter out services with no operations
  return Array.from(groups.values()).filter((g) => g.operations.length > 0);
}

/**
 * Determine which service an operation belongs to. A path matches a service
 * when it matches EITHER `pathPrefixes` OR `tags` (union) — both fields may
 * be present on a ServiceConfig, in which case either is sufficient.
 */
function findService(
  path: string,
  operation: OperationObject,
  services: ServiceConfig[],
): ServiceConfig | null {
  for (const service of services) {
    if (service.excludePaths?.some((ex) => path.startsWith(ex))) {
      continue;
    }

    if (service.pathPrefixes?.some((prefix) => path.startsWith(prefix))) {
      return service;
    }

    if (service.tags?.some((t) => operation.tags?.includes(t))) {
      return service;
    }
  }
  return null;
}

/**
 * Union path-template placeholders into the spec-declared path parameters.
 * See cloudflare-codegen's withTemplatePlaceholders for the rationale — code
 * generation reads the path template directly, so a placeholder the spec
 * never declares in `parameters` still needs a matching `args.<name>`
 * argument in the generated arguments schema.
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

/** Extract a single operation into our intermediate form */
function extractOperation(
  spec: OpenAPISpec,
  httpMethod: string,
  path: string,
  operation: OperationObject,
  pathLevelParams: ParameterObject[],
): GroupedOperation | null {
  if (operation.deprecated) return null;

  // Skip endpoints whose success response is non-JSON (binary, streaming, raw
  // text, e.g. serverlessDownloadFile / serverlessLogsStream). These require
  // hand-written implementations that handle raw bytes or SSE.
  if (hasNonJsonSuccessResponse(operation)) return null;

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

  // Skip endpoints whose request body is exclusively non-JSON (multipart
  // uploads, raw octet-stream). falApi's JSON serialization can't support these.
  if (hasNonJsonRequestBody(operation)) return null;

  const allParams = [
    ...pathLevelParams,
    ...(operation.parameters ?? []),
  ] as ParameterObject[];

  const declaredPathParams = allParams.filter((p) => p.in === "path");
  const pathParams = withTemplatePlaceholders(path, declaredPathParams);
  const queryParams = allParams.filter((p) => p.in === "query");

  let requestBody: SchemaObject | undefined;
  if (operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content["application/json"];
    if (jsonContent?.schema) {
      requestBody = resolveSchema(spec, jsonContent.schema);
    }
  }

  const { responseSchema, isCollection, fullResponseSchema } =
    extractResponseSchema(spec, operation);

  const pagination = detectPagination(queryParams, fullResponseSchema);

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
    pagination,
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

/**
 * Extract the success response schema. fal.ai responses are bare JSON
 * objects (no {success, result} envelope), so the "result" IS the full
 * response body. A collection is detected by finding a top-level array
 * property (see pagination.ts's detectResultsField) — when found, the
 * grouped operation's `responseSchema` becomes that array's item schema, and
 * the full object schema is returned alongside for pagination field
 * detection (next_cursor/has_more live as siblings of the array, not inside it).
 */
function extractResponseSchema(
  spec: OpenAPISpec,
  operation: OperationObject,
): {
  responseSchema?: SchemaObject;
  isCollection: boolean;
  fullResponseSchema?: SchemaObject;
} {
  if (!operation.responses) return { isCollection: false };

  const successCodes = ["200", "201"];
  let schema: SchemaObject | undefined;

  for (const code of successCodes) {
    const resp = operation.responses[code];
    const jsonSchema = resp?.content?.["application/json"]?.schema;
    if (jsonSchema) {
      schema = jsonSchema;
      break;
    }
  }

  if (!schema) return { isCollection: false };

  const fullResponseSchema = resolveSchema(spec, schema);

  for (const [, prop] of Object.entries(fullResponseSchema.properties ?? {})) {
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (type === "array" && prop.items) {
      return {
        responseSchema: resolveSchema(spec, prop.items),
        isCollection: true,
        fullResponseSchema,
      };
    }
  }

  return {
    responseSchema: fullResponseSchema,
    isCollection: false,
    fullResponseSchema,
  };
}

/** Detect if an operation's success response uses a non-JSON content type. */
function hasNonJsonSuccessResponse(operation: OperationObject): boolean {
  if (!operation.responses) return false;

  for (const code of ["200", "201"]) {
    const resp = operation.responses[code];
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
