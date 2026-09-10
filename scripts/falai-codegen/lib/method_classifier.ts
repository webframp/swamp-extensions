/**
 * Method classifier — determines the swamp method type for each operation
 * and generates the model source code.
 *
 * Classifies operations as:
 * - list: GET returning a collection
 * - get: GET returning a single item (path ends with {id})
 * - create: POST that creates a resource
 * - update: PUT/PATCH that modifies a resource
 * - delete: DELETE
 * - action: POST that performs an action (not a standard CRUD create)
 *
 * fal.ai has no account/zone/org scoping, so — unlike cloudflare-codegen and
 * snyk-codegen — there is no scope-derived globalArg substituted into paths.
 * Every path parameter in the spec becomes a method argument.
 */

import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { ParameterObject, SchemaObject } from "./schema_fetcher.ts";
import { schemaToZod } from "./type_mapper.ts";
import { SENSITIVE_RESPONSE_FIELDS, ZOD_VERSION } from "../config.ts";

export type MethodType =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "action";

export interface ClassifiedMethod {
  /** swamp method name (e.g., list_assets, get_asset, create_asset_collection) */
  name: string;
  /** The classification */
  type: MethodType;
  /** Description for the method */
  description: string;
  /** The original operation */
  operation: GroupedOperation;
}

/**
 * Classify an operation into a swamp method type.
 */
export function classifyOperation(op: GroupedOperation): MethodType {
  const { httpMethod, path, isCollection } = op;

  switch (httpMethod) {
    case "get":
      if (isCollection) return "list";
      return "get";
    case "post": {
      const lastSegment = path.split("/").pop() ?? "";
      if (lastSegment.startsWith("{")) return "action";
      if (op.requestBody?.properties) return "create";
      return "action";
    }
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return "action";
  }
}

/**
 * Generate a method name from the operation.
 * Uses the operationId if available, otherwise constructs from path + method.
 */
export function generateMethodName(
  op: GroupedOperation,
  type: MethodType,
): string {
  if (op.operationId) {
    // fal.ai operationIds are camelCase, e.g. "listAssets", "createComputeInstance".
    let name = camelToSnake(op.operationId);

    const verbPrefixes = [
      "list",
      "get",
      "create",
      "update",
      "delete",
      "put",
      "patch",
      "set",
      "add",
      "remove",
      "assign",
      "unassign",
      "favorite",
      "unfavorite",
      "move",
      "estimate",
      "search",
      "upload",
      "sign",
    ];
    // Strip a service prefix ahead of the verb, e.g. "serverless_get_app_queue_info"
    // -> "get_app_queue_info". Mirrors cloudflare-codegen's operationId handling,
    // needed here for the handful of fal.ai operationIds that carry a leading
    // service name (serverlessGetAnalytics, serverlessListApps, ...).
    for (const verb of verbPrefixes) {
      const idx = name.indexOf(`_${verb}_`);
      if (idx >= 0) {
        name = name.slice(idx + 1);
        break;
      }
      if (name.endsWith(`_${verb}`)) {
        name = name.slice(name.lastIndexOf(`_${verb}`) + 1);
        break;
      }
    }

    const hasVerb = verbPrefixes.some((v) =>
      name.startsWith(`${v}_`) || name === v
    );
    if (!hasVerb && type !== "action") {
      name = `${type}_${name}`;
    }

    return sanitizeMethodName(name);
  }

  const segments = op.path.split("/").filter((s) => s && !s.startsWith("{"));
  const lastSegments = segments.slice(-2);
  const resource = lastSegments.join("_");
  return sanitizeMethodName(`${type}_${resource}`);
}

/** Convert a camelCase identifier to snake_case. */
function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Sanitize a method name to valid TypeScript identifier */
function sanitizeMethodName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * Classify all operations in a service group into methods.
 * De-duplicates by method name (first wins).
 */
export function classifyServiceMethods(
  group: ServiceGroup,
): ClassifiedMethod[] {
  const methods: ClassifiedMethod[] = [];
  const seen = new Set<string>();

  for (const op of group.operations) {
    const type = classifyOperation(op);
    const name = generateMethodName(op, type);

    if (seen.has(name)) continue;
    seen.add(name);

    methods.push({
      name,
      type,
      description: op.summary || op.description || `${type} operation`,
      operation: op,
    });
  }

  return methods;
}

/**
 * Generate the complete model TypeScript source file for a service.
 */
export function generateModelSource(
  group: ServiceGroup,
  methods: ClassifiedMethod[],
  version: string,
  upgradesBlock = "  upgrades: [],",
): string {
  const { config } = group;
  const modelType = `@webframp/falai/${config.name}`;

  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * ${config.description}`);
  lines.push(` *`);
  lines.push(
    ` * Auto-generated by scripts/falai-codegen — do not edit manually.`,
  );
  lines.push(` *`);
  lines.push(` * @module`);
  lines.push(` */`);
  lines.push(`// SPDX-License-Identifier: Apache-2.0`);
  lines.push(``);
  lines.push(`import { z } from "npm:zod@${ZOD_VERSION}";`);

  const usesFalApi = methods.some((m) =>
    m.type !== "list" || !m.operation.pagination.paginated
  );
  const usesFalApiPaginated = methods.some((m) =>
    m.type === "list" && m.operation.pagination.paginated
  );
  const apiImports: string[] = [];
  if (usesFalApi) apiImports.push("falApi");
  if (usesFalApiPaginated) apiImports.push("falApiPaginated");
  const usesSanitize = methods.some(methodEmitsSanitize);
  if (usesSanitize) apiImports.push("sanitizeInstanceName");
  const usesShortHash = methods.some(
    (m) => m.type === "create" && resolveIdAccessor(m) === undefined,
  );
  if (usesShortHash) apiImports.push("shortHash");
  if (apiImports.length > 0) {
    lines.push(
      `import { ${apiImports.join(", ")} } from "./_lib/api.ts";`,
    );
  }
  lines.push(``);
  const hasListMethod = methods.some((m) => m.type === "list");
  if (hasListMethod) {
    lines.push(`const EXTENSION_NAME = "${modelType}";`);
    lines.push(``);
  }

  lines.push(
    `// =============================================================================`,
  );
  lines.push(`// Schemas`);
  lines.push(
    `// =============================================================================`,
  );
  lines.push(``);

  lines.push(generateGlobalArgsSchema());
  lines.push(``);

  const schemaNames = generateResponseSchemas(methods, lines);

  lines.push(
    `// =============================================================================`,
  );
  lines.push(`// Model Definition`);
  lines.push(
    `// =============================================================================`,
  );
  lines.push(``);
  lines.push(`/** ${config.description} */`);
  lines.push(`export const model = {`);
  lines.push(`  type: "${modelType}",`);
  lines.push(`  version: "${version}",`);
  lines.push(`  globalArguments: GlobalArgsSchema,`);
  lines.push(``);
  lines.push(upgradesBlock);
  lines.push(``);

  lines.push(`  resources: {`);
  const seenResources = new Set<string>();
  for (const method of methods) {
    if (method.type === "delete") continue;
    const resourceName = resourceNameFor(method);
    if (seenResources.has(resourceName)) continue;
    seenResources.add(resourceName);
    lines.push(`    "${resourceName}": {`);
    lines.push(`      description: "${escapeStr(method.description)}",`);
    lines.push(
      `      schema: ${schemaNames.get(method.name) ?? "z.object({})"},`,
    );
    lines.push(`      lifetime: "infinite" as const,`);
    lines.push(
      `      garbageCollection: ${method.type === "list" ? 10 : 20},`,
    );
    lines.push(`    },`);
  }
  lines.push(`  },`);
  lines.push(``);

  lines.push(`  methods: {`);
  for (const method of methods) {
    lines.push(generateMethod(method));
  }
  lines.push(`  },`);
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

function resourceNameFor(method: ClassifiedMethod): string {
  return method.type === "list"
    ? method.name.replace(/^list_/, "")
    : method.name.replace(/^(get|create|update|action)_/, "");
}

/** Generate GlobalArgsSchema — just the API key, since fal.ai has no scoping. */
function generateGlobalArgsSchema(): string {
  return [
    `const GlobalArgsSchema = z.object({`,
    `  apiToken: z.string().meta({ sensitive: true }).describe("fal.ai API key; overrides the FAL_KEY environment variable. Wire with a vault.get(...) expression to source it from a vault.").optional(),`,
    `});`,
  ].join("\n");
}

/** Generate Zod schemas for all unique response shapes */
function generateResponseSchemas(
  methods: ClassifiedMethod[],
  lines: string[],
): Map<string, string> {
  const schemaNames = new Map<string, string>();

  const seenResources = new Set<string>();
  const methodsWithResources: ClassifiedMethod[] = [];

  for (const method of methods) {
    if (method.type === "delete") continue;
    const resourceName = resourceNameFor(method);
    if (!seenResources.has(resourceName)) {
      seenResources.add(resourceName);
      methodsWithResources.push(method);
    }
  }

  for (const method of methodsWithResources) {
    const schema = method.operation.responseSchema;
    if (!schema) {
      schemaNames.set(method.name, "z.object({})");
      continue;
    }

    const varName = toPascalCase(method.name) + "Schema";
    schemaNames.set(method.name, varName);

    if (method.type === "list") {
      const itemVarName = toPascalCase(method.name.replace(/^list_/, "")) +
        "ItemSchema";
      const itemZod = withPassthrough(schemaToZod(schema, { indent: 2 }, 1));
      lines.push(`const ${itemVarName} = ${itemZod};`);
      lines.push(``);
      lines.push(`const ${varName} = z.object({`);
      lines.push(`  items: z.array(${itemVarName}),`);
      lines.push(`  truncated: z.boolean(),`);
      lines.push(`  fetchedAt: z.string(),`);
      lines.push(`  durationMs: z.number().optional().describe(`);
      lines.push(`    "Method execution duration in milliseconds",`);
      lines.push(`  ),`);
      lines.push(`  collectedBy: z.string().optional().describe(`);
      lines.push(`    "Extension that collected this data",`);
      lines.push(`  ),`);
      lines.push(`});`);
    } else {
      const zodStr = withPassthrough(schemaToZod(schema, { indent: 2 }, 1));
      lines.push(`const ${varName} = ${zodStr};`);
    }
    lines.push(``);
  }

  for (const method of methods) {
    if (method.type === "delete") continue;
    if (schemaNames.has(method.name)) continue;
    const resourceName = resourceNameFor(method);
    const primary = methodsWithResources.find(
      (m) => resourceNameFor(m) === resourceName,
    );
    schemaNames.set(
      method.name,
      primary
        ? (schemaNames.get(primary.name) ?? "z.object({})")
        : "z.object({})",
    );
  }

  return schemaNames;
}

/** Generate a single method definition */
function generateMethod(method: ClassifiedMethod): string {
  const { operation } = method;
  const lines: string[] = [];
  const indent = "    ";

  lines.push(`${indent}${method.name}: {`);
  lines.push(`${indent}  description: "${escapeStr(method.description)}",`);
  lines.push(`${indent}  arguments: ${generateArgsSchema(operation)},`);

  const bodyLines = generateExecuteBody(method, indent);
  const argsParam = bodyReferencesArgs(bodyLines) ? "args" : "_args";
  lines.push(
    `${indent}  execute: async (${argsParam}: Record<string, unknown>, context: { globalArgs: Record<string, string>; writeResource: (spec: string, instance: string, data: unknown) => Promise<{ name: string }>; logger: { info: (msg: string, props: Record<string, unknown>) => void } }) => {`,
  );
  lines.push(...bodyLines);

  lines.push(`${indent}  },`);
  lines.push(`${indent}},`);

  return lines.join("\n");
}

/** True when generated body text references the `args` parameter. */
export function bodyReferencesArgs(bodyLines: string[]): boolean {
  const code = bodyLines
    .join("\n")
    .replace(/\/\/[^\n]*/g, "");
  return /(^|[^.\w])args\b/.test(code);
}

/** Generate the statements inside a method's execute function */
function generateExecuteBody(
  method: ClassifiedMethod,
  indent: string,
): string[] {
  const { type } = method;
  const lines: string[] = [];

  const apiPath = buildApiPath(method.operation.path);

  lines.push(`${indent}    const { apiToken } = context.globalArgs;`);

  if (type === "list") {
    lines.push(generateListBody(method, apiPath, indent));
  } else if (type === "get") {
    lines.push(generateGetBody(method, apiPath, indent));
  } else if (type === "create") {
    lines.push(generateCreateBody(method, apiPath, indent));
  } else if (type === "update") {
    lines.push(generateUpdateBody(method, apiPath, indent));
  } else if (type === "delete") {
    lines.push(generateDeleteBody(method, apiPath, indent));
  } else {
    lines.push(generateActionBody(method, apiPath, indent));
  }

  return lines;
}

/** Generate the arguments schema for a method */
function generateArgsSchema(op: GroupedOperation): string {
  const fields: string[] = [];
  const seenFields = new Set<string>();

  for (const p of op.pathParams) {
    const fieldName = sanitizeFieldName(p.name);
    if (seenFields.has(fieldName)) continue;
    seenFields.add(fieldName);
    const desc = p.description
      ? `.describe("${escapeStr(p.description)}")`
      : "";
    fields.push(`  ${fieldName}: z.string()${desc},`);
  }

  for (const p of op.queryParams) {
    const fieldName = sanitizeFieldName(p.name);
    if (seenFields.has(fieldName)) continue;
    seenFields.add(fieldName);
    const desc = p.description
      ? `.describe("${escapeStr(p.description)}")`
      : "";
    // Delegate to the type mapper rather than hand-rolling a switch, so
    // fal.ai's OpenAPI 3.1 `type: [T, "null"]` array form, enums, and nested
    // arrays are handled identically to every other schema in this file.
    const zodType = p.schema
      ? schemaToZod(p.schema, { indent: 2 }, 2)
      : "z.string()";
    fields.push(`  ${fieldName}: ${zodType}.optional()${desc},`);
  }

  if (op.requestBody?.type === "array" && op.requestBody.items) {
    const itemZod = schemaToZod(op.requestBody.items, { indent: 2 }, 2);
    const desc = op.requestBody.description
      ? `.describe("${escapeStr(truncateStr(op.requestBody.description))}")`
      : "";
    if (!seenFields.has("items")) {
      seenFields.add("items");
      fields.push(`  items: z.array(${itemZod})${desc},`);
    }
  } else if (op.requestBody?.oneOf) {
    const variantZods = op.requestBody.oneOf.map((variant) =>
      schemaToZod(variant, { indent: 2 }, 2)
    );
    const desc = op.requestBody.description
      ? `.describe("${escapeStr(truncateStr(op.requestBody.description))}")`
      : "";
    if (!seenFields.has("body")) {
      seenFields.add("body");
      if (variantZods.length === 1) {
        fields.push(`  body: ${variantZods[0]}${desc},`);
      } else {
        fields.push(`  body: z.union([${variantZods.join(", ")}])${desc},`);
      }
    }
  } else if (op.requestBody?.properties) {
    const required = new Set(op.requestBody.required ?? []);
    for (const [name, prop] of Object.entries(op.requestBody.properties)) {
      if (name === "id") continue;
      const fieldName = sanitizeFieldName(name);
      if (seenFields.has(fieldName)) continue;
      seenFields.add(fieldName);
      const fieldZod = schemaToZod(prop, { indent: 2 }, 2);
      const optSuffix = required.has(name) ? "" : ".optional()";
      const desc = prop.description
        ? `.describe("${escapeStr(truncateStr(prop.description))}")`
        : "";
      fields.push(`  ${fieldName}: ${fieldZod}${optSuffix}${desc},`);
    }
  }

  if (fields.length === 0) {
    return "z.object({})";
  }

  return `z.object({\n${fields.join("\n")}\n    })`;
}

/** Generate list method body */
function generateListBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const pathParamNames = method.operation.pathParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const resultsField = method.operation.pagination.resultsField ??
    resourceName;

  if (method.operation.pagination.paginated) {
    const excludeNames = [...pathParamNames, "limit", "cursor"];
    return `${indent}    const startMs = Date.now();
${indent}    const params: Record<string, string | string[]> = {};
${indent}    const excludeKeys = new Set<string>(${
      JSON.stringify(excludeNames)
    });
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (v === undefined || v === null || excludeKeys.has(k)) continue;
${indent}      params[k] = Array.isArray(v) ? v.map(String) : String(v);
${indent}    }
${indent}    const requestedLimit = args.limit !== undefined
${indent}      ? Number(args.limit)
${indent}      : undefined;
${indent}    const requestedCursor = typeof args.cursor === "string"
${indent}      ? args.cursor
${indent}      : undefined;
${indent}
${indent}    const { results, truncated } = await falApiPaginated<Record<string, unknown>>(
${indent}      apiToken,
${indent}      \`${apiPath}\`,
${indent}      "${resultsField}",
${indent}      params,
${indent}      { limit: requestedLimit, cursor: requestedCursor },
${indent}    );
${indent}
${indent}    if (truncated) {
${indent}      context.logger.info("WARNING: results truncated at {count} (pagination cap)", { count: results.length });
${indent}    }
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", "main", {
${indent}      items: results,
${indent}      truncated,
${indent}      fetchedAt: new Date().toISOString(),
${indent}      durationMs: Date.now() - startMs,
${indent}      collectedBy: EXTENSION_NAME,
${indent}    });
${indent}
${indent}    context.logger.info("Found {count} ${resourceName}", { count: results.length });
${indent}    return { dataHandles: [handle] };`;
  }

  // Unpaginated list (no limit/cursor params) — single fetch.
  const excludeNames = [...pathParamNames];
  const hasLimit = method.operation.queryParams.some((p) =>
    sanitizeFieldName(p.name) === "limit"
  );
  return `${indent}    const startMs = Date.now();
${indent}    const params = new URLSearchParams();
${indent}    const excludeKeys = new Set<string>(${
    JSON.stringify(excludeNames)
  });
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (v === undefined || v === null || excludeKeys.has(k)) continue;
${indent}      if (Array.isArray(v)) {
${indent}        for (const item of v) params.append(k, String(item));
${indent}      } else {
${indent}        params.append(k, String(v));
${indent}      }
${indent}    }
${indent}    const qs = params.toString();
${indent}    const url = qs ? \`${apiPath}?\${qs}\` : \`${apiPath}\`;
${indent}
${indent}    const result = await falApi<Record<string, unknown>>(apiToken, "GET", url);
${indent}    const items = ((result as Record<string, unknown>)["${resultsField}"] ?? []) as unknown[];
${indent}${
    hasLimit
      ? `    // No cursor/offset in this response: a full page equal to the
${indent}    // requested limit means more results may exist that we didn't fetch.
${indent}    const limit = args.limit !== undefined ? Number(args.limit) : undefined;
${indent}    const truncated = limit !== undefined && items.length === limit;
${indent}`
      : `    const truncated = false;
${indent}`
  }
${indent}    const handle = await context.writeResource("${resourceName}", "main", {
${indent}      items,
${indent}      truncated,
${indent}      fetchedAt: new Date().toISOString(),
${indent}      durationMs: Date.now() - startMs,
${indent}      collectedBy: EXTENSION_NAME,
${indent}    });
${indent}
${indent}    context.logger.info("Found {count} ${resourceName}", { count: items.length });
${indent}    return { dataHandles: [handle] };`;
}

/** Generate get method body */
function generateGetBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = method.name.replace(/^get_/, "");
  const instanceExpr = buildPathParamInstanceExpr(
    method.operation.pathParams,
    '"latest"',
  );
  const { queryBuild, pathSuffix } = buildQueryString(method, indent);

  return `${queryBuild}
${indent}    const result = await falApi<Record<string, unknown>>(
${indent}      apiToken,
${indent}      "GET",
${indent}      \`${apiPath}${pathSuffix}\`,
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", ${instanceExpr}, result);
${indent}    context.logger.info("Fetched ${resourceName}", {});
${indent}    return { dataHandles: [handle] };`;
}

/**
 * Build the resource instance-name expression from a method's path
 * parameters. fal.ai paths are frequently scoped by more than one segment
 * (e.g. `/serverless/apps/{owner}/{name}/queue`) — using only the last path
 * param drops the scoping segment and collides two different owners' same-
 * named resources onto one instance. Every path param is joined into the
 * instance name to keep it collision-resistant.
 */
function buildPathParamInstanceExpr(
  pathParams: ParameterObject[],
  fallback: string,
): string {
  if (pathParams.length === 0) return fallback;
  if (pathParams.length === 1) {
    return `sanitizeInstanceName(String(args.${
      sanitizeFieldName(pathParams[0].name)
    }))`;
  }
  const parts = pathParams
    .map((p) => `String(args.${sanitizeFieldName(p.name)})`)
    .join(", ");
  return `sanitizeInstanceName([${parts}].join("_"))`;
}

/**
 * Build the query-string assembly statements shared by every method type
 * that can carry query parameters — including `get`, which cloudflare-codegen's
 * reference pattern omits (get-by-id endpoints rarely take query params on
 * Cloudflare's API, but fal.ai's getAccountBilling/getFocusReport etc. do).
 */
function buildQueryString(
  method: ClassifiedMethod,
  indent: string,
): { queryBuild: string; pathSuffix: string; queryParamNames: string[] } {
  const queryParamNames = method.operation.queryParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const hasQueryParams = queryParamNames.length > 0;
  const queryBuild = hasQueryParams
    ? `\n${indent}    const queryParts: string[] = [];
${indent}    const queryKeys = new Set(${JSON.stringify(queryParamNames)});
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (v === undefined || v === null || !queryKeys.has(k)) continue;
${indent}      if (Array.isArray(v)) {
${indent}        for (const item of v) queryParts.push(\`\${k}=\${encodeURIComponent(String(item))}\`);
${indent}      } else {
${indent}        queryParts.push(\`\${k}=\${encodeURIComponent(String(v))}\`);
${indent}      }
${indent}    }
${indent}    const qs = queryParts.length > 0 ? \`?\${queryParts.join("&")}\` : "";`
    : "";
  const pathSuffix = hasQueryParams ? "${qs}" : "";
  return { queryBuild, pathSuffix, queryParamNames };
}

function buildParamAndBodySetup(
  method: ClassifiedMethod,
  indent: string,
): {
  queryBuild: string;
  pathSuffix: string;
  bodySetup: string;
  bodyArg: string;
} {
  const pathParamNames = method.operation.pathParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const { queryBuild, pathSuffix, queryParamNames } = buildQueryString(
    method,
    indent,
  );
  const excludeNames = [...pathParamNames, ...queryParamNames];

  const reqBody = method.operation.requestBody;
  const hasBody = reqBody !== undefined;
  let bodySetup = "";
  let bodyArg = "";
  if (hasBody && reqBody?.type === "array") {
    bodySetup = `\n${indent}    const body = args.items;\n`;
    bodyArg = `\n${indent}      body,`;
  } else if (hasBody && reqBody?.oneOf) {
    bodySetup = `\n${indent}    const body = args.body;\n`;
    bodyArg = `\n${indent}      body,`;
  } else if (hasBody && excludeNames.length > 0) {
    bodySetup = `\n${indent}    const body: Record<string, unknown> = {};
${indent}    const excludeKeys = new Set(${JSON.stringify(excludeNames)});
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (!excludeKeys.has(k)) body[k] = v;
${indent}    }\n`;
    bodyArg = `\n${indent}      body,`;
  } else if (hasBody) {
    bodyArg = `\n${indent}      args,`;
  }

  return { queryBuild, pathSuffix, bodySetup, bodyArg };
}

/**
 * Search a response schema's properties for an id-shaped field, one level
 * deep. fal.ai frequently wraps a create response in a single named object
 * (e.g. `{ collection: { id, ... } }`, `{ asset: { asset_id, ... } }`)
 * instead of echoing the id at the top level, so a top-level-only search
 * misses it.
 */
function findIdAccessor(
  schema: SchemaObject | undefined,
  depth = 0,
): string[] | undefined {
  if (!schema?.properties || depth > 1) return undefined;
  if ("id" in schema.properties) return ["id"];
  const idLike = Object.keys(schema.properties).find((k) => /_id$/.test(k));
  if (idLike) return [idLike];
  if (depth === 0) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.properties) {
        const nested = findIdAccessor(prop, depth + 1);
        if (nested) return [key, ...nested];
      }
    }
  }
  return undefined;
}

/**
 * Fallback search for a "name" field when no id-shaped field exists
 * anywhere in the response — some fal.ai resources are addressed by name
 * rather than id (e.g. `createWorkflow` returns `{ workflow: { name, ... } }`
 * with no id field at all).
 */
function findNameAccessor(
  schema: SchemaObject | undefined,
  depth = 0,
): string[] | undefined {
  if (!schema?.properties || depth > 1) return undefined;
  if ("name" in schema.properties) return ["name"];
  if (depth === 0) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.properties) {
        const nested = findNameAccessor(prop, depth + 1);
        if (nested) return [key, ...nested];
      }
    }
  }
  return undefined;
}

/**
 * Resolve how to read a newly created resource's identifier out of its
 * response body — as a property-access path, searching id-shaped fields
 * first (top level, then one level of wrapping), then name-shaped fields.
 * Returns undefined when the response carries no discoverable identifier at
 * all (e.g. `{ success: true }`, `{ signed_url: "..." }`), in which case the
 * caller must derive the instance name from the request instead.
 */
function resolveIdAccessor(method: ClassifiedMethod): string[] | undefined {
  const schema = method.operation.responseSchema;
  return findIdAccessor(schema) ?? findNameAccessor(schema);
}

/** Build the TS expression that reads an accessor path off `result`. */
function buildAccessorExpr(accessor: string[]): string {
  let expr = `(result as Record<string, unknown>)["${accessor[0]}"]`;
  for (const key of accessor.slice(1, -1)) {
    expr = `(${expr} as Record<string, unknown> | undefined)?.["${key}"]`;
  }
  if (accessor.length > 1) {
    const last = accessor[accessor.length - 1];
    expr = `(${expr} as Record<string, unknown> | undefined)?.["${last}"]`;
  }
  return expr;
}

/** Generate create method body */
function generateCreateBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = method.name.replace(/^create_/, "");
  const { queryBuild, pathSuffix, bodySetup } = buildParamAndBodySetup(
    method,
    indent,
  );
  const accessor = resolveIdAccessor(method);
  const idStatement = accessor
    ? `${indent}    const id = sanitizeInstanceName(String(${
      buildAccessorExpr(accessor)
    } ?? "created"));`
    : `${indent}    // No id- or name-shaped field anywhere in this response —
${indent}    // derive a deterministic, collision-resistant instance name
${indent}    // from the request instead of colliding every call onto "created".
${indent}    const id = sanitizeInstanceName(await shortHash(JSON.stringify(args)));`;
  const sensitiveFields = SENSITIVE_RESPONSE_FIELDS[method.operation.operationId];

  const redactBlock = sensitiveFields?.length
    ? `\n${indent}    // ${
      JSON.stringify(sensitiveFields)
    } are one-time credential fields fal.ai never
${indent}    // returns again — persisting them would expose them to anyone with
${indent}    // datastore read access, so they are dropped before writeResource.
${indent}    const stored: Record<string, unknown> = { ...result };
${indent}    for (const field of ${JSON.stringify(sensitiveFields)}) {
${indent}      delete stored[field];
${indent}    }\n`
    : "";
  const storedVar = sensitiveFields?.length ? "stored" : "result";

  return `${bodySetup}${queryBuild}
${indent}
${indent}    const result = await falApi<Record<string, unknown>>(
${indent}      apiToken,
${indent}      "POST",
${indent}      \`${apiPath}${pathSuffix}\`,
${indent}      ${bodySetup ? "body" : "args"},
${indent}    );
${redactBlock}${indent}
${idStatement}
${indent}    const handle = await context.writeResource("${resourceName}", id, ${storedVar});
${indent}    context.logger.info("Created ${resourceName} {id}", { id });
${indent}    return { dataHandles: [handle] };`;
}

/** Generate update method body */
function generateUpdateBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = method.name.replace(/^update_/, "");
  const httpMethod = method.operation.httpMethod.toUpperCase();
  const instanceExpr = buildPathParamInstanceExpr(
    method.operation.pathParams,
    '"updated"',
  );
  const { queryBuild, pathSuffix, bodySetup } = buildParamAndBodySetup(
    method,
    indent,
  );

  return `${bodySetup}${queryBuild}
${indent}
${indent}    const result = await falApi<Record<string, unknown>>(
${indent}      apiToken,
${indent}      "${httpMethod}",
${indent}      \`${apiPath}${pathSuffix}\`,
${indent}      ${bodySetup ? "body" : "args"},
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", ${instanceExpr}, result);
${indent}    context.logger.info("Updated ${resourceName}", {});
${indent}    return { dataHandles: [handle] };`;
}

/** Generate delete method body */
function generateDeleteBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const idParam = method.operation.pathParams[
    method.operation.pathParams.length - 1
  ];
  const idRef = idParam
    ? `args.${sanitizeFieldName(idParam.name)}`
    : '"unknown"';

  const { queryBuild, pathSuffix, bodySetup, bodyArg } = buildParamAndBodySetup(
    method,
    indent,
  );

  return `${bodySetup}${queryBuild}
${indent}    await falApi(
${indent}      apiToken,
${indent}      "DELETE",
${indent}      \`${apiPath}${pathSuffix}\`,${bodyArg}
${indent}    );
${indent}
${indent}    context.logger.info("Deleted resource {id}", { id: ${idRef} });
${indent}    return { dataHandles: [] };`;
}

/** Generate action method body */
function generateActionBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = method.name.replace(/^action_/, "");
  const httpMethod = method.operation.httpMethod.toUpperCase();
  const { queryBuild, pathSuffix, bodySetup, bodyArg } = buildParamAndBodySetup(
    method,
    indent,
  );

  return `${bodySetup}${queryBuild}
${indent}    const result = await falApi<Record<string, unknown>>(
${indent}      apiToken,
${indent}      "${httpMethod}",
${indent}      \`${apiPath}${pathSuffix}\`,${bodyArg}
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", "latest", result ?? {});
${indent}    context.logger.info("Executed ${method.name}", {});
${indent}    return { dataHandles: [handle] };`;
}

/** Build the API path with template literal substitution */
/**
 * A path parameter value flows straight from caller input into a URL path
 * segment. Left bare, a value like "abc/../../admin" changes which path
 * segment fetch() actually requests. encodeURIComponent keeps every path
 * param confined to its own segment.
 */
function buildApiPath(path: string): string {
  return path.replace(
    /\{([^}]+)\}/g,
    (_, name) =>
      `\${encodeURIComponent(String(args.${sanitizeFieldName(name)}))}`,
  );
}

function sanitizeFieldName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/^\d/, "_$&");
}

/**
 * True when a method's generated body references sanitizeInstanceName.
 *   - create: always
 *   - get / update: only when a trailing path param supplies the instance id
 *   - list ("main"), action ("latest"), delete (no resource): never
 */
function methodEmitsSanitize(method: ClassifiedMethod): boolean {
  if (method.type === "create") return true;
  if (method.type === "get" || method.type === "update") {
    return method.operation.pathParams.length > 0;
  }
  return false;
}

function toPascalCase(name: string): string {
  return name
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Append `.passthrough()` to a generated object schema so unknown API-returned
 * fields survive validation instead of being stripped.
 */
function withPassthrough(zodExpr: string): string {
  if (!zodExpr.startsWith("z.object({")) return zodExpr;
  if (zodExpr.endsWith(".nullable()")) {
    return `${
      zodExpr.slice(0, -".nullable()".length)
    }.passthrough().nullable()`;
  }
  return `${zodExpr}.passthrough()`;
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function truncateStr(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= 80 ? oneLine : oneLine.slice(0, 77) + "...";
}
