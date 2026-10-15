/**
 * Batch request bodies ({data: [...]}) must survive end to end: the grouper
 * keeps the array, the classifier treats a batch POST as a create (not a
 * paginated list that re-POSTs), and every method kind sends the array back
 * inside its envelope instead of spreading it into an object.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

const ITEMS = "#/components/schemas/Item";
const BATCH = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            minItems: 1,
            maxItems: 25,
            items: { $ref: ITEMS },
          },
        },
      },
    },
  },
};

const RESPONSE = {
  "200": {
    description: "ok",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: ITEMS } },
            meta: {
              type: "object",
              properties: {
                page: {
                  type: "object",
                  properties: { after: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["type", "attributes"],
        properties: {
          type: { type: "string", enum: ["things"] },
          attributes: {
            type: "object",
            required: ["start"],
            properties: { start: { type: "string" } },
          },
        },
      },
    },
  },
  paths: {
    "/api/v2/things/{thing_id}/overrides": {
      get: {
        operationId: "ListThingOverrides",
        tags: ["Things"],
        parameters: [
          {
            name: "thing_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "page[size]", in: "query", schema: { type: "integer" } },
          { name: "page[number]", in: "query", schema: { type: "integer" } },
        ],
        responses: RESPONSE,
      },
      post: {
        operationId: "CreateThingOverrides",
        tags: ["Things"],
        parameters: [
          {
            name: "thing_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "include", in: "query", schema: { type: "string" } },
        ],
        requestBody: BATCH,
        responses: RESPONSE,
      },
    },
    "/api/v2/things/bulk": {
      patch: {
        operationId: "BulkUpdateThings",
        tags: ["Things"],
        requestBody: BATCH,
        responses: RESPONSE,
      },
      delete: {
        operationId: "BulkDeleteThings",
        tags: ["Things"],
        requestBody: BATCH,
        responses: { "204": { description: "gone" } },
      },
    },
  },
} as unknown as OpenAPISpec;

const SERVICE: ServiceConfig = {
  name: "things",
  description: "Things",
  tags: ["Things"],
  labels: [],
};

function build() {
  const [group] = groupOperations(SPEC, [SERVICE]);
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");
  return { group, methods, source };
}

Deno.test("grouper keeps a {data: [...]} body as a wrapped array", () => {
  const { group } = build();
  const post = group.operations.find((o) => o.httpMethod === "post")!;
  assertEquals(post.requestBodyIsArray, true);
  assertEquals(post.requestBodyArrayWrapper, "data");
  assertEquals(post.requestBody?.minItems, 1);
  assertEquals(post.requestBody?.maxItems, 25);
  // Item $refs are inlined so the item shape is typed, not z.unknown().
  assertEquals(
    Object.keys(post.requestBody?.items?.properties ?? {}).sort(),
    ["attributes", "type"],
  );
});

Deno.test("batch POST with a cursor-bearing response is a create, not a list", () => {
  const { methods } = build();
  const create = methods.find((m) => m.name === "create_thing_overrides")!;
  assertEquals(create.type, "create");
});

Deno.test("generated create re-wraps the array and never uses paginated POST", () => {
  const { source } = build();
  assertEquals(source.includes("ddApiPostPaginated"), false);
  assertStringIncludes(source, "{ data: args.entries }");
  // Query params stay on the URL, not in the body.
  assertStringIncludes(source, "include");
  assertStringIncludes(source, ".min(1).max(25)");
});

Deno.test("generated update and delete send the wrapped array", () => {
  const { source } = build();
  const sends = source.match(/\{ data: args\.entries \}/g) ?? [];
  // create + bulk update + bulk delete
  assertEquals(sends.length, 3);
  assertEquals(source.includes("body[k] = v"), false);
});

Deno.test("batch write and list of the same noun use distinct resource specs", () => {
  const { source } = build();
  const declared = new Set(
    [...source.matchAll(/^ {4}"([a-z_]+)": \{\n {6}description:/gm)].map((m) =>
      m[1]
    ),
  );
  const written = [...source.matchAll(/writeResource\(\s*"([a-z_]+)"/g)].map((
    m,
  ) => m[1]);
  for (const name of written) assertEquals(declared.has(name), true, name);
  // list_thing_overrides -> "thing_overrides"; the create keeps its own spec
  // so its raw {data: [...]} response is not validated as {items, ...}.
  assertEquals(declared.has("thing_overrides"), true);
  assertEquals(declared.has("create_thing_overrides"), true);
});

Deno.test("batch create resource schema accepts the raw collection response", () => {
  const { source } = build();
  // Collection responses are not flattened by the API helper, so the spec must
  // validate {data: [...]} and still accept previously stored list-shaped data.
  assertStringIncludes(
    source,
    "data: z.array(z.record(z.string(), z.unknown())).optional()",
  );
  const m = source.match(
    /const CreateThingOverridesSchema = (z\.object\(\{[\s\S]*?\}\)\.passthrough\(\));/,
  );
  assertEquals(m !== null, true);
  const schema = new Function("z", `return ${m![1]}`)(z);
  assertEquals(
    schema.safeParse({ data: [{ id: "x", type: "things" }] }).success,
    true,
  );
  assertEquals(schema.safeParse({ items: [], truncated: false }).success, true);
});

Deno.test("generated batch method tests do not pass a stray name arg", async () => {
  const { group, methods } = build();
  const { generateTestSource } = await import("./test_generator.ts");
  const src = generateTestSource(group.config, methods, "things");
  assertEquals(src.includes("test-resource"), false);
});

Deno.test("every method gets its own execution test", async () => {
  const { group, methods } = build();
  const { generateTestSource } = await import("./test_generator.ts");
  const src = generateTestSource(group.config, methods, "things");
  for (const m of methods) {
    assertStringIncludes(src, `things model: ${m.name} `);
  }
});
