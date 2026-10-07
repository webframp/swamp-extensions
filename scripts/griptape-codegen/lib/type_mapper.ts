/**
 * Type mapper — converts OpenAPI schema objects to Zod source code strings.
 *
 * Generates TypeScript source code that defines Zod schemas matching
 * the shapes described by the OpenAPI spec. Handles:
 * - Primitives (string, number, integer, boolean)
 * - Objects with properties and required fields
 * - Arrays
 * - Enums
 * - Nullable
 * - Optional (not in required array)
 * - Unions (oneOf/anyOf)
 * - Records (additionalProperties)
 */

import type { SchemaObject } from "./schema_fetcher.ts";

/** Configuration for type mapper output */
export interface TypeMapperOptions {
  /** Indent level (number of spaces per level) */
  indent?: number;
  /** Maximum depth before collapsing to z.unknown() */
  maxDepth?: number;
  /**
   * "request" (default) keeps the spec's constraints so bad input fails fast
   * before it reaches the API. "response" is deliberately tolerant: observed
   * data must never be rejected because the server returned a value the spec
   * did not anticipate. Response mode
   *   - maps enums to their base type (a new enum member must not fail a page),
   *   - drops pattern / length / range constraints,
   *   - treats every object field as nullish (one item missing a "required"
   *     field must not fail a whole page of results), and
   *   - keeps unknown keys on every object (z.looseObject), and
   *   - omits spec defaults (observed data is not fabricated).
   */
  mode?: "request" | "response";
}

const DEFAULT_OPTIONS: Required<TypeMapperOptions> = {
  indent: 2,
  maxDepth: 8,
  mode: "request",
};

/**
 * Convert an OpenAPI SchemaObject to a Zod schema source code string.
 */
export function schemaToZod(
  schema: SchemaObject,
  options?: TypeMapperOptions,
  depth = 0,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (depth > opts.maxDepth) {
    return "z.unknown()";
  }

  // Handle nullable wrapper
  const nullable = schema.nullable === true;
  let base = schemaToZodInner(schema, opts, depth);

  if (nullable) {
    base = `${base}.nullable()`;
  }

  return base;
}

function schemaToZodInner(
  schema: SchemaObject,
  opts: Required<TypeMapperOptions>,
  depth: number,
): string {
  // Enum takes priority
  if (schema.enum) {
    return opts.mode === "response"
      ? enumBaseToZod(schema.enum)
      : enumToZod(schema.enum);
  }

  // Union types
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf)!;
    if (variants.length === 1) {
      return schemaToZod(variants[0], opts, depth + 1);
    }
    const members = variants.map((v) => schemaToZod(v, opts, depth + 1));
    return `z.union([${members.join(", ")}])`;
  }

  switch (schema.type) {
    case "string":
      return stringToZod(schema, opts.mode);
    case "number":
    case "integer":
      return numberToZod(schema, opts.mode);
    case "boolean":
      return "z.boolean()";
    case "array":
      return arrayToZod(schema, opts, depth);
    case "object":
      return objectToZod(schema, opts, depth);
    default:
      // No type specified — could be a freeform object or unknown
      if (schema.properties) {
        return objectToZod(schema, opts, depth);
      }
      return "z.unknown()";
  }
}

function stringToZod(
  schema: SchemaObject,
  mode: "request" | "response" = "request",
): string {
  let s = "z.string()";
  // Response fields are nullish at the object level; no constraints apply.
  if (mode === "response") return s;
  if (schema.format === "date-time" && schema.nullable !== true) {
    // Lifecycle timestamp fields (last_used, deleted_at, started_at, ...) are
    // routinely null before the event occurs, and the Griptape spec is
    // inconsistent about marking them nullable (e.g. `last_used` is declared
    // required + non-nullable but the API returns null for a never-used
    // secret). These are observational response fields, so accept null rather
    // than throwing on writeResource validation. A real timestamp still
    // validates. (When the spec DOES mark nullable, schemaToZod adds .nullable()
    // itself — guard against double-wrapping here.)
    s += ".nullable()";
  }
  if (schema.minLength !== undefined) {
    s += `.min(${schema.minLength})`;
  }
  if (schema.maxLength !== undefined) {
    s += `.max(${schema.maxLength})`;
  }
  if (schema.pattern !== undefined) {
    // new RegExp(...) with a JSON-encoded source so backslashes and quotes in
    // the spec's pattern survive into valid TypeScript.
    s += `.regex(new RegExp(${
      JSON.stringify(normalizePattern(schema.pattern))
    }))`;
  }
  return s;
}

function numberToZod(
  schema: SchemaObject,
  mode: "request" | "response" = "request",
): string {
  let s = "z.number()";
  if (mode === "response") return s;
  if (schema.type === "integer") {
    s += ".int()";
  }
  if (schema.minimum !== undefined) {
    s += `.min(${schema.minimum})`;
  }
  if (schema.maximum !== undefined) {
    s += `.max(${schema.maximum})`;
  }
  return s;
}

function enumToZod(values: (string | number | boolean)[]): string {
  // Filter to only string values for z.enum (most common in CF API)
  const stringValues = values.filter((v) => typeof v === "string") as string[];
  if (stringValues.length === values.length && stringValues.length > 0) {
    const literals = stringValues.map((v) => `"${escapeString(v)}"`);
    return `z.enum([${literals.join(", ")}])`;
  }
  // Mixed types — use z.union of literals
  const literals = values.map((v) => {
    if (typeof v === "string") return `z.literal("${escapeString(v)}")`;
    if (typeof v === "boolean") return `z.literal(${v})`;
    return `z.literal(${v})`;
  });
  return `z.union([${literals.join(", ")}])`;
}

/**
 * Response-side enum: the enum's base type, so an unexpected member still
 * validates. Mixed or empty enums fall back to z.unknown().
 */
function enumBaseToZod(values: (string | number | boolean)[]): string {
  const kinds = new Set(values.map((v) => typeof v));
  if (kinds.size !== 1) return "z.unknown()";
  const kind = [...kinds][0];
  if (kind === "string") return "z.string()";
  if (kind === "number") return "z.number()";
  if (kind === "boolean") return "z.boolean()";
  return "z.unknown()";
}

function arrayToZod(
  schema: SchemaObject,
  opts: Required<TypeMapperOptions>,
  depth: number,
): string {
  if (!schema.items) {
    return "z.array(z.unknown())";
  }
  const itemType = schemaToZod(schema.items, opts, depth + 1);
  return `z.array(${itemType})`;
}

function objectToZod(
  schema: SchemaObject,
  opts: Required<TypeMapperOptions>,
  depth: number,
): string {
  // Record type (additionalProperties without fixed properties)
  if (
    schema.additionalProperties && !schema.properties
  ) {
    if (schema.additionalProperties === true) {
      return "z.record(z.string(), z.unknown())";
    }
    const valueType = schemaToZod(
      schema.additionalProperties as SchemaObject,
      opts,
      depth + 1,
    );
    return `z.record(z.string(), ${valueType})`;
  }

  const response = opts.mode === "response";
  const objectFn = response ? "z.looseObject" : "z.object";

  if (!schema.properties) {
    return `${objectFn}({})`;
  }

  const required = new Set(schema.required ?? []);
  const indent = " ".repeat(opts.indent * (depth + 1));
  const closingIndent = " ".repeat(opts.indent * depth);

  const fields: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const safeName = isSafeIdentifier(name) ? name : `"${name}"`;
    let fieldType = schemaToZod(prop, opts, depth + 1);

    if (response) {
      // Tolerant: absent or null never fails validation, required or not.
      fieldType = fieldType.replace(/\.nullable\(\)$/, "") + ".nullish()";
    } else if (!required.has(name)) {
      // Add .optional() for non-required fields
      fieldType += ".optional()";
    }

    // Add .default() if the schema declares a default value
    if (!response && prop.default !== undefined) {
      fieldType += `.default(${JSON.stringify(prop.default)})`;
    }

    // Add .describe() if there's a description (only for top-level fields)
    if (prop.description && depth < 2) {
      fieldType += `.describe(${
        JSON.stringify(truncateDescription(prop.description))
      })`;
    }

    fields.push(`${indent}${safeName}: ${fieldType},`);
  }

  if (fields.length === 0) {
    return `${objectFn}({})`;
  }

  return `${objectFn}({\n${fields.join("\n")}\n${closingIndent}})`;
}

/** Generate a Zod schema variable name from an operation/resource name */
export function schemaVarName(baseName: string): string {
  // Convert to PascalCase + "Schema" suffix
  const pascal = baseName
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
  return `${pascal}Schema`;
}

/** Generate a TypeScript-safe identifier for a field name */
function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/** Escape string for use inside a double-quoted TypeScript string */
function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Collapse whitespace and shorten `desc` to at most `max` characters
 * (including the trailing "..."), cutting at a word boundary so the text never
 * ends mid-word. A single word longer than the limit is hard-cut.
 */
export function truncateAtWord(desc: string, max = 100): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const budget = max - 3;
  const window = oneLine.slice(0, budget + 1);
  // Cut at the last space within the budget (the +1 char lets a word that ends
  // exactly at the budget survive).
  const lastSpace = window.lastIndexOf(" ");
  let cut = lastSpace > 0
    ? window.slice(0, lastSpace)
    : oneLine.slice(0, budget);
  cut = cut.replace(/[\s,;:.\-]+$/, "");
  return cut + "...";
}

function truncateDescription(desc: string): string {
  return truncateAtWord(desc, 100);
}

/**
 * Normalize known-malformed regex patterns from the source spec before emitting
 * them into generated Zod `.regex(...)` calls.
 *
 * The Griptape spec declares UUID fields with the character class
 * `[0-9(a-f|A-F)]`. Inside a regex character class `|`, `(`, and `)` are
 * LITERALS, not alternation/grouping — so the class matches the 16 hex digits
 * PLUS `(`, `|`, `)`. A value like `(((( ...` then passes UUID validation and
 * reaches the API, which rejects it with an unhelpful 400/404 instead of Zod
 * surfacing a clear format error. Rewrite that class to the intended
 * `[0-9a-fA-F]`. The replacement is global and idempotent; a well-formed
 * pattern is returned unchanged.
 */
export function normalizePattern(pattern: string): string {
  return pattern.replaceAll("[0-9(a-f|A-F)]", "[0-9a-fA-F]");
}
