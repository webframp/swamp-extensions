/**
 * Schema fetcher — downloads, hash-verifies, and caches the Griptape Cloud
 * OpenAPI spec.
 *
 * The spec is a mutable S3 object (application/yaml). We pin it by SHA-256 of
 * the response body (see SPEC_SHA256 in config.ts): the fetcher throws if the
 * fetched body does not match the pin, so generation is reproducible and an
 * upstream spec change is a loud failure rather than a silent diff.
 *
 * Parses with @std/yaml. $ref / allOf resolution is identical to the sibling
 * generators.
 */

import { SCHEMA_URL, SPEC_SHA256 } from "../config.ts";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

const CACHE_DIR = ".cache";
const CACHE_FILE = "griptape-openapi.yaml";

export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string };
  servers?: { url: string; description?: string }[];
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
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
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  $ref?: string;
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

/** Compute the lowercase-hex SHA-256 of a string. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch the spec body as raw text, verifying it against SPEC_SHA256 unless
 * `expectedHash` is explicitly `null` (the bump flow, which is establishing a
 * new pin and prints the diff itself). Returns the raw YAML and its hash.
 */
export async function fetchSpecText(
  expectedHash: string | null = SPEC_SHA256,
): Promise<{ text: string; hash: string }> {
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch schema: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  const hash = await sha256Hex(text);

  if (expectedHash !== null && hash !== expectedHash) {
    throw new Error(
      `Griptape spec hash mismatch.\n` +
        `  expected: ${expectedHash}\n` +
        `  fetched:  ${hash}\n` +
        `The upstream spec at ${SCHEMA_URL} has changed. Review the diff and ` +
        `re-pin with: deno task bump -- --update-spec`,
    );
  }

  return { text, hash };
}

/**
 * Fetch (or load from a fresh cache) and parse the Griptape OpenAPI spec.
 *
 * The cache stores the raw YAML for 24h. A cache hit is still hash-verified, so
 * a stale-but-matching cache is fine and a stale-but-drifted cache fails loudly.
 */
export async function fetchSchema(cacheDir?: string): Promise<OpenAPISpec> {
  const dir = cacheDir ?? CACHE_DIR;
  const cachePath = join(dir, CACHE_FILE);

  // Try cache first (24h TTL), but always hash-verify.
  try {
    const stat = await Deno.stat(cachePath);
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    if (age < 24 * 60 * 60 * 1000) {
      const cached = await Deno.readTextFile(cachePath);
      const hash = await sha256Hex(cached);
      if (hash === SPEC_SHA256) {
        console.log(`   Using cached spec: ${cachePath}`);
        return parseYaml(cached) as unknown as OpenAPISpec;
      }
      // Cached copy drifted from the pin — fall through to a fresh fetch.
    }
  } catch {
    // Cache miss — proceed to fetch.
  }

  console.log(`   Fetching Griptape Cloud OpenAPI spec...`);
  const { text } = await fetchSpecText();

  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(cachePath, text);
  console.log(
    `   Cached spec to ${cachePath} (${(text.length / 1024).toFixed(0)}KB)`,
  );

  return parseYaml(text) as unknown as OpenAPISpec;
}

/**
 * Resolve a $ref string to the object it points to.
 * Only handles local refs (#/components/...).
 */
export function resolveRef(spec: OpenAPISpec, ref: string): SchemaObject {
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

/** Resolve a parameter $ref to a ParameterObject. */
export function resolveParamRef(
  spec: OpenAPISpec,
  ref: string,
): ParameterObject {
  return resolveRef(spec, ref) as unknown as ParameterObject;
}

/**
 * Recursively resolve a schema, inlining all $ref and merging allOf.
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
