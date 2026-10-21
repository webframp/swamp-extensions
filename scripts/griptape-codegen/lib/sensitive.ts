/**
 * Sensitive-field detection for generated Griptape models.
 *
 * The Griptape spec does not flag credentials, so detection is name-based.
 * Swamp acts on `.meta({ sensitive: true })` in two places that matter here:
 *
 * - Method arguments: the value is redacted in logs and the UI.
 * - Resource schemas: before persistence swamp stores the value in a vault and
 *   keeps only a vault reference. Its walk visits nested OBJECT fields only. It
 *   does not descend into arrays, records or unions, so a secret below one of
 *   those is never redacted however it is marked.
 *
 * The helpers below find credential fields anywhere in a request or response
 * schema, following $refs and merging union variants, so the generator can
 * mark request arguments and declare response paths that swamp can reach.
 */

import type { OpenAPISpec, SchemaObject } from "./schema_fetcher.ts";
import { resolveRef } from "./schema_fetcher.ts";

/** Lower snake_case form of a field name (`clientSecret` -> `client_secret`). */
function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

const EXACT_SENSITIVE = new Set([
  "value",
  "secret",
  "secret_value",
  "password",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "secret_access_key",
  "auth_code",
  "authorization_code",
  "credential",
  "credentials",
]);

/**
 * True when a field name denotes a credential/secret. Exact-match a curated
 * set plus a suffix rule rather than a broad substring test, so innocuous
 * fields like `value_count`, `token_limit` or `max_tokens` are not
 * over-redacted, and references such as `api_key_secret_id` or
 * `bot_token_secret_ref` (an id, not the secret) are left alone. camelCase,
 * kebab-case and snake_case spellings are treated alike.
 */
export function isSensitiveFieldName(name: string): boolean {
  const n = toSnake(name);
  if (EXACT_SENSITIVE.has(n)) return true;
  return /_(token|secret|password|api_key|apikey|private_key|secret_access_key)$/
    .test(n);
}

/**
 * Below the top level of a body, a bare `value` is ordinary data (tag values,
 * message artifacts, environment-variable values), so it is not treated as a
 * secret there. Every other sensitive name applies at any depth.
 */
export function isNestedSensitiveFieldName(name: string): boolean {
  return toSnake(name) !== "value" && isSensitiveFieldName(name);
}

/**
 * Sensitive object paths below a schema. `true` marks a sensitive leaf; a
 * nested tree marks an object whose descendants hold one.
 */
export interface SensitiveTree {
  [field: string]: SensitiveTree | true;
}

/** Result of scanning a schema for credential fields. */
export interface SensitiveScan {
  /** Paths reachable through plain objects (and merged union variants). */
  tree: SensitiveTree;
  /**
   * Paths that pass through an array or record. Swamp cannot redact these in a
   * resource, so a response carrying one must be handled another way.
   */
  unreachable: string[];
}

const MAX_DEPTH = 8;

/** Follow $refs (cycle-safe) and return the referenced schema. */
function deref(
  spec: OpenAPISpec,
  schema: SchemaObject,
  visited: Set<string>,
): { schema: SchemaObject; visited: Set<string> } | undefined {
  let s = schema;
  let seen = visited;
  while (s.$ref) {
    if (seen.has(s.$ref)) return undefined;
    seen = new Set(seen).add(s.$ref);
    s = resolveRef(spec, s.$ref);
  }
  return { schema: s, visited: seen };
}

/** Every property a value of this schema may carry, across allOf/oneOf/anyOf. */
function collectProperties(
  spec: OpenAPISpec,
  schema: SchemaObject,
  visited: Set<string>,
): [string, SchemaObject, Set<string>][] {
  const out: [string, SchemaObject, Set<string>][] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    out.push([name, prop, visited]);
  }
  for (
    const sub of [
      ...(schema.allOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
    ]
  ) {
    const d = deref(spec, sub, visited);
    if (d) out.push(...collectProperties(spec, d.schema, d.visited));
  }
  return out;
}

function flatten(tree: SensitiveTree, prefix: string): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    v === true ? [`${prefix}.${k}`] : flatten(v, `${prefix}.${k}`)
  );
}

function scanObject(
  spec: OpenAPISpec,
  schema: SchemaObject,
  visited: Set<string>,
  depth: number,
  path: string,
  unreachable: string[],
): SensitiveTree {
  const tree: SensitiveTree = {};
  if (depth > MAX_DEPTH) return tree;
  for (
    const [name, rawProp, propVisited] of collectProperties(
      spec,
      schema,
      visited,
    )
  ) {
    const here = path ? `${path}.${name}` : name;
    const sensitive = depth === 0
      ? isSensitiveFieldName(name)
      : isNestedSensitiveFieldName(name);
    if (sensitive) {
      tree[name] = true;
      continue;
    }
    const d = deref(spec, rawProp, propVisited);
    if (!d) continue;
    const prop = d.schema;
    // Arrays and records: swamp's resource walk does not enter them.
    const container = prop.items ??
      (typeof prop.additionalProperties === "object"
        ? prop.additionalProperties
        : undefined);
    if (container) {
      const inner = deref(spec, container, d.visited);
      if (!inner) continue;
      const marker = prop.items ? "[]" : "{}";
      const sub = scanObject(
        spec,
        inner.schema,
        inner.visited,
        depth + 1,
        `${here}${marker}`,
        unreachable,
      );
      unreachable.push(...flatten(sub, `${here}${marker}`));
      continue;
    }
    const sub = scanObject(spec, prop, d.visited, depth + 1, here, unreachable);
    if (Object.keys(sub).length > 0) {
      const existing = tree[name];
      tree[name] = existing && existing !== true
        ? mergeTrees(existing, sub)
        : sub;
    }
  }
  return tree;
}

function mergeTrees(a: SensitiveTree, b: SensitiveTree): SensitiveTree {
  const out: SensitiveTree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (cur === true || v === true) out[k] = true;
    else out[k] = cur ? mergeTrees(cur, v) : v;
  }
  return out;
}

/** Scan a (possibly $ref) schema for credential fields. */
export function scanSensitive(
  spec: OpenAPISpec,
  schema: SchemaObject | undefined,
): SensitiveScan {
  const unreachable: string[] = [];
  if (!schema) return { tree: {}, unreachable };
  const d = deref(spec, schema, new Set());
  if (!d) return { tree: {}, unreachable };
  // A bare array body/response: everything below it is unreachable.
  if (d.schema.items) {
    const inner = deref(spec, d.schema.items, d.visited);
    if (inner) {
      const sub = scanObject(
        spec,
        inner.schema,
        inner.visited,
        1,
        "[]",
        unreachable,
      );
      unreachable.push(...flatten(sub, "[]"));
    }
    return { tree: {}, unreachable };
  }
  const tree = scanObject(spec, d.schema, d.visited, 0, "", unreachable);
  return { tree, unreachable };
}

/** Flatten a tree to dotted paths (`config.google_drive.access_token`). */
export function sensitivePaths(tree: SensitiveTree): string[][] {
  return Object.entries(tree).flatMap(([k, v]) =>
    v === true ? [[k]] : sensitivePaths(v).map((p) => [k, ...p])
  );
}

/**
 * Return a copy of a response schema in which every sensitive path in `tree`
 * is declared down to its leaf, and the leaf carries `x-swamp-sensitive`
 * (emitted as `.meta({ sensitive: true })`). Top-level siblings keep their
 * types. Below the top level only the path itself is declared; response
 * objects are loose, so the remaining fields still pass through.
 */
export function withSensitiveMarkers(
  schema: SchemaObject,
  tree: SensitiveTree,
): SchemaObject {
  const properties: Record<string, SchemaObject> = {
    ...(schema.properties ?? {}),
  };
  for (const [name, node] of Object.entries(tree)) {
    properties[name] = node === true
      ? { ...(properties[name] ?? {}), "x-swamp-sensitive": true }
      : withSensitiveMarkers({ type: "object" }, node);
  }
  return { ...schema, properties };
}
