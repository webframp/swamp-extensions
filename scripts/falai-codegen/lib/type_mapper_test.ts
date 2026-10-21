/**
 * Tests for the type mapper module.
 */

import { ZOD_VERSION } from "../config.ts";
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

Deno.test("type_mapper: lenient ignores required, marking every field optional", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
    },
    required: ["name"],
  };
  assertEquals(
    schemaToZod(schema, { lenient: true }),
    "z.object({\n  name: z.string().optional(),\n  count: z.number().int().optional(),\n})",
  );
});

Deno.test("type_mapper: lenient on a required+nullable field emits .nullable().optional()", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      quantity: { type: ["number", "null"] },
    },
    required: ["quantity"],
  };
  assertEquals(
    schemaToZod(schema, { lenient: true }),
    "z.object({\n  quantity: z.number().nullable().optional(),\n})",
  );
});

Deno.test("type_mapper: lenient applies at nested depths too", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      inner: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    required: ["inner"],
  };
  assertEquals(
    schemaToZod(schema, { lenient: true }),
    "z.object({\n  inner: z.object({\n    id: z.string().optional(),\n  }).optional(),\n})",
  );
});

// ---------------------------------------------------------------------------
// schemaVarName
// ---------------------------------------------------------------------------

Deno.test("type_mapper: schemaVarName converts snake_case to PascalCase+Schema", () => {
  assertEquals(schemaVarName("compute_instance"), "ComputeInstanceSchema");
  assertEquals(schemaVarName("asset"), "AssetSchema");
});

// ---------------------------------------------------------------------------
// Sensitive fields
// ---------------------------------------------------------------------------

Deno.test("type_mapper: sensitiveFields marks only the named top-level fields, before optional", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      key_id: { type: "string" },
      key_secret: { type: "string", description: "Secret" },
      nested: {
        type: "object",
        properties: { key_secret: { type: "string" } },
      },
    },
  };
  assertEquals(
    schemaToZod(schema, { lenient: true, sensitiveFields: ["key_secret"] }),
    `z.object({
  key_id: z.string().optional(),
  key_secret: z.string().meta({ sensitive: true }).optional().describe("Secret"),
  nested: z.object({
    key_secret: z.string().optional(),
  }).optional(),
})`,
  );
});

Deno.test("type_mapper: sensitiveFields keeps chained refinements after the marker", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      token: { type: ["string", "null"], minLength: 1 },
      blob: { type: "object", properties: { a: { type: "string" } } },
    },
  };
  const out = schemaToZod(schema, {
    lenient: true,
    sensitiveFields: ["token", "blob"],
  });
  assertEquals(
    out.includes(
      "token: z.string().min(1).meta({ sensitive: true }).nullable().optional(),",
    ),
    true,
  );
  assertEquals(out.includes("}).meta({ sensitive: true }).optional(),"), true);
});

Deno.test("pinned zod keeps metadata across a refinement in either order", async () => {
  // The marker's position is a convention, not a requirement: pinned zod
  // carries .meta() through .min() whichever comes first.
  const { z } = await import(`npm:zod@${ZOD_VERSION}`);
  assertEquals(
    z.string().meta({ sensitive: true }).min(1).meta()?.sensitive,
    true,
  );
  assertEquals(
    z.string().min(1).meta({ sensitive: true }).meta()?.sensitive,
    true,
  );
});

Deno.test("type_mapper: sensitiveFields does not leak into array items or records", () => {
  const item: SchemaObject = {
    type: "object",
    properties: { key: { type: "string" } },
  };
  assertEquals(
    schemaToZod({ type: "array", items: item }, { sensitiveFields: ["key"] })
      .includes("sensitive"),
    false,
  );
  assertEquals(
    schemaToZod({ type: "object", additionalProperties: item }, {
      sensitiveFields: ["key"],
    }).includes("sensitive"),
    false,
  );
});
