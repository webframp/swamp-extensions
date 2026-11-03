/**
 * Method classifier — determines the swamp method type for each operation
 * and generates the model source code.
 *
 * DNSimple uses HTTP verbs loosely: `disableDomainDnssec` is a DELETE and
 * `enableDomainAutoRenewal` is a PUT. Keying on the HTTP method alone would
 * turn eight actions into resource deletions, so an operation is classified by
 * HTTP method and `operationId` prefix together (see `classifyOperation`).
 *
 * Every DNSimple response wraps its payload in `{ data }`, so the generated
 * code stores `data`, never the envelope. Account-scoped paths substitute
 * `globalArgs.accountId` for the `/{account}` segment; every other path
 * parameter is a method argument.
 */

import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { OpenAPISpec, SchemaObject } from "./schema_fetcher.ts";
import { schemaToZod } from "./type_mapper.ts";
import {
  BILLABLE_OPERATIONS,
  SENSITIVE_ARG_FIELDS,
  SENSITIVE_RESPONSE_FIELDS,
  ZOD_VERSION,
} from "../config.ts";

export type MethodType =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "action";

/**
 * What a method writes:
 * - `list`: `{ items, truncated, ... }` wrapper (paginated or array `data`)
 * - `object`: the response `data` object
 * - `receipt`: `{ operation, args, status, completedAt }`, for a no-body response
 * - `object-or-receipt`: the `data` object, or a receipt when the API sends none
 * - `none`: nothing (a delete with no body)
 */
export type ResultKind =
  | "list"
  | "object"
  | "receipt"
  | "object-or-receipt"
  | "none";

export interface ClassifiedMethod {
  /** swamp method name: the operationId in snake case */
  name: string;
  /** The classification */
  type: MethodType;
  /** Description for the method */
  description: string;
  /** The original operation */
  operation: GroupedOperation;
  /** What the method writes */
  resultKind: ResultKind;
  /** Resource spec name the method writes; absent when `resultKind` is none */
  resource?: string;
}

/** `operationId` prefixes of a DELETE that removes a resource. */
const DELETE_VERBS = ["delete", "remove", "cancel", "reject"];

/** `operationId` prefixes of an operation that performs an action. */
const ACTION_VERBS = [
  "accept",
  "activate",
  "apply",
  "authorize",
  "batch",
  "change",
  "check",
  "deactivate",
  "disable",
  "enable",
  "initiate",
  "issue",
  "link",
  "purchase",
  "register",
  "renew",
  "restore",
  "transfer",
  "unapply",
  "unlink",
];

/** The leading lowercase word of a camelCase operationId. */
function leadingVerb(operationId: string): string {
  return operationId.match(/^[a-z]+/)?.[0] ?? "";
}

/**
 * Classify an operation by HTTP method and `operationId` prefix. Throws on an
 * operation that matches no rule, so a new verb in a future spec surfaces at
 * generation time instead of silently becoming an action.
 */
export function classifyOperation(op: GroupedOperation): MethodType {
  const verb = leadingVerb(op.operationId);
  const method = op.httpMethod;

  if (method === "get") {
    return op.pagination.paginated || verb === "list" ? "list" : "get";
  }
  if (method === "post" && verb === "create") return "create";
  if (method === "patch" || (method === "put" && verb === "update")) {
    return "update";
  }
  if (method === "delete" && DELETE_VERBS.includes(verb)) return "delete";
  if (ACTION_VERBS.includes(verb)) return "action";

  throw new Error(
    `${op.operationId} (${method.toUpperCase()} ${op.path}): no classification ` +
      `rule matches the verb "${verb}"; add it to ACTION_VERBS or DELETE_VERBS ` +
      `in method_classifier.ts`,
  );
}

/** Convert a camelCase identifier to snake_case. */
function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** The swamp method name for an operation: its operationId in snake case. */
export function generateMethodName(op: GroupedOperation): string {
  return camelToSnake(op.operationId);
}

/** Decide what a method writes. */
export function resultKindFor(
  op: GroupedOperation,
  type: MethodType,
): ResultKind {
  if (op.dataKind === "array") return "list";
  if (op.dataKind === "object") {
    return (type === "action" || type === "delete") && op.noContent
      ? "object-or-receipt"
      : "object";
  }
  return type === "delete" ? "none" : "receipt";
}

/**
 * The resource name a method writes by default. The verb prefix is stripped
 * for list/get/create/update (`get_zone_record` -> `zone_record`); everything
 * else (`check_domain`, `enable_domain_dnssec`, `whoami`) keeps its full name
 * so it can never share a resource with the plain getter of the same noun.
 */
function baseResourceName(name: string, type: MethodType): string {
  const prefix =
    { list: "list_", get: "get_", create: "create_", update: "update_" }[
      type as "list" | "get" | "create" | "update"
    ];
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A stable fingerprint of what a method's resource schema would contain. */
function schemaFingerprint(method: ClassifiedMethod): string {
  return JSON.stringify([
    method.resultKind,
    method.operation.responseSchema ?? null,
    method.operation.pagination.keep,
  ]);
}

/**
 * Classify all operations in a service group into methods and assign each its
 * resource. Methods that share a resource name must share a response schema;
 * a method whose schema differs from the first claimant's (`check_domain`
 * against `get_domain`, say) falls back to its full method name rather than
 * overwriting the other's instances with a different shape.
 *
 * Throws one error listing every unclassifiable operation.
 */
export function classifyServiceMethods(
  group: ServiceGroup,
): ClassifiedMethod[] {
  const methods: ClassifiedMethod[] = [];
  const problems: string[] = [];

  for (const op of group.operations) {
    let type: MethodType;
    try {
      type = classifyOperation(op);
    } catch (err) {
      problems.push((err as Error).message);
      continue;
    }
    const name = generateMethodName(op);
    const resultKind = resultKindFor(op, type);
    const billable = BILLABLE_OPERATIONS.includes(op.operationId);
    const text = op.summary || op.description || `${type} operation`;
    methods.push({
      name,
      type,
      description: billable ? `Billable: ${text}` : text,
      operation: op,
      resultKind,
    });
  }

  if (problems.length > 0) {
    throw new Error(`classification failed:\n  ${problems.join("\n  ")}`);
  }

  const owners = new Map<string, ClassifiedMethod>();
  for (const method of methods) {
    if (method.resultKind === "none") continue;
    let resource = baseResourceName(method.name, method.type);
    const owner = owners.get(resource);
    if (owner && schemaFingerprint(owner) !== schemaFingerprint(method)) {
      resource = method.name;
    }
    if (!owners.has(resource)) owners.set(resource, method);
    method.resource = resource;
  }

  const seen = new Set<string>();
  for (const method of methods) {
    if (seen.has(method.name)) {
      throw new Error(
        `duplicate method name ${method.name} in ${group.config.name}`,
      );
    }
    seen.add(method.name);
  }
  return methods;
}

/** All operationIds the spec declares. */
function specOperationIds(spec: OpenAPISpec): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) {
      if (op && !Array.isArray(op) && typeof op.operationId === "string") {
        ids.add(op.operationId);
      }
    }
  }
  return ids;
}

/**
 * Fail when a config map or list names an operation the spec lacks. An
 * upstream operationId rename would otherwise drop a sensitive marking or a
 * billable warning silently and ship a schema that persists a secret in
 * cleartext.
 */
export function assertSensitiveOperationsExist(
  spec: OpenAPISpec,
  config: {
    response?: Record<string, string[]>;
    args?: Record<string, string[]>;
    billable?: string[];
  } = {},
): void {
  const ids = specOperationIds(spec);
  const named: [string, string[]][] = [
    [
      "SENSITIVE_RESPONSE_FIELDS",
      Object.keys(config.response ?? SENSITIVE_RESPONSE_FIELDS),
    ],
    ["SENSITIVE_ARG_FIELDS", Object.keys(config.args ?? SENSITIVE_ARG_FIELDS)],
    ["BILLABLE_OPERATIONS", config.billable ?? BILLABLE_OPERATIONS],
  ];
  const problems = named.flatMap(([label, keys]) => {
    const missing = keys.filter((id) => !ids.has(id));
    return missing.length > 0
      ? [`${label} names operation(s) not in the spec: ${missing.join(", ")}`]
      : [];
  });
  if (problems.length > 0) {
    throw new Error(`${problems.join("; ")}; update config.ts`);
  }
}

/**
 * Sensitive response fields for one resource: the union of the
 * SENSITIVE_RESPONSE_FIELDS entries of every method that writes it, checked
 * against the resource's schema (the primary method's response schema).
 *
 * swamp only vaults fields the resource schema declares, so a configured field
 * the spec does not declare (renamed upstream, say), a resource with no
 * response schema, or a list resource (whose secrets would sit inside
 * `items`) stops generation instead of shipping a schema that persists the
 * secret in cleartext.
 */
export function sensitiveFieldsForResource(
  primary: ClassifiedMethod,
  writers: ClassifiedMethod[],
  sensitive: Record<string, string[]> = SENSITIVE_RESPONSE_FIELDS,
): string[] {
  const fields = [
    ...new Set(
      writers.flatMap((m) => sensitive[m.operation.operationId] ?? []),
    ),
  ];
  if (fields.length === 0) return fields;
  const where = writers.map((m) => m.operation.operationId).join(", ");
  if (primary.resultKind === "list") {
    throw new Error(
      `${where}: sensitive response fields are only supported on ` +
        `single-object resources, not list methods`,
    );
  }
  const schema = primary.operation.responseSchema;
  if (!schema) {
    throw new Error(
      `${where}: sensitive response fields configured but the spec has no ` +
        `response schema to declare them in`,
    );
  }
  const declared = new Set<string>();
  for (const variant of [schema, ...(schema.oneOf ?? schema.anyOf ?? [])]) {
    for (const name of Object.keys(variant.properties ?? {})) {
      declared.add(name);
    }
  }
  const missing = fields.filter((f) => !declared.has(f));
  if (missing.length > 0) {
    throw new Error(
      `${where}: sensitive response field(s) ${missing.join(", ")} are not ` +
        `declared in the response schema; update SENSITIVE_RESPONSE_FIELDS ` +
        `in config.ts`,
    );
  }
  return fields;
}

/**
 * Sensitive request fields for an operation, checked against the resolved
 * request body schema. Throws when a configured field is not declared there.
 */
export function sensitiveArgFields(
  op: GroupedOperation,
  sensitive: Record<string, string[]> = SENSITIVE_ARG_FIELDS,
): string[] {
  const fields = sensitive[op.operationId] ?? [];
  if (fields.length === 0) return fields;
  const declared = new Set(Object.keys(op.requestBody?.properties ?? {}));
  const missing = fields.filter((f) => !declared.has(f));
  if (missing.length > 0) {
    throw new Error(
      `${op.operationId}: sensitive argument field(s) ${missing.join(", ")} ` +
        `are not declared in the request body schema; update ` +
        `SENSITIVE_ARG_FIELDS in config.ts`,
    );
  }
  return fields;
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
  const modelType = `@webframp/dnsimple/${config.name}`;

  const schemaLines: string[] = [];
  const schemaNames = generateResponseSchemas(methods, schemaLines);

  const methodSources = methods.map((m) => generateMethod(m));
  const body = methodSources.join("\n");

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${config.description}`);
  lines.push(` *`);
  lines.push(
    ` * Auto-generated by scripts/dnsimple-codegen — do not edit manually.`,
  );
  lines.push(` *`);
  lines.push(` * @module`);
  lines.push(` */`);
  lines.push(`// SPDX-License-Identifier: Apache-2.0`);
  lines.push(``);
  lines.push(`import { z } from "npm:zod@${ZOD_VERSION}";`);

  const helpers = [
    "buildQuery",
    "dnsimpleApi",
    "dnsimpleApiData",
    "dnsimpleApiPaginated",
    "instanceName",
    "pickBody",
    "requireAccountId",
    "sanitizeInstanceName",
    "shortHash",
  ].filter((h) => new RegExp(`\\b${h}\\s*[<(]`).test(body));
  if (helpers.length > 0) {
    lines.push(`import { ${helpers.join(", ")} } from "./_lib/api.ts";`);
  }
  lines.push(`import type { ApiGlobalArgs } from "./_lib/api.ts";`);
  lines.push(``);
  if (methods.some((m) => m.resultKind === "list")) {
    lines.push(`const EXTENSION_NAME = "${modelType}";`);
    lines.push(``);
  }
  lines.push(
    `/** The slice of swamp's method context the methods below use. */`,
  );
  lines.push(`interface MethodContext {`);
  lines.push(`  globalArgs: ApiGlobalArgs;`);
  lines.push(
    `  writeResource: (spec: string, instance: string, data: unknown) => Promise<{ name: string }>;`,
  );
  lines.push(
    `  logger: { info: (msg: string, props: Record<string, unknown>) => void };`,
  );
  lines.push(`}`);
  lines.push(``);

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
  lines.push(...schemaLines);

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
    if (!method.resource || seenResources.has(method.resource)) continue;
    seenResources.add(method.resource);
    lines.push(`    "${method.resource}": {`);
    lines.push(`      description: "${escapeStr(method.description)}",`);
    lines.push(
      `      schema: ${
        schemaNames.get(method.resource) ?? "z.object({}).passthrough()"
      },`,
    );
    lines.push(`      lifetime: "infinite" as const,`);
    lines.push(
      `      garbageCollection: ${method.resultKind === "list" ? 10 : 20},`,
    );
    lines.push(`    },`);
  }
  lines.push(`  },`);
  lines.push(``);

  lines.push(`  methods: {`);
  lines.push(body);
  lines.push(`  },`);
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

/** Generate GlobalArgsSchema: token, account scope and environment. */
function generateGlobalArgsSchema(): string {
  const tokenDescription =
    'DNSimple API access token (account or user token). Wire it with ${{ vault.get("dnsimple", "ACCESS_TOKEN") }}; never pass the literal value. The DNSIMPLE_TOKEN environment variable is read as a fallback, but it is not redacted and is not recommended.';
  const accountDescription =
    "Numeric DNSimple account ID that account-scoped paths use. The account model's whoami method returns it.";
  const environmentDescription =
    "DNSimple API environment. The sandbox has its own accounts and tokens.";
  return [
    `const GlobalArgsSchema = z.object({`,
    `  apiToken: z.string().meta({ sensitive: true }).describe(${
      JSON.stringify(tokenDescription)
    }).optional(),`,
    `  accountId: z.string().regex(/^\\d+$/).describe(${
      JSON.stringify(accountDescription)
    }).optional(),`,
    `  environment: z.enum(["production", "sandbox"]).default("production").describe(${
      JSON.stringify(environmentDescription)
    }),`,
    `});`,
  ].join("\n");
}

const RECEIPT_SCHEMA = `const ReceiptSchema = z.object({
  operation: z.string().describe("The OpenAPI operationId that ran"),
  args: z.record(z.string(), z.unknown()).describe(
    "Arguments the method was called with, sensitive fields omitted",
  ),
  status: z.number().int().describe("HTTP status DNSimple returned"),
  completedAt: z.string().describe("When the method finished"),
});`;

/** Map options shared by every response schema: tolerant and passthrough. */
const RESPONSE_OPTS = {
  indent: 2,
  lenient: true,
  passthrough: true,
  nullTolerant: true,
};

/** Generate Zod schemas for all unique response shapes */
function generateResponseSchemas(
  methods: ClassifiedMethod[],
  lines: string[],
): Map<string, string> {
  const schemaNames = new Map<string, string>();
  const seen = new Set<string>();

  if (
    methods.some((m) =>
      m.resultKind === "receipt" || m.resultKind === "object-or-receipt"
    )
  ) {
    lines.push(RECEIPT_SCHEMA);
    lines.push(``);
  }

  for (const method of methods) {
    const resource = method.resource;
    if (!resource || seen.has(resource)) continue;
    seen.add(resource);

    const writers = methods.filter((m) => m.resource === resource);
    const sensitiveFields = sensitiveFieldsForResource(method, writers);
    const varName = toPascalCase(resource) + "Schema";
    schemaNames.set(resource, varName);
    const schema = method.operation.responseSchema;

    if (method.resultKind === "receipt") {
      schemaNames.set(resource, "ReceiptSchema");
      continue;
    }

    if (method.resultKind === "list") {
      const itemVarName = toPascalCase(resource) + "ItemSchema";
      const itemZod = schemaToZod(schema ?? {}, RESPONSE_OPTS, 1);
      lines.push(`const ${itemVarName} = ${itemZod};`);
      lines.push(``);
      lines.push(`const ${varName} = z.object({`);
      lines.push(`  items: z.array(${itemVarName}),`);
      lines.push(`  truncated: z.boolean(),`);
      lines.push(`  total_entries: z.number().int().optional().describe(`);
      lines.push(
        `    "total_entries DNSimple reported for the full result set",`,
      );
      lines.push(`  ),`);
      for (const key of method.operation.pagination.keep) {
        const sibling = siblingSchema(method.operation, key);
        lines.push(
          `  ${key}: ${schemaToZod(sibling, RESPONSE_OPTS, 1)}.optional(),`,
        );
      }
      lines.push(`  fetchedAt: z.string(),`);
      lines.push(`  durationMs: z.number().optional().describe(`);
      lines.push(`    "Method execution duration in milliseconds",`);
      lines.push(`  ),`);
      lines.push(`  collectedBy: z.string().optional().describe(`);
      lines.push(`    "Extension that collected this data",`);
      lines.push(`  ),`);
      lines.push(`});`);
      lines.push(``);
      continue;
    }

    const zodStr = schemaToZod(
      schema ?? {},
      { ...RESPONSE_OPTS, sensitiveFields },
      1,
    );
    if (method.resultKind === "object-or-receipt") {
      lines.push(`const ${varName}Data = ${zodStr};`);
      lines.push(``);
      lines.push(
        `const ${varName} = z.union([${varName}Data, ReceiptSchema]);`,
      );
    } else {
      lines.push(`const ${varName} = ${zodStr};`);
    }
    lines.push(``);
  }

  return schemaNames;
}

/**
 * Schema of a property kept next to a paginated results array. Resolved from
 * the operation's own response: the grouper stores only the item schema, so
 * the kept sibling is looked up by name on `data` through the stored schema's
 * parent when present, else left open.
 */
function siblingSchema(op: GroupedOperation, key: string): SchemaObject {
  return op.paginatedSiblings?.[key] ?? {};
}

/** Generate a single method definition */
function generateMethod(method: ClassifiedMethod): string {
  const indent = "    ";
  const lines: string[] = [];

  lines.push(`${indent}${method.name}: {`);
  lines.push(`${indent}  description: "${escapeStr(method.description)}",`);
  lines.push(`${indent}  arguments: ${generateArgsSchema(method)},`);

  const bodyLines = generateExecuteBody(method, indent);
  const argsParam = bodyReferencesArgs(bodyLines) ? "args" : "_args";
  lines.push(
    `${indent}  execute: async (${argsParam}: Record<string, unknown>, context: MethodContext) => {`,
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

/** The camelCase-free identifier a path/query/body field becomes. */
export function sanitizeFieldName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/^\d/, "_$&");
}

/** One generated argument field: `name: zod,` with its provenance. */
interface ArgField {
  name: string;
  zod: string;
  origin: "path" | "query" | "body";
}

/**
 * Argument fields for a method, in path/query/body order. Throws when two
 * origins claim one name, since a silent first-wins would drop an argument
 * the API requires.
 */
export function argFields(method: ClassifiedMethod): ArgField[] {
  const op = method.operation;
  const fields: ArgField[] = [];
  const claim = (field: ArgField) => {
    const prior = fields.find((f) => f.name === field.name);
    if (prior) {
      throw new Error(
        `${op.operationId}: ${field.origin} argument "${field.name}" collides ` +
          `with a ${prior.origin} argument of the same name`,
      );
    }
    fields.push(field);
  };

  for (const p of op.pathParams) {
    const name = sanitizeFieldName(p.name);
    const type = Array.isArray(p.schema?.type)
      ? p.schema.type[0]
      : p.schema?.type;
    const base = type === "integer" || type === "number"
      ? "z.union([z.string(), z.number().int()])"
      : "z.string()";
    claim({ name, zod: `${base}${describe(p.description)}`, origin: "path" });
  }

  for (const p of op.queryParams) {
    const name = sanitizeFieldName(p.name);
    if (name !== p.name) {
      throw new Error(
        `${op.operationId}: query parameter "${p.name}" is not a plain ` +
          `identifier; the generated query builder sends argument names as-is`,
      );
    }
    const base = p.schema
      ? schemaToZod(p.schema, { indent: 2 }, 2)
      : "z.string()";
    claim({
      name,
      zod: `${base}${p.required ? "" : ".optional()"}${
        describe(p.description)
      }`,
      origin: "query",
    });
  }

  const body = op.requestBody;
  const sensitive = new Set(sensitiveArgFields(op));
  if (body?.properties) {
    const required = new Set(body.required ?? []);
    for (const [prop, schema] of Object.entries(body.properties)) {
      const name = sanitizeFieldName(prop);
      if (name !== prop) {
        throw new Error(
          `${op.operationId}: request field "${prop}" is not a plain ` +
            `identifier; the generated body builder sends argument names as-is`,
        );
      }
      let zod = schemaToZod(schema, { indent: 2 }, 2);
      if (sensitive.has(prop)) zod = markSensitive(zod);
      claim({
        name,
        zod: `${zod}${required.has(prop) ? "" : ".optional()"}${
          describe(schema.description)
        }`,
        origin: "body",
      });
    }
  } else if (body) {
    const optional = op.requestBodyRequired ? "" : ".optional()";
    const shape = bodyShape(op);
    if (shape === "union") {
      const variants = (body.oneOf ?? body.anyOf)!.map((v) =>
        schemaToZod(v, { indent: 2 }, 2)
      );
      const zod = variants.length === 1
        ? variants[0]
        : `z.union([${variants.join(", ")}])`;
      claim({
        name: "body",
        zod: `${zod}${optional}${describe(body.description)}`,
        origin: "body",
      });
    } else if (shape === "array") {
      const item = schemaToZod(body.items ?? {}, { indent: 2 }, 2);
      claim({
        name: "items",
        zod: `z.array(${item})${optional}${describe(body.description)}`,
        origin: "body",
      });
    } else {
      // A free-form object, such as the settings hash some services take.
      claim({
        name: "body",
        zod: `z.record(z.string(), z.unknown())${optional}${
          describe(body.description)
        }`,
        origin: "body",
      });
    }
  }
  return fields;
}

/**
 * How a request body maps onto method arguments:
 * - `properties`: each property is an argument
 * - `union`: one `body` argument holding any of the variants
 * - `array`: one `items` argument holding the array
 * - `record`: one `body` argument holding a free-form object
 *
 * Throws on a body that fits none, so a new shape in a future spec stops
 * generation instead of sending nothing.
 */
export function bodyShape(op: GroupedOperation): BodyShape | undefined {
  const body = op.requestBody;
  if (!body) return undefined;
  if (body.properties) return "properties";
  if (body.oneOf || body.anyOf) return "union";
  const type = Array.isArray(body.type) ? body.type[0] : body.type;
  if (type === "array") return "array";
  if (type === "object") return "record";
  throw new Error(
    `${op.operationId}: unsupported request body shape (no properties, ` +
      `oneOf, anyOf, array or free-form object)`,
  );
}

export type BodyShape = "properties" | "union" | "array" | "record";

/** Append `.meta({ sensitive: true })` ahead of a trailing `.nullable()`. */
function markSensitive(zod: string): string {
  const marker = ".meta({ sensitive: true })";
  const nullable = ".nullable()";
  return zod.endsWith(nullable)
    ? `${zod.slice(0, -nullable.length)}${marker}${nullable}`
    : `${zod}${marker}`;
}

function describe(description: string | undefined): string {
  return description
    ? `.describe("${escapeStr(truncateStr(description))}")`
    : "";
}

/** Generate the arguments schema for a method */
function generateArgsSchema(method: ClassifiedMethod): string {
  const fields = argFields(method);
  if (fields.length === 0) return "z.object({})";
  return `z.object({\n${
    fields.map((f) => `  ${f.name}: ${f.zod},`).join("\n")
  }\n    })`;
}

/** Statements inside a method's execute function */
function generateExecuteBody(
  method: ClassifiedMethod,
  indent: string,
): string[] {
  const op = method.operation;
  const pad = `${indent}    `;
  const lines: string[] = [];

  if (op.accountScoped) {
    lines.push(
      `${pad}const accountId = requireAccountId(context.globalArgs, "${method.name}");`,
    );
  }

  const path = buildApiPath(op);
  const options = requestOptions(method);
  const httpMethod = op.httpMethod.toUpperCase();
  const resource = method.resource;
  const pathArgs = op.pathParams.map((p) =>
    `args.${sanitizeFieldName(p.name)}`
  );
  const sensitive = sensitiveArgFields(op);

  if (method.resultKind === "list" && op.pagination.paginated) {
    lines.push(`${pad}const startMs = Date.now();`);
    lines.push(
      `${pad}const { results, truncated, totalEntries${
        op.pagination.keep.length > 0 ? ", kept" : ""
      } } = await dnsimpleApiPaginated<unknown>(`,
    );
    lines.push(`${pad}  context.globalArgs,`);
    lines.push(`${pad}  ${path},`);
    lines.push(`${pad}  {`);
    if (op.queryParams.length > 0) {
      lines.push(`${pad}    query: buildQuery(args, ${queryNames(op)}),`);
    }
    lines.push(
      `${pad}    resultsPath: ${JSON.stringify(op.pagination.resultsPath)},`,
    );
    if (op.pagination.keep.length > 0) {
      lines.push(`${pad}    keep: ${JSON.stringify(op.pagination.keep)},`);
    }
    lines.push(`${pad}  },`);
    lines.push(`${pad});`);
    lines.push(`${pad}if (truncated) {`);
    lines.push(
      `${pad}  context.logger.info("WARNING: results truncated at {count} of {total} (pagination cap)", { count: results.length, total: totalEntries ?? results.length });`,
    );
    lines.push(`${pad}}`);
    const kept = op.pagination.keep.map((k) => `${pad}  ${k}: kept.${k},`);
    lines.push(
      `${pad}const handle = await context.writeResource("${resource}", ${
        listInstanceExpr(op)
      }, {`,
    );
    lines.push(`${pad}  items: results,`);
    lines.push(`${pad}  truncated,`);
    lines.push(`${pad}  total_entries: totalEntries,`);
    lines.push(...kept);
    lines.push(`${pad}  fetchedAt: new Date().toISOString(),`);
    lines.push(`${pad}  durationMs: Date.now() - startMs,`);
    lines.push(`${pad}  collectedBy: EXTENSION_NAME,`);
    lines.push(`${pad}});`);
    lines.push(
      `${pad}context.logger.info("Found {count} ${resource}", { count: results.length });`,
    );
    lines.push(`${pad}return { dataHandles: [handle] };`);
    return lines;
  }

  if (method.resultKind === "list") {
    // An array `data` with no pagination object: one request.
    lines.push(`${pad}const startMs = Date.now();`);
    lines.push(
      `${pad}const items = await dnsimpleApiData<unknown[]>(context.globalArgs, "${httpMethod}", ${path}${options});`,
    );
    const instance = op.pathParams.length > 0 || method.type !== "list"
      ? itemInstanceExpr(method)
      : `"main"`;
    lines.push(
      `${pad}const handle = await context.writeResource("${resource}", ${instance}, {`,
    );
    lines.push(`${pad}  items,`);
    lines.push(`${pad}  truncated: false,`);
    lines.push(`${pad}  fetchedAt: new Date().toISOString(),`);
    lines.push(`${pad}  durationMs: Date.now() - startMs,`);
    lines.push(`${pad}  collectedBy: EXTENSION_NAME,`);
    lines.push(`${pad}});`);
    lines.push(
      `${pad}context.logger.info("Found {count} ${resource}", { count: items.length });`,
    );
    lines.push(`${pad}return { dataHandles: [handle] };`);
    return lines;
  }

  if (method.resultKind === "none") {
    lines.push(
      `${pad}await dnsimpleApi(context.globalArgs, "${httpMethod}", ${path}${options});`,
    );
    const id = pathArgs[pathArgs.length - 1] ?? '"unknown"';
    lines.push(
      `${pad}context.logger.info("Deleted resource {id}", { id: ${id} });`,
    );
    lines.push(`${pad}return { dataHandles: [] };`);
    return lines;
  }

  if (
    method.resultKind === "receipt" || method.resultKind === "object-or-receipt"
  ) {
    const receiptArgs = `pickBody(args, ${JSON.stringify(sensitive)})`;
    lines.push(
      `${pad}const response = await dnsimpleApi<{ data?: Record<string, unknown> }>(context.globalArgs, "${httpMethod}", ${path}${options});`,
    );
    const receipt =
      `{ operation: "${op.operationId}", args: ${receiptArgs}, status: response.status, completedAt: new Date().toISOString() }`;
    const data = method.resultKind === "object-or-receipt"
      ? `response.body?.data ?? ${receipt}`
      : receipt;
    lines.push(
      `${pad}const handle = await context.writeResource("${resource}", ${
        itemInstanceExpr(method)
      }, ${data});`,
    );
    lines.push(`${pad}context.logger.info("Executed ${method.name}", {});`);
    lines.push(`${pad}return { dataHandles: [handle] };`);
    return lines;
  }

  // resultKind "object": the response `data` is stored as the resource.
  lines.push(
    `${pad}const result = await dnsimpleApiData<Record<string, unknown>>(context.globalArgs, "${httpMethod}", ${path}${options});`,
  );
  lines.push(
    `${pad}const handle = await context.writeResource("${resource}", ${
      method.type === "create"
        ? createInstanceExpr(method)
        : itemInstanceExpr(method)
    }, result);`,
  );
  const verb = { get: "Fetched", create: "Created", update: "Updated" }[
    method.type as "get" | "create" | "update"
  ] ?? "Executed";
  lines.push(`${pad}context.logger.info("${verb} ${resource}", {});`);
  lines.push(`${pad}return { dataHandles: [handle] };`);
  return lines;
}

/** `["a", "b"]` of the query argument names, as source. */
function queryNames(op: GroupedOperation): string {
  return JSON.stringify(op.queryParams.map((p) => sanitizeFieldName(p.name)));
}

/**
 * The `, { query, body }` options argument as source, or "" when the method
 * sends neither.
 */
function requestOptions(method: ClassifiedMethod): string {
  const op = method.operation;
  const parts: string[] = [];
  if (op.queryParams.length > 0) {
    parts.push(`query: buildQuery(args, ${queryNames(op)})`);
  }
  const body = op.requestBody;
  if (body?.properties) {
    const exclude = [
      ...op.pathParams.map((p) => sanitizeFieldName(p.name)),
      ...op.queryParams.map((p) => sanitizeFieldName(p.name)),
    ];
    parts.push(`body: pickBody(args, ${JSON.stringify(exclude)})`);
  } else if (body) {
    parts.push(`body: args.${bodyShape(op) === "array" ? "items" : "body"}`);
  }
  if (parts.length === 0) return "";
  return `, { ${parts.join(", ")} }`;
}

/**
 * Instance name for a list: a parentless list is "main"; one path parameter
 * names itself; several are hashed so two parents never overwrite each other.
 */
function listInstanceExpr(op: GroupedOperation): string {
  const refs = op.pathParams.map((p) =>
    `String(args.${sanitizeFieldName(p.name)})`
  );
  if (refs.length === 0) return `"main"`;
  if (refs.length === 1) return `sanitizeInstanceName(${refs[0]})`;
  return `sanitizeInstanceName(await shortHash(JSON.stringify([${
    refs.join(", ")
  }])))`;
}

/**
 * Instance name for get/update/action: the path parameters, parent first
 * (`example.com-12345`); with none, `<resource>-current`.
 */
function itemInstanceExpr(method: ClassifiedMethod): string {
  const op = method.operation;
  if (op.pathParams.length === 0) return `"${method.resource}-current"`;
  const refs = op.pathParams.map((p) => `args.${sanitizeFieldName(p.name)}`);
  return `await instanceName([${refs.join(", ")}])`;
}

/**
 * Instance name for create: the new item's `id` prefixed with its parents'
 * path parameters. A response with no `id` falls back to a hash of the
 * non-sensitive arguments, so distinct calls never collide on one instance.
 */
function createInstanceExpr(method: ClassifiedMethod): string {
  const op = method.operation;
  const parents = op.pathParams.map((p) => `args.${sanitizeFieldName(p.name)}`);
  const sensitive = JSON.stringify(sensitiveArgFields(op));
  const fallback =
    `sanitizeInstanceName(await shortHash(JSON.stringify(pickBody(args, ${sensitive}))))`;
  if (!op.responseSchema?.properties?.id) return fallback;
  return `result["id"] !== undefined && result["id"] !== null ? await instanceName([${
    [...parents, `result["id"]`].join(", ")
  }]) : ${fallback}`;
}

/**
 * Build the API path as a template literal. A path parameter value flows
 * straight from caller input into a URL path segment; encodeURIComponent
 * keeps each one confined to its own segment. `/{account}` becomes the
 * validated `accountId`.
 */
function buildApiPath(op: GroupedOperation): string {
  const body = op.path.replace(
    /\{([^}]+)\}/g,
    (_, name) =>
      name === "account" && op.accountScoped
        ? "${encodeURIComponent(accountId)}"
        : `\${encodeURIComponent(String(args.${sanitizeFieldName(name)}))}`,
  );
  return "`" + body + "`";
}

function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function truncateStr(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 80) return oneLine;
  // Cut at a word boundary so a description never ends mid-word.
  const cut = oneLine.slice(0, 77);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}...`;
}
