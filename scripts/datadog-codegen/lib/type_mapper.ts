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

/** A field the mapper marked `.meta({ sensitive: true })`. */
export interface SensitiveMark {
  /**
   * Path from the root schema: `.` for object fields, `[]` for array items,
   * `{}` for record values, `|` for a union member.
   */
  path: string;
  /**
   * True when every step from the root is an object field. swamp's resource
   * redaction walks object shapes only, so a resource field is stored in a
   * vault only when this is true. Method-argument masking walks arrays,
   * records and unions too, so arguments do not depend on it.
   */
  reachable: boolean;
}

/** Configuration for type mapper output */
export interface TypeMapperOptions {
  /** Indent level (number of spaces per level) */
  indent?: number;
  /** Maximum depth before collapsing to z.unknown() */
  maxDepth?: number;
  /** Mark an object property sensitive when this returns true for it. */
  isSensitiveName?: (name: string, schema: SchemaObject) => boolean;
  /** Object-field paths (`a.b`) from the root to mark sensitive. */
  sensitivePaths?: readonly string[];
  /** Receives every field the mapper marked sensitive. */
  marks?: SensitiveMark[];
}

interface ResolvedOptions {
  indent: number;
  maxDepth: number;
  isSensitiveName?: (name: string, schema: SchemaObject) => boolean;
  sensitivePaths: ReadonlySet<string>;
  marks?: SensitiveMark[];
}

/** Where the mapper is in the schema tree, for sensitive-field paths. */
interface Position {
  path: string;
  reachable: boolean;
}

const ROOT: Position = { path: "", reachable: true };

const DEFAULT_OPTIONS = {
  indent: 2,
  maxDepth: 8,
};

function resolveOptions(options?: TypeMapperOptions): ResolvedOptions {
  const o = options ?? {};
  return {
    indent: o.indent ?? DEFAULT_OPTIONS.indent,
    maxDepth: o.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
    isSensitiveName: o.isSensitiveName,
    sensitivePaths: new Set(o.sensitivePaths ?? []),
    marks: o.marks,
  };
}

function child(pos: Position, step: string, viaObject: boolean): Position {
  const path = step.startsWith(".")
    ? (pos.path ? `${pos.path}${step}` : step.slice(1))
    : `${pos.path}${step}`;
  return { path, reachable: pos.reachable && viaObject };
}

/**
 * Convert an OpenAPI SchemaObject to a Zod schema source code string.
 */
export function schemaToZod(
  schema: SchemaObject,
  options?: TypeMapperOptions,
  depth = 0,
): string {
  return toZod(schema, resolveOptions(options), depth, ROOT);
}

function toZod(
  schema: SchemaObject,
  opts: ResolvedOptions,
  depth: number,
  pos: Position,
): string {
  if (depth > opts.maxDepth) {
    return "z.unknown()";
  }

  // Handle nullable wrapper
  const nullable = schema.nullable === true;
  let base = schemaToZodInner(schema, opts, depth, pos);

  if (nullable) {
    base = `${base}.nullable()`;
  }

  return base;
}

function schemaToZodInner(
  schema: SchemaObject,
  opts: ResolvedOptions,
  depth: number,
  pos: Position,
): string {
  // Enum takes priority
  if (schema.enum) {
    return enumToZod(schema.enum);
  }

  // Union types
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf)!;
    if (variants.length === 1) {
      return toZod(variants[0], opts, depth + 1, pos);
    }
    const members = variants.map((v) =>
      toZod(v, opts, depth + 1, child(pos, "|", false))
    );
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
      return arrayToZod(schema, opts, depth, pos);
    case "object":
      return objectToZod(schema, opts, depth, pos);
    case "null":
      return "z.null()";
    default:
      // No type specified — could be a freeform object or unknown
      if (schema.properties) {
        return objectToZod(schema, opts, depth, pos);
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
  opts: ResolvedOptions,
  depth: number,
  pos: Position,
): string {
  if (!schema.items) {
    return "z.array(z.unknown())";
  }
  const itemType = toZod(
    schema.items,
    opts,
    depth + 1,
    child(pos, "[]", false),
  );
  return `z.array(${itemType})`;
}

function objectToZod(
  schema: SchemaObject,
  opts: ResolvedOptions,
  depth: number,
  pos: Position,
): string {
  // Record type (additionalProperties without fixed properties)
  if (schema.additionalProperties && !schema.properties) {
    if (schema.additionalProperties === true) {
      return "z.record(z.string(), z.unknown())";
    }
    const valueType = toZod(
      schema.additionalProperties as SchemaObject,
      opts,
      depth + 1,
      child(pos, "{}", false),
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
    const fieldPos = child(pos, `.${name}`, true);
    let fieldType = toZod(prop, opts, depth + 1, fieldPos);

    // Mark secret-bearing fields so swamp masks or vaults their values.
    if (
      opts.sensitivePaths.has(fieldPos.path) ||
      opts.isSensitiveName?.(name, prop)
    ) {
      fieldType += ".meta({ sensitive: true })";
      opts.marks?.push({ ...fieldPos });
    }

    // Add .optional() for non-required fields
    if (!required.has(name)) {
      fieldType += ".optional()";
    }

    // Add .default() if the schema declares a default value
    if (prop.default !== undefined) {
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
    return "z.object({})";
  }

  return `z.object({\n${fields.join("\n")}\n${closingIndent}})`;
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
