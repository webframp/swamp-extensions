/**
 * Tests for the schema fetcher module: $ref resolution, allOf/oneOf/anyOf
 * flattening, and the local cache path (never hits the live network).
 */

import { assertEquals } from "@std/assert";
import {
  fetchSchema,
  type OpenAPISpec,
  resolveRef,
  resolveSchema,
} from "./schema_fetcher.ts";

const SPEC: OpenAPISpec = {
  openapi: "3.1.0",
  info: { title: "Test", version: "v1" },
  paths: {},
  components: {
    schemas: {
      Widget: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

Deno.test("resolveRef: resolves a local component schema ref", () => {
  const resolved = resolveRef(SPEC, "#/components/schemas/Widget");
  assertEquals(resolved.type, "object");
  assertEquals(resolved.properties?.id.type, "string");
});

Deno.test("resolveRef: throws on external refs", () => {
  let threw = false;
  try {
    resolveRef(SPEC, "https://example.com/schema.json");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("resolveRef: throws on an unresolvable path", () => {
  let threw = false;
  try {
    resolveRef(SPEC, "#/components/schemas/DoesNotExist");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("resolveSchema: follows a $ref", () => {
  const resolved = resolveSchema(SPEC, { $ref: "#/components/schemas/Widget" });
  assertEquals(resolved.properties?.id.type, "string");
});

Deno.test("resolveSchema: flattens allOf into a merged object", () => {
  const resolved = resolveSchema(SPEC, {
    allOf: [
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
      { type: "object", properties: { b: { type: "integer" } } },
    ],
  });
  assertEquals(Object.keys(resolved.properties ?? {}).sort(), ["a", "b"]);
  assertEquals(resolved.required, ["a"]);
});

Deno.test("resolveSchema: resolves nested schemas inside oneOf", () => {
  const resolved = resolveSchema(SPEC, {
    oneOf: [{ $ref: "#/components/schemas/Widget" }, { type: "string" }],
  });
  assertEquals(resolved.oneOf?.[0].properties?.id.type, "string");
  assertEquals(resolved.oneOf?.[1].type, "string");
});

Deno.test("resolveSchema: circular $ref collapses to a description marker instead of looping", () => {
  const circular: OpenAPISpec = {
    ...SPEC,
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
  };
  const resolved = resolveSchema(circular, {
    $ref: "#/components/schemas/Node",
  });
  const child = resolveSchema(
    circular,
    resolved.properties!.child,
    new Set(["#/components/schemas/Node"]),
  );
  assertEquals(child.description, "[circular ref]");
});

Deno.test("fetchSchema: serves from a fresh local cache without any network call", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/openapi.json`,
      JSON.stringify(SPEC),
    );
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error("network should not be called when cache is fresh");
    };
    try {
      const loaded = await fetchSchema(dir);
      assertEquals(loaded.info.title, "Test");
      assertEquals(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
