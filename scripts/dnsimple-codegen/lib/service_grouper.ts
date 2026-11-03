/**
 * Service grouper — maps OpenAPI paths/operations into logical service groups.
 *
 * Takes the raw OpenAPI spec and the service registry config, then produces
 * a grouped intermediate representation: one ServiceGroup per extension,
 * containing all operations that belong to that service.
 *
 * Grouping is by path prefix, longest match wins. Two claim checks keep the
 * registry honest: generation fails when an operation matches two services
 * with equally long prefixes, and when an operation outside
 * EXCLUDED_OPERATIONS matches none.
 *
 * DNSimple scopes 103 of its 111 operations by an `/{account}` path segment.
 * That segment is stripped per operation, not per service — the `account` and
 * `domains` services mix global and account paths. The generated method
 * substitutes `globalArgs.accountId` for it.
 */

import type {
  OpenAPISpec,
  OperationObject,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from "./schema_fetcher.ts";
import {
  resolveParameter,
  resolveRef,
  resolveRequestBody,
  resolveSchema,
} from "./schema_fetcher.ts";
import { EXCLUDED_OPERATIONS, type ServiceConfig } from "../config.ts";
import {
  detectPagination,
  PAGINATION_PARAMS,
  type PaginationInfo,
  schemaAtPath,
} from "./pagination.ts";

/** The path segment DNSimple scopes account-level operations with. */
export const ACCOUNT_SEGMENT = "/{account}";

/** A single API operation grouped into a service */
export interface GroupedOperation {
  /** HTTP method (get, post, put, patch, delete) */
  httpMethod: string;
  /** Full path template (e.g., /{account}/zones/{zone}/records) */
  path: string;
  /** OpenAPI operationId */
  operationId: string;
  /** Human-readable summary */
  summary: string;
  /** Full description */
  description: string;
  /** True when the path starts with `/{account}` (the segment is stripped) */
  accountScoped: boolean;
  /** Path parameters other than `account` */
  pathParams: ParameterObject[];
  /** Query parameters, minus `page`/`per_page` on a paginated operation */
  queryParams: ParameterObject[];
  /** Resolved request body schema (if POST/PUT/PATCH) */
  requestBody?: SchemaObject;
  /** True when the spec marks the request body itself required */
  requestBodyRequired?: boolean;
  /**
   * Resolved schema of the response's `data` property. For a collection it is
   * the ITEM schema (the array's `items`).
   */
  responseSchema?: SchemaObject;
  /** Shape of `data`: one object, an array, or absent (no JSON body). */
  dataKind: "object" | "array" | "none";
  /** True when `data` is an array */
  isCollection: boolean;
  /** True when some 2xx response has no body (e.g. a 204) */
  noContent: boolean;
  /** Pagination shape detected for this operation */
  pagination: PaginationInfo;
  /** Resolved schemas of `pagination.keep` siblings of the results array */
  paginatedSiblings?: Record<string, SchemaObject>;
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

/** Verbs OpenAPI allows on a path that the generator does not support. */
const UNSUPPORTED_METHODS = ["head", "options", "trace"] as const;

/**
 * Operation IDs and paths are emitted into generated source as identifiers and
 * template-literal text, so anything outside these shapes stops generation
 * rather than producing code that does not parse.
 */
const OPERATION_ID = /^[a-z][a-zA-Z0-9]*$/;
const PATH_TEXT = /^[A-Za-z0-9_\-./{}]+$/;

export interface GroupOptions {
  /** Service names to return; every service is still used for claim checks. */
  only?: string[];
  /** Operation IDs the generator never emits. */
  excluded?: string[];
}

/**
 * Group every operation in the spec into its service group.
 *
 * Throws one error listing every operation that matches two services or none.
 */
export function groupOperations(
  spec: OpenAPISpec,
  services: ServiceConfig[],
  options: GroupOptions = {},
): ServiceGroup[] {
  const excluded = new Set(options.excluded ?? EXCLUDED_OPERATIONS);
  const groups = new Map<string, ServiceGroup>();
  for (const config of services) {
    groups.set(config.name, { config, operations: [] });
  }
  const problems: string[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;
    const pathLevelParams = (pathItem.parameters ?? []) as ParameterObject[];
    if (!PATH_TEXT.test(path)) {
      problems.push(`${path} has characters the generator cannot emit`);
      continue;
    }
    for (const method of UNSUPPORTED_METHODS) {
      if (method in pathItem) {
        problems.push(
          `${method.toUpperCase()} ${path} uses an HTTP method the generator does not support`,
        );
      }
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation || typeof operation !== "object") continue;
      const label = operation.operationId ?? `${method} ${path}`;
      if (excluded.has(operation.operationId ?? "")) continue;
      if (!OPERATION_ID.test(operation.operationId ?? "")) {
        problems.push(
          `${method.toUpperCase()} ${path} has operationId ` +
            `${
              JSON.stringify(operation.operationId)
            }; expected camelCase letters and digits`,
        );
        continue;
      }

      const match = findService(path, services);
      if (match.kind === "none") {
        problems.push(
          `${label} (${method.toUpperCase()} ${path}) matches no service`,
        );
        continue;
      }
      if (match.kind === "conflict") {
        problems.push(
          `${label} (${method.toUpperCase()} ${path}) matches ${
            match.names.join(" and ")
          }`,
        );
        continue;
      }

      groups.get(match.service.name)!.operations.push(
        extractOperation(spec, method, path, operation, pathLevelParams),
      );
    }
  }

  for (const group of groups.values()) {
    if (group.operations.length === 0) {
      problems.push(
        `service ${group.config.name} matched no operations; check its pathPrefixes`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `service grouping failed:\n  ${problems.join("\n  ")}\n` +
        `Fix SERVICES or EXCLUDED_OPERATIONS in config.ts.`,
    );
  }

  const wanted = options.only ? new Set(options.only) : undefined;
  return Array.from(groups.values()).filter((g) =>
    g.operations.length > 0 && (!wanted || wanted.has(g.config.name))
  );
}

/** True when `path` is `prefix` itself or sits beneath it, on a segment edge. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

type ServiceMatch =
  | { kind: "service"; service: ServiceConfig }
  | { kind: "none" }
  | { kind: "conflict"; names: string[] };

/**
 * Find the service whose longest matching prefix claims the path. Paths under
 * a service's `excludePaths` are skipped for that service. Two services tying
 * on prefix length is a conflict, not a coin flip.
 */
export function findService(
  path: string,
  services: ServiceConfig[],
): ServiceMatch {
  let bestLength = -1;
  let best: ServiceConfig[] = [];
  for (const service of services) {
    if (service.excludePaths?.some((ex) => underPrefix(path, ex))) continue;
    for (const prefix of service.pathPrefixes) {
      if (!underPrefix(path, prefix)) continue;
      if (prefix.length > bestLength) {
        bestLength = prefix.length;
        best = [service];
      } else if (prefix.length === bestLength && !best.includes(service)) {
        best.push(service);
      }
    }
  }
  if (best.length === 0) return { kind: "none" };
  if (best.length > 1) {
    return { kind: "conflict", names: best.map((s) => s.name) };
  }
  return { kind: "service", service: best[0] };
}

/**
 * Union path-template placeholders into the spec-declared path parameters.
 * Code generation reads the path template directly, so a placeholder the spec
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
): GroupedOperation {
  const operationId = operation.operationId ??
    `${httpMethod}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const accountScoped = path.startsWith(`${ACCOUNT_SEGMENT}/`);

  const allParams = [
    ...pathLevelParams,
    ...(operation.parameters ?? []),
  ].map((p) => resolveParameter(spec, p));

  const declaredPathParams = allParams.filter((p) => p.in === "path");
  const pathParams = withTemplatePlaceholders(path, declaredPathParams)
    .filter((p) => !(accountScoped && p.name === "account"))
    .map((p) => resolveParamSchema(spec, p));

  const { responseSchema, rawResponse, resolvedResponse, noContent } =
    extractResponseSchema(spec, operationId, operation);
  const pagination = detectPagination(
    operationId,
    rawResponse,
    resolvedResponse,
  );

  const queryParams = allParams
    .filter((p) => p.in === "query")
    .filter((p) =>
      !(pagination.paginated && PAGINATION_PARAMS.includes(p.name))
    )
    .map((p) => resolveParamSchema(spec, p));

  let requestBody: SchemaObject | undefined;
  let requestBodyRequired = false;
  if (operation.requestBody) {
    const body = resolveRequestBody(spec, operation.requestBody);
    requestBodyRequired = body.required === true;
    const content = body.content ?? {};
    const jsonContent = content["application/json"];
    if (Object.keys(content).length > 0 && !jsonContent) {
      throw new Error(
        `${operationId}: request body is not application/json ` +
          `(${
            Object.keys(content).join(", ")
          }); the generated client sends JSON only`,
      );
    }
    if (jsonContent?.schema) {
      requestBody = resolveSchema(spec, jsonContent.schema);
    }
  }

  // A paginated response's results may sit below `data` (`data.rows` for DNS
  // analytics), so its item schema comes from the detected results path.
  const resultsSchema = pagination.paginated
    ? schemaAtPath(resolvedResponse, pagination.resultsPath)
    : responseSchema;
  const dataKind = responseSchema === undefined
    ? "none"
    : (resultsSchema && isArray(resultsSchema))
    ? "array"
    : "object";

  return {
    httpMethod,
    path,
    operationId,
    summary: operation.summary ?? "",
    description: operation.description ?? "",
    accountScoped,
    pathParams,
    queryParams,
    requestBody,
    requestBodyRequired,
    responseSchema: dataKind === "array"
      ? resultsSchema!.items ?? {}
      : responseSchema,
    dataKind,
    isCollection: dataKind === "array",
    noContent,
    pagination,
    paginatedSiblings: pagination.keep.length > 0
      ? Object.fromEntries(
        pagination.keep.map((key) => [
          key,
          schemaAtPath(resolvedResponse, [
            ...pagination.resultsPath.slice(0, -1),
            key,
          ])!,
        ]),
      )
      : undefined,
    deprecated: operation.deprecated ?? false,
    tags: operation.tags ?? [],
  };
}

function isArray(schema: SchemaObject): boolean {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return type === "array";
}

/** Resolve a parameter's own schema (`$ref`s such as `Date` or an enum). */
function resolveParamSchema(
  spec: OpenAPISpec,
  param: ParameterObject,
): ParameterObject {
  if (!param.schema) return param;
  return { ...param, schema: resolveSchema(spec, param.schema) };
}

/**
 * Extract the success response. Every DNSimple JSON response wraps its payload
 * in `{ data }`, so the method's result is the `data` property's schema; the
 * raw (unresolved) and resolved full schemas are returned alongside for
 * pagination detection.
 *
 * Throws when a JSON success response has no `data` property, or when the
 * success response is not JSON — either would need a hand-written client.
 */
function extractResponseSchema(
  spec: OpenAPISpec,
  operationId: string,
  operation: OperationObject,
): {
  responseSchema?: SchemaObject;
  rawResponse?: SchemaObject;
  resolvedResponse?: SchemaObject;
  noContent: boolean;
} {
  let noContent = false;
  let rawResponse: SchemaObject | undefined;

  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    if (!code.startsWith("2")) continue;
    const resp = (response as { $ref?: string }).$ref
      ? (resolveRef(
        spec,
        (response as { $ref: string }).$ref,
      ) as unknown as ResponseObject)
      : response;
    const content = resp.content ?? {};
    const contentTypes = Object.keys(content);
    if (contentTypes.length === 0) {
      noContent = true;
      continue;
    }
    const json = content["application/json"]?.schema;
    if (!json) {
      throw new Error(
        `${operationId}: ${code} response is not application/json ` +
          `(${contentTypes.join(", ")}); the generated client reads JSON only`,
      );
    }
    rawResponse ??= json.$ref
      ? (resolveRef(spec, json.$ref) as SchemaObject)
      : json;
  }

  if (!rawResponse) return { noContent };

  const resolvedResponse = resolveSchema(spec, rawResponse);
  const data = resolvedResponse.properties?.data;
  if (!data) {
    throw new Error(
      `${operationId}: success response has no \`data\` property; ` +
        `the generated client unwraps \`{ data }\` envelopes only`,
    );
  }
  return { responseSchema: data, rawResponse, resolvedResponse, noContent };
}
