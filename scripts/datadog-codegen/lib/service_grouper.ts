/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Groups by tag (Datadog's natural categorization), with support for
 * path-prefix splitting (e.g., Security Monitoring → rules/signals/suppressions).
 *
 * Key differences from Snyk codegen:
 * - Groups by tag, not path prefix
 * - Supports pathPrefixes filter within a tag
 * - Hybrid JSON:API detection (some DD endpoints are JSON:API, some aren't)
 * - Pagination detection per-endpoint via lib/pagination.ts
 */

import type {
  OpenAPISpec,
  OperationObject,
  ParameterObject,
  RefObject,
  ResponseObject,
  SchemaObject,
} from "./schema_fetcher.ts";
import { resolveParamRef, resolveSchema } from "./schema_fetcher.ts";
import type { PaginationConfig, ServiceConfig } from "../config.ts";
import {
  ALL_PAGINATION_PARAMS,
  detectPagination,
  resolveParamsForPagination,
} from "./pagination.ts";

/** A single API operation grouped into a service */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete) */
  httpMethod: string;
  /** Full path (e.g., /api/v2/monitors/{monitor_id}) */
  path: string;
  /** OpenAPI operationId */
  operationId: string;
  /** Human-readable summary */
  summary: string;
  /** Full description */
  description: string;
  /** Path parameters */
  pathParams: ParameterObject[];
  /** Query parameters (excluding pagination params) */
  queryParams: ParameterObject[];
  /** Resolved request body schema */
  requestBody?: SchemaObject;
  /** Whether the request body uses JSON:API envelope ({data: {type, attributes}}) */
  requestBodyIsJsonApi: boolean;
  /** The JSON:API type value for request bodies (e.g., "team", "downtime") */
  requestBodyType?: string;
  /** Whether the request body is a raw array (e.g., POST /v2/logs) */
  requestBodyIsArray: boolean;
  /** Resolved success response schema */
  responseSchema?: SchemaObject;
  /** Whether the response is a collection (array in data) */
  isCollection: boolean;
  /** Whether this endpoint uses JSON:API format ({data, meta}) */
  isJsonApi: boolean;
  /** Pagination configuration detected for this endpoint */
  pagination: PaginationConfig;
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
 * Operations that don't match any configured service tag are silently dropped.
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

    // Skip unstable APIs
    if (path.startsWith("/api/unstable/")) continue;

    // Path-level parameters
    const pathLevelParams = resolveParams(
      spec,
      pathItem.parameters as (ParameterObject | RefObject)[] ?? [],
    );

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation) continue;
      if (
        typeof operation !== "object" ||
        !("responses" in operation || "tags" in operation)
      ) continue;

      // Skip deprecated and x-unstable (unless service allows unstable)
      if (operation.deprecated) continue;

      const tags = operation.tags ?? [];

      if (operation["x-unstable"]) {
        // Check if the matched service allows unstable
        const matchedService = findService(path, tags, services);
        if (!matchedService?.allowUnstable) continue;
      }

      // Find which service this operation belongs to (by tag + optional path filter)
      const service = findService(path, tags, services);
      if (!service) continue;

      const group = groups.get(service.name)!;

      const grouped = extractOperation(
        spec,
        method,
        path,
        operation,
        pathLevelParams,
        service,
      );
      if (grouped) {
        group.operations.push(grouped);
      }
    }
  }

  // Filter out services with no operations
  return Array.from(groups.values()).filter((g) => g.operations.length > 0);
}

/** Determine which service an operation belongs to (by tag + path filter) */
function findService(
  path: string,
  tags: string[],
  services: ServiceConfig[],
): ServiceConfig | null {
  for (const service of services) {
    // Must match at least one tag
    const tagMatch = service.tags.some((t) => tags.includes(t));
    if (!tagMatch) continue;

    // Check path exclusions
    if (service.excludePaths?.some((ex) => path.startsWith(ex))) {
      continue;
    }

    // If pathPrefixes specified, must also match a prefix
    if (service.pathPrefixes) {
      const prefixMatch = service.pathPrefixes.some((prefix) =>
        path.startsWith(prefix)
      );
      if (!prefixMatch) continue;
    }

    return service;
  }
  return null;
}

/** Resolve parameter $refs into concrete ParameterObjects */
function resolveParams(
  spec: OpenAPISpec,
  params: (ParameterObject | RefObject)[],
): ParameterObject[] {
  return params.map((p) => {
    if ("$ref" in p) {
      return resolveParamRef(spec, p.$ref);
    }
    return p;
  });
}

/** Extract a single operation into our intermediate form */
function extractOperation(
  spec: OpenAPISpec,
  httpMethod: string,
  path: string,
  operation: OperationObject,
  pathLevelParams: ParameterObject[],
  service: ServiceConfig,
): GroupedOperation | null {
  // Skip endpoints whose success response is non-JSON (CSV, binary, etc.)
  if (hasNonJsonResponse(operation)) return null;

  // Resolve all parameters (may contain $refs)
  const opParams = resolveParams(
    spec,
    operation.parameters as (ParameterObject | RefObject)[] ?? [],
  );
  const allParams = [...pathLevelParams, ...opParams];

  // Separate path params and query params
  const pathParams = allParams.filter((p) => p.in === "path");

  // Query params: exclude pagination params (handled by helper)
  const allQueryParams = allParams.filter((p) => p.in === "query");
  const queryParams = allQueryParams.filter(
    (p) => !ALL_PAGINATION_PARAMS.has(p.name),
  );

  // Detect pagination style from all query params (including pagination ones)
  const resolvedAllParams = resolveParamsForPagination(
    spec,
    operation.parameters as (ParameterObject | RefObject)[] ?? [],
  );
  const allResolvedQuery = [
    ...allParams.filter((p) => p.in === "query"),
    ...resolvedAllParams.filter((p) => p.in === "query"),
  ];
  // Deduplicate by name
  const uniqueQuery = [
    ...new Map(allResolvedQuery.map((p) => [p.name, p])).values(),
  ];

  const pagination = service.pagination ?? detectPagination(
    spec,
    operation,
    uniqueQuery,
  );

  // Extract request body schema — unwrap JSON:API envelope if present
  let requestBody: SchemaObject | undefined;
  let requestBodyIsJsonApi = false;
  let requestBodyIsArray = false;
  let requestBodyType: string | undefined;
  if (operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content["application/json"];
    if (jsonContent?.schema) {
      const fullBody = resolveSchema(spec, jsonContent.schema);

      // Check for JSON:API pattern: {data: {type, attributes: {...}}}
      if (fullBody.properties?.data) {
        const dataSchema = resolveSchema(spec, fullBody.properties.data);
        if (dataSchema.properties?.attributes) {
          // Unwrap: expose attributes fields as the user-facing schema
          const attrsSchema = resolveSchema(
            spec,
            dataSchema.properties.attributes,
          );
          requestBody = attrsSchema;
          requestBodyIsJsonApi = true;
          // Extract the type enum/const if available
          if (dataSchema.properties?.type) {
            const typeSchema = resolveSchema(spec, dataSchema.properties.type);
            if (typeSchema.enum && typeSchema.enum.length > 0) {
              requestBodyType = String(typeSchema.enum[0]);
            }
          }
        } else {
          // data exists but no attributes — use data's properties directly
          requestBody = dataSchema;
          requestBodyIsJsonApi = true;
        }
      } else if (
        fullBody.properties && Object.keys(fullBody.properties).length > 0
      ) {
        // Flat body — use as-is
        requestBody = fullBody;
      } else if (fullBody.oneOf && fullBody.oneOf.length > 0) {
        // oneOf — take the first variant's properties
        const first = resolveSchema(spec, fullBody.oneOf[0]);
        requestBody = first;
      } else if (fullBody.type === "array") {
        // Array body (e.g., POST /v2/logs accepts [{message, ddsource}])
        // Expose as a schema with a single "items" field of array type
        requestBody = fullBody;
        requestBodyIsArray = true;
      }
    }
  }

  // Extract response schema and detect format
  const { responseSchema, isCollection, isJsonApi } = extractResponseSchema(
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
    requestBodyIsJsonApi,
    requestBodyIsArray,
    requestBodyType,
    responseSchema,
    isCollection,
    isJsonApi,
    pagination,
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

/**
 * Extract the success response schema.
 *
 * Datadog v2 responses come in two flavors:
 * 1. JSON:API: { data: [{id, type, attributes, relationships}], meta, included }
 * 2. Flat: { data: [...items], meta } or just { results: [...] }
 *
 * We detect which format and flatten accordingly.
 */
function extractResponseSchema(
  spec: OpenAPISpec,
  operation: OperationObject,
): {
  responseSchema?: SchemaObject;
  isCollection: boolean;
  isJsonApi: boolean;
} {
  if (!operation.responses) {
    return { isCollection: false, isJsonApi: false };
  }

  // Try 200, 201, then any 2xx
  const successCodes = ["200", "201", "202"];
  let responseContent: Record<string, { schema?: SchemaObject }> | undefined;

  for (const code of successCodes) {
    const resp = operation.responses[code] as ResponseObject | undefined;
    if (resp?.content?.["application/json"]) {
      responseContent = resp.content;
      break;
    }
  }

  if (!responseContent) {
    return { isCollection: false, isJsonApi: false };
  }

  const rawSchema = responseContent["application/json"]?.schema;
  if (!rawSchema) return { isCollection: false, isJsonApi: false };

  const fullSchema = resolveSchema(spec, rawSchema);

  // Check if this is JSON:API format (has data with id/type/attributes)
  if (fullSchema.properties?.data) {
    const dataSchema = resolveSchema(
      spec,
      fullSchema.properties.data,
    );

    // Collection: data is an array
    if (dataSchema.type === "array" && dataSchema.items) {
      const itemSchema = resolveSchema(spec, dataSchema.items);
      const isJsonApi = hasJsonApiShape(itemSchema);

      if (isJsonApi) {
        const flattened = flattenJsonApiItem(spec, itemSchema);
        return { responseSchema: flattened, isCollection: true, isJsonApi };
      }
      // Flat array in data
      return {
        responseSchema: itemSchema,
        isCollection: true,
        isJsonApi: false,
      };
    }

    // Single item: data is an object
    if (dataSchema.type === "object" || dataSchema.properties) {
      const isJsonApi = hasJsonApiShape(dataSchema);
      if (isJsonApi) {
        const flattened = flattenJsonApiItem(spec, dataSchema);
        return { responseSchema: flattened, isCollection: false, isJsonApi };
      }
      return {
        responseSchema: dataSchema,
        isCollection: false,
        isJsonApi: false,
      };
    }

    // oneOf — take first variant
    if (dataSchema.oneOf && dataSchema.oneOf.length > 0) {
      const first = resolveSchema(spec, dataSchema.oneOf[0]);
      const isJsonApi = hasJsonApiShape(first);
      if (isJsonApi) {
        const flattened = flattenJsonApiItem(spec, first);
        return { responseSchema: flattened, isCollection: false, isJsonApi };
      }
      return { responseSchema: first, isCollection: false, isJsonApi: false };
    }
  }

  // No `data` top-level key — use full schema as flat response
  return { responseSchema: fullSchema, isCollection: false, isJsonApi: false };
}

/** Check if a schema has JSON:API shape (id + type + attributes) */
function hasJsonApiShape(schema: SchemaObject): boolean {
  if (!schema.properties) return false;
  const keys = Object.keys(schema.properties);
  return keys.includes("id") && keys.includes("type") &&
    keys.includes("attributes");
}

/**
 * Flatten a JSON:API item (with id/type/attributes/relationships)
 * into a flat schema: { id, type, ...attributes_properties }
 */
function flattenJsonApiItem(
  spec: OpenAPISpec,
  itemSchema: SchemaObject,
): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  // Always include id and type
  if (itemSchema.properties?.id) {
    properties.id = resolveSchema(spec, itemSchema.properties.id);
    required.push("id");
  }
  if (itemSchema.properties?.type) {
    properties.type = resolveSchema(spec, itemSchema.properties.type);
  }

  // Flatten attributes into the top level
  if (itemSchema.properties?.attributes) {
    const attrs = resolveSchema(spec, itemSchema.properties.attributes);
    if (attrs.properties) {
      for (const [name, prop] of Object.entries(attrs.properties)) {
        properties[name] = resolveSchema(spec, prop);
      }
      if (attrs.required) {
        required.push(...attrs.required);
      }
    }
  }

  // Include relationship IDs
  if (itemSchema.properties?.relationships) {
    const rels = resolveSchema(spec, itemSchema.properties.relationships);
    if (rels.properties) {
      for (const [name, _rel] of Object.entries(rels.properties)) {
        properties[`${name}_id`] = {
          type: "string",
          description: `Related ${name} ID`,
        };
      }
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Detect if an operation's success response is exclusively non-JSON.
 * Skips endpoints returning CSV, binary, XML, etc.
 */
function hasNonJsonResponse(operation: OperationObject): boolean {
  if (!operation.responses) return false;
  for (const code of ["200", "201", "202"]) {
    const resp = operation.responses[code] as ResponseObject | undefined;
    if (!resp?.content) continue;
    const contentTypes = Object.keys(resp.content);
    const hasJson = contentTypes.some((t) => t.includes("json"));
    if (!hasJson && contentTypes.length > 0) return true;
  }
  return false;
}
