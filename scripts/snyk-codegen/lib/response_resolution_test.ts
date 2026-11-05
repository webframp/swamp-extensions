// SPDX-License-Identifier: Apache-2.0
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ServiceConfig } from "../config.ts";
import { generateApiLib } from "./extension_generator.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import { groupOperations } from "./service_grouper.ts";

const CONFIG: ServiceConfig = {
  name: "things",
  description: "Things",
  pathPrefixes: ["/orgs/{org_id}/things"],
  scope: "org",
  labels: [],
};

const ITEM = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    attributes: {
      type: "object",
      properties: { state: { type: "string" } },
    },
  },
};

const SPEC = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  components: {
    schemas: {},
    responses: {
      ListThings: {
        description: "ok",
        content: {
          "application/vnd.api+json": {
            schema: {
              type: "object",
              properties: { data: { type: "array", items: ITEM } },
            },
          },
        },
      },
    },
  },
  paths: {
    // Response is a $ref to a shared component: must classify as a list.
    "/orgs/{org_id}/things": {
      get: {
        operationId: "listThings",
        responses: { "200": { $ref: "#/components/responses/ListThings" } },
      },
    },
    // A POST whose only success is 204 has no body to require.
    "/orgs/{org_id}/things/{thing_id}/relationships/parts": {
      post: {
        operationId: "updateThingParts",
        parameters: [
          {
            name: "org_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "thing_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/vnd.api+json": {
              schema: {
                type: "object",
                properties: {
                  data: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "204": { description: "no content" } },
      },
    },
    // A POST returning an array in data (several credentials at once).
    "/orgs/{org_id}/things/creds": {
      post: {
        operationId: "createCreds",
        requestBody: {
          content: {
            "application/vnd.api+json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/vnd.api+json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "array", items: ITEM } },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as OpenAPISpec;

Deno.test("response $refs resolve: a shared list response classifies as a list", () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);
  const list = methods.find((m) => m.name === "list_things")!;
  assertEquals(list.type, "list");
  assertEquals(list.operation.hasResponseBody, true);
});

Deno.test("hasResponseBody is false for a 204-only operation and true for 2xx content", () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const byId = Object.fromEntries(
    group.operations.map((o) => [o.operationId, o]),
  );
  assertEquals(byId.updateThingParts.hasResponseBody, false);
  assertEquals(byId.createCreds.hasResponseBody, true);
});

Deno.test("a create that answers 204 has no requireBody guard and writes nothing", async () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);
  const parts = methods.find((m) => m.name === "update_thing_parts")!;
  assertEquals(parts.type, "create");

  const src = generateModelSource(group, methods, "2026.01.01.1");
  // Only the create that returns content is guarded.
  assertEquals((src.match(/requireBody\(result,/g) ?? []).length, 1);
  assertEquals(src.includes('requireBody(result, "create_creds")'), true);
  // The no-content create neither requires a body nor writes a resource.
  assertEquals(
    src.includes('requireBody(result, "update_thing_parts")'),
    false,
  );

  const dir = await Deno.makeTempDir();
  const original = globalThis.fetch;
  try {
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
    await Deno.writeTextFile(join(dir, "things.ts"), src);
    const { model } = await import(`file://${join(dir, "things.ts")}`);
    const written: unknown[] = [];
    const context = {
      globalArgs: { apiToken: "t", orgId: "o", version: "v" },
      logger: { info() {} },
      writeResource: (_s: string, name: string, data: unknown) => {
        written.push({ name, data });
        return Promise.resolve({ name });
      },
    };
    let capturedMethod: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedMethod = init?.method;
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    const result = await model.methods.update_thing_parts.execute(
      { thing_id: "t1", data: ["a"] },
      context,
    );
    // The call still goes out with the right verb and body, but nothing is
    // persisted: a 204 write has no resource data.
    assertEquals(capturedMethod, "POST");
    assertEquals(capturedBody, { data: ["a"] });
    assertEquals(result, { dataHandles: [] });
    assertEquals(written, []);

    // An array in `data` on a non-list call keeps every item.
    written.length = 0;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "1", attributes: { state: "a" } },
              { id: "2", attributes: { state: "b" } },
            ],
          }),
          { status: 201 },
        ),
      )) as typeof fetch;
    await model.methods.create_creds.execute({ name: "n" }, context);
    assertEquals(written, [{
      name: "created",
      data: {
        items: [{ id: "1", state: "a" }, { id: "2", state: "b" }],
      },
    }]);
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
});
