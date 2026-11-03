import { assertEquals, assertThrows } from "@std/assert";
import { SPEC_CORRECTIONS } from "../config.ts";
import {
  applySpecCorrections,
  type OpenAPISpec,
  resolveParameter,
  resolveRef,
  resolveRequestBody,
  resolveSchema,
} from "./schema_fetcher.ts";
import { loadSpec } from "./spec_fixture.ts";

/** A minimal spec whose components the tests below point `$ref`s at. */
function specWith(
  schemas: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): OpenAPISpec {
  return {
    openapi: "3.1.1",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas, ...extra },
  } as unknown as OpenAPISpec;
}

Deno.test("applySpecCorrections: fixes a known error and reports a correction that no longer applies", () => {
  const spec = loadSpec();
  const props = (spec.components.schemas.Contact as unknown as {
    properties: Record<string, { description?: string }>;
  }).properties;
  const stale = applySpecCorrections(spec, [
    ...SPEC_CORRECTIONS,
    { path: ["components", "nowhere"], expected: "x", value: "y" },
  ]);
  assertEquals(props.postal_code.description, "The postal code.");
  assertEquals(
    stale.map((c) => c.path.join(".")).filter((p) => p.endsWith("nowhere")),
    ["components.nowhere"],
  );
  // Applying twice changes nothing: the expected text is gone.
  assertEquals(applySpecCorrections(spec).length, SPEC_CORRECTIONS.length);
  assertEquals(props.postal_code.description, "The postal code.");
});

Deno.test("applySpecCorrections: every configured correction applies to the pinned spec", () => {
  assertEquals(applySpecCorrections(loadSpec()), []);
});

Deno.test("applySpecCorrections: makes the transfer auth_code optional, and only while the spec still requires it", () => {
  const body = (required: string[]) =>
    ({
      components: {
        schemas: {},
        requestBodies: {
          DomainTransfer: {
            content: {
              "application/json": { schema: { type: "object", required } },
            },
          },
        },
      },
    }) as unknown as OpenAPISpec;
  const requiredOf = (spec: OpenAPISpec) =>
    (spec.components.requestBodies!.DomainTransfer.content!["application/json"]
      .schema as { required: string[] }).required;

  const spec = body(["registrant_id", "auth_code"]);
  applySpecCorrections(spec);
  assertEquals(requiredOf(spec), ["registrant_id"]);

  // A spec that already differs is left alone.
  const other = body(["registrant_id", "premium_price"]);
  applySpecCorrections(other);
  assertEquals(requiredOf(other), ["registrant_id", "premium_price"]);
});

Deno.test("resolveRef: follows a local ref and rejects an external one", () => {
  const spec = loadSpec();
  assertEquals(
    resolveRef(spec, "#/components/schemas/Pagination").type,
    "object",
  );
  assertThrows(
    () => resolveRef(spec, "https://example.com/x.json"),
    Error,
    "External $ref not supported",
  );
  assertThrows(
    () => resolveRef(spec, "#/components/schemas/Nope"),
    Error,
    "Failed to resolve $ref",
  );
});

Deno.test("resolveSchema: inlines refs at every depth, not just the top", () => {
  const spec = specWith({
    Leaf: { type: "string" },
    Item: {
      type: "object",
      properties: { leaf: { $ref: "#/components/schemas/Leaf" } },
    },
    Root: {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
        byName: {
          type: "object",
          additionalProperties: { $ref: "#/components/schemas/Leaf" },
        },
        either: {
          oneOf: [{ $ref: "#/components/schemas/Leaf" }, { type: "integer" }],
        },
      },
    },
  });
  const root = resolveSchema(spec, { $ref: "#/components/schemas/Root" });
  assertEquals(root.properties!.items.items!.properties!.leaf, {
    type: "string",
  });
  assertEquals(root.properties!.byName.additionalProperties, {
    type: "string",
  });
  assertEquals(root.properties!.either.oneOf![0], { type: "string" });
});

Deno.test("resolveSchema: flattens allOf, merging properties and required", () => {
  const spec = specWith({
    Base: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" } },
    },
    Named: {
      type: "object",
      required: ["name", "id"],
      properties: { name: { type: "string" } },
    },
  });
  const merged = resolveSchema(spec, {
    description: "both",
    allOf: [
      { $ref: "#/components/schemas/Base" },
      { $ref: "#/components/schemas/Named" },
      { type: "object", properties: { extra: { type: "boolean" } } },
    ],
  });
  assertEquals(merged.type, "object");
  assertEquals(merged.description, "both");
  assertEquals(Object.keys(merged.properties!).sort(), [
    "extra",
    "id",
    "name",
  ]);
  assertEquals([...merged.required!].sort(), ["id", "name"]);
});

Deno.test("resolveSchema: allOf inside a property is flattened too", () => {
  const spec = specWith({
    Actor: { type: "object", properties: { id: { type: "integer" } } },
  });
  const out = resolveSchema(spec, {
    type: "object",
    properties: {
      actor: { allOf: [{ $ref: "#/components/schemas/Actor" }] },
    },
  });
  assertEquals(out.properties!.actor.properties!.id, { type: "integer" });
});

Deno.test("resolveSchema: a circular ref collapses to an open object", () => {
  const spec = specWith({
    Node: {
      type: "object",
      properties: {
        next: { $ref: "#/components/schemas/Node" },
        value: { type: "string" },
      },
    },
  });
  const node = resolveSchema(spec, { $ref: "#/components/schemas/Node" });
  assertEquals(node.properties!.value, { type: "string" });
  assertEquals(node.properties!.next.type, "object");
  assertEquals(node.properties!.next.properties, undefined);
});

Deno.test("resolveSchema: the same ref used twice is not mistaken for a cycle", () => {
  const spec = specWith({ Leaf: { type: "string" } });
  const out = resolveSchema(spec, {
    type: "object",
    properties: {
      a: { $ref: "#/components/schemas/Leaf" },
      b: { $ref: "#/components/schemas/Leaf" },
    },
  });
  assertEquals(out.properties!.a, { type: "string" });
  assertEquals(out.properties!.b, { type: "string" });
});

Deno.test("resolveParameter and resolveRequestBody: follow components refs", () => {
  const spec = loadSpec();
  const account = resolveParameter(spec, {
    $ref: "#/components/parameters/Account",
  } as never);
  assertEquals(account.name, "account");
  assertEquals(account.in, "path");

  const body = resolveRequestBody(spec, {
    $ref: "#/components/requestBodies/ZoneRecordCreate",
  });
  assertEquals(
    Object.keys(body.content!["application/json"].schema!.properties!).includes(
      "content",
    ),
    true,
  );
  // A body that is not a ref comes back unchanged.
  const inline = { required: true };
  assertEquals(resolveRequestBody(spec, inline), inline);
});

Deno.test("the pinned spec resolves every response and request schema without a stray $ref", () => {
  const spec = loadSpec();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const op of Object.values(item)) {
      if (!op || Array.isArray(op)) continue;
      for (const resp of Object.values(op.responses ?? {})) {
        const schema = resp.content?.["application/json"]?.schema;
        if (!schema) continue;
        const text = JSON.stringify(resolveSchema(spec, schema));
        assertEquals(text.includes('"$ref"'), false, `${path} left a $ref`);
      }
    }
  }
});
