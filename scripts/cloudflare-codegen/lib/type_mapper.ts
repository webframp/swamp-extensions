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
}

const DEFAULT_OPTIONS: Required<TypeMapperOptions> = {
  indent: 2,
  maxDepth: 8,
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
    return enumToZod(schema.enum);
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
      return stringToZod(schema);
    case "number":
    case "integer":
      return numberToZod(schema);
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

function stringToZod(schema: SchemaObject): string {
  let s = "z.string()";
  if (schema.format === "date-time") {
    s += ".datetime({ offset: true }).optional()";
    // Remove the .optional() we're about to add — datetime fields from CF
    // are usually present but we want the format validation
    s = "z.string()";
  }
  if (schema.minLength !== undefined) {
    s += `.min(${schema.minLength})`;
  }
  if (schema.maxLength !== undefined) {
    s += `.max(${schema.maxLength})`;
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

  if (!schema.properties) {
    return "z.object({})";
  }

  const required = new Set(schema.required ?? []);
  const indent = " ".repeat(opts.indent * (depth + 1));
  const closingIndent = " ".repeat(opts.indent * depth);

  const fields: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const safeName = isSafeIdentifier(name) ? name : `"${name}"`;
    let fieldType = schemaToZod(prop, opts, depth + 1);

    // Add .optional() for non-required fields
    if (!required.has(name)) {
      fieldType += ".optional()";
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
    return "z.object({})";
  }

  return `z.object({\n${fields.join("\n")}\n${closingIndent}})`;
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

/** Truncate long descriptions for .describe() calls */
function truncateDescription(desc: string): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 100) return oneLine;
  return oneLine.slice(0, 97) + "...";
}
