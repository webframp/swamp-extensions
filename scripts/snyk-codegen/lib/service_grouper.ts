/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Takes the raw Snyk OpenAPI spec and the service registry config, then produces
 * a grouped intermediate representation: one ServiceGroup per extension,
 * containing all operations that belong to that service.
 *
 * Key differences from the Cloudflare codegen:
 * - JSON:API response format (data/attributes envelope)
 * - Cursor pagination via starting_after/ending_before/limit
 * - Parameters may be $ref objects that need resolution
 * - Response content type is application/vnd.api+json
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
import type { ServiceConfig } from "../config.ts";

/** A single API operation grouped into a service */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete) */
  httpMethod: string;
  /** Full path (e.g., /orgs/{org_id}/projects/{project_id}) */
  path: string;
  /** OpenAPI operationId */
  operationId: string;
  /** Human-readable summary */
  summary: string;
  /** Full description */
  description: string;
  /** Path parameters (excluding this service's scope param, e.g. org_id) */
  pathParams: ParameterObject[];
  /** Query parameters (excluding pagination params) */
  queryParams: ParameterObject[];
  /** Resolved request body schema (if POST/PUT/PATCH) */
  requestBody?: SchemaObject;
  /** Resolved success response schema (the flattened attributes) */
  responseSchema?: SchemaObject;
  /** Whether the response is a collection (array in data) or single item */
  isCollection: boolean;
  /** Whether this endpoint uses cursor-based pagination */
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

/** Pagination params that are handled by the API helper, not user args */
const PAGINATION_PARAMS = new Set([
  "starting_after",
  "ending_before",
  "limit",
]);

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
    const service = findService(path, services);
    if (!service) continue;

    const group = groups.get(service.name)!;

    // Path-level parameters (resolve $refs)
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

      const grouped = extractOperation(
        spec,
        method,
        path,
        operation,
        pathLevelParams,
        service.scope,
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
  scope: "org" | "group" | "user",
): GroupedOperation | null {
  // Skip deprecated endpoints
  if (operation.deprecated) return null;

  // Skip endpoints whose success response is non-JSON:API
  if (hasNonJsonApiResponse(operation)) return null;

  // Resolve all operation parameters (may contain $refs)
  const opParams = resolveParams(
    spec,
    operation.parameters as (ParameterObject | RefObject)[] ?? [],
  );
  const allParams = [...pathLevelParams, ...opParams];

  // Determine which scope params to strip
  const scopeParam = scope === "org"
    ? "org_id"
    : scope === "group"
    ? "group_id"
    : null;

  // Path params: exclude only this service's scope param (sourced from
  // globalArgs). A secondary scope param — e.g. group_id on an org-scoped
  // service — is a genuine method argument sourced from `args`, so it must
  // stay in pathParams for the args schema and test generator to see it.
  const pathParams = allParams.filter(
    (p) =>
      p.in === "path" &&
      p.name !== scopeParam,
  );

  // Query params: exclude pagination params (those are handled by the helper)
  const queryParams = allParams.filter(
    (p) =>
      p.in === "query" &&
      !PAGINATION_PARAMS.has(p.name) &&
      p.name !== "version",
  );

  // Detect cursor pagination: if endpoint has starting_after param
  const usesCursorPagination = allParams.some(
    (p) => p.in === "query" && p.name === "starting_after",
  );

  // Extract request body schema (JSON:API uses application/vnd.api+json)
  let requestBody: SchemaObject | undefined;
  if (operation.requestBody?.content) {
    const jsonApiContent =
      operation.requestBody.content["application/vnd.api+json"] ??
        operation.requestBody.content["application/json"];
    if (jsonApiContent?.schema) {
      requestBody = resolveSchema(spec, jsonApiContent.schema);
    }
  }

  // Extract response schema
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
    usesCursorPagination,
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

/**
 * Extract the success response schema from a JSON:API response.
 *
 * JSON:API responses look like:
 *   { data: [...], links: {...}, jsonapi: {...} }  (collection)
 *   { data: {...}, links: {...}, jsonapi: {...} }  (single)
 *
 * The `data` items have: { id, type, attributes: {...}, relationships: {...} }
 * We extract the `attributes` schema as the resource shape, flattened with `id`.
 */
function extractResponseSchema(
  spec: OpenAPISpec,
  operation: OperationObject,
): { responseSchema?: SchemaObject; isCollection: boolean } {
  if (!operation.responses) return { isCollection: false };

  // Try 200, 201, then any 2xx
  const successCodes = ["200", "201"];
  let responseContent:
    | Record<string, { schema?: SchemaObject }>
    | undefined;

  for (const code of successCodes) {
    const resp = operation.responses[code] as ResponseObject | undefined;
    if (resp?.content) {
      // Try JSON:API content type first, then fall back to regular JSON
      if (resp.content["application/vnd.api+json"]) {
        responseContent = resp.content;
        break;
      }
      if (resp.content["application/json"]) {
        responseContent = resp.content;
        break;
      }
    }
  }

  if (!responseContent) {
    return { isCollection: false };
  }

  const contentType = responseContent["application/vnd.api+json"]
    ? "application/vnd.api+json"
    : "application/json";

  const rawSchema = responseContent[contentType]?.schema;
  if (!rawSchema) return { isCollection: false };

  const fullSchema = resolveSchema(spec, rawSchema);

  // JSON:API: look for `data` property
  if (fullSchema.properties?.data) {
    const dataSchema = resolveSchema(spec, fullSchema.properties.data);

    // Collection: data is an array
    if (dataSchema.type === "array" && dataSchema.items) {
      const itemSchema = resolveSchema(spec, dataSchema.items);
      const flattened = flattenJsonApiItem(spec, itemSchema);
      return { responseSchema: flattened, isCollection: true };
    }

    // Single item: data is an object
    if (dataSchema.type === "object" || dataSchema.properties) {
      const flattened = flattenJsonApiItem(spec, dataSchema);
      return { responseSchema: flattened, isCollection: false };
    }

    // Data might be a union (oneOf) — take the first variant
    if (dataSchema.oneOf && dataSchema.oneOf.length > 0) {
      const first = resolveSchema(spec, dataSchema.oneOf[0]);
      const flattened = flattenJsonApiItem(spec, first);
      return { responseSchema: flattened, isCollection: false };
    }
  }

  // Fallback: use the full schema as-is
  return { responseSchema: fullSchema, isCollection: false };
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

  // Include relationship IDs (flatten to {rel_name}_id)
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
 * Detect if an operation's success response uses a non-JSON:API content type.
 * Skip CycloneDX and other binary/XML formats.
 */
function hasNonJsonApiResponse(operation: OperationObject): boolean {
  if (!operation.responses) return false;

  for (const code of ["200", "201"]) {
    const resp = operation.responses[code] as ResponseObject | undefined;
    if (!resp?.content) continue;

    const contentTypes = Object.keys(resp.content);
    // If the ONLY success content type is non-JSON, skip
    const hasJson = contentTypes.some(
      (t) => t.includes("json"),
    );
    if (!hasJson && contentTypes.length > 0) return true;
  }

  return false;
}
