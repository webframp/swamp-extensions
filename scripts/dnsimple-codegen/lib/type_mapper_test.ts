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
// OpenAPI 3.1 array-form nullability (DNSimple's actual spec shape)
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
// Unions (oneOf/anyOf) — DNSimple uses anyOf for e.g. `string | string[]` params
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
  // Not lenient: lenient response schemas drop refinements altogether.
  const out = schemaToZod(schema, {
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

// ---------------------------------------------------------------------------
// Tolerant (passthrough) output
// ---------------------------------------------------------------------------

Deno.test("passthrough: every object, at every depth, tolerates unknown fields", () => {
  const out = schemaToZod(
    {
      type: "object",
      properties: {
        child: {
          type: "object",
          properties: { id: { type: "integer" } },
        },
        list: {
          type: "array",
          items: { type: "object", properties: { n: { type: "string" } } },
        },
        empty: { type: "object" },
      },
    },
    { passthrough: true, lenient: true },
  );
  assertEquals(
    out.match(/\.passthrough\(\)/g)?.length,
    3,
    "root, child and list item; the empty object is a record",
  );
});

Deno.test("nullTolerant: every object field accepts null, once, at every depth", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      email: { type: "string" },
      already: { type: ["string", "null"] },
      child: { type: "object", properties: { id: { type: "integer" } } },
    },
  };
  const out = schemaToZod(schema, { nullTolerant: true, lenient: true });
  assertEquals(out.includes("email: z.string().nullable()"), true);
  assertEquals(out.includes(".nullable().nullable()"), false);
  assertEquals(out.includes("id: z.number().int().nullable()"), true);
  assertEquals(
    schemaToZod(schema).includes("email: z.string().nullable()"),
    false,
  );
});

Deno.test("emitDefaults: false leaves a declared default out of the schema", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: { ttl: { type: "integer", default: 3600 } },
  };
  assertEquals(schemaToZod(schema).includes(".default(3600)"), true);
  assertEquals(
    schemaToZod(schema, { emitDefaults: false }).includes(".default("),
    false,
  );
});

Deno.test("free-form object: no declared properties maps to a record, never a stripping z.object", () => {
  const schema: SchemaObject = { type: "object" };
  assertEquals(schemaToZod(schema), "z.record(z.string(), z.unknown())");
  assertEquals(
    schemaToZod(schema, { passthrough: true }),
    "z.record(z.string(), z.unknown())",
  );
});

Deno.test("lenient: a string enum widens to a string, a strict one stays an enum", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: { type: { type: "string", enum: ["A", "MX"] } },
  };
  assertEquals(schemaToZod(schema).includes('z.enum(["A", "MX"])'), true);
  const lenient = schemaToZod(schema, { lenient: true });
  assertEquals(lenient.includes("z.enum"), false);
  assertEquals(lenient.includes("type: z.string().optional()"), true);
});

Deno.test("lenient: integer and mixed enums widen too, and response bounds are dropped", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      kind: { type: "integer", enum: [1, 2, 3] },
      mixed: { enum: ["a", 1] },
      period: { type: "integer", minimum: 1, maximum: 10 },
      name: { type: "string", minLength: 2, pattern: "^a" },
    },
  };
  const lenient = schemaToZod(schema, { lenient: true });
  assertEquals(lenient.includes("z.literal"), false);
  assertEquals(lenient.includes("kind: z.number().optional()"), true);
  assertEquals(lenient.includes("mixed: z.unknown().optional()"), true);
  assertEquals(lenient.includes(".min(") || lenient.includes(".max("), false);
  assertEquals(lenient.includes(".regex("), false);
  // Request schemas keep every constraint.
  const strict = schemaToZod(schema);
  assertEquals(strict.includes(".min(1).max(10)"), true);
  assertEquals(strict.includes(".regex("), true);
});

Deno.test("passthrough: off by default and kept before .nullable()", () => {
  const schema: SchemaObject = {
    type: ["object", "null"],
    properties: { a: { type: "string" } },
  };
  assertEquals(schemaToZod(schema).includes("passthrough"), false);
  assertEquals(
    schemaToZod(schema, { passthrough: true }).endsWith(
      ".passthrough().nullable()",
    ),
    true,
  );
});

Deno.test("passthrough: a sensitive field stays declared and marked", () => {
  const out = schemaToZod(
    {
      type: "object",
      properties: { private_key: { type: "string" }, id: { type: "integer" } },
    },
    { passthrough: true, lenient: true, sensitiveFields: ["private_key"] },
  );
  assertEquals(
    out.includes("private_key: z.string().meta({ sensitive: true })"),
    true,
  );
});
