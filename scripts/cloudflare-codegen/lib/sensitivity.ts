/**
 * Sensitivity analysis — decides which request and response fields hold
 * secrets, and how each returned secret is kept out of plaintext storage.
 *
 * Two signals mark a field as secret:
 *
 * 1. The Cloudflare spec's own `x-sensitive: true`, on the field or on the
 *    `$ref` target it points at. This is authoritative and covers fields whose
 *    names give nothing away (`text` on a Workers secret binding, `psk`,
 *    `destination_conf`).
 * 2. A credential-shaped field name ({@link isSensitiveFieldName}), as a
 *    backstop for fields the spec forgets to flag.
 *
 * Swamp moves a resource field marked `.meta({ sensitive: true })` into a vault
 * and persists only a vault reference, but it reaches a field only along a
 * path of plain object properties from the resource root. It does not look
 * inside arrays, records or unions, and it cannot see a field the Zod schema
 * does not declare. The generator therefore reshapes response schemas so every
 * secret it can lift is declared on such a path:
 *
 * - An opaque `$ref` field (emitted as `z.unknown()`) whose target holds a
 *   secret is expanded into a passthrough skeleton that declares only the path
 *   to the secret.
 * - A top-level union is flattened into one object so its variants' secrets
 *   sit on plain property paths.
 * - A response that is itself a secret (a bare token string) is wrapped as
 *   `{ value }` by the method body.
 *
 * Whatever still cannot be reached (secrets inside list items, arrays, maps or
 * nested unions) is returned as strip paths, and the generated method deletes
 * those values before writing the resource.
 *
 * @module
 */

import type { OpenAPISpec, SchemaObject } from "./schema_fetcher.ts";
import { resolveRef, resolveSchema } from "./schema_fetcher.ts";

/** One step of a strip path, evaluated by `stripSensitive` in `_lib/api.ts`. */
export type SensitivePathSegment =
  /** Descend into property `k`; with `when`, only if `obj[when[0]] === when[1]`. */
  | { k: string; when?: [string, string | number | boolean] }
  /** Descend into every element of an array. */
  | { each: true }
  /** Descend into every value of a record/map. */
  | { values: true };

export type SensitivePath = SensitivePathSegment[];

/** What the generator needs to know about the secrets in one response. */
export interface ResponseSecrets {
  /** The response itself is a secret; the body writes `{ value: result }`. */
  wrapRoot: boolean;
  /**
   * Secret fields the emitted resource schema declares along a plain property
   * path, so swamp moves them into a vault. Each entry is a key path.
   */
  vaultable: string[][];
  /**
   * Every secret leaf the spec flags in the response, wherever it sits. The
   * classifier strips the ones its resource schema cannot vault.
   */
  leaves: SensitivePath[];
}

/** Description suffix for a secret-valued method argument. */
export const SECRET_ARG_HINT =
  "Secret: pass a vault.get expression, never a literal value.";

const MAX_DEPTH = 16;

// ---------------------------------------------------------------------------
// Field-name heuristic
// ---------------------------------------------------------------------------

/** Exact (snake_case) names that hold a credential. */
const SENSITIVE_NAMES = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "token",
  "jwt",
  "api_key",
  "apikey",
  "api_token",
  "access_token",
  "refresh_token",
  "session_token",
  "auth_token",
  "bearer_token",
  "client_secret",
  "private_key",
  "secret_key",
  "secret_access_key",
  "tunnel_secret",
  "cf_api_key",
  "auth_credentials",
  "credentials",
  "psk",
  "pre_shared_key",
  "stream_key",
]);

/**
 * Fields the spec flags `x-sensitive` that hold no secret. A Pages build
 * config's `web_analytics_token` is the Web Analytics site tag, published in
 * the beacon script of every page the project serves.
 */
export const PUBLIC_FIELDS: ReadonlySet<string> = new Set([
  "web_analytics_token",
]);

/** `*_token` names that are pagination cursors or public tags, not credentials. */
const NON_SECRET_TOKENS = new Set([
  "page_token",
  "next_page_token",
  "continuation_token",
  "pagination_token",
  "next_token",
  "cursor_token",
  "sync_token",
  ...PUBLIC_FIELDS,
]);

/**
 * Remove the spec's `x-sensitive` flag from every property named in
 * {@link PUBLIC_FIELDS}, wherever it is declared. Mutates the spec in place;
 * run it once, before any sensitivity analysis reads the spec.
 */
export function clearPublicFieldFlags(spec: OpenAPISpec): void {
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object") {
      for (const [key, prop] of Object.entries(properties)) {
        if (PUBLIC_FIELDS.has(key) && prop && typeof prop === "object") {
          delete (prop as SchemaObject)["x-sensitive"];
        }
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(spec);
}

/**
 * True when a field name denotes a credential.
 *
 * Names are normalized from camelCase to snake_case first, so
 * `secretAccessKey`, `sessionToken` and `privateKey` match. An exact set plus a
 * narrow suffix rule (`*_secret`, `*_password`, `*_token`, ...) is used instead
 * of a substring test, so identifiers and counters that merely mention a
 * secret (`token_id`, `secret_name`, `max_tokens`, `client_secret_version`,
 * `token_pricing`) are not flagged. A boolean or numeric field is a flag or a
 * counter, never a credential (`require_secret`, `ttl_token`), so it never
 * matches when its schema is given.
 */
export function isSensitiveFieldName(
  name: string,
  schema?: SchemaObject,
): boolean {
  if (
    schema?.type === "boolean" || schema?.type === "number" ||
    schema?.type === "integer"
  ) {
    return false;
  }
  const n = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  if (NON_SECRET_TOKENS.has(n)) return false;
  if (SENSITIVE_NAMES.has(n)) return true;
  return /_(secret|password|passphrase|token|api_key|apikey|private_key|secret_key|secret_access_key)$/
    .test(n);
}

/**
 * True when a schema node is a structured container (an object with declared
 * properties, a map, or an array/union of objects). The name heuristic marks a
 * container only when nothing inside it is marked on its own (see
 * hasInlineSecret): marking a whole container also registers every key name
 * and type tag inside it with swamp's redactor.
 */
export function isContainerSchema(s: SchemaObject): boolean {
  if (s.properties) return true;
  if (s.additionalProperties && typeof s.additionalProperties === "object") {
    return true;
  }
  if (s.items && (s.items.properties || s.items.oneOf || s.items.anyOf)) {
    return true;
  }
  const variants = s.oneOf ?? s.anyOf;
  if (variants?.some((v) => v.properties || v.$ref)) return true;
  return false;
}

/**
 * Sensitivity of a request-argument field. Write-only secrets are still
 * secrets on the way in.
 */
export function isSensitiveArgField(name: string, prop: SchemaObject): boolean {
  if (prop["x-swamp-sensitive"] || prop["x-sensitive"]) return true;
  if (!isSensitiveFieldName(name, prop)) return false;
  return !isContainerSchema(prop) || !hasInlineSecret(prop);
}

/**
 * True when a node's inline tree (not crossing `$ref`) contains a field that
 * will be marked on its own. A credential-named container is marked whole only
 * when it has no such field: a `secrets` map whose values are opaque must be
 * redacted as a unit, but a `credentials` object that declares its
 * `secret_access_key` should not drag its `access_key_id` along.
 */
function hasInlineSecret(s: SchemaObject, depth = 0): boolean {
  if (depth > MAX_DEPTH || s.$ref) return false;
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    if (prop["x-swamp-sensitive"] || prop["x-sensitive"]) return true;
    if (!isContainerSchema(prop) && isSensitiveFieldName(key, prop)) {
      return true;
    }
    if (hasInlineSecret(prop, depth + 1)) return true;
  }
  const children = [
    s.items,
    ...(s.oneOf ?? []),
    ...(s.anyOf ?? []),
    typeof s.additionalProperties === "object"
      ? s.additionalProperties
      : undefined,
  ];
  return children.some((c) =>
    c !== undefined &&
    (c["x-swamp-sensitive"] || c["x-sensitive"] ||
      hasInlineSecret(c, depth + 1))
  );
}

/**
 * Sensitivity of a response (resource) field. A `writeOnly` field is never
 * returned by the API, so it is not marked: marking it would only make swamp
 * demand a vault for a value that never arrives.
 */
export function isSensitiveResponseField(
  name: string,
  prop: SchemaObject,
): boolean {
  if (prop.writeOnly || prop["x-swamp-write-only"]) return false;
  if (prop["x-swamp-sensitive"] || prop["x-sensitive"]) return true;
  if (!isSensitiveFieldName(name, prop)) return false;
  return !isContainerSchema(prop) || !hasInlineSecret(prop);
}

// ---------------------------------------------------------------------------
// Spec-aware helpers
// ---------------------------------------------------------------------------

interface Flags {
  sensitive: boolean;
  writeOnly: boolean;
}

/** Sensitivity of a node, following its `$ref` chain. */
function flagsOf(spec: OpenAPISpec, node: SchemaObject): Flags {
  let sensitive = Boolean(node["x-sensitive"] || node["x-swamp-sensitive"]);
  let writeOnly = Boolean(node.writeOnly || node["x-swamp-write-only"]);
  let current: SchemaObject | undefined = node;
  const seen = new Set<string>();
  while (current?.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    try {
      current = resolveRef(spec, current.$ref);
    } catch {
      break;
    }
    if (current["x-sensitive"]) sensitive = true;
    if (current.writeOnly) writeOnly = true;
  }
  return { sensitive, writeOnly };
}

/**
 * Flag every node of a schema's inline tree (not crossing `$ref`) that holds a
 * secret, so the type mapper can mark it without access to the spec. Mutates
 * in place. The flags only restate what the node and its `$ref` target already
 * say, so mutating nodes shared with the spec's components is safe.
 */
export function annotateSensitive(
  spec: OpenAPISpec,
  schema: SchemaObject | undefined,
  depth = 0,
): void {
  if (!schema || depth > MAX_DEPTH) return;
  const flags = flagsOf(spec, schema);
  if (flags.sensitive) schema["x-swamp-sensitive"] = true;
  if (flags.writeOnly) schema["x-swamp-write-only"] = true;
  if (schema.$ref) return;
  for (const prop of Object.values(schema.properties ?? {})) {
    annotateSensitive(spec, prop, depth + 1);
  }
  if (schema.items) annotateSensitive(spec, schema.items, depth + 1);
  for (const v of schema.oneOf ?? []) annotateSensitive(spec, v, depth + 1);
  for (const v of schema.anyOf ?? []) annotateSensitive(spec, v, depth + 1);
  for (const v of schema.allOf ?? []) annotateSensitive(spec, v, depth + 1);
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    annotateSensitive(spec, schema.additionalProperties, depth + 1);
  }
}

/**
 * Visit every secret leaf under `schema`, crossing `$ref`, arrays, maps and
 * unions. `responseMode` skips write-only leaves, which the API never returns.
 * A leaf is not descended into: a secret object is secret as a whole.
 */
function walkLeaves(
  spec: OpenAPISpec,
  schema: SchemaObject | undefined,
  responseMode: boolean,
  visit: (path: SensitivePath, name: string | undefined) => void,
  path: SensitivePath = [],
  name: string | undefined = undefined,
  guard: [string, string | number | boolean] | undefined = undefined,
  seenRefs: Set<string> = new Set(),
  depth = 0,
): void {
  if (!schema || depth > MAX_DEPTH) return;
  const flags = flagsOf(spec, schema);
  if (flags.sensitive) {
    if (!(responseMode && flags.writeOnly) && path.length > 0) {
      visit(path, name);
    }
    return;
  }
  if (schema.$ref) {
    if (seenRefs.has(schema.$ref)) return;
    let target: SchemaObject;
    try {
      target = resolveRef(spec, schema.$ref);
    } catch {
      return;
    }
    const next = new Set(seenRefs);
    next.add(schema.$ref);
    walkLeaves(
      spec,
      target,
      responseMode,
      visit,
      path,
      name,
      guard,
      next,
      depth + 1,
    );
    return;
  }
  for (const part of schema.allOf ?? []) {
    walkLeaves(
      spec,
      part,
      responseMode,
      visit,
      path,
      name,
      guard,
      seenRefs,
      depth + 1,
    );
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const seg: SensitivePathSegment = guard
      ? { k: key, when: guard }
      : { k: key };
    walkLeaves(
      spec,
      prop,
      responseMode,
      visit,
      [...path, seg],
      key,
      undefined,
      seenRefs,
      depth + 1,
    );
  }
  if (schema.items) {
    walkLeaves(
      spec,
      schema.items,
      responseMode,
      visit,
      [...path, { each: true }],
      name,
      undefined,
      seenRefs,
      depth + 1,
    );
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    walkLeaves(
      spec,
      schema.additionalProperties,
      responseMode,
      visit,
      [...path, { values: true }],
      name,
      undefined,
      seenRefs,
      depth + 1,
    );
  }
  for (const variant of schema.oneOf ?? schema.anyOf ?? []) {
    walkLeaves(
      spec,
      variant,
      responseMode,
      visit,
      path,
      name,
      discriminatorOf(spec, variant) ?? guard,
      seenRefs,
      depth + 1,
    );
  }
}

/**
 * A union variant's discriminator: a property constrained to exactly one enum
 * value (e.g. `type: "secret_text"`). Strip paths through the variant carry it
 * as a guard, so stripping a secret `value` from a `secret_text` entry leaves a
 * `plain_text` entry's `value` alone.
 */
function discriminatorOf(
  spec: OpenAPISpec,
  variant: SchemaObject,
): [string, string | number | boolean] | undefined {
  let resolved: SchemaObject;
  try {
    resolved = resolveSchema(spec, variant);
  } catch {
    return undefined;
  }
  for (const [key, prop] of Object.entries(resolved.properties ?? {})) {
    let target: SchemaObject = prop;
    try {
      target = prop.$ref ? resolveSchema(spec, prop) : prop;
    } catch {
      continue;
    }
    if (target.enum?.length === 1) return [key, target.enum[0]];
  }
  return undefined;
}

/** True when any non-write-only secret sits anywhere under `schema`. */
function hasResponseSecret(spec: OpenAPISpec, schema: SchemaObject): boolean {
  let found = false;
  walkLeaves(spec, schema, true, () => {
    found = true;
  }, [{ k: "_" }]);
  return found;
}

/**
 * Trim a leaf path that ends inside an array or map up to the property that
 * holds it. A list of secrets is removed as a whole.
 */
function trimToKey(path: SensitivePath): SensitivePath {
  let end = path.length;
  while (end > 0 && !("k" in path[end - 1])) end--;
  return path.slice(0, end);
}

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/**
 * Names of every secret a request accepts, for the README. Crosses `$ref`, so
 * it reports secrets nested inside opaque arguments too (a Hyperdrive origin's
 * `password`), which the arguments schema cannot mark individually.
 */
export function collectInputSecretNames(
  spec: OpenAPISpec,
  requestBody: SchemaObject | undefined,
  queryParams: { name: string; schema?: SchemaObject }[],
): string[] {
  const names = new Set<string>();
  walkLeaves(spec, requestBody, false, (_path, name) => {
    if (name) names.add(name);
  }, requestBody ? [{ k: "_" }] : []);
  // The name heuristic over the inline tree, matching what the argument
  // schema marks.
  const visitInline = (s: SchemaObject | undefined, depth: number) => {
    if (!s || depth > MAX_DEPTH || s.$ref) return;
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (isSensitiveArgField(key, prop)) names.add(key);
      visitInline(prop, depth + 1);
    }
    visitInline(s.items, depth + 1);
    for (const v of s.oneOf ?? s.anyOf ?? []) visitInline(v, depth + 1);
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      visitInline(s.additionalProperties, depth + 1);
    }
  };
  visitInline(requestBody, 0);
  for (const p of queryParams) {
    const schema = p.schema ?? {};
    if (
      flagsOf(spec, schema).sensitive || isSensitiveArgField(p.name, schema)
    ) {
      names.add(p.name);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

/** True when the type mapper emits this node as a `z.object` with fields. */
export function emitsObject(s: SchemaObject): boolean {
  if (s.enum || s.oneOf || s.anyOf) return false;
  if (!s.properties) return false;
  return s.type === undefined || s.type === "object";
}

/** True when the type mapper can only emit this node as `z.unknown()`. */
function isOpaque(s: SchemaObject): boolean {
  if (s.$ref || s.allOf) return true;
  return !s.type && !s.properties && !s.items && !s.oneOf && !s.anyOf &&
    !s.enum;
}

/**
 * Build a passthrough skeleton for an opaque field: an object that declares
 * only the properties leading to a secret, so the secret is reachable while
 * every other key passes through untouched. Undefined when no secret can be
 * placed on a plain property path.
 */
function skeletonOf(
  spec: OpenAPISpec,
  schema: SchemaObject,
  depth: number,
): SchemaObject | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let resolved: SchemaObject;
  try {
    resolved = resolveSchema(spec, schema);
  } catch {
    return undefined;
  }
  if (!emitsObject(resolved)) return undefined;
  const props: Record<string, SchemaObject> = {};
  for (const [key, prop] of Object.entries(resolved.properties ?? {})) {
    const flags = flagsOf(spec, prop);
    if (flags.sensitive) {
      if (!flags.writeOnly) props[key] = { ...prop, "x-swamp-sensitive": true };
      continue;
    }
    if (!hasResponseSecret(spec, prop)) continue;
    const nested = skeletonOf(spec, prop, depth + 1);
    if (nested) props[key] = nested;
  }
  if (Object.keys(props).length === 0) return undefined;
  return {
    type: "object",
    properties: props,
    nullable: true,
    "x-swamp-loose": true,
  };
}

/** Expand opaque secret-holding fields of an inline object (copy-on-write). */
function expandOpaque(
  spec: OpenAPISpec,
  schema: SchemaObject,
  depth = 0,
): SchemaObject {
  if (!emitsObject(schema) || depth > MAX_DEPTH) return schema;
  let changed = false;
  const props: Record<string, SchemaObject> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let next = prop;
    if (isOpaque(prop)) {
      if (!flagsOf(spec, prop).sensitive && hasResponseSecret(spec, prop)) {
        next = skeletonOf(spec, prop, depth + 1) ?? prop;
      }
    } else if (emitsObject(prop)) {
      next = expandOpaque(spec, prop, depth + 1);
    }
    if (next !== prop) changed = true;
    props[key] = next;
  }
  return changed ? { ...schema, properties: props } : schema;
}

/**
 * One schema for a key whose union variants disagree. Secrets stay reachable:
 * each secret-holding variant contributes a skeleton, and the skeletons are
 * merged. Falls back to marking the whole value sensitive only when a variant
 * holds a secret no skeleton can reach, and to opaque when none holds one.
 */
function mergeConflicting(
  spec: OpenAPISpec,
  cands: SchemaObject[],
): SchemaObject {
  const holding = cands.filter((c) => hasResponseSecret(spec, c));
  if (holding.length === 0) return {};
  const skeletons = holding.map((c) => {
    const flags = flagsOf(spec, c);
    return flags.sensitive ? undefined : skeletonOf(spec, c, 1);
  });
  if (skeletons.some((sk) => sk === undefined)) {
    return { "x-swamp-sensitive": true };
  }
  return mergeSkeletons(skeletons as SchemaObject[]);
}

/** Merge skeleton objects key by key, recursing where they overlap. */
function mergeSkeletons(skeletons: SchemaObject[]): SchemaObject {
  const props: Record<string, SchemaObject> = {};
  for (const sk of skeletons) {
    for (const [key, prop] of Object.entries(sk.properties ?? {})) {
      const existing = props[key];
      if (!existing || JSON.stringify(existing) === JSON.stringify(prop)) {
        props[key] = prop;
      } else if (emitsObject(existing) && emitsObject(prop)) {
        props[key] = mergeSkeletons([existing, prop]);
      } else {
        props[key] = { "x-swamp-sensitive": true };
      }
    }
  }
  return {
    type: "object",
    properties: props,
    nullable: true,
    "x-swamp-loose": true,
  };
}

/**
 * Flatten a top-level union of objects into one object whose properties are
 * the union of the variants'. Resource schemas only validate (warn-only) and
 * locate sensitive fields; the persisted data is the raw response, so a
 * looser shape loses nothing. A key whose variants disagree becomes opaque,
 * and stays sensitive if any variant's copy holds a secret.
 */
function flattenUnion(spec: OpenAPISpec, schema: SchemaObject): SchemaObject {
  const variants = (schema.oneOf ?? schema.anyOf ?? []).map((v) => {
    try {
      return resolveSchema(spec, v);
    } catch {
      return v;
    }
  });
  if (variants.length === 0 || !variants.every(emitsObject)) return schema;
  const merged: Record<string, SchemaObject> = {};
  const candidates = new Map<string, SchemaObject[]>();
  for (const variant of variants) {
    for (const [key, prop] of Object.entries(variant.properties ?? {})) {
      const seen = candidates.get(key);
      if (!seen) {
        candidates.set(key, [prop]);
        merged[key] = prop;
      } else if (
        !seen.some((c) =>
          c === prop || JSON.stringify(c) === JSON.stringify(prop)
        )
      ) {
        seen.push(prop);
      }
    }
  }
  for (const [key, cands] of candidates) {
    if (cands.length > 1) merged[key] = mergeConflicting(spec, cands);
  }
  return {
    type: "object",
    properties: merged,
    ...(schema.nullable ? { nullable: true } : {}),
  };
}

/**
 * Key paths of the fields the emitted resource schema marks sensitive along
 * plain object properties — exactly the fields swamp will move into a vault.
 * Mirrors the type mapper: a field is marked by isSensitiveResponseField, and
 * only z.object nodes are descended.
 */
export function vaultablePaths(schema: SchemaObject | undefined): string[][] {
  const out: string[][] = [];
  const walk = (s: SchemaObject, prefix: string[], depth: number) => {
    if (depth > MAX_DEPTH || !emitsObject(s)) return;
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (isSensitiveResponseField(key, prop)) {
        out.push([...prefix, key]);
        continue;
      }
      walk(prop, [...prefix, key], depth + 1);
    }
  };
  if (schema) walk(schema, [], 0);
  return out;
}

/**
 * Reshape a (top-level-resolved) response schema so its secrets are reachable
 * by swamp's sensitive-field handling, and report what is where.
 *
 * Returns the original schema object untouched when the response carries no
 * secret, so regeneration of unaffected methods is byte-identical.
 */
export function prepareResponseSchema(
  spec: OpenAPISpec,
  schema: SchemaObject | undefined,
  isCollection = false,
): { schema: SchemaObject | undefined; secrets: ResponseSecrets } {
  const none: ResponseSecrets = { wrapRoot: false, vaultable: [], leaves: [] };
  if (!schema) return { schema, secrets: none };

  // A list resource stores its items under an array, which swamp's sensitive
  // handling never enters, so nothing in an item can be vaulted. Leave the
  // item schema as it is and report every secret for stripping.
  if (isCollection) {
    annotateSensitive(spec, schema);
    return {
      schema,
      secrets: { ...none, leaves: collectLeaves(spec, schema) },
    };
  }

  const rootFlags = flagsOf(spec, schema);
  if (rootFlags.sensitive && !rootFlags.writeOnly) {
    return {
      schema,
      secrets: { wrapRoot: true, vaultable: [["value"]], leaves: [] },
    };
  }

  annotateSensitive(spec, schema);
  if (!hasResponseSecret(spec, schema)) {
    return { schema, secrets: { ...none, vaultable: vaultablePaths(schema) } };
  }

  let prepared = schema;
  if ((schema.oneOf || schema.anyOf) && !schema.properties) {
    // Flatten only when it lets swamp vault something; otherwise the union
    // stays as it is and its secrets are stripped.
    const flat = expandOpaque(spec, flattenUnion(spec, schema));
    if (vaultablePaths(flat).length > 0) prepared = flat;
  } else {
    prepared = expandOpaque(spec, prepared);
  }

  return {
    schema: prepared,
    secrets: {
      wrapRoot: false,
      vaultable: vaultablePaths(prepared),
      leaves: collectLeaves(spec, prepared),
    },
  };
}

/** Every returned secret leaf under `schema`, trimmed and de-duplicated. */
function collectLeaves(
  spec: OpenAPISpec,
  schema: SchemaObject,
): SensitivePath[] {
  const leaves: SensitivePath[] = [];
  const seen = new Set<string>();
  walkLeaves(spec, schema, true, (path) => {
    const trimmed = trimToKey(path);
    if (trimmed.length === 0) return;
    const key = JSON.stringify(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    leaves.push(trimmed);
  });
  return leaves;
}

/**
 * The plain key path of a strip path, or undefined when the path crosses an
 * array or map (and so can never be vaulted).
 */
export function keyPathOf(path: SensitivePath): string[] | undefined {
  const keys: string[] = [];
  for (const seg of path) {
    if (!("k" in seg)) return undefined;
    keys.push(seg.k);
  }
  return keys;
}

/** Render a strip path for humans (README): `a.b[].c`, `env_vars{}.value`. */
export function formatPath(path: SensitivePath): string {
  let out = "";
  for (const seg of path) {
    if ("k" in seg) out += out ? `.${seg.k}` : seg.k;
    else if ("each" in seg) out += "[]";
    else out += "{}";
  }
  return out;
}
