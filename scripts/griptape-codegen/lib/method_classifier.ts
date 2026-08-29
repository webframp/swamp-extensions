/**
 * Method classifier — determines the swamp method type for each Griptape
 * operation and generates the model source code.
 *
 * Classifies operations as:
 * - list: GET returning a resource-named collection
 * - get: GET returning a single item
 * - create: POST that creates a resource (returns 201 with the entity)
 * - update: PUT/PATCH
 * - delete: DELETE
 * - action: POST that performs an operation without creating a durable,
 *   id-addressable resource (Run*, Query*, Search*, Cancel*, Refresh*, ...).
 *   Griptape is run-oriented, so actions are common.
 */

import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import { schemaToZod } from "./type_mapper.ts";
import { ZOD_VERSION } from "../config.ts";
import type { ServiceConfig } from "../config.ts";

export type MethodType =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "action";

export interface ClassifiedMethod {
  /** swamp method name (e.g., list_threads, get_thread, create_thread). */
  name: string;
  /** The classification. */
  type: MethodType;
  /** Description for the method. */
  description: string;
  /** The original operation. */
  operation: GroupedOperation;
}

/**
 * Leading verbs (from PascalCase operationIds) that map to a POST "action"
 * rather than a resource "create". These POST but return a run/job/result
 * envelope keyed by its own id, not a durable CRUD resource the caller then
 * gets/updates/deletes by the same path.
 */
const ACTION_VERBS = new Set([
  "run",
  "query",
  "search",
  "cancel",
  "refresh",
  "execute",
  "start",
  "send",
  "save",
  "allocate",
  "renew",
  "release",
  "chat",
]);

/** Split a PascalCase operationId into lowercase words (CreateThread -> [create, thread]). */
export function splitOperationId(operationId: string): string[] {
  return operationId
    // Boundary between a lowercase/digit and an uppercase letter.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Boundary between an acronym run and a following word (APIKey -> API Key).
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Classify an operation into a swamp method type. */
export function classifyOperation(op: GroupedOperation): MethodType {
  const { httpMethod } = op;
  const words = splitOperationId(op.operationId);
  const verb = words[0] ?? "";

  switch (httpMethod) {
    case "get":
      // isCollection is set only for List* operations (see extractResponseSchema),
      // so it and the operationId verb agree; prefer the verb when present.
      if (verb === "list" || op.isCollection) return "list";
      return "get";
    case "post":
      if (ACTION_VERBS.has(verb)) return "action";
      if (verb === "create") return "create";
      // A POST whose response is a collection is a query-style action.
      if (op.isCollection) return "action";
      return "action";
    case "put":
    case "patch":
      // A PUT/PATCH named Create* creates/replaces a named resource (e.g.
      // SaveBucketAsset = PUT /buckets/{id}/assets, operationId CreateAsset).
      // Treat it as a create so instance-name resolution keys on the entity's
      // own identifier, not the last path param (the parent bucket).
      if (verb === "create") return "create";
      return "update";
    case "delete":
      return "delete";
    default:
      return "action";
  }
}

/**
 * Generate a swamp method name from a PascalCase operationId.
 *
 * CreateThread            -> create_thread
 * ListThreadMessages      -> list_thread_messages
 * CancelAssistantRun      -> cancel_assistant_run
 * CreateAssistantRun      -> create_assistant_run (action; verb kept)
 * GetToolOpenapi          -> get_tool_openapi
 */
export function generateMethodName(
  op: GroupedOperation,
  type: MethodType,
): string {
  const words = splitOperationId(op.operationId);
  if (words.length === 0) {
    return sanitizeMethodName(`${type}_resource`);
  }

  const name = words.join("_");

  // If the operationId already begins with an English verb, keep it verbatim
  // (create_thread, list_threads, cancel_assistant_run). Otherwise prefix the
  // classification so the name reads as an action.
  const knownVerbs = new Set([
    "list",
    "get",
    "create",
    "update",
    "delete",
    "cancel",
    "refresh",
    "run",
    "query",
    "search",
    "execute",
    "start",
    "send",
    "save",
    "allocate",
    "renew",
    "release",
    "chat",
  ]);
  if (knownVerbs.has(words[0])) return sanitizeMethodName(name);
  if (type === "action") return sanitizeMethodName(name);
  return sanitizeMethodName(`${type}_${name}`);
}

/** Sanitize a method name to a valid TypeScript identifier. */
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

/** The type of the swamp resource each method's data is written under. */
function resourceNameFor(method: ClassifiedMethod): string {
  const { name, type } = method;
  if (type === "list") return name.replace(/^list_/, "");
  return name.replace(
    /^(get|create|update|cancel|refresh|run|query|search|execute|start|send|save|allocate|renew|release|chat)_/,
    "",
  );
}

/** Generate the complete model TypeScript source file for a service. */
export function generateModelSource(
  group: ServiceGroup,
  methods: ClassifiedMethod[],
  version: string,
  upgradesBlock = "  upgrades: [],",
): string {
  const { config } = group;
  const modelType = `@webframp/griptape/${config.name}`;

  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * ${config.description}`);
  lines.push(` *`);
  lines.push(
    ` * Auto-generated by scripts/griptape-codegen — do not edit manually.`,
  );
  lines.push(` *`);
  lines.push(` * @module`);
  lines.push(` */`);
  lines.push(`// SPDX-License-Identifier: Apache-2.0`);
  lines.push(``);
  lines.push(`import { z } from "npm:zod@${ZOD_VERSION}";`);

  // Import only the helpers actually referenced.
  const usesApi = methods.some((m) => m.type !== "list");
  const usesPaginated = methods.some((m) => m.type === "list");
  const usesSanitize = methods.some(methodEmitsSanitize);
  const apiImports: string[] = [];
  if (usesApi) apiImports.push("griptapeApi");
  if (usesPaginated) apiImports.push("griptapeApiPaginated");
  if (usesSanitize) apiImports.push("sanitizeInstanceName");
  if (apiImports.length > 0) {
    lines.push(`import { ${apiImports.join(", ")} } from "./_lib/api.ts";`);
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

  // Resources
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

  // Methods
  lines.push(`  methods: {`);
  for (const method of methods) {
    lines.push(generateMethod(method, config, schemaNames));
  }
  lines.push(`  },`);
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

/** GlobalArgsSchema — single Griptape scope (apiKey + optional baseUrl). */
function generateGlobalArgsSchema(): string {
  return [
    `const GlobalArgsSchema = z.object({`,
    `  apiKey: z.string().meta({ sensitive: true }).describe("Griptape Cloud API key; overrides the GT_CLOUD_API_KEY environment variable. Wire with a vault.get(...) expression to source it from a vault.").optional(),`,
    `  baseUrl: z.string().describe("Griptape Cloud API base URL; overrides the GT_CLOUD_BASE_URL environment variable and the built-in default.").optional(),`,
    `});`,
  ].join("\n");
}

/** Generate Zod schemas for all unique response shapes. */
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
      const itemVarName = toPascalCase(resourceNameFor(method)) + "ItemSchema";
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

  // Map non-primary methods sharing a resource to the primary's schema var.
  for (const method of methods) {
    if (method.type === "delete") continue;
    if (schemaNames.has(method.name)) continue;
    const resourceName = resourceNameFor(method);
    const primary = methodsWithResources.find((m) =>
      resourceNameFor(m) === resourceName
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

/** Generate a single method definition. */
function generateMethod(
  method: ClassifiedMethod,
  config: ServiceConfig,
  _schemaNames: Map<string, string>,
): string {
  const { operation } = method;
  const lines: string[] = [];
  const indent = "    ";

  lines.push(`${indent}${method.name}: {`);
  lines.push(`${indent}  description: "${escapeStr(method.description)}",`);
  lines.push(`${indent}  arguments: ${generateArgsSchema(operation)},`);

  const bodyLines = generateExecuteBody(method, config, indent);
  const argsParam = bodyReferencesArgs(bodyLines) ? "args" : "_args";
  lines.push(
    `${indent}  execute: async (${argsParam}: Record<string, unknown>, context: { globalArgs: Record<string, string>; writeResource: (spec: string, instance: string, data: unknown) => Promise<{ name: string }>; logger: { info: (msg: string, props: Record<string, unknown>) => void } }) => {`,
  );
  lines.push(...bodyLines);
  lines.push(`${indent}  },`);
  lines.push(`${indent}},`);

  return lines.join("\n");
}

/**
 * True when generated body text references the `args` parameter (comments
 * stripped, word-boundary matched). Exported for direct unit testing.
 */
export function bodyReferencesArgs(bodyLines: string[]): boolean {
  const code = bodyLines.join("\n").replace(/\/\/[^\n]*/g, "");
  return /(^|[^.\w])args\b/.test(code);
}

/** True when the method's body will emit a sanitizeInstanceName(...) call. */
function methodEmitsSanitize(method: ClassifiedMethod): boolean {
  const { type, operation } = method;
  if (type === "create") return true;
  if (
    (type === "get" || type === "update") && operation.pathParams.length > 0
  ) {
    return true;
  }
  // Actions key on their path param when they have one.
  if (type === "action" && operation.pathParams.length > 0) return true;
  return false;
}

/** Generate the statements inside a method's execute function. */
function generateExecuteBody(
  method: ClassifiedMethod,
  _config: ServiceConfig,
  indent: string,
): string[] {
  const { operation, type } = method;
  const lines: string[] = [];
  const apiPath = buildApiPath(operation.path);

  lines.push(`${indent}    const { apiKey, baseUrl } = context.globalArgs;`);

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

/** Build the runtime API path template, substituting path params from args.
 *
 * Path-param values are percent-encoded: Griptape asset names and other path
 * segments can contain "/", spaces, "?", "#", which would otherwise corrupt the
 * request URL or its framing. encodeURIComponent is applied at the interpolation
 * site so the generated template is safe by construction.
 */
export function buildApiPath(path: string): string {
  return path.replace(
    /\{([^}]+)\}/g,
    (_m, name: string) =>
      `\${encodeURIComponent(String(args.${sanitizeFieldName(name)}))}`,
  );
}

/** Generate the arguments schema for a method. */
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
    let zodType = "z.string()";
    if (p.schema?.type === "integer" || p.schema?.type === "number") {
      zodType = "z.number()";
    } else if (p.schema?.type === "boolean") {
      zodType = "z.boolean()";
    } else if (p.schema?.enum) {
      const vals = (p.schema.enum as string[]).map((v) =>
        `"${escapeStr(String(v))}"`
      );
      zodType = `z.enum([${vals.join(", ")}])`;
    }
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
    const variantZods = op.requestBody.oneOf.map((v) =>
      schemaToZod(v, { indent: 2 }, 2)
    );
    if (!seenFields.has("body")) {
      seenFields.add("body");
      fields.push(
        variantZods.length === 1
          ? `  body: ${variantZods[0]},`
          : `  body: z.union([${variantZods.join(", ")}]),`,
      );
    }
  } else if (op.requestBody?.properties) {
    const required = new Set(op.requestBody.required ?? []);
    for (const [name, prop] of Object.entries(op.requestBody.properties)) {
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

  if (fields.length === 0) return "z.object({})";
  return `z.object({\n${fields.join("\n")}\n    })`;
}

/** Generate list method body — reads the recorded resource-named array key. */
function generateListBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const itemsKey = method.operation.listItemsKey ?? "data";
  const pathParamNames = method.operation.pathParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const excludeNames = [...pathParamNames, "page", "page_size"];

  return `${indent}    const startMs = Date.now();
${indent}    const params: Record<string, string> = {};
${indent}    const excludeKeys = new Set(${JSON.stringify(excludeNames)});
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (v !== undefined && !excludeKeys.has(k)) params[k] = String(v);
${indent}    }
${indent}
${indent}    const { results, truncated } = await griptapeApiPaginated<Record<string, unknown>>(
${indent}      apiKey,
${indent}      \`${apiPath}\`,
${indent}      "${itemsKey}",
${indent}      params,
${indent}      baseUrl,
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

/** Generate get method body. */
function generateGetBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const idParam = lastPathParam(method);
  const instanceExpr = idParam
    ? `sanitizeInstanceName(String(args.${sanitizeFieldName(idParam.name)}))`
    : '"latest"';

  return `${indent}    const result = await griptapeApi<Record<string, unknown>>(
${indent}      apiKey,
${indent}      "GET",
${indent}      \`${apiPath}\`,
${indent}      undefined,
${indent}      baseUrl,
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", ${instanceExpr}, result);
${indent}    context.logger.info("Fetched ${resourceName}", {});
${indent}    return { dataHandles: [handle] };`;
}

/** Generate create method body. Instance name keyed on the entity's own id. */
function generateCreateBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const bodyFilter = buildBodyFilter(method, indent);
  const httpMethod = method.operation.httpMethod.toUpperCase();
  const candidates = entityIdCandidates(method);
  const pathParamRefs = method.operation.pathParams.map((p) =>
    `String(args.${sanitizeFieldName(p.name)})`
  );

  return `${bodyFilter}
${indent}
${indent}    const result = await griptapeApi<Record<string, unknown>>(
${indent}      apiKey,
${indent}      "${httpMethod}",
${indent}      \`${apiPath}\`,
${indent}      body,
${indent}      baseUrl,
${indent}    );
${indent}
${indent}    const record = result as Record<string, unknown>;
${indent}    const pathParamValues = new Set<string>([${
    pathParamRefs.join(", ")
  }]);
${indent}    const idCandidates = ${JSON.stringify(candidates)};
${indent}    let rawId = idCandidates.map((k) => record[k]).find((v) => v !== undefined && v !== null && v !== "");
${indent}    if (rawId === undefined) {
${indent}      // No named id candidate matched. Scan for a single id-shaped key that is
${indent}      // not organization_id and whose value is not a path param (the parent
${indent}      // addressing context, e.g. bucket_id on an asset — would collide).
${indent}      for (const [k, v] of Object.entries(record)) {
${indent}        if (/(^|_)id$/.test(k) && k !== "organization_id" && typeof v === "string" && v !== "" && !pathParamValues.has(v)) {
${indent}          rawId = v;
${indent}          break;
${indent}        }
${indent}      }
${indent}    }
${indent}    if (rawId === undefined && typeof record.name === "string" && record.name !== "") {
${indent}      rawId = record.name;
${indent}    }
${indent}    const fallbackId = [${
    pathParamRefs.join(", ")
  }].filter((s: string) => s && s !== "undefined").join("_") || "created";
${indent}    const id = sanitizeInstanceName(String(rawId ?? fallbackId));
${indent}    const handle = await context.writeResource("${resourceName}", id, result);
${indent}    context.logger.info("Created ${resourceName} {id}", { id });
${indent}    return { dataHandles: [handle] };`;
}

/** Generate update method body. */
function generateUpdateBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const httpMethod = method.operation.httpMethod.toUpperCase();
  const idParam = lastPathParam(method);
  const instanceExpr = idParam
    ? `sanitizeInstanceName(String(args.${sanitizeFieldName(idParam.name)}))`
    : '"updated"';
  const bodyFilter = buildBodyFilter(method, indent);

  return `${bodyFilter}
${indent}
${indent}    const result = await griptapeApi<Record<string, unknown>>(
${indent}      apiKey,
${indent}      "${httpMethod}",
${indent}      \`${apiPath}\`,
${indent}      body,
${indent}      baseUrl,
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", ${instanceExpr}, result);
${indent}    context.logger.info("Updated ${resourceName}", {});
${indent}    return { dataHandles: [handle] };`;
}

/** Generate delete method body. */
function generateDeleteBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const idParam = lastPathParam(method);
  const idRef = idParam
    ? `args.${sanitizeFieldName(idParam.name)}`
    : '"unknown"';

  return `${indent}    await griptapeApi<Record<string, unknown>>(
${indent}      apiKey,
${indent}      "DELETE",
${indent}      \`${apiPath}\`,
${indent}      undefined,
${indent}      baseUrl,
${indent}    );
${indent}
${indent}    context.logger.info("Deleted resource {id}", { id: ${idRef} });
${indent}    return { dataHandles: [] };`;
}

/** Generate action method body (Run/Query/Search/Cancel/Refresh/...). */
function generateActionBody(
  method: ClassifiedMethod,
  apiPath: string,
  indent: string,
): string {
  const resourceName = resourceNameFor(method);
  const httpMethod = method.operation.httpMethod.toUpperCase();
  const hasBody = httpMethod === "POST" || httpMethod === "PUT" ||
    httpMethod === "PATCH";
  const bodyFilter = hasBody ? buildBodyFilter(method, indent) : "";
  const bodyArg = hasBody
    ? `\n${indent}      body,`
    : `\n${indent}      undefined,`;

  // Key the instance on the acted-on resource's path param (structure_id,
  // structure_run_id, ...) so distinct targets do not collide. Only actions
  // with NO path param (a genuine singleton/collection-level action) fall back
  // to the constant "latest".
  const idParam = lastPathParam(method);
  const instanceExpr = idParam
    ? `sanitizeInstanceName(String(args.${sanitizeFieldName(idParam.name)}))`
    : '"latest"';

  return `${bodyFilter}
${indent}    const result = await griptapeApi<Record<string, unknown>>(
${indent}      apiKey,
${indent}      "${httpMethod}",
${indent}      \`${apiPath}\`,${bodyArg}
${indent}      baseUrl,
${indent}    );
${indent}
${indent}    const handle = await context.writeResource("${resourceName}", ${instanceExpr}, result);
${indent}    context.logger.info("Ran ${method.name}", {});
${indent}    return { dataHandles: [handle] };`;
}

/**
 * Build the `const body = ...` statement for create/update/action bodies,
 * choosing the shape by request-body kind (array -> items, oneOf -> body,
 * object -> args minus path/query params).
 */
function buildBodyFilter(method: ClassifiedMethod, indent: string): string {
  const reqBody = method.operation.requestBody;
  const pathParamNames = method.operation.pathParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const queryParamNames = method.operation.queryParams.map((p) =>
    sanitizeFieldName(p.name)
  );
  const excludeNames = [...pathParamNames, ...queryParamNames];

  if (reqBody?.type === "array") {
    return `${indent}    const body = args.items;`;
  }
  if (reqBody?.oneOf) {
    return `${indent}    const body = args.body;`;
  }
  if (excludeNames.length > 0) {
    return `${indent}    const body: Record<string, unknown> = {};
${indent}    const excludeKeys = new Set(${JSON.stringify(excludeNames)});
${indent}    for (const [k, v] of Object.entries(args)) {
${indent}      if (!excludeKeys.has(k)) body[k] = v;
${indent}    }`;
  }
  return `${indent}    const body = args;`;
}

/**
 * The resource-id path parameter for get/update/delete — the LAST `{placeholder}`
 * in the URL template, matched back to its ParameterObject.
 *
 * OpenAPI does not guarantee `parameters` are declared in URL order: GetAsset on
 * `/api/buckets/{bucket_id}/assets/{name}` declares `[name, bucket_id]`, so the
 * naive "last declared param" is `bucket_id` (the parent), not `name` (the
 * resource). Keying the instance name on the parent collides every asset in a
 * bucket under one instance. The final URL segment placeholder is the resource.
 */
function lastPathParam(method: ClassifiedMethod) {
  const params = method.operation.pathParams;
  const matches = [...method.operation.path.matchAll(/\{([^}]+)\}/g)];
  const lastTemplateName = matches.length > 0
    ? matches[matches.length - 1][1]
    : undefined;
  if (lastTemplateName) {
    const byName = params.find((p) => p.name === lastTemplateName);
    if (byName) return byName;
  }
  return params[params.length - 1];
}

/**
 * Ordered candidate response keys to derive a created resource's instance name.
 *
 * Griptape entities name their id `<resource>_id`, but the resource name does
 * not always match the id field: the `models` service creates a `model` whose
 * id is `model_config_id` (the path param on GET /api/models/{model_config_id}).
 * So candidates, in priority order:
 *   1. The sibling resource path param, when it is id-shaped and NOT the parent
 *      on a nested create. The last path param of a nested create is the PARENT
 *      (POST /threads/{thread_id}/messages -> thread_id), so it is excluded when
 *      the path has a trailing collection segment after the param.
 *   2. `<singular-resource>_id` derived from the resource name.
 *   3. A generic `id` key.
 * The create body tries each against the response and falls back to "created".
 *
 * `organization_id` is deliberately never a candidate: it is present on almost
 * every entity and would collide all resources under one org's instance name.
 */
export function entityIdCandidates(method: ClassifiedMethod): string[] {
  const candidates: string[] = [];

  // A create path ending in a `{param}` segment addresses the entity directly
  // (rare for create). A create path ending in a plain collection segment
  // (POST /api/threads, POST /threads/{thread_id}/messages) does NOT — its last
  // path param, if any, is a parent. So only use a path param when it is the
  // final segment.
  const path = method.operation.path;
  const endsWithParam = /\{[^}]+\}\/?$/.test(path);
  if (endsWithParam) {
    const idParam = lastPathParam(method);
    if (
      idParam && /_id$/.test(idParam.name) && idParam.name !== "organization_id"
    ) {
      candidates.push(idParam.name);
    }
  }

  const resource = resourceNameFor(method).replace(/-/g, "_");
  const singular = resource.endsWith("s") ? resource.slice(0, -1) : resource;
  candidates.push(`${singular}_id`);
  candidates.push("id");

  // De-dup while preserving order.
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// Small string helpers (shared with the sibling generators' conventions).
// ---------------------------------------------------------------------------

/** Convert snake_case / kebab-case to PascalCase. */
export function toPascalCase(name: string): string {
  return name
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

/** Sanitize an API field name to a safe object key / identifier fragment. */
export function sanitizeFieldName(name: string): string {
  return name.replace(/-/g, "_");
}

/** Escape a string for a double-quoted TypeScript literal. */
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")
    .trim();
}

/** Append `.passthrough()`-equivalent — keep unknown keys via z.looseObject. */
function withPassthrough(zod: string): string {
  // The type_mapper emits z.object({...}); Griptape entities carry more fields
  // than any tier-1 snapshot needs, so keep unknown keys rather than stripping.
  if (zod.startsWith("z.object({")) {
    return zod.replace(/^z\.object\(/, "z.looseObject(");
  }
  return zod;
}

/** Truncate a long description for a .describe() argument. */
function truncateStr(desc: string): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length <= 100 ? oneLine : oneLine.slice(0, 97) + "...";
}
