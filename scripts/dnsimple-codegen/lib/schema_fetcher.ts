/**
 * Schema fetcher — downloads and caches the DNSimple API v2 OpenAPI spec.
 *
 * Fetches from the live DNSimple endpoint, caches locally in .cache/ for 24h,
 * and parses the JSON into a typed intermediate representation.
 *
 * DNSimple's spec is OpenAPI 3.1: nullability is expressed as `type: [T, "null"]`
 * rather than the 3.0-style `nullable: true` sibling keyword. Both forms are
 * modeled on SchemaObject.type so downstream consumers (type_mapper.ts) can
 * handle either.
 */

import { SCHEMA_URL, SPEC_CORRECTIONS } from "../config.ts";
import type { SpecCorrection } from "../config.ts";
import { join } from "@std/path";

const CACHE_DIR = ".cache";
const CACHE_FILE = "openapi.json";

/**
 * Fix known errors in the spec's text, in place. A correction applies only
 * when the value at its path is still the expected one; the others are
 * returned so the caller can report entries upstream has since fixed.
 */
export function applySpecCorrections(
  spec: OpenAPISpec,
  corrections: SpecCorrection[] = SPEC_CORRECTIONS,
): SpecCorrection[] {
  const stale: SpecCorrection[] = [];
  for (const correction of corrections) {
    const parent = correction.path.slice(0, -1).reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      spec,
    );
    const last = correction.path[correction.path.length - 1];
    if (
      parent && typeof parent === "object" &&
      JSON.stringify((parent as Record<string, unknown>)[last]) ===
        JSON.stringify(correction.expected)
    ) {
      (parent as Record<string, unknown>)[last] = correction.value;
    } else {
      stale.push(correction);
    }
  }
  return stale;
}

export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, RequestBodyObject>;
    responses?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface PathItem {
  [method: string]: OperationObject | ParameterObject[] | undefined;
  parameters?: ParameterObject[];
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
}

export interface ParameterObject {
  /** Set on an unresolved `$ref` entry; resolved by `resolveParameter`. */
  $ref?: string;
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  example?: unknown;
}

export interface RequestBodyObject {
  $ref?: string;
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface SchemaObject {
  /** OpenAPI 3.0 uses a single string; 3.1 permits an array (e.g. ["string", "null"]). */
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: (string | number | boolean | null)[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  $ref?: string;
  /** OpenAPI 3.0-style nullable sibling keyword. */
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  default?: unknown;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: SchemaObject | boolean;
}

/** Fetch or load from cache the DNSimple OpenAPI spec */
export async function fetchSchema(
  cacheDir?: string,
): Promise<OpenAPISpec> {
  const dir = cacheDir ?? CACHE_DIR;
  const cachePath = join(dir, CACHE_FILE);

  // Try cache first
  try {
    const stat = await Deno.stat(cachePath);
    // Cache valid for 24 hours
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    if (age < 24 * 60 * 60 * 1000) {
      const cached = await Deno.readTextFile(cachePath);
      return JSON.parse(cached) as OpenAPISpec;
    }
  } catch {
    // Cache miss — proceed to fetch
  }

  console.log(`Fetching DNSimple OpenAPI spec from ${SCHEMA_URL}...`);
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch schema: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();

  // Write to cache
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(cachePath, text);
  console.log(`Cached schema to ${cachePath} (${text.length} bytes)`);

  return JSON.parse(text) as OpenAPISpec;
}

/** Force re-fetch regardless of cache age */
export async function fetchSchemaFresh(
  cacheDir?: string,
): Promise<OpenAPISpec> {
  const dir = cacheDir ?? CACHE_DIR;
  const cachePath = join(dir, CACHE_FILE);

  // Remove cache if exists
  try {
    await Deno.remove(cachePath);
  } catch {
    // Doesn't exist — fine
  }

  return fetchSchema(dir);
}

/**
 * Resolve a $ref string to the schema object it points to.
 * Only handles local refs (#/components/schemas/...).
 */
export function resolveRef(
  spec: OpenAPISpec,
  ref: string,
): SchemaObject {
  if (!ref.startsWith("#/")) {
    throw new Error(`External $ref not supported: ${ref}`);
  }
  const parts = ref.replace("#/", "").split("/");
  // deno-lint-ignore no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    current = current[part];
    if (current === undefined) {
      throw new Error(`Failed to resolve $ref: ${ref}`);
    }
  }
  return current as SchemaObject;
}

/**
 * Resolve a parameter that may be a `$ref` into `components.parameters`.
 * DNSimple declares nearly every path and filter parameter that way.
 */
export function resolveParameter(
  spec: OpenAPISpec,
  param: ParameterObject,
): ParameterObject {
  if (!param.$ref) return param;
  return resolveRef(spec, param.$ref) as unknown as ParameterObject;
}

/**
 * Resolve a request body that may be a `$ref` into `components.requestBodies`.
 * 25 of DNSimple's 29 request bodies are references.
 */
export function resolveRequestBody(
  spec: OpenAPISpec,
  body: RequestBodyObject,
): RequestBodyObject {
  if (!body.$ref) return body;
  return resolveRef(spec, body.$ref) as unknown as RequestBodyObject;
}

/**
 * Recursively resolve a schema, inlining every `$ref` at every depth and
 * flattening `allOf` into a single object. `oneOf`/`anyOf` variants,
 * properties, array items and `additionalProperties` are all resolved.
 *
 * Handles circular references by tracking the chain of refs being resolved:
 * a ref that is already an ancestor collapses to an open object.
 */
export function resolveSchema(
  spec: OpenAPISpec,
  schema: SchemaObject,
  visited: Set<string> = new Set(),
): SchemaObject {
  if (schema.$ref) {
    if (visited.has(schema.$ref)) {
      // Circular reference — an open object keeps the generated type valid.
      return { type: "object", description: "[circular ref]" };
    }
    const next = new Set(visited).add(schema.$ref);
    const { $ref: _ref, ...siblings } = schema;
    return {
      ...resolveSchema(spec, resolveRef(spec, schema.$ref), next),
      ...siblings,
    };
  }

  if (schema.allOf) {
    const { allOf, ...own } = schema;
    const merged: SchemaObject = { ...own, type: "object" };
    let properties: Record<string, SchemaObject> = {};
    let required: string[] = [];
    if (own.properties) {
      for (const [k, v] of Object.entries(own.properties)) {
        properties[k] = resolveSchema(spec, v, visited);
      }
      required = [...(own.required ?? [])];
    }
    for (const sub of allOf) {
      const resolved = resolveSchema(spec, sub, visited);
      if (resolved.properties) {
        properties = { ...properties, ...resolved.properties };
      }
      if (resolved.required) {
        required = [...new Set([...required, ...resolved.required])];
      }
      if (resolved.description && !merged.description) {
        merged.description = resolved.description;
      }
    }
    merged.properties = properties;
    if (required.length > 0) merged.required = required;
    else delete merged.required;
    return merged;
  }

  const out: SchemaObject = { ...schema };
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = resolveSchema(spec, v, visited);
    }
  }
  if (schema.items) out.items = resolveSchema(spec, schema.items, visited);
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    out.additionalProperties = resolveSchema(
      spec,
      schema.additionalProperties,
      visited,
    );
  }
  if (schema.oneOf) {
    out.oneOf = schema.oneOf.map((v) => resolveSchema(spec, v, visited));
  }
  if (schema.anyOf) {
    out.anyOf = schema.anyOf.map((v) => resolveSchema(spec, v, visited));
  }
  return out;
}
