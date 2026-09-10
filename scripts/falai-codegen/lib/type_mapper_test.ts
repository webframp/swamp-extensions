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

Deno.test("type_mapper: string with pattern emits .regex(new RegExp(...))", () => {
  const schema: SchemaObject = { type: "string", pattern: "^[a-z0-9]+$" };
  assertEquals(
    schemaToZod(schema),
    'z.string().regex(new RegExp("^[a-z0-9]+$"))',
  );
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
// OpenAPI 3.1 array-form nullability (fal.ai's actual spec shape)
// ---------------------------------------------------------------------------

Deno.test("type_mapper: type: [string, null] emits .nullable()", () => {
  const schema: SchemaObject = { type: ["string", "null"] };
  assertEquals(schemaToZod(schema), "z.string().nullable()");
});

Deno.test("type_mapper: type: [number, null] emits .nullable()", () => {
  const schema: SchemaObject = { type: ["number", "null"] };
  assertEquals(schemaToZod(schema), "z.number().nullable()");
});

Deno.test("type_mapper: type: [array, null] with items", () => {
  const schema: SchemaObject = {
    type: ["array", "null"],
    items: { type: "string" },
  };
  assertEquals(schemaToZod(schema), "z.array(z.string()).nullable()");
});

Deno.test("type_mapper: OpenAPI 3.0 nullable:true sibling keyword still works", () => {
  const schema: SchemaObject = { type: "string", nullable: true };
  assertEquals(schemaToZod(schema), "z.string().nullable()");
});

Deno.test("type_mapper: enum containing a null literal drops it and stays nullable via type array", () => {
  const schema: SchemaObject = {
    type: ["string", "null"],
    enum: ["a", "b", null],
  };
  assertEquals(schemaToZod(schema), 'z.enum(["a", "b"]).nullable()');
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

Deno.test("type_mapper: string enum", () => {
  const schema: SchemaObject = { type: "string", enum: ["a", "b", "c"] };
  assertEquals(schemaToZod(schema), 'z.enum(["a", "b", "c"])');
});

// ---------------------------------------------------------------------------
// Unions (oneOf/anyOf) — fal.ai uses anyOf for e.g. `string | string[]` params
// ---------------------------------------------------------------------------

Deno.test("type_mapper: anyOf with two variants becomes z.union", () => {
  const schema: SchemaObject = {
    anyOf: [{ type: "string" }, {
      type: "array",
      items: { type: "string" },
    }],
  };
  assertEquals(
    schemaToZod(schema),
    "z.union([z.string(), z.array(z.string())])",
  );
});

Deno.test("type_mapper: oneOf with two variants becomes z.union", () => {
  const schema: SchemaObject = {
    oneOf: [
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
      {
        type: "object",
        properties: { b: { type: "string" } },
        required: ["b"],
      },
    ],
  };
  assertEquals(
    schemaToZod(schema),
    "z.union([z.object({\n    a: z.string(),\n  }), z.object({\n    b: z.string(),\n  })])",
  );
});

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

Deno.test("type_mapper: object with required and optional fields", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
    },
    required: ["name"],
  };
  assertEquals(
    schemaToZod(schema),
    "z.object({\n  name: z.string(),\n  count: z.number().int().optional(),\n})",
  );
});

Deno.test("type_mapper: record via additionalProperties", () => {
  const schema: SchemaObject = {
    type: "object",
    additionalProperties: { type: "string" },
  };
  assertEquals(schemaToZod(schema), "z.record(z.string(), z.string())");
});

// ---------------------------------------------------------------------------
// schemaVarName
// ---------------------------------------------------------------------------

Deno.test("type_mapper: schemaVarName converts snake_case to PascalCase+Schema", () => {
  assertEquals(schemaVarName("compute_instance"), "ComputeInstanceSchema");
  assertEquals(schemaVarName("asset"), "AssetSchema");
});
