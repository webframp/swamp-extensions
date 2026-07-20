/**
 * Schema fetcher — downloads and caches the Datadog v2 OpenAPI spec.
 *
 * Fetches from the DataDog/datadog-api-client-go repo (YAML format),
 * parses with @std/yaml, and caches locally in .cache/.
 */

import { SCHEMA_URL } from "../config.ts";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

const CACHE_DIR = ".cache";
const CACHE_FILE = "datadog-v2-openapi.yaml";

export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
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
  parameters?: (ParameterObject | RefObject)[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
  "x-unstable"?: boolean;
}

export interface RefObject {
  $ref: string;
}

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  example?: unknown;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: (string | number | boolean)[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  $ref?: string;
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

/** Fetch or load from cache the Datadog v2 OpenAPI spec */
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
      console.log(`   Using cached spec: ${cachePath}`);
      const cached = await Deno.readTextFile(cachePath);
      return parseYaml(cached) as unknown as OpenAPISpec;
    }
  } catch {
    // Cache miss — proceed to fetch
  }

  console.log(`   Fetching Datadog v2 OpenAPI spec from GitHub...`);
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch schema: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();

  // Write raw YAML to cache
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(cachePath, text);
  console.log(
    `   Cached spec to ${cachePath} (${
      (text.length / 1024 / 1024).toFixed(1)
    }MB)`,
  );

  return parseYaml(text) as unknown as OpenAPISpec;
}

/** Force re-fetch regardless of cache age */
export async function fetchSchemaFresh(
  cacheDir?: string,
): Promise<OpenAPISpec> {
  const dir = cacheDir ?? CACHE_DIR;
  const cachePath = join(dir, CACHE_FILE);

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
 * Resolve a parameter $ref to a ParameterObject.
 */
export function resolveParamRef(
  spec: OpenAPISpec,
  ref: string,
): ParameterObject {
  const resolved = resolveRef(spec, ref);
  return resolved as unknown as ParameterObject;
}

/**
 * Recursively resolve a schema, inlining all $ref.
 * Handles circular references by tracking visited refs.
 */
export function resolveSchema(
  spec: OpenAPISpec,
  schema: SchemaObject,
  visited: Set<string> = new Set(),
): SchemaObject {
  if (schema.$ref) {
    if (visited.has(schema.$ref)) {
      return { type: "object", description: "[circular ref]" };
    }
    visited.add(schema.$ref);
    const resolved = resolveRef(spec, schema.$ref);
    return resolveSchema(spec, resolved, visited);
  }

  if (schema.allOf) {
    const merged: SchemaObject = {
      type: "object",
      properties: {},
      required: [],
    };
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(spec, sub, new Set(visited));
      if (resolved.properties) {
        merged.properties = { ...merged.properties, ...resolved.properties };
      }
      if (resolved.required) {
        merged.required = [
          ...new Set([...(merged.required ?? []), ...resolved.required]),
        ];
      }
    }
    if (merged.required?.length === 0) delete merged.required;
    return merged;
  }

  return schema;
}
