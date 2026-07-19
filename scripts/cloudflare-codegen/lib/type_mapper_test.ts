/**
 * Tests for the type mapper module.
 */

import { assertEquals } from "@std/assert";
import { schemaToZod, schemaVarName } from "./type_mapper.ts";
import type { SchemaObject } from "./schema_fetcher.ts";

// ---------------------------------------------------------------------------
// Primitive Types
// ---------------------------------------------------------------------------

Deno.test("type_mapper: string type", () => {
  const schema: SchemaObject = { type: "string" };
  assertEquals(schemaToZod(schema), "z.string()");
});

Deno.test("type_mapper: string with maxLength", () => {
  const schema: SchemaObject = { type: "string", maxLength: 255 };
  assertEquals(schemaToZod(schema), "z.string().max(255)");
});

Deno.test("type_mapper: string with minLength and maxLength", () => {
  const schema: SchemaObject = { type: "string", minLength: 1, maxLength: 100 };
  assertEquals(schemaToZod(schema), "z.string().min(1).max(100)");
});

Deno.test("type_mapper: integer type", () => {
  const schema: SchemaObject = { type: "integer" };
  assertEquals(schemaToZod(schema), "z.number().int()");
});

Deno.test("type_mapper: number with min/max", () => {
  const schema: SchemaObject = { type: "number", minimum: 0, maximum: 100 };
  assertEquals(schemaToZod(schema), "z.number().min(0).max(100)");
});

Deno.test("type_mapper: boolean type", () => {
  const schema: SchemaObject = { type: "boolean" };
  assertEquals(schemaToZod(schema), "z.boolean()");
});

// ---------------------------------------------------------------------------
// Nullable
// ---------------------------------------------------------------------------

Deno.test("type_mapper: nullable string", () => {
  const schema: SchemaObject = { type: "string", nullable: true };
  assertEquals(schemaToZod(schema), "z.string().nullable()");
});

Deno.test("type_mapper: nullable integer", () => {
  const schema: SchemaObject = { type: "integer", nullable: true };
  assertEquals(schemaToZod(schema), "z.number().int().nullable()");
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

Deno.test("type_mapper: string enum", () => {
  const schema: SchemaObject = { enum: ["active", "pending", "deleted"] };
  assertEquals(
    schemaToZod(schema),
    'z.enum(["active", "pending", "deleted"])',
  );
});

Deno.test("type_mapper: mixed enum (uses union of literals)", () => {
  const schema: SchemaObject = { enum: [1, "two", true] };
  assertEquals(
    schemaToZod(schema),
    'z.union([z.literal(1), z.literal("two"), z.literal(true)])',
  );
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

Deno.test("type_mapper: array of strings", () => {
  const schema: SchemaObject = { type: "array", items: { type: "string" } };
  assertEquals(schemaToZod(schema), "z.array(z.string())");
});

Deno.test("type_mapper: array without items defaults to unknown", () => {
  const schema: SchemaObject = { type: "array" };
  assertEquals(schemaToZod(schema), "z.array(z.unknown())");
});

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

Deno.test("type_mapper: empty object", () => {
  const schema: SchemaObject = { type: "object" };
  assertEquals(schemaToZod(schema), "z.object({})");
});

Deno.test("type_mapper: object with properties", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
    required: ["id"],
  };
  const result = schemaToZod(schema);
  // id is required, name is optional
  assertEquals(result.includes("id: z.string(),"), true);
  assertEquals(result.includes("name: z.string().optional(),"), true);
});

Deno.test("type_mapper: record type (additionalProperties)", () => {
  const schema: SchemaObject = {
    type: "object",
    additionalProperties: { type: "string" },
  };
  assertEquals(schemaToZod(schema), "z.record(z.string(), z.string())");
});

Deno.test("type_mapper: record with boolean additionalProperties", () => {
  const schema: SchemaObject = {
    type: "object",
    additionalProperties: true,
  };
  assertEquals(schemaToZod(schema), "z.record(z.string(), z.unknown())");
});

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

Deno.test("type_mapper: oneOf with two schemas", () => {
  const schema: SchemaObject = {
    oneOf: [{ type: "string" }, { type: "number" }],
  };
  assertEquals(schemaToZod(schema), "z.union([z.string(), z.number()])");
});

Deno.test("type_mapper: oneOf with single schema unwraps", () => {
  const schema: SchemaObject = {
    oneOf: [{ type: "string" }],
  };
  assertEquals(schemaToZod(schema), "z.string()");
});

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

Deno.test("type_mapper: respects maxDepth", () => {
  const deepSchema: SchemaObject = {
    type: "object",
    properties: {
      nested: {
        type: "object",
        properties: {
          deep: { type: "string" },
        },
      },
    },
  };
  const result = schemaToZod(deepSchema, { maxDepth: 1 });
  assertEquals(result.includes("z.unknown()"), true);
});

// ---------------------------------------------------------------------------
// schemaVarName helper
// ---------------------------------------------------------------------------

Deno.test("type_mapper: schemaVarName converts to PascalCase", () => {
  assertEquals(schemaVarName("list_buckets"), "ListBucketsSchema");
  assertEquals(schemaVarName("get-namespace"), "GetNamespaceSchema");
  assertEquals(schemaVarName("create_database"), "CreateDatabaseSchema");
});
