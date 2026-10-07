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
   * Response-side mode. Response schemas describe what the API returned, which
   * the spec never captures fully, so one unexpected value must not fail a
   * whole page. Lenient mode emits plain `z.string()` / `z.number()` for
   * enums, drops value constraints (min/max/pattern/int), marks every object
   * property nullish, and omits defaults. Request-side schemas stay strict.
   */
  lenient?: boolean;
}

const DEFAULT_OPTIONS: Required<TypeMapperOptions> = {
  indent: 2,
  maxDepth: 8,
  lenient: false,
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
    return opts.lenient ? lenientEnum(schema.enum) : enumToZod(schema.enum);
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
      return opts.lenient ? "z.string()" : stringToZod(schema);
    case "number":
    case "integer":
      return opts.lenient ? "z.number()" : numberToZod(schema);
    case "boolean":
      return "z.boolean()";
    case "array":
      return arrayToZod(schema, opts, depth);
    case "object":
      return objectToZod(schema, opts, depth);
    case "null":
      return "z.null()";
    default:
      // No type specified — could be a freeform object or unknown
      if (schema.properties) {
        return objectToZod(schema, opts, depth);
      }
      return "z.unknown()";
  }
}

function stringToZod(schema: SchemaObject): string {
  let s = "z.string()";
  if (schema.minLength !== undefined) {
    s += `.min(${schema.minLength})`;
  }
  if (schema.maxLength !== undefined) {
    s += `.max(${schema.maxLength})`;
  }
  if (schema.pattern !== undefined) {
    s += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
  }
  return s;
}

function numberToZod(schema: SchemaObject): string {
  let s = "z.number()";
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

/** Response-side enum: accept any value of the enum's primitive type. */
function lenientEnum(values: (string | number | boolean)[]): string {
  const types = new Set(values.map((v) => typeof v));
  if (types.size === 1) {
    const only = [...types][0];
    if (only === "string") return "z.string()";
    if (only === "number") return "z.number()";
    if (only === "boolean") return "z.boolean()";
  }
  return "z.unknown()";
}

function enumToZod(values: (string | number | boolean)[]): string {
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
  if (schema.additionalProperties && !schema.properties) {
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

  if (!schema.properties) {
    return opts.lenient ? "z.object({}).passthrough()" : "z.object({})";
  }

  const required = new Set(schema.required ?? []);
  const indent = " ".repeat(opts.indent * (depth + 1));
  const closingIndent = " ".repeat(opts.indent * depth);

  const fields: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const safeName = isSafeIdentifier(name) ? name : `"${name}"`;
    let fieldType = schemaToZod(prop, opts, depth + 1);

    // Add .optional() for non-required fields
    if (opts.lenient) {
      // Snyk returns null for attributes the spec types as plain values.
      fieldType += ".nullish()";
    } else if (!required.has(name)) {
      fieldType += ".optional()";
    }

    // Add .default() if the schema declares a default value. Response-side
    // schemas record what the API sent, so they never inject defaults.
    if (!opts.lenient && prop.default !== undefined) {
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
    return opts.lenient ? "z.object({}).passthrough()" : "z.object({})";
  }

  // Response objects keep fields the spec does not list, at every depth.
  const tail = opts.lenient ? ".passthrough()" : "";
  return `z.object({\n${fields.join("\n")}\n${closingIndent}})${tail}`;
}

/** Generate a Zod schema variable name from an operation/resource name */
export function schemaVarName(baseName: string): string {
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

/** Truncate long descriptions for .describe() calls */
function truncateDescription(desc: string): string {
  return truncateAtBoundary(desc, 100);
}

/**
 * Truncate prose to at most `max` characters without cutting a word in half.
 * Prefers the last complete sentence inside the budget, then the last whole
 * word followed by an ellipsis.
 */
export function truncateAtBoundary(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;

  const bounded = oneLine.slice(0, max);
  // A sentence terminator only counts when followed by a space (or the cut),
  // so "e.g." or "v1.2" inside a word does not end the sentence.
  let sentenceEnd = -1;
  for (let i = bounded.length - 1; i > 0; i--) {
    if (
      ".!?".includes(bounded[i]) &&
      (i === bounded.length - 1 ? oneLine[max] === " " : bounded[i + 1] === " ")
    ) {
      sentenceEnd = i;
      break;
    }
  }
  if (sentenceEnd > 0) return bounded.slice(0, sentenceEnd + 1);

  // Cut at the last space within budget less room for the ellipsis.
  const room = bounded.slice(0, max - 3);
  const wordEnd = oneLine[max - 3] === " "
    ? room.length
    : room.lastIndexOf(" ");
  return `${room.slice(0, wordEnd > 0 ? wordEnd : room.length).trimEnd()}...`;
}
